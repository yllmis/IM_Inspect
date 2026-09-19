import { z } from "zod";

import { Connector } from "../connectors/connector";
import {
  ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  ToolError,
  ToolErrorCode,
} from "../domain/errors";
import {
  Permission,
  ToolContext,
  ToolFailure,
  ToolResponse,
  ToolServiceError,
  ToolSuccess,
  ToolTrace,
  ToolTraceSchema,
} from "./context";
import { createEscalationDraftDefinition } from "./create-escalation-draft";
import { createFixedConfirmationVerifier } from "./confirmation-verifier";
import { findUserOrMessageDefinition } from "./find-user-or-message";
import { getConnectionStatusDefinition } from "./get-connection-status";
import { getDeliveryEventsDefinition } from "./get-delivery-events";
import { getMessageStatusDefinition } from "./get-message-status";
import { RetryPolicy, resolveRetryPolicy, retryDelayMs } from "./retry-policy";

export const TOOL_NAMES = [
  "find_user_or_message",
  "get_message_status",
  "get_delivery_events",
  "get_connection_status",
  "create_escalation_draft",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDefinition {
  readonly name: ToolName;
  readonly permission: Permission;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly maxOutputBytes: number;
  readonly readOnly: boolean;
  readonly inputSchema: z.ZodTypeAny;
  readonly run: (args: unknown, context: ToolContext) => Promise<unknown>;
}

export interface ToolRegistryDependencies {
  connector: Connector;
  draftRepository: import("./draft-repository").DraftRepository;
  confirmationVerifier?: import("./confirmation-verifier").ConfirmationVerifier;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  retryPolicy?: Partial<RetryPolicy>;
}

export class ToolRegistry {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>;
  private readonly connectorCapabilities: ConnectorCapabilities;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly retryPolicy: RetryPolicy;

  constructor(dependencies: ToolRegistryDependencies) {
    const draftRepository = dependencies.draftRepository;
    const confirmationVerifier =
      dependencies.confirmationVerifier ?? createFixedConfirmationVerifier();
    const definitions = [
      findUserOrMessageDefinition(dependencies.connector),
      getMessageStatusDefinition(dependencies.connector),
      getDeliveryEventsDefinition(dependencies.connector),
      getConnectionStatusDefinition(dependencies.connector),
      createEscalationDraftDefinition(draftRepository, confirmationVerifier),
    ];
    this.definitions = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
    this.connectorCapabilities = ConnectorCapabilitiesSchema.parse(
      dependencies.connector.getCapabilities(),
    );
    this.now = dependencies.now ?? Date.now;
    this.sleep =
      dependencies.sleep ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.retryPolicy = resolveRetryPolicy(dependencies.retryPolicy);
  }

  getConnectorCapabilities(): ConnectorCapabilities {
    return ConnectorCapabilitiesSchema.parse(this.connectorCapabilities);
  }

  async execute<T = unknown>(
    name: string,
    rawArgs: unknown,
    context: ToolContext,
  ): Promise<ToolResponse<T>> {
    const startedAt = this.now();
    const definition = this.definitions.get(name);
    if (!definition) {
      return this.failure(
        context,
        startedAt,
        name,
        "tool_not_found",
        `tool is not allowlisted: ${name}`,
        false,
        { tool: name },
        "blocked",
      );
    }
    if (!context.permissions.has(definition.permission)) {
      return this.failure(
        context,
        startedAt,
        name,
        "permission_denied",
        `permission required: ${definition.permission}`,
        false,
        { permission: definition.permission },
        "blocked",
      );
    }
    if (context.callsUsed >= context.maxCalls) {
      return this.failure(
        context,
        startedAt,
        name,
        "rate_limited",
        "tool call limit exceeded",
        false,
        { maxCalls: context.maxCalls },
        "blocked",
      );
    }
    if (this.now() >= context.deadline) {
      return this.failure(
        context,
        startedAt,
        name,
        "timeout",
        "run deadline exceeded",
        true,
        undefined,
        "blocked",
      );
    }

    let args: unknown;
    try {
      args = definition.inputSchema.parse(rawArgs);
    } catch (error) {
      return this.failure(
        context,
        startedAt,
        name,
        "invalid_argument",
        "tool arguments failed schema validation",
        false,
        { issues: error instanceof z.ZodError ? error.issues : undefined },
        "blocked",
      );
    }

    context.callsUsed += 1;
    const cacheKey = definition.readOnly
      ? invocationCacheKey(definition.name, args)
      : null;
    const cached = cacheKey ? context.resultCache.get(cacheKey) : undefined;
    if (cached) {
      return this.cached<T>(context, startedAt, definition.name, args, cached);
    }

    let attempts = 0;
    const retryDelaysMs: number[] = [];
    while (attempts < definition.maxAttempts) {
      attempts += 1;
      try {
        const data = await this.withTimeout(
          definition.run(args, context),
          Math.min(
            definition.timeoutMs,
            Math.max(1, context.deadline - this.now()),
          ),
        );
        enforceOutputSize(data, definition.maxOutputBytes);
        const response = this.success<T>(
          context,
          startedAt,
          name,
          args,
          attempts,
          retryDelaysMs,
          data as T,
        );
        if (cacheKey) {
          context.resultCache.set(
            cacheKey,
            structuredClone(response) as ToolSuccess<unknown>,
          );
        }
        return response;
      } catch (error) {
        const normalized = normalizeError(error);
        const delayMs = definition.readOnly
          ? retryDelayMs(normalized, attempts, this.retryPolicy)
          : null;
        const canRetry =
          attempts < definition.maxAttempts &&
          delayMs !== null &&
          this.now() + delayMs < context.deadline;
        if (canRetry) {
          retryDelaysMs.push(delayMs);
          await this.sleep(delayMs);
          continue;
        }
        return this.failure(
          context,
          startedAt,
          name,
          normalized.code,
          normalized.message,
          normalized.retryable,
          normalized.details,
          "error",
          attempts,
          args,
          retryDelaysMs,
        );
      }
    }
    return this.failure(
      context,
      startedAt,
      name,
      "internal",
      "tool execution stopped unexpectedly",
      false,
      undefined,
      "error",
      attempts,
      args,
      retryDelaysMs,
    );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new ToolServiceError("timeout", "tool timed out", true)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private success<T>(
    context: ToolContext,
    startedAt: number,
    toolName: string,
    args: unknown,
    attempts: number,
    retryDelaysMs: number[],
    data: T,
  ): ToolSuccess<T> {
    const truncated = isTruncated(data);
    const meta = this.meta(
      context,
      startedAt,
      attempts,
      retryDelaysMs,
      false,
      truncated,
    );
    this.trace(context, {
      requestId: context.requestId,
      runId: context.runId,
      toolName,
      args: summarizeArgs(toolName, args),
      outcome: "success",
      resultSummary: summarizeResult(toolName, data),
      durationMs: meta.durationMs,
      attempts,
      retryDelaysMs,
      cached: false,
      truncated: meta.truncated,
    });
    return { ok: true, data, meta };
  }

  private failure(
    context: ToolContext,
    startedAt: number,
    toolName: string,
    code: ToolErrorCode,
    _message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    outcome: ToolTrace["outcome"] = "error",
    attempts = 1,
    args: unknown = {},
    retryDelaysMs: number[] = [],
  ): ToolFailure {
    const meta = this.meta(
      context,
      startedAt,
      attempts,
      retryDelaysMs,
      false,
      false,
    );
    const safeDetails = summarizeErrorDetails(code, details);
    const error: ToolError = {
      code,
      message: publicErrorMessage(code),
      retryable,
      details: safeDetails,
    };
    this.trace(context, {
      requestId: context.requestId,
      runId: context.runId,
      toolName,
      args: summarizeArgs(toolName, args),
      outcome,
      errorCode: code,
      resultSummary: safeDetails,
      durationMs: meta.durationMs,
      attempts,
      retryDelaysMs,
      cached: false,
      truncated: meta.truncated,
    });
    return { ok: false, error, meta };
  }

  private meta(
    context: ToolContext,
    startedAt: number,
    attempts: number,
    retryDelaysMs: number[],
    cached: boolean,
    truncated: boolean,
  ) {
    return {
      requestId: context.requestId,
      runId: context.runId,
      durationMs: Math.max(0, this.now() - startedAt),
      attempts,
      retryDelaysMs: [...retryDelaysMs],
      cached,
      truncated,
    };
  }

  /** 缓存命中仍生成独立 Trace，但 attempts=0，明确表示没有访问 Connector。 */
  private cached<T>(
    context: ToolContext,
    startedAt: number,
    toolName: string,
    args: unknown,
    cached: ToolSuccess<unknown>,
  ): ToolSuccess<T> {
    const data = structuredClone(cached.data) as T;
    const meta = this.meta(
      context,
      startedAt,
      0,
      [],
      true,
      cached.meta.truncated,
    );
    this.trace(context, {
      requestId: context.requestId,
      runId: context.runId,
      toolName,
      args: summarizeArgs(toolName, args),
      outcome: "cached",
      resultSummary: summarizeResult(toolName, data),
      durationMs: meta.durationMs,
      attempts: 0,
      retryDelaysMs: [],
      cached: true,
      truncated: meta.truncated,
    });
    return { ok: true, data, meta };
  }

  private trace(context: ToolContext, trace: ToolTrace) {
    context.traces.push(ToolTraceSchema.parse(trace));
  }
}

function isTruncated(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "truncated" in value &&
    (value as { truncated?: unknown }).truncated === true,
  );
}

function redact(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return redactObject(value as Record<string, unknown>);
}

function redactObject(value: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /token|password|secret|authorization|phone|body|content/i;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitive.test(key)
        ? "[REDACTED]"
        : Array.isArray(item)
          ? item.map((nested) =>
              nested && typeof nested === "object"
                ? redactObject(nested as Record<string, unknown>)
                : nested,
            )
          : item && typeof item === "object"
            ? redactObject(item as Record<string, unknown>)
            : item,
    ]),
  );
}

