import { readFile } from "node:fs/promises";
import path from "node:path";

import { type Pool, type ResultSetHeader } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DiagnosisResult } from "../../domain/diagnosis";
import { EscalationDraftService } from "../../tools/escalation-draft-service";
import { createMySqlPool } from "./connection";
import { MySqlEscalationDraftStore } from "./mysql-escalation-draft-store";

const databaseUrl = process.env.MYSQL_TEST_URL;
const integration = describe.skipIf(!databaseUrl);
const tenantId = "integration_draft_store";
const actorId = "integration_support";
const now = new Date("2026-09-19T10:00:00Z");
const diagnosis: DiagnosisResult = {
  classification: "write_failed",
  facts: ["消息写入失败"],
  evidence: [
    {
      id: "integration:write:error",
      source: "integration-test",
      kind: "write",
      observedAt: now.toISOString(),
      field: "insert",
      value: "failed",
    },
  ],
  possibleCauses: ["存储写入失败"],
  missingInformation: [],
  unsupportedCapabilities: [],
  recommendedAction: "escalate",
};

integration("MySqlEscalationDraftStore integration", () => {
  let pool: Pool;
  let service: EscalationDraftService;
  let schemaReady = false;

  beforeAll(async () => {
    pool = createMySqlPool({ databaseUrl: databaseUrl!, connectionLimit: 2 });
    const migration = await readFile(
      path.join(
        process.cwd(),
        "migrations/mysql/002_escalation_draft_security.sql",
      ),
      "utf8",
    );
    for (const statement of migration
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)) {
      await pool.query(statement);
    }
    schemaReady = true;
    await removeTestRows(pool);
    service = new EscalationDraftService(
      new MySqlEscalationDraftStore(pool),
      () => now,
    );
  });

  afterAll(async () => {
    if (!pool) return;
    if (schemaReady) await removeTestRows(pool);
    await pool.end();
  });

  it("atomically persists the diagnosis, confirmation, and idempotent draft", async () => {
    const prepared = await service.prepare({
      tenantId,
      actorId,
      runId: "integration_run",
      sessionId: "integration_session",
      sessionVersion: 1,
      issueId: "integration_issue",
      diagnosisResultId: "integration_diagnosis",
      diagnosisResult: diagnosis,
      permissions: ["escalation:draft:create"],
      proposal: {
        messageId: "integration_message",
        diagnosisResultId: "integration_diagnosis",
        classification: "write_failed",
        facts: diagnosis.facts,
        evidenceRefs: ["integration:write:error"],
        possibleCauses: diagnosis.possibleCauses,
        missingInformation: [],
        unsupportedCapabilities: [],
        recommendedAction: "escalate",
        summary: "MySQL 原子确认测试",
        idempotencyKey: "integration-draft-key-001",
      },
    });
    const confirmation = {
      tenantId,
      actorId,
      sessionId: "integration_session",
      sessionVersion: 1,
      confirmationToken: prepared.confirmationToken,
      permissions: ["escalation:draft:create"],
    };
    const created = await service.confirm(confirmation);
    const repeated = await service.confirm(confirmation);
    expect(created).toMatchObject({ reused: false });
    expect(repeated).toMatchObject({
      reused: true,
      draft: { draftId: created.draft.draftId },
    });

    const [rows] = await pool.query<
      ({
        diagnosisCount: number;
        draftCount: number;
      } & import("mysql2/promise").RowDataPacket)[]
    >(
      `SELECT
       (SELECT COUNT(*) FROM diagnosis_results WHERE tenant_id = ?) AS diagnosisCount,
       (SELECT COUNT(*) FROM agent_drafts WHERE tenant_id = ?) AS draftCount`,
      [tenantId, tenantId],
    );
    expect(Number(rows[0].diagnosisCount)).toBe(1);
    expect(Number(rows[0].draftCount)).toBe(1);
  });
});

async function removeTestRows(pool: Pool): Promise<void> {
  await pool.execute<ResultSetHeader>(
    "DELETE FROM draft_confirmations WHERE tenant_id = ?",
    [tenantId],
  );
  await pool.execute<ResultSetHeader>(
    "DELETE FROM agent_drafts WHERE tenant_id = ?",
    [tenantId],
  );
  await pool.execute<ResultSetHeader>(
    "DELETE FROM diagnosis_results WHERE tenant_id = ?",
    [tenantId],
  );
}
