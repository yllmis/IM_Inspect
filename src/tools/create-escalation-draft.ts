import { z } from "zod";
import { createHash } from "node:crypto";

import { DiagnosisClassificationSchema } from "../domain/diagnosis";
import { IdentifierSchema } from "../connectors/connector";
import { ToolServiceError } from "./context";
import { ConfirmationVerifier } from "./confirmation-verifier";
import {
  DraftRecord,
  DraftRecordSchema,
  DraftRepository,
} from "./draft-repository";
import type { ToolDefinition } from "./registry";

export const CreateEscalationDraftInputSchema = z
  .object({
    messageId: IdentifierSchema,
    conversationId: IdentifierSchema.optional(),
    classification: DiagnosisClassificationSchema,
    facts: z.array(z.string().max(500)).max(20),
    evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(50),
    possibleCauses: z.array(z.string().max(500)).max(10).default([]),
    missingInformation: z.array(z.string().max(500)).max(20).default([]),
    unsupportedCapabilities: z.array(z.string().max(100)).max(20).default([]),
    recommendedAction: z.literal("escalate"),
    summary: z.string().min(1).max(2000),
    idempotencyKey: z.string().trim().min(16).max(128),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CreateEscalationDraftInput = z.infer<
  typeof CreateEscalationDraftInputSchema
>;

export function computeDraftContentHash(
  input: Omit<CreateEscalationDraftInput, "contentHash" | "idempotencyKey">,
): string {
  const canonical = JSON.stringify({
    messageId: input.messageId,
    conversationId: input.conversationId ?? null,
    classification: input.classification,
    facts: input.facts,
    evidenceRefs: input.evidenceRefs,
    possibleCauses: input.possibleCauses,
    missingInformation: input.missingInformation,
    unsupportedCapabilities: input.unsupportedCapabilities,
    recommendedAction: input.recommendedAction,
    summary: input.summary,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function createEscalationDraftDefinition(
  repository: DraftRepository,
  verifier: ConfirmationVerifier,
): ToolDefinition {
  return {
    name: "create_escalation_draft",
    permission: "escalation:draft:create",
    timeoutMs: 3_000,
    maxOutputBytes: 128_000,
    readOnly: false,
    inputSchema: CreateEscalationDraftInputSchema,
    async run(args, context) {
      const input = CreateEscalationDraftInputSchema.parse(args);
      const expectedHash = computeDraftContentHash(input);
      if (expectedHash !== input.contentHash) {
        throw new ToolServiceError(
          "invalid_argument",
          "contentHash does not match the normalized draft content",
          false,
          { expectedHash },
        );
      }
      if (input.classification === "delivered") {
        throw new ToolServiceError(
          "invalid_argument",
          "delivered messages cannot create an escalation draft",
        );
      }
      const existing = await repository.findByIdempotency(
        context.tenantId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.contentHash !== input.contentHash) {
          throw new ToolServiceError(
            "idempotency_conflict",
            "idempotency key is already bound to different content",
          );
        }
        return { draft: existing, reused: true };
      }
      await verifier.verify(
        {
          contentHash: input.contentHash,
          idempotencyKey: input.idempotencyKey,
        },
        context,
      );
      const draft: DraftRecord = DraftRecordSchema.parse({
        draftId: `draft_${context.runId}_${input.idempotencyKey.slice(0, 8)}`,
        tenantId: context.tenantId,
        actorId: context.actorId,
        runId: context.runId,
        messageId: input.messageId,
        conversationId: input.conversationId,
        classification: input.classification,
        facts: input.facts,
        evidenceRefs: input.evidenceRefs,
        possibleCauses: input.possibleCauses,
        missingInformation: input.missingInformation,
        unsupportedCapabilities: input.unsupportedCapabilities,
        summary: input.summary,
        contentHash: input.contentHash,
        idempotencyKey: input.idempotencyKey,
        status: "draft",
        createdAt: new Date().toISOString(),
      });
      try {
        await repository.create(draft);
      } catch {
        const raced = await repository.findByIdempotency(
          context.tenantId,
          input.idempotencyKey,
        );
        if (raced?.contentHash === input.contentHash) {
          return { draft: raced, reused: true };
        }
        throw new ToolServiceError(
          "idempotency_conflict",
          "idempotency key is already bound to different content",
        );
      }
      return { draft, reused: false };
    },
  };
}
