import { z } from "zod";

import { Connector, DeliveryEventsInputSchema } from "../connectors/connector";
import { DeliveryFactSchema } from "../domain/delivery";
import { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  unwrapConnector,
} from "./handler-utils";

const resultSchema = z
  .object({
    events: z.array(DeliveryFactSchema).max(50),
    unsupportedCapabilities: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

export function getDeliveryEventsDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "get_delivery_events",
    permission: "diagnosis:read_delivery",
    timeoutMs: 3_000,
    readOnly: true,
    inputSchema: DeliveryEventsInputSchema,
    async run(args) {
      requireCapability(connector, "deliveryEvents");
      const events = unwrapConnector(
        await connector.getDeliveryEvents(
          DeliveryEventsInputSchema.parse(args),
        ),
      );
      const truncated = events.length > 50;
      return parseResult(resultSchema, {
        events: events.slice(0, 50),
        unsupportedCapabilities: [],
        truncated,
      });
    },
  };
}
