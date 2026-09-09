import {
  Connector,
  FindUserOrMessageInputSchema,
  FindUserOrMessageResultSchema,
} from "../connectors/connector";
import type { ToolDefinition } from "./registry";
import {
  parseResult,
  requireCapability,
  sanitizeEvidence,
  unwrapConnector,
} from "./handler-utils";

export function findUserOrMessageDefinition(
  connector: Connector,
): ToolDefinition {
  return {
    name: "find_user_or_message",
    permission: "diagnosis:read",
    timeoutMs: 2_000,
    maxOutputBytes: 64_000,
    readOnly: true,
    inputSchema: FindUserOrMessageInputSchema,
    async run(args) {
      const input = FindUserOrMessageInputSchema.parse(args);
      requireCapability(connector, "messageLookup");
      const result = parseResult(
        FindUserOrMessageResultSchema,
        unwrapConnector(await connector.findUserOrMessage(input)),
      );
      const matches = result.matches.slice(0, input.limit).map((match) => ({
        entityType: match.entityType,
        userId: match.userId,
        conversationId: match.conversationId,
        messageId: match.messageId,
        observedAt: match.observedAt,
        // displayName 可能是个人信息；第一版结果只保留稳定 ID。
        evidence: match.evidence.map(sanitizeEvidence),
      }));
      return {
        ...result,
        matches,
        truncated: result.truncated || result.matches.length > input.limit,
      };
    },
  };
}
