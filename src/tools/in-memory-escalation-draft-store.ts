import { DiagnosisResultSchema } from "../domain/diagnosis";
import { DraftRecord, DraftRecordSchema } from "./draft-repository";
import {
  ConfirmationRecord,
  ConfirmationRecordSchema,
  draftFromConfirmation,
  DraftSecurityError,
  EscalationDraftStore,
} from "./escalation-draft-service";

/** 测试用事务替身：同步 Map 操作模拟确认消费与草稿保存的原子边界。 */
export function createInMemoryEscalationDraftStore(): EscalationDraftStore {
  const confirmations = new Map<string, ConfirmationRecord>();
  const drafts = new Map<string, DraftRecord>();
  return {
    async prepare({ snapshot, confirmation: raw }) {
      DiagnosisResultSchema.parse(snapshot.result);
      const confirmation = ConfirmationRecordSchema.parse(raw);
      for (const existing of confirmations.values()) {
        if (
          existing.tenantId === confirmation.tenantId &&
          existing.actorId === confirmation.actorId &&
          existing.runId === confirmation.runId &&
          existing.idempotencyKey === confirmation.idempotencyKey &&
          !existing.usedAt
        ) {
          existing.revokedAt = confirmation.createdAt;
        }
      }
      confirmations.set(confirmation.tokenHash, confirmation);
    },
    async confirmAndCreateDraft(input) {
      const confirmation = confirmations.get(input.tokenHash);
      if (!confirmation) {
        throw new DraftSecurityError(
          "confirmation_required",
          "confirmation token is invalid",
        );
      }
      if (
        confirmation.tenantId !== input.expected.tenantId ||
        confirmation.actorId !== input.expected.actorId ||
        confirmation.sessionId !== input.expected.sessionId
      ) {
        throw new DraftSecurityError(
          "confirmation_required",
          "confirmation does not belong to this session",
        );
      }
      if (confirmation.sessionVersion !== input.expected.sessionVersion) {
        throw new DraftSecurityError(
          "state_changed",
          "session changed after confirmation was prepared",
        );
      }
      if (confirmation.revokedAt) {
        throw new DraftSecurityError(
          "confirmation_required",
          "confirmation was revoked",
        );
      }
      if (Date.parse(confirmation.expiresAt) <= input.now.getTime()) {
        throw new DraftSecurityError(
          "confirmation_expired",
          "confirmation has expired",
        );
      }
      const draft = draftFromConfirmation(confirmation);
      const key = `${draft.tenantId}:${draft.idempotencyKey}`;
      const existing = drafts.get(key);
      if (existing) {
        if (existing.contentHash !== draft.contentHash) {
          throw new DraftSecurityError(
            "idempotency_conflict",
            "idempotency key is bound to different content",
          );
        }
        confirmation.usedAt ??= input.now.toISOString();
        return { draft: DraftRecordSchema.parse(existing), reused: true };
      }
      if (confirmation.usedAt) {
        throw new DraftSecurityError(
          "confirmation_replayed",
          "confirmation was already used",
        );
      }
      drafts.set(key, draft);
      confirmation.usedAt = input.now.toISOString();
      return { draft, reused: false };
    },
  };
}
