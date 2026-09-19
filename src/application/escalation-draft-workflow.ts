import { createHash } from "node:crypto";
import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { StateStore } from "../agent/state-store";
import { Permission } from "../tools/context";
import {
  DraftProposal,
  EscalationDraftService,
} from "../tools/escalation-draft-service";

export const PrepareEscalationDraftApiSchema = z
  .object({
    sessionId: IdentifierSchema,
    summary: z.string().trim().min(1).max(2000),
  })
  .strict();
export type PrepareEscalationDraftApiInput = z.infer<
  typeof PrepareEscalationDraftApiSchema
>;

export const ConfirmEscalationDraftApiSchema = z
  .object({
    sessionId: IdentifierSchema,
    confirmationToken: z.string().min(32).max(512),
  })
  .strict();
export type ConfirmEscalationDraftApiInput = z.infer<
  typeof ConfirmEscalationDraftApiSchema
>;

export interface AuthenticatedPrincipal {
  tenantId: string;
  actorId: string;
  permissions: readonly Permission[];
}

export class DraftWorkflowError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "diagnosis_not_ready"
      | "escalation_not_recommended",
    message: string,
  ) {
    super(message);
    this.name = "DraftWorkflowError";
  }
}

/**
 * Workflow 类似 Go 的 Application Service：API 只提供客服可编辑摘要，
 * 事实、分类、runId 和权限都从服务端状态与 Principal 构造。
 */
export class EscalationDraftWorkflow {
  constructor(
    private readonly stateStore: StateStore,
    private readonly draftService: EscalationDraftService,
  ) {}

  async prepare(
    raw: PrepareEscalationDraftApiInput,
    principal: AuthenticatedPrincipal,
  ) {
    const input = PrepareEscalationDraftApiSchema.parse(raw);
    const state = await this.loadState(input.sessionId, principal);
    const diagnosis = state.diagnosisResult;
    if (
      !diagnosis ||
      !state.diagnosisResultId ||
      !state.lastRunId ||
      !state.messageId ||
      !state.currentIssue.issueId
    ) {
      throw new DraftWorkflowError(
        "diagnosis_not_ready",
        "a persisted deterministic diagnosis is required",
      );
    }
    if (diagnosis.recommendedAction !== "escalate") {
      throw new DraftWorkflowError(
        "escalation_not_recommended",
        "the deterministic diagnosis does not recommend escalation",
      );
    }

    const proposal: DraftProposal = {
      messageId: state.messageId,
      conversationId: state.conversationId ?? undefined,
      diagnosisResultId: state.diagnosisResultId,
      classification: diagnosis.classification,
      facts: diagnosis.facts,
      evidenceRefs: diagnosis.evidence.map((item) => item.id),
      possibleCauses: diagnosis.possibleCauses,
      missingInformation: diagnosis.missingInformation,
      unsupportedCapabilities: diagnosis.unsupportedCapabilities,
      recommendedAction: "escalate",
      summary: input.summary,
      idempotencyKey: createIdempotencyKey(
        principal.tenantId,
        state.sessionId,
        state.currentIssue.issueId,
        state.diagnosisResultId,
      ),
    };
    return this.draftService.prepare({
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      permissions: [...principal.permissions],
      runId: state.lastRunId,
      sessionId: state.sessionId,
      sessionVersion: state.version,
      issueId: state.currentIssue.issueId,
      diagnosisResultId: state.diagnosisResultId,
      diagnosisResult: diagnosis,
      proposal,
    });
  }

  async confirm(
    raw: ConfirmEscalationDraftApiInput,
    principal: AuthenticatedPrincipal,
  ) {
    const input = ConfirmEscalationDraftApiSchema.parse(raw);
    const state = await this.loadState(input.sessionId, principal);
    return this.draftService.confirm({
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      permissions: [...principal.permissions],
      sessionId: state.sessionId,
      sessionVersion: state.version,
      confirmationToken: input.confirmationToken,
    });
  }

  private async loadState(
    sessionId: string,
    principal: AuthenticatedPrincipal,
  ) {
    const state = await this.stateStore.load({
      sessionId,
      tenantId: principal.tenantId,
      actorId: principal.actorId,
    });
    if (!state) {
      throw new DraftWorkflowError(
        "session_not_found",
        "diagnosis session does not exist",
      );
    }
    return state;
  }
}

function createIdempotencyKey(
  tenantId: string,
  sessionId: string,
  issueId: string,
  diagnosisResultId: string,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ tenantId, sessionId, issueId, diagnosisResultId }))
    .digest("hex");
  return `draft_${hash}`;
}
