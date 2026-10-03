import { ToolRegistry } from "../tools/registry";
import { createInMemoryDraftRepository } from "../tools/draft-repository";
import { createConnectorFromEnvironment } from "./connector-runtime";

export interface ToolRegistryRuntimeOptions {
  /**
   * 能力声明刷新间隔。Connector 启动时会读取一次能力，但不能因为一次网络
   * 故障就永久缓存“全部不支持”；到期后重新创建 Connector 进行探测。
   */
  refreshMs?: number;
  now?: () => number;
  createRegistry?: () => Promise<ToolRegistry>;
}

/**
 * 负责 Route 进程内的 Connector/ToolRegistry 生命周期。
 * 这不是诊断事实缓存：它只缓存工具对象，并按 TTL 重新探测 Go IM 能力。
 */
export class ToolRegistryRuntime {
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly createRegistry: () => Promise<ToolRegistry>;
  private registryPromise?: Promise<ToolRegistry>;
  private createdAt = 0;

  constructor(options: ToolRegistryRuntimeOptions = {}) {
    this.refreshMs = Math.max(0, options.refreshMs ?? 15_000);
    this.now = options.now ?? Date.now;
    this.createRegistry =
      options.createRegistry ??
      (async () => {
        const connector = await createConnectorFromEnvironment();
        return new ToolRegistry({
          connector,
          draftRepository: createInMemoryDraftRepository(),
        });
      });
  }

  get(): Promise<ToolRegistry> {
    const expired = this.now() - this.createdAt >= this.refreshMs;
    if (!this.registryPromise || expired) {
      this.createdAt = this.now();
      const next = this.createRegistry();
      // 失败不能留在缓存中；下一次请求应当立即允许修复地址、隧道或 Token 后重试。
      this.registryPromise = next.catch((error) => {
        this.registryPromise = undefined;
        this.createdAt = 0;
        throw error;
      });
    }
    return this.registryPromise;
  }

  /** 测试和开发热更新使用；不会触碰 Go IM 或任何业务数据。 */
  reset(): void {
    this.registryPromise = undefined;
    this.createdAt = 0;
  }
}

export function readCapabilityRefreshMs(
  value: string | undefined,
  fallback = 15_000,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 86_400_000) {
    throw new Error(
      "GO_IM_CAPABILITY_REFRESH_MS must be an integer between 0 and 86400000",
    );
  }
  return parsed;
}
