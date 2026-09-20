import { InMemoryTraceStore } from "../agent/trace-store";

// MVP 使用进程内 TraceStore；接口已隔离，部署到多实例时替换为 MySQL 实现。
let traceStore: InMemoryTraceStore | undefined;

export function getTraceStore(): InMemoryTraceStore {
  traceStore ??= new InMemoryTraceStore();
  return traceStore;
}