function summarizeResult(
  toolName: string,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: typeof value };
  }
  const result = value as Record<string, unknown>;
  switch (toolName) {
    case "find_user_or_message": {
      const matches = Array.isArray(result.matches) ? result.matches : [];
      return {
        resolutionStatus: result.resolutionStatus,
        matchCount: matches.length,
        truncated: result.truncated === true,
      };
    }
    case "get_message_status": {
      const message = asRecord(result.message);
      return {
        message: {
          messageId: message.messageId,
          exists: message.exists,
          persisted: message.persisted,
          status: message.status,
        },
      };
    }
    case "get_delivery_events": {
      const query = asRecord(result.query);
      return {
        eventCount: Array.isArray(result.events) ? result.events.length : 0,
        complete: query.complete === true,
        returnedCount: query.returnedCount,
        effectiveTimeRange: query.effectiveTimeRange,
        truncated: result.truncated === true,
      };
    }
    case "get_connection_status": {
      const connection = asRecord(result.connection);
      return {
        connection: {
          userId: connection.userId,
          state: connection.state,
          observedAt: connection.observedAt,
          historical: connection.historical,
        },
      };
    }
    case "create_escalation_draft": {
      const draft = asRecord(result.draft);
      return {
        reused: result.reused === true,
        draft: { draftId: draft.draftId, status: draft.status },
      };
    }
    default:
      return { type: "unrecognized_tool_result" };
  }
}

