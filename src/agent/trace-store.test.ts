import { describe, expect, it } from "vitest";

import { RunTraceRecorder } from "./run-trace";
import { InMemoryTraceStore } from "./trace-store";

function makeTrace(runId: string) {
  return new RunTraceRecorder({
    runId,
    sessionId: "session_store_001",
    requestId: `request_${runId}`,
  }).finish({ status: "completed", finalClassification: "delivered" });
}

describe("InMemoryTraceStore", () => {
  it("isolates traces by tenant and actor and returns a clone", async () => {
    const store = new InMemoryTraceStore();
    const identity = { tenantId: "tenant_a", actorId: "actor_a" };
    const trace = makeTrace("run_store_001");
    await store.save(identity, trace);

    const loaded = await store.get(identity, "run_store_001");
    expect(loaded).toEqual(trace);
    expect(
      await store.get(
        { tenantId: "tenant_b", actorId: "actor_a" },
        "run_store_001",
      ),
    ).toBeNull();
    expect(loaded).not.toBe(trace);
  });

  it("evicts the oldest trace at the configured bound", async () => {
    const store = new InMemoryTraceStore(1);
    const identity = { tenantId: "tenant_a", actorId: "actor_a" };
    await store.save(identity, makeTrace("run_old"));
    await store.save(identity, makeTrace("run_new"));

    expect(await store.get(identity, "run_old")).toBeNull();
    expect(await store.get(identity, "run_new")).not.toBeNull();
  });
});
