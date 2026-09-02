import { ToolContext, ToolServiceError } from "./context";

export interface ConfirmationRequest {
  contentHash: string;
  idempotencyKey: string;
}

export interface ConfirmationVerifier {
  verify(request: ConfirmationRequest, context: ToolContext): Promise<void>;
}

export function createFixedConfirmationVerifier(
  validTokens: ReadonlyMap<
    string,
    ConfirmationRequest & { actorId?: string; runId?: string }
  > = new Map(),
): ConfirmationVerifier {
  const usedTokens = new Set<string>();
  return {
    async verify(request, context) {
      const token = context.confirmationToken;
      if (!token) {
        throw new ToolServiceError(
          "confirmation_required",
          "a server-issued confirmation token is required",
        );
      }
      if (usedTokens.has(token)) {
        throw new ToolServiceError(
          "confirmation_required",
          "confirmation token has already been used",
        );
      }
      const expected = validTokens.get(token);
      if (
        !expected ||
        expected.contentHash !== request.contentHash ||
        expected.idempotencyKey !== request.idempotencyKey ||
        (expected.actorId && expected.actorId !== context.actorId) ||
        (expected.runId && expected.runId !== context.runId)
      ) {
        throw new ToolServiceError(
          "confirmation_required",
          "confirmation token does not match this draft",
        );
      }
      usedTokens.add(token);
    },
  };
}
