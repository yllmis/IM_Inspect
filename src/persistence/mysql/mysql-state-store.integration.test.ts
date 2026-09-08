import { readFile } from "node:fs/promises";
import path from "node:path";

import { type Pool, type ResultSetHeader } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAgentSessionState } from "../../agent/session-state";
import { StateStoreError } from "../../agent/state-store";
import { createMySqlPool } from "./connection";
import { MySqlStateStore } from "./mysql-state-store";

const databaseUrl = process.env.MYSQL_TEST_URL;
const integration = describe.skipIf(!databaseUrl);
const tenantId = "integration_state_store";
const actorId = "integration_support";
const start = Date.parse("2026-09-08T08:00:00Z");

integration("MySqlStateStore integration", () => {
  let pool: Pool;
  let store: MySqlStateStore;

  beforeAll(async () => {
    pool = createMySqlPool({
      databaseUrl: databaseUrl!,
      connectionLimit: 2,
    });
    const migration = await readFile(
      path.join(
        process.cwd(),
        "migrations/mysql/001_create_agent_sessions.sql",
      ),
      "utf8",
    );
    await pool.query(migration);
    await removeTestRows(pool);
    store = new MySqlStateStore(pool, () => start);
  });

  afterAll(async () => {
    if (!pool) return;
    await removeTestRows(pool);
    await pool.end();
  });

  it("persists state and enforces optimistic version updates in MySQL", async () => {
    const original = createAgentSessionState({
      sessionId: "integration_session",
      tenantId,
      actorId,
      issueSummary: "MySQL 集成测试",
      now: new Date(start),
      ttlMs: 60_000,
    });
    await store.create(original);

    const loaded = await store.load({
      tenantId,
      actorId,
      sessionId: original.sessionId,
    });
    expect(loaded).toEqual(original);

    const saved = await store.save(
      { ...original, status: "extracting_context" },
      1,
    );
    expect(saved).toMatchObject({
      version: 2,
      status: "extracting_context",
    });
    await expect(store.save(original, 1)).rejects.toMatchObject({
      code: "version_conflict",
    } satisfies Partial<StateStoreError>);
  });

  it("maps duplicate primary keys to already_exists", async () => {
    const duplicate = createAgentSessionState({
      sessionId: "integration_duplicate",
      tenantId,
      actorId,
      issueSummary: "重复会话",
      now: new Date(start),
      ttlMs: 60_000,
    });
    await store.create(duplicate);
    await expect(store.create(duplicate)).rejects.toMatchObject({
      code: "already_exists",
    } satisfies Partial<StateStoreError>);
  });
});

async function removeTestRows(pool: Pool): Promise<void> {
  await pool.execute<ResultSetHeader>(
    "DELETE FROM agent_sessions WHERE tenant_id = ? AND actor_id = ?",
    [tenantId, actorId],
  );
}
