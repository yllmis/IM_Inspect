import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { ToolError, ToolErrorCode } from "../domain/errors";

// 权限是服务端认证主体的属性，不接受模型或客服文本动态创建权限。
export const PermissionSchema = z.enum([
  "diagnosis:read",
  "diagnosis:read_delivery",
  "diagnosis:read_connection",
  "escalation:draft:create",
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const ConnectorRequestContextSchema = z
  .object({
    tenantId: IdentifierSchema,
    actorId: IdentifierSchema,
    requestId: IdentifierSchema,
    runId: IdentifierSchema,
  })
  .strict();
export type ConnectorRequestContext = z.infer<
  typeof ConnectorRequestContextSchema
>;

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
  const allowedKeys = new Set([
    "requestId",
    "runId",
    "tenantId",
    "actorId",
    "permissions",
    "deadline",
    "maxCalls",
    "confirmationToken",
  ]);
  if (
    Object.keys(input as Record<string, unknown>).some(
      (key) => !allowedKeys.has(key),
    )
  ) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.unrecognized_keys,
        keys: Object.keys(input as Record<string, unknown>).filter(
          (key) => !allowedKeys.has(key),
        ),
        path: [],
        message: "unrecognized server context field",
      },
    ]);
  }
  const now = Date.now();
  const deadline = input.deadline ?? now + 10_000;
  const maxCalls = input.maxCalls ?? 6;
  const parsed = z
    .object({
      requestId: IdentifierSchema,
      runId: IdentifierSchema,
      tenantId: IdentifierSchema,
      actorId: IdentifierSchema,
      permissions: z.array(PermissionSchema).max(4),
      deadline: z.number().finite().int().positive(),
      maxCalls: z.number().int().min(1).max(20),
      confirmationToken: z.string().min(1).max(512).optional(),
    })
    .strict()
    .parse({
      requestId: input.requestId,
      runId: input.runId,
      tenantId: input.tenantId,
      actorId: input.actorId,
      permissions: [...new Set(input.permissions)],
      deadline,
      maxCalls,
      confirmationToken: input.confirmationToken,
    });
  return {
    requestId: parsed.requestId,
    runId: parsed.runId,
    tenantId: parsed.tenantId,
    actorId: parsed.actorId,
    permissions: new Set(parsed.permissions),
    deadline: parsed.deadline,
    maxCalls: parsed.maxCalls,
    traces: [],
    resultCache: new Map(),
    confirmationToken: parsed.confirmationToken,
    callsUsed: 0,
  };
}

/** 只把服务端上下文传给 Connector；模型参数不会进入租户和操作者身份。 */
export function connectorRequestContext(
  context: ToolContext,
): ConnectorRequestContext {
  return ConnectorRequestContextSchema.parse({
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestId: context.requestId,
    runId: context.runId,
  });
}
