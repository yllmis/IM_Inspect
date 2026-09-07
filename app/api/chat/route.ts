import { NextResponse } from "next/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

import { runAgent } from "../../../src/agent/agent";
import {
  InMemoryStateStore,
  StateStoreError,
} from "../../../src/agent/state-store";
import { IdentifierSchema } from "../../../src/connectors/connector";
import { FakeConnector } from "../../../src/connectors/fake/fake-connector";
import { createToolContext } from "../../../src/tools/context";
import { createInMemoryDraftRepository } from "../../../src/tools/draft-repository";
import { ToolRegistry } from "../../../src/tools/registry";

const RequestSchema = z
  .object({
    sessionId: IdentifierSchema.optional(),
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();

// 仅用于本地 MVP。进程重启或 Serverless 实例切换会丢失状态；
// 接入真实客服环境时替换为实现 StateStore 的持久化存储。
const stateStore = new InMemoryStateStore();
const registry = new ToolRegistry({
  connector: new FakeConnector("delivered"),
  draftRepository: createInMemoryDraftRepository(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(
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
    const result = await runAgent({
      sessionId: parsed.data.sessionId ?? crypto.randomUUID(),
      text: parsed.data.text,
      model: provider.chatModel(modelId),
      toolContext,
      registry,
      stateStore,
    });
    return NextResponse.json({ ...result, traces: toolContext.traces });
  } catch (error) {
    if (error instanceof StateStoreError && error.code === "version_conflict") {
      return NextResponse.json(
        { error: "state_version_conflict", retryable: true },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "agent_execution_failed" },
      { status: 502 },
    );
  }
}
