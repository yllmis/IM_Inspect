import { z } from "zod";

import { Connector } from "../connectors/connector";
import {
  ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  ToolError,
  ToolErrorCode,
} from "../domain/errors";
import {
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
  readonly permission: string;
  readonly timeoutMs: number;
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
}

export class ToolRegistry {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>;
  private readonly connectorCapabilities: ConnectorCapabilities;
  private readonly now: () => number;

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
        "invalid_argument",
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
        true,
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
    let attempts = 0;
    while (attempts < (definition.readOnly ? 2 : 1)) {
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
        return this.success<T>(
          context,
          startedAt,
          name,
          args,
          attempts,
          data as T,
        );
      } catch (error) {
        const normalized = normalizeError(error);
        const canRetry =
          definition.readOnly &&
          attempts < 2 &&
          ["dependency_unavailable", "timeout", "rate_limited"].includes(
            normalized.code,
          ) &&
          this.now() < context.deadline;
        if (canRetry) continue;
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
    data: T,
  ): ToolSuccess<T> {
    const truncated = isTruncated(data);
    const meta = this.meta(context, startedAt, attempts, truncated);
    this.trace(context, {
      requestId: context.requestId,
      runId: context.runId,
      toolName,
      args: summarizeArgs(toolName, args),
      outcome: "success",
      resultSummary: summarizeResult(toolName, data),
      durationMs: meta.durationMs,
      attempts,
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
  ): ToolFailure {
    const meta = this.meta(context, startedAt, attempts, false);
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
      truncated: meta.truncated,
    });
    return { ok: false, error, meta };
  }

  private meta(
    context: ToolContext,
    startedAt: number,
    attempts: number,
    truncated: boolean,
  ) {
    return {
      requestId: context.requestId,
      runId: context.runId,
      durationMs: Math.max(0, this.now() - startedAt),
      attempts,
      truncated,
    };
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
      return typeof details.maxCalls === "number"
        ? { maxCalls: details.maxCalls }
        : undefined;
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
    permission_denied: "tool permission was denied",
    not_found: "the requested record was not found",
    ambiguous_match: "the query matched multiple records",
    unsupported_capability: "the connector capability is not supported",
    conflicting_evidence: "the tool result conflicts with current evidence",
    rate_limited: "tool call limit was exceeded",
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
