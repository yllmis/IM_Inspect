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
  sanitizeConnectionFact,
  unwrapConnector,
} from "./handler-utils";

export const GetConnectionStatusResultSchema = z
  .object({
    connection: ConnectionFactSchema,
    unsupportedCapabilities: z.array(z.string().min(1).max(128)).max(20),
  })
  .strict();

export function getConnectionStatusDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "get_connection_status",
    permission: "diagnosis:read_connection",
    timeoutMs: 2_000,
    maxAttempts: 2,
    maxOutputBytes: 32_000,
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
        connection: sanitizeConnectionFact(connection),
        unsupportedCapabilities: connection.historical
          ? []
          : ["historicalPresence"],
      });
    },
  };
}
