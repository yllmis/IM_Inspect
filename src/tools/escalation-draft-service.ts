import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import {
  DiagnosisClassificationSchema,
  DiagnosisResult,
  DiagnosisResultSchema,
} from "../domain/diagnosis";
import {
  computeDraftContentHash,
  CreateEscalationDraftInput,
} from "./create-escalation-draft";
import { Permission } from "./context";
import { DraftRecord, DraftRecordSchema } from "./draft-repository";

export const DraftProposalSchema = z
  .object({
    messageId: IdentifierSchema,
    conversationId: IdentifierSchema.optional(),
    diagnosisResultId: IdentifierSchema,
    classification: DiagnosisClassificationSchema,
    facts: z.array(z.string().max(500)).max(20),
    evidenceRefs: z.array(z.string().min(1).max(256)).min(1).max(50),
    possibleCauses: z.array(z.string().max(500)).max(10).default([]),
    missingInformation: z.array(z.string().max(500)).max(20).default([]),
    unsupportedCapabilities: z.array(z.string().max(100)).max(20).default([]),
    recommendedAction: z.literal("escalate"),
    summary: z.string().trim().min(1).max(2000),
    idempotencyKey: z.string().trim().min(16).max(128),
  })
  .strict();
export type DraftProposal = z.infer<typeof DraftProposalSchema>;

/** 服务端可信请求：身份、权限和诊断结果都不能来自浏览器 JSON。 */
export const PrepareDraftRequestSchema = z
  .object({
    tenantId: IdentifierSchema,
    actorId: IdentifierSchema,
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionVersion: z.number().int().positive(),
    issueId: IdentifierSchema,
    diagnosisResultId: IdentifierSchema,
    diagnosisResult: DiagnosisResultSchema,
    proposal: DraftProposalSchema,
    permissions: z.array(z.string()).max(20),
  })
  .strict();
export type PrepareDraftRequest = z.infer<typeof PrepareDraftRequestSchema>;

/** Confirm 只接收令牌和服务端身份；草稿内容从待确认快照读取。 */
export const ConfirmDraftRequestSchema = z
  .object({
    tenantId: IdentifierSchema,
    actorId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionVersion: z.number().int().positive(),
    confirmationToken: z.string().min(32).max(512),
    permissions: z.array(z.string()).max(20),
  })
  .strict();
export type ConfirmDraftRequest = z.infer<typeof ConfirmDraftRequestSchema>;

export interface DiagnosisSnapshot {
  diagnosisResultId: string;
  tenantId: string;
  actorId: string;
  sessionId: string;
  issueId: string;
  runId: string;
  result: DiagnosisResult;
  createdAt: string;
}

