import { z } from "zod";

import { ToolServiceError } from "./context";

export interface RetryPolicy {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseBackoffMs: 100,
  maxBackoffMs: 1_000,
  maxRetryAfterMs: 1_000,
};

const RetryPolicySchema = z
  .object({
    baseBackoffMs: z.number().int().positive().max(60_000),
    maxBackoffMs: z.number().int().positive().max(60_000),
    maxRetryAfterMs: z.number().int().positive().max(60_000),
  })
  .strict()
  .refine((policy) => policy.baseBackoffMs <= policy.maxBackoffMs, {
    message: "baseBackoffMs cannot exceed maxBackoffMs",
  });

export function resolveRetryPolicy(
  override: Partial<RetryPolicy> = {},
): RetryPolicy {
  return RetryPolicySchema.parse({ ...DEFAULT_RETRY_POLICY, ...override });
}

/**
 * RetryPolicy 是 ToolRegistry 的确定性重试边界：模型不能决定是否重试或等待多久。
 * 第一版不加随机 jitter，保证 Fake Connector 和单元测试可重复。
 */
export function retryDelayMs(
  error: ToolServiceError,
  completedAttempts: number,
  policy: RetryPolicy,
): number | null {
  if (!error.retryable) return null;

  if (error.code === "rate_limited") {
    const retryAfterMs = readRetryAfterMs(error.details);
    if (retryAfterMs === null || retryAfterMs > policy.maxRetryAfterMs) {
      return null;
    }
    return retryAfterMs;
  }

  if (!["dependency_unavailable", "timeout"].includes(error.code)) {
    return null;
  }

  return Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * 2 ** Math.max(0, completedAttempts - 1),
  );
}

function readRetryAfterMs(details?: Record<string, unknown>): number | null {
  const value = details?.retryAfterMs;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}
