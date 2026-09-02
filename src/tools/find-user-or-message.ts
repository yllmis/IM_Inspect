import {
  Connector,
  FindUserOrMessageInputSchema,
  FindUserOrMessageResultSchema,
} from "../connectors/connector";
import type { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  unwrapConnector,
} from "./handler-utils";

export function findUserOrMessageDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "find_user_or_message",
    permission: "diagnosis:read",
    timeoutMs: 2_000,
    readOnly: true,
    inputSchema: FindUserOrMessageInputSchema,
    async run(args) {
      requireCapability(connector, "messageLookup");
      const result = parseResult(
        FindUserOrMessageResultSchema,
        unwrapConnector(
          await connector.findUserOrMessage(
            FindUserOrMessageInputSchema.parse(args),
          ),
        ),
      );
      return {
        ...result,
        matches: result.matches.slice(0, 20),
        truncated: result.truncated || result.matches.length > 20,
      };
    },
  };
}
