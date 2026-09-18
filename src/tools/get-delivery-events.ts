import { z } from "zod";

import {
  Connector,
  DeliveryEventsInputSchema,
  DeliveryEventsPageSchema,
  DeliveryTimeRangeSchema,
  SourceReferenceSchema,
} from "../connectors/connector";
import { DeliveryFactSchema } from "../domain/delivery";
import { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  sanitizeDeliveryFact,
  unwrapConnectorWithSource,
} from "./handler-utils";

export const GetDeliveryEventsResultSchema = z
  .object({
    events: z.array(DeliveryFactSchema).max(50),
    query: z
      .object({
        complete: z.boolean(),
        effectiveTimeRange: DeliveryTimeRangeSchema,
        returnedCount: z.number().int().min(0).max(50),
        source: z.string().min(1).max(128),
        sourceReference: SourceReferenceSchema,
      })
      .strict(),
    unsupportedCapabilities: z.array(z.string().min(1).max(128)).max(20),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.query.returnedCount !== result.events.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query", "returnedCount"],
        message: "returnedCount must match the bounded event list",
      });
    }
    if (result.query.complete && result.truncated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query", "complete"],
        message: "a truncated delivery result cannot be complete",
      });
    }
  });

export function getDeliveryEventsDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "get_delivery_events",
    permission: "diagnosis:read_delivery",
    timeoutMs: 3_000,
    maxAttempts: 2,
    maxOutputBytes: 256_000,
    readOnly: true,
    inputSchema: DeliveryEventsInputSchema,
    async run(args) {
      const input = DeliveryEventsInputSchema.parse(args);
      requireCapability(connector, "deliveryEvents");
      const connectorResult = unwrapConnectorWithSource(
        await connector.getDeliveryEvents(input),
      );
      const page = DeliveryEventsPageSchema.parse(connectorResult.data);
      const boundedEvents = page.events
        .slice(0, input.limit)
        .map(sanitizeDeliveryFact);
      const truncated = page.truncated || page.events.length > input.limit;
      const coversRequestedRange =
        !input.timeRange ||
        (Date.parse(page.effectiveTimeRange.start) ===
          Date.parse(input.timeRange.start) &&
          Date.parse(page.effectiveTimeRange.end) ===
            Date.parse(input.timeRange.end));
      return parseResult(GetDeliveryEventsResultSchema, {
        events: boundedEvents,
        query: {
          complete: page.complete && !truncated && coversRequestedRange,
          effectiveTimeRange: page.effectiveTimeRange,
          returnedCount: boundedEvents.length,
          source: connectorResult.source,
          sourceReference: page.sourceReference,
        },
        unsupportedCapabilities: [],
        truncated,
      });
    },
  };
}
