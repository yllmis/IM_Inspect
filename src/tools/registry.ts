import { z } from "zod";

import { Connector } from "../connectors/connector";
import { ToolError, ToolErrorCode } from "../domain/errors";
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
    this.now = dependencies.now ?? Date.now;
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
      args: redact(args),
      outcome: "success",
      resultSummary: summarize(data),
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
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    outcome: ToolTrace["outcome"] = "error",
    attempts = 1,
    args: unknown = {},
  ): ToolFailure {
    const meta = this.meta(context, startedAt, attempts, false);
    const error: ToolError = { code, message, retryable, details };
    this.trace(context, {
      requestId: context.requestId,
      runId: context.runId,
      toolName,
      args: redact(args),
      outcome,
      errorCode: code,
      resultSummary: details ? redact(details) : undefined,
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

function summarize(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: typeof value };
  }
  const summary: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "message" && item && typeof item === "object") {
      const message = item as Record<string, unknown>;
      summary.message = {
        messageId: message.messageId,
        exists: message.exists,
        persisted: message.persisted,
        status: message.status,
      };
    } else if (Array.isArray(item)) {
      summary[key] = { count: item.length };
    } else if (key === "draft" && item && typeof item === "object") {
      const draft = item as Record<string, unknown>;
      summary.draft = { draftId: draft.draftId, status: draft.status };
    } else {
      summary[key] = item;
    }
  }
  return redact(summary);
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