function summarizeArgs(
  toolName: string,
  value: unknown,
): Record<string, unknown> {
  const args = asRecord(value);
  switch (toolName) {
    case "find_user_or_message":
      return redact({
        userId: args.userId,
        hasDisplayName: typeof args.displayName === "string",
        conversationId: args.conversationId,
        messageId: args.messageId,
        timeRange: args.timeRange,
        limit: args.limit,
      });
    case "get_message_status":
      return redact({ messageId: args.messageId });
    case "get_delivery_events":
      return redact({
        messageId: args.messageId,
        timeRange: args.timeRange,
        limit: args.limit,
      });
    case "get_connection_status":
      return redact({ userId: args.userId, at: args.at });
    case "create_escalation_draft":
      return {
        messageId: args.messageId,
        classification: args.classification,
        contentHash: "[REDACTED]",
        idempotencyKey: "[REDACTED]",
      };
    default:
      return {};
  }
}

function summarizeErrorDetails(
  code: ToolErrorCode,
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  switch (code) {
    case "unsupported_capability":
      return typeof details.capability === "string"
        ? { capability: details.capability.slice(0, 128) }
        : undefined;
    case "permission_denied":
      return typeof details.permission === "string"
        ? { permission: details.permission.slice(0, 128) }
        : undefined;
    case "rate_limited":
      return {
        ...(typeof details.maxCalls === "number"
          ? { maxCalls: details.maxCalls }
          : {}),
        ...(Number.isSafeInteger(details.retryAfterMs) &&
        (details.retryAfterMs as number) > 0
          ? { retryAfterMs: details.retryAfterMs }
          : {}),
      };
    case "invalid_argument":
      return Array.isArray(details.issues)
        ? { issueCount: details.issues.length }
        : undefined;
    case "conflicting_evidence":
      return {
        expected: safeIdentifier(details.expected),
        actual: safeIdentifier(details.actual),
      };
    case "internal":
      return typeof details.maxOutputBytes === "number"
        ? { maxOutputBytes: details.maxOutputBytes }
        : undefined;
    default:
      return undefined;
  }
}

function publicErrorMessage(code: ToolErrorCode): string {
  const messages: Record<ToolErrorCode, string> = {
    invalid_argument: "tool arguments are invalid",
    tool_not_found: "the requested tool is not allowlisted",
    permission_denied: "tool permission was denied",
    not_found: "the requested record was not found",
    ambiguous_match: "the query matched multiple records",
    unsupported_capability: "the connector capability is not supported",
    conflicting_evidence: "the tool result conflicts with current evidence",
    rate_limited: "the tool rate limit was reached",
    timeout: "tool execution timed out",
    dependency_unavailable: "tool dependency is unavailable",
    confirmation_required: "human confirmation is required",
    idempotency_conflict: "the idempotency key conflicts with existing data",
    internal: "tool execution failed",
  };
  return messages[code];
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 128) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enforceOutputSize(value: unknown, maxOutputBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ToolServiceError("internal", "tool result is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes) {
    throw new ToolServiceError(
      "internal",
      "tool result exceeds the safe output limit",
      false,
      { maxOutputBytes },
    );
  }
}

function invocationCacheKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableSerialize(args)}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeError(error: unknown): ToolServiceError {
  if (error instanceof ToolServiceError) return error;
  if (error instanceof z.ZodError) {
    return new ToolServiceError(
      "internal",
      "tool returned invalid data",
      false,
      {
        issues: error.issues,
      },
    );
  }
  return new ToolServiceError("internal", "tool execution failed", false);
}
