import { z } from "zod";

import {
  Connector,
  ConnectionStatusInputSchema,
} from "../connectors/connector";
import { ConnectionFactSchema } from "../domain/connection";
import type { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  unwrapConnector,
} from "./handler-utils";

export const GetConnectionStatusResultSchema = z
  .object({
    connection: ConnectionFactSchema,
    unsupportedCapabilities: z.array(z.string()),
  })
  .strict();

export function getConnectionStatusDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "get_connection_status",
    permission: "diagnosis:read_connection",
    timeoutMs: 2_000,
    readOnly: true,
    inputSchema: ConnectionStatusInputSchema,
    async run(args) {
      requireCapability(connector, "historicalPresence");
      const connection = unwrapConnector(
        await connector.getConnectionStatus(
          ConnectionStatusInputSchema.parse(args),
        ),
      );
      return parseResult(GetConnectionStatusResultSchema, {
        connection,
        unsupportedCapabilities: connection.historical
          ? []
          : ["historicalPresence"],
      });
    },
  };
}
