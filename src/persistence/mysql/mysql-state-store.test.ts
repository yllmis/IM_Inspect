import { type Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import { createAgentSessionState } from "../../agent/session-state";
import { StateStoreError } from "../../agent/state-store";
import { MySqlStateStore } from "./mysql-state-store";

const start = Date.parse("2026-09-08T08:00:00Z");

function session(sessionId = "session_mysql") {
  return createAgentSessionState({
    sessionId,
    tenantId: "tenant_mysql",
    actorId: "support_mysql",
    issueSummary: "用户反馈消息未收到",
    now: new Date(start),
    ttlMs: 60_000,
  });
}

function fakePool() {
  const rows = new Map<
    string,
    { state_json: string; version: number; expiresAt: number }
  >();
  const execute = vi.fn(async (sql: string, rawValues?: unknown) => {
    const values = (rawValues ?? []) as unknown[];
    if (sql.startsWith("INSERT")) {
      const key = rowKey(values[0], values[1], values[2]);
      if (rows.has(key)) {
        throw Object.assign(new Error("duplicate"), { errno: 1062 });
      }
      rows.set(key, {
        state_json: String(values[3]),
        version: Number(values[4]),
        expiresAt: (values[7] as Date).getTime(),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT")) {
      const row = rows.get(rowKey(values[0], values[1], values[2]));
      return [
        row ? [{ state_json: row.state_json, version: row.version }] : [],
        [],
      ];
    }
    if (sql.startsWith("UPDATE")) {
      const key = rowKey(values[3], values[4], values[5]);
      const row = rows.get(key);
      const expectedVersion = Number(values[6]);
      const now = (values[7] as Date).getTime();
      if (!row || row.version !== expectedVersion || row.expiresAt <= now) {
        return [{ affectedRows: 0 }, []];
      }
      rows.set(key, {
        state_json: String(values[0]),
        version: Number(values[1]),
        expiresAt: row.expiresAt,
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("DELETE")) {
      const key = rowKey(values[0], values[1], values[2]);
      const row = rows.get(key);
      const shouldDelete =
        row &&
        (values.length === 3 || row.expiresAt <= (values[3] as Date).getTime());
      if (shouldDelete) rows.delete(key);
      return [{ affectedRows: shouldDelete ? 1 : 0 }, []];
    }
    throw new Error("unexpected SQL");
  });
  return { pool: { execute } as unknown as Pool, rows, execute };
}

describe("MySqlStateStore", () => {
  it("creates and loads an isolated Zod-validated session", async () => {
    const database = fakePool();
    const store = new MySqlStateStore(database.pool, () => start);
    const created = await store.create(session());
    created.currentIssue.summary = "调用方修改";

    await expect(
      store.load({
        tenantId: "tenant_mysql",
        actorId: "support_mysql",
        sessionId: "session_mysql",
      }),
    ).resolves.toMatchObject({
      version: 1,
      currentIssue: { summary: "用户反馈消息未收到" },
    });
    await expect(store.create(session())).rejects.toMatchObject({
      code: "already_exists",
    } satisfies Partial<StateStoreError>);
  });

  it("increments versions atomically and rejects a stale save", async () => {
    let now = start;
    const database = fakePool();
    const store = new MySqlStateStore(database.pool, () => now);
    const original = await store.create(session());
    now += 1_000;

    const saved = await store.save(
      { ...original, status: "extracting_context" },
      1,
    );
    expect(saved).toMatchObject({
      version: 2,
      status: "extracting_context",
      createdAt: "2026-09-08T08:00:00.000Z",
      updatedAt: "2026-09-08T08:00:01.000Z",
    });
    await expect(store.save(original, 1)).rejects.toMatchObject({
      code: "version_conflict",
    } satisfies Partial<StateStoreError>);
  });

  it("removes expired sessions and supports explicit deletion", async () => {
    let now = start;
    const database = fakePool();
    const store = new MySqlStateStore(database.pool, () => now);
    await store.create(session("session_expired"));
    await store.create(session("session_deleted"));

    now += 60_000;
    await expect(
      store.load({
        tenantId: "tenant_mysql",
        actorId: "support_mysql",
        sessionId: "session_expired",
      }),
    ).resolves.toBeNull();
    await expect(
      store.delete({
        tenantId: "tenant_mysql",
        actorId: "support_mysql",
        sessionId: "session_deleted",
      }),
    ).resolves.toBe(true);
  });
});

function rowKey(tenantId: unknown, actorId: unknown, sessionId: unknown) {
  return JSON.stringify([tenantId, actorId, sessionId]);
}
