import { describe, expect, it } from "vitest";

import { buildDiagnosisInput } from "../agent/diagnosis-input";
import {
  AgentSessionStateSchema,
  createAgentSessionState,
} from "../agent/session-state";
import { InMemoryStateStore } from "../agent/state-store";
import { loadFixture } from "../connectors/fake/fixture-loader";
import { diagnose } from "../domain/diagnose";
import { EscalationDraftService } from "../tools/escalation-draft-service";
import { createInMemoryEscalationDraftStore } from "../tools/in-memory-escalation-draft-store";
import {
  ConfirmEscalationDraftApiSchema,
  EscalationDraftWorkflow,
  PrepareEscalationDraftApiSchema,
} from "./escalation-draft-workflow";

const now = new Date("2026-09-19T10:00:00Z");
const principal = {
  tenantId: "tenant_test",
  actorId: "support_test",
  permissions: ["escalation:draft:create" as const],
};

async function readyWorkflow() {
  const fixture = loadFixture("write_failed");
  const initial = createAgentSessionState({
    sessionId: "session_workflow",
    tenantId: principal.tenantId,
    actorId: principal.actorId,
    issueSummary: "消息写入失败",
    now,
  });
  const diagnosedState = {
    ...initial,
    messageId: fixture.message.messageId,
    confirmedFacts: {
      ...initial.confirmedFacts,
      message: fixture.message,
    },
    evidence: fixture.message.evidence,
  };
  const result = diagnose(buildDiagnosisInput(diagnosedState));
  const state = AgentSessionStateSchema.parse({
    ...diagnosedState,
    diagnosisResultId: "diag_workflow_001",
    diagnosisResult: result,
    lastRunId: "run_workflow_001",
  });
  const stateStore = new InMemoryStateStore({ now: () => now.getTime() });
  await stateStore.create(state);
  const workflow = new EscalationDraftWorkflow(
    stateStore,
    new EscalationDraftService(createInMemoryEscalationDraftStore(), () => now),
  );
  return { workflow, stateStore, state };
}

describe("EscalationDraftWorkflow", () => {
  it("builds trusted fields from StateStore and only accepts an editable summary", async () => {
    const { workflow } = await readyWorkflow();
    const prepared = await workflow.prepare(
      { sessionId: "session_workflow", summary: "客服确认后的升级摘要" },
      principal,
    );
    expect(prepared.proposal).toMatchObject({
      messageId: "msg_write_failed",
      diagnosisResultId: "diag_workflow_001",
      classification: "write_failed",
      summary: "客服确认后的升级摘要",
    });
    const confirmed = await workflow.confirm(
      {
        sessionId: "session_workflow",
        confirmationToken: prepared.confirmationToken,
      },
      principal,
    );
    expect(confirmed).toMatchObject({ reused: false });
  });

  it("rejects client-forged identity, permission, diagnosis, and confirmed fields", () => {
    expect(() =>
      PrepareEscalationDraftApiSchema.parse({
        sessionId: "session_workflow",
        summary: "摘要",
        actorId: "admin",
        permissions: ["admin:all"],
        classification: "delivered",
        confirmed: true,
      }),
    ).toThrow();
    expect(() =>
      ConfirmEscalationDraftApiSchema.parse({
        sessionId: "session_workflow",
        confirmationToken: "x".repeat(32),
        confirmed: true,
      }),
    ).toThrow();
  });

  it("rejects an old confirmation after the session version changes", async () => {
    const { workflow, stateStore, state } = await readyWorkflow();
    const prepared = await workflow.prepare(
      { sessionId: state.sessionId, summary: "准备确认" },
      principal,
    );
    await stateStore.save(
      AgentSessionStateSchema.parse({
        ...state,
        currentIssue: { ...state.currentIssue, summary: "状态已经变化" },
      }),
      state.version,
    );
    await expect(
      workflow.confirm(
        {
          sessionId: state.sessionId,
          confirmationToken: prepared.confirmationToken,
        },
        principal,
      ),
    ).rejects.toMatchObject({ code: "state_changed" });
  });

  it("requires a deterministic diagnosis that recommends escalation", async () => {
    const state = createAgentSessionState({
      sessionId: "session_empty",
      tenantId: principal.tenantId,
      actorId: principal.actorId,
      issueSummary: "未知问题",
      now,
    });
    const store = new InMemoryStateStore({ now: () => now.getTime() });
    await store.create(state);
    const workflow = new EscalationDraftWorkflow(
      store,
      new EscalationDraftService(createInMemoryEscalationDraftStore()),
    );
    await expect(
      workflow.prepare(
        { sessionId: state.sessionId, summary: "不能直接升级" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "diagnosis_not_ready" });
  });
});
