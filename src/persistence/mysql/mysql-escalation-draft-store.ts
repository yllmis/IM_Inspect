import {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

import { DiagnosisResultSchema } from "../../domain/diagnosis";
import { DraftRecord, DraftRecordSchema } from "../../tools/draft-repository";
import {
  ConfirmationRecord,
  ConfirmationRecordSchema,
  draftFromConfirmation,
  DraftSecurityError,
  EscalationDraftStore,
} from "../../tools/escalation-draft-service";

interface ConfirmationRow extends RowDataPacket {
  confirmationId: string;
  tokenHash: string;
  tenantId: string;
  actorId: string;
  runId: string;
  sessionId: string;
  sessionVersion: string | number;
  diagnosisResultId: string;
  contentHash: string;
  idempotencyKey: string;
  proposal: unknown;
  expiresAt: Date | string;
  usedAt: Date | string | null;
  revokedAt: Date | string | null;
  createdAt: Date | string;
}

interface DraftRow extends RowDataPacket, DraftRecord {}

export class MySqlEscalationDraftStore implements EscalationDraftStore {
  constructor(private readonly pool: Pool) {}

  async prepare(
    input: Parameters<EscalationDraftStore["prepare"]>[0],
  ): Promise<void> {
    const confirmation = ConfirmationRecordSchema.parse(input.confirmation);
    const diagnosis = DiagnosisResultSchema.parse(input.snapshot.result);
    await this.inTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO diagnosis_results
         (diagnosis_result_id, tenant_id, actor_id, session_id, issue_id, run_id, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE diagnosis_result_id = VALUES(diagnosis_result_id)`,
        [
          input.snapshot.diagnosisResultId,
          input.snapshot.tenantId,
          input.snapshot.actorId,
          input.snapshot.sessionId,
          input.snapshot.issueId,
          input.snapshot.runId,
          JSON.stringify(diagnosis),
          new Date(input.snapshot.createdAt),
        ],
      );
      await connection.execute(
        `UPDATE draft_confirmations SET revoked_at = ?
         WHERE tenant_id = ? AND actor_id = ? AND run_id = ? AND idempotency_key = ?
         AND used_at IS NULL AND revoked_at IS NULL`,
        [
          new Date(confirmation.createdAt),
          confirmation.tenantId,
          confirmation.actorId,
          confirmation.runId,
          confirmation.idempotencyKey,
        ],
      );
      await connection.execute(
        `INSERT INTO draft_confirmations
         (confirmation_id, token_hash, tenant_id, actor_id, run_id, session_id,
          session_version, diagnosis_result_id, content_hash, idempotency_key,
          draft_json, expires_at, used_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [
          confirmation.confirmationId,
          confirmation.tokenHash,
          confirmation.tenantId,
          confirmation.actorId,
          confirmation.runId,
          confirmation.sessionId,
          confirmation.sessionVersion,
          confirmation.diagnosisResultId,
          confirmation.contentHash,
          confirmation.idempotencyKey,
          JSON.stringify(confirmation.proposal),
          new Date(confirmation.expiresAt),
          new Date(confirmation.createdAt),
        ],
      );
    });
  }

  async confirmAndCreateDraft(
    input: Parameters<EscalationDraftStore["confirmAndCreateDraft"]>[0],
  ) {
    return this.inTransaction(async (connection) => {
      const confirmation = await this.selectConfirmation(
        connection,
        input.tokenHash,
      );
      if (!confirmation) {
        throw new DraftSecurityError(
          "confirmation_required",
          "confirmation token is invalid",
        );
      }
      assertConfirmationMatches(confirmation, input.expected);
      if (confirmation.revokedAt) {
        throw new DraftSecurityError(
          "confirmation_required",
          "confirmation was revoked",
        );
      }
      if (Date.parse(confirmation.expiresAt) <= input.now.getTime()) {
        throw new DraftSecurityError(
          "confirmation_expired",
          "confirmation has expired",
        );
      }

      const draft = draftFromConfirmation(confirmation);
      const existing = await this.selectDraft(
        connection,
        draft.tenantId,
        draft.idempotencyKey,
      );
      if (existing) {
        if (existing.contentHash !== draft.contentHash) {
          throw new DraftSecurityError(
            "idempotency_conflict",
            "idempotency key is bound to different content",
          );
        }
        if (!confirmation.usedAt) {
          await markConfirmationUsed(
            connection,
            confirmation.confirmationId,
            input.now,
          );
        }
        return { draft: existing, reused: true };
      }
      if (confirmation.usedAt) {
        throw new DraftSecurityError(
          "confirmation_replayed",
          "confirmation was already used",
        );
      }

      await insertDraft(connection, draft);
      await markConfirmationUsed(
        connection,
        confirmation.confirmationId,
        input.now,
      );
      return { draft, reused: false };
    });
  }

  private async selectConfirmation(
    connection: PoolConnection,
    tokenHash: string,
  ) {
    const [rows] = await connection.execute<ConfirmationRow[]>(
      `SELECT confirmation_id AS confirmationId, token_hash AS tokenHash,
       tenant_id AS tenantId, actor_id AS actorId, run_id AS runId,
       session_id AS sessionId, session_version AS sessionVersion,
       diagnosis_result_id AS diagnosisResultId, content_hash AS contentHash,
       idempotency_key AS idempotencyKey, draft_json AS proposal,
       expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt,
       created_at AS createdAt
       FROM draft_confirmations WHERE token_hash = ? LIMIT 1 FOR UPDATE`,
      [tokenHash],
    );
    return rows[0] ? parseConfirmation(rows[0]) : null;
  }

  private async selectDraft(
    connection: PoolConnection,
    tenantId: string,
    idempotencyKey: string,
  ) {
    const [rows] = await connection.execute<DraftRow[]>(
      `SELECT draft_id AS draftId, tenant_id AS tenantId, actor_id AS actorId,
       run_id AS runId, diagnosis_result_id AS diagnosisResultId,
       message_id AS messageId, conversation_id AS conversationId, classification,
       facts_json AS facts, evidence_refs_json AS evidenceRefs,
       possible_causes_json AS possibleCauses, missing_information_json AS missingInformation,
       unsupported_capabilities_json AS unsupportedCapabilities, summary,
       content_hash AS contentHash, idempotency_key AS idempotencyKey,
       status, created_at AS createdAt
       FROM agent_drafts WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
      [tenantId, idempotencyKey],
    );
    return rows[0] ? parseDraft(rows[0]) : null;
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function assertConfirmationMatches(
  record: ConfirmationRecord,
  expected: Parameters<
    EscalationDraftStore["confirmAndCreateDraft"]
  >[0]["expected"],
) {
  if (
    record.tenantId !== expected.tenantId ||
    record.actorId !== expected.actorId ||
    record.sessionId !== expected.sessionId
  ) {
    throw new DraftSecurityError(
      "confirmation_required",
      "confirmation does not belong to this session",
    );
  }
  if (record.sessionVersion !== expected.sessionVersion) {
    throw new DraftSecurityError(
      "state_changed",
      "session changed after confirmation was prepared",
    );
  }
}

async function insertDraft(connection: PoolConnection, draft: DraftRecord) {
  const parsed = DraftRecordSchema.parse(draft);
  await connection.execute(
    `INSERT INTO agent_drafts
     (draft_id, tenant_id, actor_id, run_id, diagnosis_result_id, message_id,
      conversation_id, classification, facts_json, evidence_refs_json,
      possible_causes_json, missing_information_json, unsupported_capabilities_json,
      summary, content_hash, idempotency_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      parsed.draftId,
      parsed.tenantId,
      parsed.actorId,
      parsed.runId,
      parsed.diagnosisResultId,
      parsed.messageId,
      parsed.conversationId ?? null,
      parsed.classification,
      JSON.stringify(parsed.facts),
      JSON.stringify(parsed.evidenceRefs),
      JSON.stringify(parsed.possibleCauses),
      JSON.stringify(parsed.missingInformation),
      JSON.stringify(parsed.unsupportedCapabilities),
      parsed.summary,
      parsed.contentHash,
      parsed.idempotencyKey,
      parsed.status,
      new Date(parsed.createdAt),
    ],
  );
}

async function markConfirmationUsed(
  connection: PoolConnection,
  confirmationId: string,
  now: Date,
) {
  await connection.execute(
    "UPDATE draft_confirmations SET used_at = ? WHERE confirmation_id = ? AND used_at IS NULL",
    [now, confirmationId],
  );
}

function parseConfirmation(row: ConfirmationRow): ConfirmationRecord {
  return ConfirmationRecordSchema.parse({
    ...row,
    sessionVersion: Number(row.sessionVersion),
    proposal: parseJsonColumn(row.proposal),
    expiresAt: toIso(row.expiresAt),
    usedAt: row.usedAt ? toIso(row.usedAt) : null,
    revokedAt: row.revokedAt ? toIso(row.revokedAt) : null,
    createdAt: toIso(row.createdAt),
  });
}

function parseDraft(row: DraftRow): DraftRecord {
  const value = { ...row } as Record<string, unknown>;
  for (const key of [
    "facts",
    "evidenceRefs",
    "possibleCauses",
    "missingInformation",
    "unsupportedCapabilities",
  ]) {
    value[key] = parseJsonColumn(value[key]);
  }
  value.createdAt = toIso(value.createdAt as Date | string);
  if (value.conversationId === null) delete value.conversationId;
  return DraftRecordSchema.parse(value);
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return value;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
