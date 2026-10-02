import { InMemoryTraceStore } from "../agent/trace-store";

// Next.js 各 Route 可能单独打包模块，模块级变量无法跨 Route 共享。
// MVP 单进程用 globalThis 共享仓储；重启恢复和多实例部署仍需持久化实现。
const runtime = globalThis as typeof globalThis & {
  __imInspectTraceStore?: InMemoryTraceStore;
};

export function getTraceStore(): InMemoryTraceStore {
  runtime.__imInspectTraceStore ??= new InMemoryTraceStore();
  return runtime.__imInspectTraceStore;
}
