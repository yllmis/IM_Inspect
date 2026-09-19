import { describe, expect, it } from "vitest";

import { buildDiagnosisInput } from "../agent/diagnosis-input";
import { createAgentSessionState } from "../agent/session-state";
import { loadFixture } from "../connectors/fake/fixture-loader";
import { diagnose } from "../domain/diagnose";
import { createInMemoryEscalationDraftStore } from "./in-memory-escalation-draft-store";
import {
  DraftProposal,
  DraftSecurityError,
  EscalationDraftService,
} from "./escalation-draft-service";

const now = new Date("2026-09-19T10:00:00Z");

function diagnosis() {
  const fixture = loadFixture("write_failed");
  const state = createAgentSessionState({
    sessionId: "session_draft",
    tenantId: "tenant_test",
    actorId: "support_test",
    issueSummary: "消息写入失败",
    problemType: "message_not_received",
    now,
  });
  return diagnose(
    buildDiagnosisInput({
      ...state,
      messageId: fixture.message.messageId,
      confirmedFacts: {
        ...state.confirmedFacts,
        message: fixture.message,
      },
      evidence: fixture.message.evidence,
    }),
  );
}

function proposal(
  result: ReturnType<typeof diagnosis>,
  summary = "请研发排查消息写入失败。",
): DraftProposal {
  return {
    messageId: "msg_write_failed",
    diagnosisResultId: "diag_write_failed_001",
    classification: result.classification,
    facts: result.facts,
    evidenceRefs: result.evidence.map((item) => item.id),
    possibleCauses: result.possibleCauses,
    missingInformation: result.missingInformation,
    unsupportedCapabilities: result.unsupportedCapabilities,
    recommendedAction: "escalate",
    summary,
    idempotencyKey: "draft-security-key-001",
  };
}

function prepareInput(
  result: ReturnType<typeof diagnosis>,
  draft: DraftProposal,
) {
  return {
    tenantId: "tenant_test",
    actorId: "support_test",
    runId: "run_draft_001",
    sessionId: "session_draft",
    sessionVersion: 3,
    issueId: "issue_draft_001",
    diagnosisResultId: "diag_write_failed_001",
    diagnosisResult: result,
    proposal: draft,
    permissions: ["escalation:draft:create"],
  };
}

function confirmInput(token: string) {
  return {
    tenantId: "tenant_test",
    actorId: "support_test",
    sessionId: "session_draft",
    sessionVersion: 3,
    confirmationToken: token,
    permissions: ["escalation:draft:create"],
  };
}

describe("EscalationDraftService", () => {
  it("requires permission and binds a ten-minute confirmation", async () => {
    const result = diagnosis();
    const draft = proposal(result);
    const service = new EscalationDraftService(
      createInMemoryEscalationDraftStore(),
      () => now,
    );
    await expect(
      service.prepare({ ...prepareInput(result, draft), permissions: [] }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    const prepared = await service.prepare(prepareInput(result, draft));
    expect(prepared.expiresAt).toBe("2026-09-19T10:10:00.000Z");
    const confirmed = await service.confirm(
      confirmInput(prepared.confirmationToken),
    );
    expect(confirmed).toMatchObject({
      reused: false,
      draft: {
        diagnosisResultId: "diag_write_failed_001",
        summary: "请研发排查消息写入失败。",
      },
    });

    const duplicate = await service.confirm(
      confirmInput(prepared.confirmationToken),
    );
    expect(duplicate).toMatchObject({ reused: true });
  });

  it("stores the reviewed snapshot so confirm cannot replace its content", async () => {
    const result = diagnosis();
    const original = proposal(result);
    const service = new EscalationDraftService(
      createInMemoryEscalationDraftStore(),
      () => now,
    );
    const prepared = await service.prepare(prepareInput(result, original));

    await expect(
      service.confirm({
        ...confirmInput(prepared.confirmationToken),
        proposal: { ...original, summary: "确认阶段偷换内容" },
      } as never),
    ).rejects.toThrow();
    const confirmed = await service.confirm(
      confirmInput(prepared.confirmationToken),
    );
    expect(confirmed.draft.summary).toBe(original.summary);
  });

  it("revokes the old token when edited content is prepared again", async () => {
    const result = diagnosis();
    const service = new EscalationDraftService(
      createInMemoryEscalationDraftStore(),
      () => now,
    );
    const first = await service.prepare(
      prepareInput(result, proposal(result, "第一版摘要")),
    );
    const second = await service.prepare(
      prepareInput(result, proposal(result, "客服修改后的摘要")),
    );
    await expect(
      service.confirm(confirmInput(first.confirmationToken)),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    const confirmed = await service.confirm(
      confirmInput(second.confirmationToken),
    );
    expect(confirmed.draft.summary).toBe("客服修改后的摘要");
  });

  it("rejects expired, cross-actor, and stale-state confirmations", async () => {
    const result = diagnosis();
    let clock = now.getTime();
    const service = new EscalationDraftService(
      createInMemoryEscalationDraftStore(),
      () => new Date(clock),
    );
    const expired = await service.prepare(
      prepareInput(result, proposal(result)),
    );
    clock += 10 * 60 * 1_000 + 1;
    await expect(
      service.confirm(confirmInput(expired.confirmationToken)),
    ).rejects.toMatchObject({
      code: "confirmation_expired",
    } satisfies Partial<DraftSecurityError>);

    clock = now.getTime();
    const current = await service.prepare(
      prepareInput(result, proposal(result)),
    );
    await expect(
      service.confirm({
        ...confirmInput(current.confirmationToken),
        actorId: "another_support",
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    await expect(
      service.confirm({
        ...confirmInput(current.confirmationToken),
        sessionVersion: 4,
      }),
    ).rejects.toMatchObject({ code: "state_changed" });
  });

  it("rejects forged confirmation and mismatched diagnosis fields", async () => {
    const result = diagnosis();
    const draft = proposal(result);
    const service = new EscalationDraftService(
      createInMemoryEscalationDraftStore(),
      () => now,
    );
    await expect(
      service.prepare({
        ...prepareInput(result, draft),
        confirmed: true,
      } as never),
    ).rejects.toThrow();
    await expect(
      service.prepare({
        ...prepareInput(result, draft),
        proposal: { ...draft, evidenceRefs: ["unknown:evidence"] },
      }),
    ).rejects.toMatchObject({ code: "diagnosis_mismatch" });
    await expect(
      service.prepare({
        ...prepareInput(result, draft),
        proposal: { ...draft, facts: ["客户端伪造的事实"] },
      }),
    ).rejects.toMatchObject({ code: "diagnosis_mismatch" });
  });
});
