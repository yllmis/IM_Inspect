import { AgentSessionState, AgentSessionStateSchema } from "./session-state";

export interface SessionStateIdentity {
  sessionId: string;
  tenantId: string;
  actorId: string;
}

export interface StateStore {
  create(state: AgentSessionState): Promise<AgentSessionState>;
  load(identity: SessionStateIdentity): Promise<AgentSessionState | null>;
  save(
    state: AgentSessionState,
    expectedVersion: number,
  ): Promise<AgentSessionState>;
  delete(identity: SessionStateIdentity): Promise<boolean>;
}

export type StateStoreErrorCode =
  | "already_exists"
  | "not_found"
  | "version_conflict"
  | "capacity_exceeded"
  | "expired"
  | "invalid_state";

export class StateStoreError extends Error {
  constructor(
    readonly code: StateStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StateStoreError";
  }
}

export class InMemoryStateStore implements StateStore {
  private readonly states = new Map<string, AgentSessionState>();
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: { now?: () => number; maxSessions?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 1_000;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions <= 0) {
      throw new Error("maxSessions must be a positive safe integer");
    }
  }

  async create(state: AgentSessionState): Promise<AgentSessionState> {
    this.removeExpired();
    const parsed = AgentSessionStateSchema.parse(state);
    const key = stateKey(parsed);
    if (this.states.has(key)) {
      throw new StateStoreError("already_exists", "session already exists");
    }
    if (Date.parse(parsed.expiresAt) <= this.now()) {
      throw new StateStoreError("expired", "session is already expired");
    }
    if (this.states.size >= this.maxSessions) {
      throw new StateStoreError(
        "capacity_exceeded",
        "in-memory session capacity exceeded",
      );
    }
    const stored = cloneState(parsed);
    this.states.set(key, stored);
    return cloneState(stored);
  }

  async load(
    identity: SessionStateIdentity,
  ): Promise<AgentSessionState | null> {
    const key = stateKey(identity);
    const stored = this.states.get(key);
    if (!stored) return null;
    if (Date.parse(stored.expiresAt) <= this.now()) {
      this.states.delete(key);
      return null;
    }
    return cloneState(stored);
  }

  async save(
    state: AgentSessionState,
    expectedVersion: number,
  ): Promise<AgentSessionState> {
    const parsed = AgentSessionStateSchema.parse(state);
    const key = stateKey(parsed);
    const current = this.states.get(key);
    if (!current) {
      throw new StateStoreError("not_found", "session does not exist");
    }
    if (Date.parse(current.expiresAt) <= this.now()) {
      this.states.delete(key);
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
      updatedAt: new Date(this.now()).toISOString(),
      expiresAt: current.expiresAt,
    });
    const stored = cloneState(updated);
    this.states.set(key, stored);
    return cloneState(stored);
  }

  async delete(identity: SessionStateIdentity): Promise<boolean> {
    return this.states.delete(stateKey(identity));
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, state] of this.states.entries()) {
      if (Date.parse(state.expiresAt) <= now) this.states.delete(key);
    }
  }
}

function stateKey(identity: SessionStateIdentity): string {
  return JSON.stringify([
    identity.tenantId,
    identity.actorId,
    identity.sessionId,
  ]);
}

function cloneState(state: AgentSessionState): AgentSessionState {
  return AgentSessionStateSchema.parse(state);
}