export interface ConfirmationRecord {
  confirmationId: string;
  tokenHash: string;
  tenantId: string;
  actorId: string;
  runId: string;
  sessionId: string;
  sessionVersion: number;
  diagnosisResultId: string;
  contentHash: string;
  idempotencyKey: string;
  proposal: DraftProposal;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const ConfirmationRecordSchema = z
  .object({
    confirmationId: IdentifierSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    tenantId: IdentifierSchema,
    actorId: IdentifierSchema,
    runId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionVersion: z.number().int().positive(),
    diagnosisResultId: IdentifierSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(16).max(128),
    proposal: DraftProposalSchema,
    expiresAt: z.string().datetime({ offset: true }),
    usedAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface EscalationDraftStore {
  /** 诊断快照和待确认记录必须原子保存，不能留下断裂的审计链。 */
  prepare(input: {
    snapshot: DiagnosisSnapshot;
    confirmation: ConfirmationRecord;
  }): Promise<void>;
  /** 消费令牌和创建草稿必须在同一事务内完成。 */
  confirmAndCreateDraft(input: {
    tokenHash: string;
    now: Date;
    expected: {
      tenantId: string;
      actorId: string;
      sessionId: string;
      sessionVersion: number;
    };
  }): Promise<{ draft: DraftRecord; reused: boolean }>;
}

export class DraftSecurityError extends Error {
  constructor(
    readonly code:
      | "permission_denied"
      | "confirmation_required"
      | "confirmation_expired"
      | "confirmation_replayed"
      | "idempotency_conflict"
      | "diagnosis_mismatch"
      | "state_changed",
    message: string,
  ) {
    super(message);
    this.name = "DraftSecurityError";
  }
}

export class EscalationDraftService {
  constructor(
    private readonly store: EscalationDraftStore,
    private readonly now: () => Date = () => new Date(),
    private readonly confirmationTtlMs = 10 * 60 * 1_000,
  ) {}

  async prepare(raw: PrepareDraftRequest) {
    const input = PrepareDraftRequestSchema.parse(raw);
    this.requirePermission(input.permissions);
    const proposal = validateProposal(
      input.proposal,
      input.diagnosisResult,
      input.diagnosisResultId,
    );
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const confirmation = ConfirmationRecordSchema.parse({
      confirmationId: `confirm_${randomUUID()}`,
      tokenHash: hashToken(token),
      tenantId: input.tenantId,
      actorId: input.actorId,
      runId: input.runId,
      sessionId: input.sessionId,
      sessionVersion: input.sessionVersion,
      diagnosisResultId: input.diagnosisResultId,
      contentHash: computeDraftContentHash(toCreateInput(proposal)),
      idempotencyKey: proposal.idempotencyKey,
      proposal,
      expiresAt: new Date(now.getTime() + this.confirmationTtlMs).toISOString(),
      usedAt: null,
      revokedAt: null,
      createdAt: now.toISOString(),
    });
    await this.store.prepare({
      snapshot: {
        diagnosisResultId: input.diagnosisResultId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        issueId: input.issueId,
        runId: input.runId,
        result: input.diagnosisResult,
        createdAt: now.toISOString(),
      },
      confirmation,
    });
    return {
      confirmationToken: token,
      expiresAt: confirmation.expiresAt,
      contentHash: confirmation.contentHash,
      proposal,
    };
  }

  async confirm(raw: ConfirmDraftRequest) {
    const input = ConfirmDraftRequestSchema.parse(raw);
    this.requirePermission(input.permissions);
    return this.store.confirmAndCreateDraft({
      tokenHash: hashToken(input.confirmationToken),
      now: this.now(),
      expected: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        sessionVersion: input.sessionVersion,
      },
    });
  }

  private requirePermission(permissions: string[]) {
    if (!permissions.includes("escalation:draft:create" satisfies Permission)) {
      throw new DraftSecurityError(
        "permission_denied",
        "draft permission is required",
      );
    }
  }
}

function validateProposal(
  proposal: DraftProposal,
  diagnosis: DiagnosisResult,
  diagnosisResultId: string,
): DraftProposal {
  if (diagnosisResultId !== proposal.diagnosisResultId) {
    throw new DraftSecurityError(
      "diagnosis_mismatch",
      "diagnosis result id does not match proposal",
    );
  }
  if (
    diagnosis.recommendedAction !== "escalate" ||
    diagnosis.classification !== proposal.classification ||
    !sameStrings(diagnosis.facts, proposal.facts) ||
    !sameStrings(
      diagnosis.evidence.map((item) => item.id),
      proposal.evidenceRefs,
    ) ||
    !sameStrings(diagnosis.possibleCauses, proposal.possibleCauses) ||
    !sameStrings(diagnosis.missingInformation, proposal.missingInformation) ||
    !sameStrings(
      diagnosis.unsupportedCapabilities,
      proposal.unsupportedCapabilities,
    ) ||
    (diagnosis.message !== undefined &&
      diagnosis.message.messageId !== proposal.messageId)
  ) {
    throw new DraftSecurityError(
      "diagnosis_mismatch",
      "proposal does not match deterministic diagnosis",
    );
  }
  return proposal;
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function toCreateInput(
  proposal: DraftProposal,
): Omit<CreateEscalationDraftInput, "contentHash"> {
  return {
    messageId: proposal.messageId,
    conversationId: proposal.conversationId,
    diagnosisResultId: proposal.diagnosisResultId,
    classification: proposal.classification,
    facts: proposal.facts,
    evidenceRefs: proposal.evidenceRefs,
    possibleCauses: proposal.possibleCauses,
    missingInformation: proposal.missingInformation,
    unsupportedCapabilities: proposal.unsupportedCapabilities,
    recommendedAction: proposal.recommendedAction,
    summary: proposal.summary,
    idempotencyKey: proposal.idempotencyKey,
  };
}

export function draftFromConfirmation(
  confirmation: ConfirmationRecord,
): DraftRecord {
  const proposal = confirmation.proposal;
  return DraftRecordSchema.parse({
    draftId: `draft_${confirmation.runId}_${confirmation.idempotencyKey.slice(0, 8)}`,
    tenantId: confirmation.tenantId,
    actorId: confirmation.actorId,
    runId: confirmation.runId,
    diagnosisResultId: proposal.diagnosisResultId,
    messageId: proposal.messageId,
    conversationId: proposal.conversationId,
    classification: proposal.classification,
    facts: proposal.facts,
    evidenceRefs: proposal.evidenceRefs,
    possibleCauses: proposal.possibleCauses,
    missingInformation: proposal.missingInformation,
    unsupportedCapabilities: proposal.unsupportedCapabilities,
    summary: proposal.summary,
    contentHash: confirmation.contentHash,
    idempotencyKey: proposal.idempotencyKey,
    status: "draft",
    createdAt: confirmation.createdAt,
  });
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
