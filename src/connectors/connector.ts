import { z } from "zod";

import { ConnectionFact, ConnectionFactSchema } from "../domain/connection";
import { DeliveryFactSchema } from "../domain/delivery";
import {
  ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  ToolError,
  ToolErrorSchema,
} from "../domain/errors";
import { EvidenceSchema } from "../domain/evidence";
import { MessageFact, MessageFactSchema } from "../domain/message";
import type { ConnectorRequestContext } from "../tools/context";

export const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      }),
    { message: "identifier cannot contain control characters" },
  );

export const SourceReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, {
    message: "source reference must be an opaque identifier",
  });

export const DeliveryTimeRangeSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(({ start, end }) => Date.parse(start) < Date.parse(end), {
    message: "start must be before end",
    path: ["end"],
  })
  .refine(
    ({ start, end }) => Date.parse(end) - Date.parse(start) <= 86_400_000,
    { message: "timeRange cannot exceed 24 hours", path: ["end"] },
  );

export const FindUserOrMessageInputSchema = z
  .object({
    userId: IdentifierSchema.optional(),
    displayName: z.string().min(1).max(100).optional(),
    conversationId: IdentifierSchema.optional(),
    messageId: IdentifierSchema.optional(),
    timeRange: z
      .object({
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
      })
      .strict()
      .refine(({ start, end }) => Date.parse(start) < Date.parse(end), {
        message: "start must be before end",
        path: ["end"],
      })
      .refine(
        ({ start, end }) =>
          Date.parse(end) - Date.parse(start) <= 7 * 86_400_000,
        { message: "timeRange cannot exceed 7 days", path: ["end"] },
      )
      .optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict()
  .refine(
    ({ userId, displayName, conversationId, messageId }) =>
      Boolean(userId || displayName || conversationId || messageId),
    { message: "at least one lookup selector is required" },
  );
export type FindUserOrMessageInput = z.infer<
  typeof FindUserOrMessageInputSchema
>;

export const FindMatchSchema = z
  .object({
    entityType: z.enum(["user", "message"]),
    userId: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(100).optional(),
    conversationId: z.string().min(1).max(128).optional(),
    messageId: z.string().min(1).max(128).optional(),
    observedAt: z.string().datetime({ offset: true }),
    evidence: z.array(EvidenceSchema).max(20),
  })
  .strict();
export type FindMatch = z.infer<typeof FindMatchSchema>;

export const FindUserOrMessageResultSchema = z
  .object({
    resolutionStatus: z.enum([
      "unique",
      "multiple",
      "none",
      "insufficient_data",
    ]),
    matches: z.array(FindMatchSchema).max(20),
    truncated: z.boolean(),
  })
  .strict();
export type FindUserOrMessageResult = z.infer<
  typeof FindUserOrMessageResultSchema
>;

export const MessageLookupInputSchema = z
  .object({ messageId: IdentifierSchema })
  .strict();
export type MessageLookupInput = z.infer<typeof MessageLookupInputSchema>;

export const DeliveryEventsInputSchema = z
  .object({
    messageId: IdentifierSchema,
    timeRange: DeliveryTimeRangeSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type DeliveryEventsInput = z.input<typeof DeliveryEventsInputSchema>;

export const DeliveryEventsPageSchema = z
  .object({
    events: z.array(DeliveryFactSchema).max(50),
    complete: z.boolean(),
    truncated: z.boolean(),
    effectiveTimeRange: DeliveryTimeRangeSchema,
    sourceReference: SourceReferenceSchema,
  })
  .strict()
  .superRefine((page, context) => {
    if (page.complete && page.truncated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["complete"],
        message: "a truncated delivery query cannot be complete",
      });
    }
  });
export type DeliveryEventsPage = z.infer<typeof DeliveryEventsPageSchema>;

export const ConnectionStatusInputSchema = z
  .object({
    userId: IdentifierSchema,
    at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConnectionStatusInput = z.infer<typeof ConnectionStatusInputSchema>;

export const ConnectorSuccessSchema = z
  .object({
    ok: z.literal(true),
    source: z.string().min(1).max(128),
    data: z.unknown(),
  })
  .strict();

export const ConnectorFailureSchema = z
  .object({
    ok: z.literal(false),
    source: z.string().min(1).max(128),
    error: ToolErrorSchema,
  })
  .strict();

export type ConnectorResult<T> =
  | { ok: true; source: string; data: T }
  | { ok: false; source: string; error: ToolError };

export interface Connector {
  getCapabilities(): ConnectorCapabilities;
  findUserOrMessage(
    input: FindUserOrMessageInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<FindUserOrMessageResult>>;
  getMessageStatus(
    input: MessageLookupInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<MessageFact>>;
  getDeliveryEvents(
    input: DeliveryEventsInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<DeliveryEventsPage>>;
  getConnectionStatus(
    input: ConnectionStatusInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<ConnectionFact>>;
}

export const ConnectorCapabilitiesResultSchema = z.object({
  capabilities: ConnectorCapabilitiesSchema,
});

export const ConnectorFactsSchema = z.object({
  message: MessageFactSchema,
  deliveries: z.array(DeliveryFactSchema),
  connection: ConnectionFactSchema.nullable(),
});
