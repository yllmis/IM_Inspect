import { describe, expect, it, vi } from "vitest";

import type { ToolRegistry } from "../tools/registry";
import {
  ToolRegistryRuntime,
  readCapabilityRefreshMs,
} from "./tool-registry-runtime";

function fakeRegistry(): ToolRegistry {
  return {} as ToolRegistry;
}

describe("ToolRegistryRuntime", () => {
  it("能力声明到期后重新创建 Connector，而不是永久复用旧快照", async () => {
    let now = 0;
    const createRegistry = vi
      .fn<() => Promise<ToolRegistry>>()
      .mockResolvedValueOnce(fakeRegistry())
      .mockResolvedValueOnce(fakeRegistry());
    const runtime = new ToolRegistryRuntime({
      refreshMs: 1_000,
      now: () => now,
      createRegistry,
    });

    await runtime.get();
    await runtime.get();
    expect(createRegistry).toHaveBeenCalledTimes(1);

    now = 1_001;
    await runtime.get();
    expect(createRegistry).toHaveBeenCalledTimes(2);
  });

  it("创建失败不会缓存失败 Promise，下一次请求可以重试", async () => {
    const createRegistry = vi
      .fn<() => Promise<ToolRegistry>>()
      .mockRejectedValueOnce(new Error("tunnel down"))
      .mockResolvedValueOnce(fakeRegistry());
    const runtime = new ToolRegistryRuntime({
      createRegistry,
      refreshMs: 60_000,
    });

    await expect(runtime.get()).rejects.toThrow("tunnel down");
    await expect(runtime.get()).resolves.toBeDefined();
    expect(createRegistry).toHaveBeenCalledTimes(2);
  });

  it("限制能力刷新配置，避免误配造成频繁探测", () => {
    expect(readCapabilityRefreshMs(undefined)).toBe(15_000);
    expect(readCapabilityRefreshMs("0")).toBe(0);
    expect(readCapabilityRefreshMs("60000")).toBe(60_000);
    expect(() => readCapabilityRefreshMs("-1")).toThrow();
    expect(() => readCapabilityRefreshMs("1.5")).toThrow();
  });
});
