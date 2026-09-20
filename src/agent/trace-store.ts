import { AgentRunTrace, AgentRunTraceSchema } from "./run-trace";

export interface TraceStoreIdentity {
  tenantId: string;
  actorId: string;
}

export interface TraceStore {
  save(identity: TraceStoreIdentity, trace: AgentRunTrace): Promise<void>;
  get(
    identity: TraceStoreIdentity,
    runId: string,
  ): Promise<AgentRunTrace | null>;
}

/**
 * MVP TraceStore：按租户和操作者隔离 Run Trace。
 * 接口对应 Repository 边界，后续可以替换为 MySQL，而查询和回放逻辑不变。
 */
export class InMemoryTraceStore implements TraceStore {
  private readonly traces = new Map<string, AgentRunTrace>();

  constructor(private readonly maxTraces = 2_000) {
    if (!Number.isSafeInteger(maxTraces) || maxTraces <= 0) {
      throw new Error("maxTraces must be a positive safe integer");
    }
  }

  async save(
    identity: TraceStoreIdentity,
    trace: AgentRunTrace,
  ): Promise<void> {
    const parsed = AgentRunTraceSchema.parse(trace);
    const key = traceKey(identity, parsed.runId);
    if (!this.traces.has(key) && this.traces.size >= this.maxTraces) {
      const oldest = this.traces.keys().next().value;
      if (oldest) this.traces.delete(oldest);
    }
    this.traces.set(key, cloneTrace(parsed));
  }

  async get(
    identity: TraceStoreIdentity,
    runId: string,
  ): Promise<AgentRunTrace | null> {
    const trace = this.traces.get(traceKey(identity, runId));
    return trace ? cloneTrace(trace) : null;
  }
}

function traceKey(identity: TraceStoreIdentity, runId: string): string {
  return JSON.stringify([identity.tenantId, identity.actorId, runId]);
}

function cloneTrace(trace: AgentRunTrace): AgentRunTrace {
  return AgentRunTraceSchema.parse(structuredClone(trace));
}
