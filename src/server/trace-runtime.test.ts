import { describe, expect, it, vi } from "vitest";

import { getTraceStore } from "./trace-runtime";

describe("Trace runtime", () => {
  it("不同 Route 的模块副本和热重载复用同一进程内仓储", async () => {
    const original = getTraceStore();
    vi.resetModules();
    const reloaded = await import("./trace-runtime");
    expect(reloaded.getTraceStore()).toBe(original);
  });
});
