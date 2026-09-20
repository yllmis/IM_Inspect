import { NextResponse } from "next/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { runAgent } from "../../../src/agent/agent";
import { ChatRequestSchema } from "../../../src/agent/chat-request";
import { ContextBudgetExceededError } from "../../../src/agent/context-budget";
import { TargetSwitchResolutionError } from "../../../src/agent/state-merge";
import { StateStoreError } from "../../../src/agent/state-store";
import { FakeConnector } from "../../../src/connectors/fake/fake-connector";
import {
  createMySqlPool,
  MySqlConfigurationError,
  readMySqlConnectionConfig,
} from "../../../src/persistence/mysql/connection";
import { MySqlStateStore } from "../../../src/persistence/mysql/mysql-state-store";
import { createToolContext } from "../../../src/tools/context";
import { createInMemoryDraftRepository } from "../../../src/tools/draft-repository";
import { ToolRegistry } from "../../../src/tools/registry";

let stateStore: MySqlStateStore | undefined;
const registry = new ToolRegistry({
  connector: new FakeConnector("delivered"),
  draftRepository: createInMemoryDraftRepository(),
});

export async function POST(request: Request) {
  const parsed = ChatRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "invalid_argument" }, { status: 400 });
  const baseURL = process.env.MIMO_BASE_URL;
  const apiKey = process.env.MIMO_API_KEY;
  const modelId = process.env.MIMO_MODEL ?? "mimo-v2.5-pro";
  if (!baseURL || !apiKey) {
    return NextResponse.json(
      { error: "model_not_configured" },
      { status: 503 },
    );
  }
  const provider = createOpenAICompatible({
    baseURL,
    name: "mimo",
    headers: { "api-key": apiKey },
    supportsStructuredOutputs: true,
  });
  const toolContext = createToolContext({
    requestId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    tenantId: "tenant_demo",
    actorId: "support_demo",
    permissions: [
      "diagnosis:read",
      "diagnosis:read_delivery",
      "diagnosis:read_connection",
    ],
  });
  try {
    stateStore ??= new MySqlStateStore(
      createMySqlPool(readMySqlConnectionConfig()),
    );
    const result = await runAgent({
      sessionId: parsed.data.sessionId ?? crypto.randomUUID(),
      text: parsed.data.text,
      model: provider.chatModel(modelId),
      toolContext,
      registry,
      stateStore,
      targetSwitchDecision: parsed.data.action,
    });
    return NextResponse.json({
      ...result,
      // traces 保留旧的单工具调试字段；trace 是统一的 AgentRunTrace。
      traces: toolContext.traces,
    });
  } catch (error) {
    if (error instanceof MySqlConfigurationError) {
      return NextResponse.json(
        { error: "database_not_configured" },
        { status: 503 },
      );
    }
    if (error instanceof StateStoreError && error.code === "version_conflict") {
      return NextResponse.json(
        { error: "state_version_conflict", retryable: true },
        { status: 409 },
      );
    }
    if (error instanceof TargetSwitchResolutionError) {
      return NextResponse.json(
        { error: `target_switch_${error.code}` },
        { status: 409 },
      );
    }
    if (error instanceof ContextBudgetExceededError) {
      return NextResponse.json(
        { error: "context_budget_exceeded", reason: error.code },
        { status: error.code === "max_total_tokens" ? 429 : 413 },
      );
    }
    return NextResponse.json(
      { error: "agent_execution_failed" },
      { status: 502 },
    );
  }
}
