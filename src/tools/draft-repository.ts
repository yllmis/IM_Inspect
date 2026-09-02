import { z } from "zod";

export const DraftRecordSchema = z
  .object({
    draftId: z.string().min(1).max(128),
    tenantId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    conversationId: z.string().min(1).max(128).optional(),
    classification: z.string().min(1).max(64),
    facts: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    possibleCauses: z.array(z.string()),
    missingInformation: z.array(z.string()),
    unsupportedCapabilities: z.array(z.string()),
    summary: z.string().min(1).max(2000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(16).max(128),
    status: z.literal("draft"),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type DraftRecord = z.infer<typeof DraftRecordSchema>;

export interface DraftRepository {
  findByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DraftRecord | undefined>;
  create(draft: DraftRecord): Promise<DraftRecord>;
}

export function createInMemoryDraftRepository(): DraftRepository {
  const records = new Map<string, DraftRecord>();
  return {
    async findByIdempotency(tenantId, idempotencyKey) {
      return records.get(`${tenantId}:${idempotencyKey}`);
    },
    async create(draft) {
      const key = `${draft.tenantId}:${draft.idempotencyKey}`;
      if (records.has(key)) {
        throw new Error("duplicate idempotency key");
      }
      records.set(key, draft);
      return draft;
    },
  };
}

export interface MySqlClient {
  execute<T = unknown>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T, unknown]>;
}

export class MySqlDraftRepository implements DraftRepository {
  constructor(private readonly client: MySqlClient) {}

  async findByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<DraftRecord | undefined> {
    const [rows] = await this.client.execute<readonly DraftRecord[]>(
      `SELECT draft_id AS draftId, tenant_id AS tenantId, actor_id AS actorId,
        run_id AS runId, message_id AS messageId, conversation_id AS conversationId,
        classification, facts_json AS facts,
        evidence_refs_json AS evidenceRefs, possible_causes_json AS possibleCauses,
        missing_information_json AS missingInformation,
        unsupported_capabilities_json AS unsupportedCapabilities, summary,
        content_hash AS contentHash, idempotency_key AS idempotencyKey,
        status, created_at AS createdAt
       FROM agent_drafts WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    const row = rows[0];
    return row ? DraftRecordSchema.parse(normalizeJsonColumns(row)) : undefined;
  }

  async create(draft: DraftRecord): Promise<DraftRecord> {
    await this.client.execute(
      `INSERT INTO agent_drafts
       (draft_id, tenant_id, actor_id, run_id, message_id, conversation_id, classification,
        facts_json, evidence_refs_json, possible_causes_json,
        missing_information_json, unsupported_capabilities_json, summary,
        content_hash, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        draft.draftId,
        draft.tenantId,
        draft.actorId,
        draft.runId,
        draft.messageId,
        draft.conversationId ?? null,
        draft.classification,
        JSON.stringify(draft.facts),
        JSON.stringify(draft.evidenceRefs),
        JSON.stringify(draft.possibleCauses),
        JSON.stringify(draft.missingInformation),
        JSON.stringify(draft.unsupportedCapabilities),
        draft.summary,
        draft.contentHash,
        draft.idempotencyKey,
        draft.status,
        draft.createdAt,
      ],
    );
    return draft;
  }
}

function normalizeJsonColumns(row: DraftRecord): DraftRecord {
  const value = { ...row } as Record<string, unknown>;
  for (const key of [
    "facts",
    "evidenceRefs",
    "possibleCauses",
    "missingInformation",
    "unsupportedCapabilities",
  ]) {
    if (typeof value[key] === "string") value[key] = JSON.parse(value[key]);
  }
  return value as DraftRecord;
}
