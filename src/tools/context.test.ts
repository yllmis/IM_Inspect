import { describe, expect, it } from "vitest";

import { connectorRequestContext, createToolContext } from "./context";

const base = {
  requestId: "req_context",
  runId: "run_context",
  tenantId: "tenant_context",
  actorId: "support_context",
  permissions: ["diagnosis:read"] as const,
};

describe("server-owned ToolContext", () => {
  it("accepts only the fixed permission set and bounds execution controls", () => {
    const context = createToolContext({ ...base, maxCalls: 6 });
    expect(context.permissions).toEqual(new Set(["diagnosis:read"]));
    expect(context.maxCalls).toBe(6);
    expect(connectorRequestContext(context)).toEqual({
      tenantId: "tenant_context",
      actorId: "support_context",
      requestId: "req_context",
      runId: "run_context",
    });
  });

  it("rejects a permission not issued by the server", () => {
    expect(() =>
      createToolContext({
        ...base,
        permissions: ["admin:all" as never],
      }),
    ).toThrow();
  });

  it.each([
    { maxCalls: 0 },
    { maxCalls: 21 },
    { deadline: Number.POSITIVE_INFINITY },
  ])("rejects unsafe execution controls: %o", (override) => {
    expect(() => createToolContext({ ...base, ...override })).toThrow();
  });

  it("does not accept extra identity or permission fields", () => {
    expect(() =>
      createToolContext({
        ...base,
        actorId: "support_context",
        permissions: ["diagnosis:read"],
        tenantRole: "admin",
      } as never),
    ).toThrow();
  });
});
