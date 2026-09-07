import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ConnectorResult } from "../connectors/connector";
import { FakeConnector } from "../connectors/fake/fake-connector";
import { DiagnosisClassification } from "../domain/diagnosis";
import { MessageFact } from "../domain/message";
import { createToolContext } from "../tools/context";
import { createInMemoryDraftRepository } from "../tools/draft-repository";
import { ToolRegistry } from "../tools/registry";
import { runAgent } from "./agent";
import { InMemoryStateStore } from "./state-store";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: 0,
  },
};

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function extraction(messageId: string | null) {
  return textResult(
    JSON.stringify({
      messageId,
      userId: null,
      conversationId: null,
      timeRange: null,
      problemType: "message_not_received",
    }),
  );
}

function responseResult(
  classification: DiagnosisClassification,
  reply: string,
) {
  return textResult(JSON.stringify({ classification, reply }));
}

function testRuntime(connector = new FakeConnector("delivered")) {
  const timestamp = Date.parse("2026-09-07T08:00:00Z");
  const store = new InMemoryStateStore({ now: () => timestamp });
  const registry = new ToolRegistry({
    connector,
    draftRepository: createInMemoryDraftRepository(),
    now: () => timestamp,
  });
  const context = (runId: string) =>
    createToolContext({
      requestId: `request_${runId}`,
      runId,
      tenantId: "tenant_test",
      actorId: "support_test",
      permissions: [
        "diagnosis:read",
        "diagnosis:read_delivery",
        "diagnosis:read_connection",
      ],
      deadline: timestamp + 10_000,
    });
  return {
    timestamp,
    store,
    registry,
    context,
    now: () => new Date(timestamp),
  };
}

