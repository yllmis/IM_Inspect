import {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

import {
  type AgentSessionState,
  AgentSessionStateSchema,
} from "../../agent/session-state";
import {
  type SessionStateIdentity,
  type StateStore,
  StateStoreError,
} from "../../agent/state-store";

interface SessionRow extends RowDataPacket {
  state_json: unknown;
  version: string | number;
}

export class MySqlStateStore implements StateStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async create(state: AgentSessionState): Promise<AgentSessionState> {
    const parsed = AgentSessionStateSchema.parse(state);
    const now = this.now();
    if (Date.parse(parsed.expiresAt) <= now) {
      throw new StateStoreError("expired", "session is already expired");
    }

    try {
      await this.pool.execute<ResultSetHeader>(INSERT_SESSION_SQL, [
        parsed.tenantId,
        parsed.actorId,
        parsed.sessionId,
        JSON.stringify(parsed),
        parsed.version,
        new Date(parsed.createdAt),
        new Date(parsed.updatedAt),
        new Date(parsed.expiresAt),
      ]);
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new StateStoreError("already_exists", "session already exists");
      }
      throw error;
    }
    return cloneState(parsed);
  }

  async load(
    identity: SessionStateIdentity,
  ): Promise<AgentSessionState | null> {
    const row = await this.selectRow(identity);
    if (!row) return null;
    const state = parseStoredState(row, identity);
    const now = this.now();
    if (Date.parse(state.expiresAt) <= now) {
      await this.deleteExpired(identity, now);
      return null;
    }
    return cloneState(state);
  }

  async save(
    state: AgentSessionState,
    expectedVersion: number,
  ): Promise<AgentSessionState> {
    const parsed = AgentSessionStateSchema.parse(state);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
      throw new StateStoreError(
        "version_conflict",
        "expected version must be a positive safe integer",
      );
    }
    const identity: SessionStateIdentity = {
      tenantId: parsed.tenantId,
      actorId: parsed.actorId,
      sessionId: parsed.sessionId,
    };
    const currentRow = await this.selectRow(identity);
    if (!currentRow) {
      throw new StateStoreError("not_found", "session does not exist");
    }
    const current = parseStoredState(currentRow, identity);
    const now = this.now();
    if (Date.parse(current.expiresAt) <= now) {
      await this.deleteExpired(identity, now);
      throw new StateStoreError("expired", "session has expired");
    }
    if (current.version !== expectedVersion) {
      throw new StateStoreError(
        "version_conflict",
        "session version does not match",
      );
    }

    const updated = AgentSessionStateSchema.parse({
      ...parsed,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: new Date(now).toISOString(),
      expiresAt: current.expiresAt,
    });
    const [result] = await this.pool.execute<ResultSetHeader>(
      UPDATE_SESSION_SQL,
      [
        JSON.stringify(updated),
        updated.version,
        new Date(updated.updatedAt),
        identity.tenantId,
        identity.actorId,
        identity.sessionId,
        expectedVersion,
        new Date(now),
      ],
    );
    if (result.affectedRows === 1) return cloneState(updated);

    return this.throwSaveConflict(identity, expectedVersion, now);
  }

  async delete(identity: SessionStateIdentity): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      DELETE_SESSION_SQL,
      [identity.tenantId, identity.actorId, identity.sessionId],
    );
    return result.affectedRows > 0;
  }

  private async selectRow(
    identity: SessionStateIdentity,
  ): Promise<SessionRow | null> {
    const [rows] = await this.pool.execute<SessionRow[]>(SELECT_SESSION_SQL, [
      identity.tenantId,
      identity.actorId,
      identity.sessionId,
    ]);
    return rows[0] ?? null;
  }

  private async deleteExpired(
    identity: SessionStateIdentity,
    now: number,
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(DELETE_EXPIRED_SESSION_SQL, [
      identity.tenantId,
      identity.actorId,
      identity.sessionId,
      new Date(now),
    ]);
  }

  private async throwSaveConflict(
    identity: SessionStateIdentity,
    expectedVersion: number,
    now: number,
  ): Promise<never> {
    const row = await this.selectRow(identity);
    if (!row) {
      throw new StateStoreError("not_found", "session does not exist");
    }
    const current = parseStoredState(row, identity);
    if (Date.parse(current.expiresAt) <= now) {
      await this.deleteExpired(identity, now);
      throw new StateStoreError("expired", "session has expired");
    }
    if (current.version !== expectedVersion) {
      throw new StateStoreError(
        "version_conflict",
        "session version does not match",
      );
    }
    throw new StateStoreError(
      "version_conflict",
      "session changed while it was being saved",
    );
  }
}

function parseStoredState(
  row: SessionRow,
  identity: SessionStateIdentity,
): AgentSessionState {
  try {
    const state = AgentSessionStateSchema.parse(
      parseJsonColumn(row.state_json),
    );
    const version = parseVersion(row.version);
    if (
      state.version !== version ||
      state.tenantId !== identity.tenantId ||
      state.actorId !== identity.actorId ||
      state.sessionId !== identity.sessionId
    ) {
      throw new StateStoreError(
        "invalid_state",
        "stored session identity or version is inconsistent",
      );
    }
    return state;
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError(
      "invalid_state",
      "stored session state failed validation",
    );
  }
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  if (Buffer.isBuffer(value)) {
    return JSON.parse(value.toString("utf8")) as unknown;
  }
  return value;
}

function parseVersion(value: string | number): number {
  const version = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new StateStoreError(
      "invalid_state",
      "stored session version is invalid",
    );
  }
  return version;
}

function cloneState(state: AgentSessionState): AgentSessionState {
  return AgentSessionStateSchema.parse(state);
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    error.errno === 1062
  );
}

const INSERT_SESSION_SQL = [
  "INSERT INTO agent_sessions (",
  "tenant_id, actor_id, session_id, state_json, version,",
  "created_at, updated_at, expires_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
].join(" ");

const SELECT_SESSION_SQL = [
  "SELECT state_json, version FROM agent_sessions",
  "WHERE tenant_id = ? AND actor_id = ? AND session_id = ? LIMIT 1",
].join(" ");

const UPDATE_SESSION_SQL = [
  "UPDATE agent_sessions",
  "SET state_json = ?, version = ?, updated_at = ?",
  "WHERE tenant_id = ? AND actor_id = ? AND session_id = ?",
  "AND version = ? AND expires_at > ?",
].join(" ");

const DELETE_SESSION_SQL = [
  "DELETE FROM agent_sessions",
  "WHERE tenant_id = ? AND actor_id = ? AND session_id = ?",
].join(" ");

const DELETE_EXPIRED_SESSION_SQL = [
  "DELETE FROM agent_sessions",
  "WHERE tenant_id = ? AND actor_id = ? AND session_id = ?",
  "AND expires_at <= ?",
].join(" ");
