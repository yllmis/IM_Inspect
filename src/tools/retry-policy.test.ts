import { describe, expect, it } from "vitest";

import { ToolServiceError } from "./context";
import { resolveRetryPolicy, retryDelayMs } from "./retry-policy";

describe("retryDelayMs", () => {
  const policy = resolveRetryPolicy({
    baseBackoffMs: 100,
    maxBackoffMs: 250,
    maxRetryAfterMs: 1_000,
  });

  it.each([
    [1, 100],
    [2, 200],
    [3, 250],
  ])("uses capped exponential backoff after attempt %i", (attempt, delay) => {
    expect(
      retryDelayMs(
        new ToolServiceError(
          "dependency_unavailable",
          "temporary failure",
          true,
        ),
        attempt,
        policy,
      ),
    ).toBe(delay);
  });

  it("uses trusted retryAfterMs only within the configured bound", () => {
    expect(
      retryDelayMs(
        new ToolServiceError("rate_limited", "limited", true, {
          retryAfterMs: 500,
        }),
        1,
        policy,
      ),
    ).toBe(500);
    expect(
      retryDelayMs(
        new ToolServiceError("rate_limited", "limited", true, {
          retryAfterMs: 1_001,
        }),
        1,
        policy,
      ),
    ).toBeNull();
  });

  it.each(["invalid_argument", "permission_denied", "internal"] as const)(
    "never retries %s",
    (code) => {
      expect(
        retryDelayMs(
          new ToolServiceError(code, "permanent failure", false),
          1,
          policy,
        ),
      ).toBeNull();
    },
  );
});
