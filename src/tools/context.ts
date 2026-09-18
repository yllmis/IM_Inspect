import { z } from "zod";

import { ToolError, ToolErrorCode } from "../domain/errors";

export const PermissionSchema = z.string().min(1).max(128);
export type Permission = z.infer<typeof PermissionSchema>;

export const ToolTraceSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    args: z.record(z.unknown()),
    outcome: z.enum(["success", "error", "blocked", "cached"]),
    errorCode: z.string().optional(),
    resultSummary: z.record(z.unknown()).optional(),
    durationMs: z.number().int().nonnegative(),
    // attempts 只计算真正访问 Connector 的次数；缓存命中没有下游调用，所以是 0。
    attempts: z.number().int().nonnegative(),
    retryDelaysMs: z.array(z.number().int().nonnegative()).max(10),
    cached: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
export type ToolTrace = z.infer<typeof ToolTraceSchema>;

export interface ToolContext {
  readonly requestId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly deadline: number;
  readonly maxCalls: number;
  readonly traces: ToolTrace[];
  /** Run-local dedup cache：只复用本次 Agent Run 中成功的只读工具结果。 */
  readonly resultCache: Map<string, ToolSuccess<unknown>>;
  readonly confirmationToken?: string;
  callsUsed: number;
}

export interface ToolResponseMeta {
  requestId: string;
  runId: string;
  durationMs: number;
  attempts: number;
  retryDelaysMs: number[];
  cached: boolean;
  truncated: boolean;
}

export interface ToolSuccess<T> {
  ok: true;
  data: T;
  meta: ToolResponseMeta;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
  meta: ToolResponseMeta;
}

export type ToolResponse<T> = ToolSuccess<T> | ToolFailure;

export class ToolServiceError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ToolErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolServiceError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function createToolContext(input: {
  requestId: string;
  runId: string;
  tenantId: string;
  actorId: string;
  permissions: Iterable<Permission>;
  deadline?: number;
  maxCalls?: number;
  confirmationToken?: string;
}): ToolContext {
  const now = Date.now();
  return {
    requestId: input.requestId,
    runId: input.runId,
    tenantId: input.tenantId,
    actorId: input.actorId,
    permissions: new Set(input.permissions),
    deadline: input.deadline ?? now + 10_000,
    maxCalls: input.maxCalls ?? 6,
    traces: [],
    resultCache: new Map(),
    confirmationToken: input.confirmationToken,
    callsUsed: 0,
  };
}