describe("runAgent stateful loop", () => {
  it("merges validated tool facts, diagnoses deterministically and persists state", async () => {
    const runtime = testRuntime();
    const model = new MockLanguageModelV4({
      doGenerate: [
        extraction("msg_delivered"),
        toolCallResult("call_message", "get_message_status", {
          messageId: "msg_delivered",
        }),
        toolCallResult("call_delivery", "get_delivery_events", {
          messageId: "msg_delivered",
        }),
        responseResult("message_not_found", "这条消息不存在。"),
      ],
    });

    const result = await runAgent({
      sessionId: "session_delivered",
      text: "用户说消息 msg_delivered 没收到",
      model,
      toolContext: runtime.context("run_delivered"),
      registry: runtime.registry,
      stateStore: runtime.store,
      now: runtime.now,
    });

    expect(result).toMatchObject({
      sessionId: "session_delivered",
      stateVersion: 2,
      status: "completed",
      reply: "已确认消息成功投递。",
      diagnosis: { classification: "delivered" },
      candidateContext: { messageId: "msg_delivered" },
      steps: 2,
      stopReason: "diagnosed",
      modelText: "",
    });
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "get_message_status",
      "get_delivery_events",
    ]);

    const saved = await runtime.store.load({
      sessionId: "session_delivered",
      tenantId: "tenant_test",
      actorId: "support_test",
    });
    expect(saved).toMatchObject({
      version: 2,
      messageId: "msg_delivered",
      status: "completed",
      confirmedFacts: {
        message: { messageId: "msg_delivered", persisted: true },
        deliveries: [{ messageId: "msg_delivered", result: "success" }],
      },
      diagnosisResult: { classification: "delivered" },
    });

    const exposedToolNames = model.doGenerateCalls[1]?.tools?.map(
      (definition) => definition.name,
    );
    expect(exposedToolNames).toEqual([
      "find_user_or_message",
      "get_message_status",
      "get_delivery_events",
      "get_connection_status",
    ]);
    expect(exposedToolNames).not.toContain("create_escalation_draft");
  });

  it("keeps only working state across turns and reuses the same session", async () => {
    const runtime = testRuntime();
    const firstModel = new MockLanguageModelV4({
      doGenerate: [
        extraction(null),
        textResult("需要 messageId"),
        textResult("请提供需要排查的 messageId。"),
      ],
    });

    const first = await runAgent({
      sessionId: "session_multi_turn",
      text: "用户说有一条消息没收到",
      model: firstModel,
      toolContext: runtime.context("run_first"),
      registry: runtime.registry,
      stateStore: runtime.store,
      now: runtime.now,
    });
    expect(first).toMatchObject({
      stateVersion: 2,
      status: "awaiting_information",
      diagnosis: {
        classification: "insufficient_data",
        missingInformation: ["messageId"],
      },
    });

    const secondModel = new MockLanguageModelV4({
      doGenerate: [
        extraction("msg_delivered"),
        toolCallResult("call_message_second", "get_message_status", {
          messageId: "msg_delivered",
        }),
        toolCallResult("call_delivery_second", "get_delivery_events", {
          messageId: "msg_delivered",
        }),
        responseResult("delivered", "消息 msg_delivered 已成功投递。"),
      ],
    });
    const second = await runAgent({
      sessionId: "session_multi_turn",
      text: "messageId 是 msg_delivered",
      model: secondModel,
      toolContext: runtime.context("run_second"),
      registry: runtime.registry,
      stateStore: runtime.store,
      now: runtime.now,
    });

    expect(second).toMatchObject({
      stateVersion: 3,
      status: "completed",
      diagnosis: { classification: "delivered" },
      candidateContext: { messageId: "msg_delivered" },
    });
    const saved = await runtime.store.load({
      sessionId: "session_multi_turn",
      tenantId: "tenant_test",
      actorId: "support_test",
    });
    expect(saved).not.toHaveProperty("messages");
    expect(saved).not.toHaveProperty("chatHistory");
    expect(saved?.currentIssue.summary).toBe("用户说有一条消息没收到");
    expect(saved?.pendingQuestion).toBeNull();
  });

  it("records a timeout as a tool error without creating a message fact", async () => {
    class TimeoutConnector extends FakeConnector {
      override async getMessageStatus(): Promise<ConnectorResult<MessageFact>> {
        return {
          ok: false,
          source: "fixture:timeout",
          error: {
            code: "timeout",
            message: "message query timed out",
            retryable: true,
          },
        };
      }
    }

    const runtime = testRuntime(new TimeoutConnector("delivered"));
    const model = new MockLanguageModelV4({
      doGenerate: [
        extraction("msg_delivered"),
        toolCallResult("call_timeout", "get_message_status", {
          messageId: "msg_delivered",
        }),
        responseResult(
          "insufficient_data",
          "消息状态查询超时，目前不能判断消息是否存在。",
        ),
      ],
    });

    const result = await runAgent({
      sessionId: "session_timeout",
      text: "查询 msg_delivered",
      model,
      toolContext: runtime.context("run_timeout"),
      registry: runtime.registry,
      stateStore: runtime.store,
      now: runtime.now,
    });

    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "tool_error",
      diagnosis: {
        classification: "insufficient_data",
        missingInformation: ["messageId"],
        toolErrors: [
          { tool: "get_message_status", error: { code: "timeout" } },
        ],
      },
    });
    const saved = await runtime.store.load({
      sessionId: "session_timeout",
      tenantId: "tenant_test",
      actorId: "support_test",
    });
    expect(saved?.confirmedFacts.message).toBeNull();
    expect(saved?.toolErrors).toMatchObject([
      { tool: "get_message_status", error: { code: "timeout" } },
    ]);
  });

  it("deduplicates a repeated tool call and stops without calling the connector twice", async () => {
    const connector = new FakeConnector("delivered");
    const runtime = testRuntime(connector);
    const model = new MockLanguageModelV4({
      doGenerate: [
        extraction("msg_delivered"),
        toolCallResult("call_message_once", "get_message_status", {
          messageId: "msg_delivered",
        }),
        toolCallResult("call_message_again", "get_message_status", {
          messageId: "msg_delivered",
        }),
        responseResult(
          "insufficient_data",
          "消息状态已查到，但还缺少投递事件。",
        ),
      ],
    });

    const result = await runAgent({
      sessionId: "session_repeated_call",
      text: "查询 msg_delivered",
      model,
      toolContext: runtime.context("run_repeated"),
      registry: runtime.registry,
      stateStore: runtime.store,
      now: runtime.now,
    });

    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "no_progress",
      diagnosis: {
        classification: "insufficient_data",
        missingInformation: ["deliveryEvents"],
      },
      toolCalls: [{ cached: false }, { cached: true }],
    });
    expect(
      connector.calls.filter((call) => call.operation === "getMessageStatus"),
    ).toHaveLength(1);

    const saved = await runtime.store.load({
      sessionId: "session_repeated_call",
      tenantId: "tenant_test",
      actorId: "support_test",
    });
    expect(saved?.calledTools.map((call) => call.outcome)).toEqual([
      "success",
      "cached",
    ]);
  });
});
