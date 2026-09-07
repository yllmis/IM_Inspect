import { z } from "zod";

import { Connector, MessageLookupInputSchema } from "../connectors/connector";
import { MessageFactSchema } from "../domain/message";
import type { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  unwrapConnector,
} from "./handler-utils";

export const GetMessageStatusResultSchema = z
  .object({
    message: MessageFactSchema,
    unsupportedCapabilities: z.array(z.string()),
  })
  .strict();

export function getMessageStatusDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "get_message_status",
    permission: "diagnosis:read",
    timeoutMs: 2_000,
    readOnly: true,
    inputSchema: MessageLookupInputSchema,
    async run(args) {
      requireCapability(connector, "messageLookup");
      const message = unwrapConnector(
        await connector.getMessageStatus(MessageLookupInputSchema.parse(args)),
      );
      return parseResult(GetMessageStatusResultSchema, {
        message,
        unsupportedCapabilities: [],
      });
    },
  };
}
