import { z } from "zod";

import { ConnectionFact, ConnectionFactSchema } from "../domain/connection";
import { DeliveryFact, DeliveryFactSchema } from "../domain/delivery";
import {
  ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  ToolError,
  ToolErrorSchema,
} from "../domain/errors";
import { MessageFact, MessageFactSchema } from "../domain/message";

export const MessageLookupInputSchema = z
  .object({ messageId: z.string().min(1).max(128) })
  .strict();
export type MessageLookupInput = z.infer<typeof MessageLookupInputSchema>;

export const DeliveryEventsInputSchema = z
  .object({
    messageId: z.string().min(1).max(128),
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
      .optional(),
  })
  .strict();
export type DeliveryEventsInput = z.infer<typeof DeliveryEventsInputSchema>;

export const ConnectionStatusInputSchema = z
  .object({
    userId: z.string().min(1).max(128),
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
  getMessageStatus(
    input: MessageLookupInput,
  ): Promise<ConnectorResult<MessageFact>>;
  getDeliveryEvents(
    input: DeliveryEventsInput,
  ): Promise<ConnectorResult<DeliveryFact[]>>;
  getConnectionStatus(
    input: ConnectionStatusInput,
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
