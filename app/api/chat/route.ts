import { NextResponse } from "next/server";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

import { FakeConnector } from "../../../src/connectors/fake/fake-connector";
import { createToolContext } from "../../../src/tools/context";
import { createInMemoryDraftRepository } from "../../../src/tools/draft-repository";
import { ToolRegistry } from "../../../src/tools/registry";
import { runAgent } from "../../../src/agent/agent";

const RequestSchema = z
  .object({ text: z.string().trim().min(1).max(20_000) })
  .strict();

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
      "escalation:draft:create",
    ],
  });
  const result = await runAgent({
    text: parsed.data.text,
    model: provider.chatModel(modelId),
    toolContext,
    registry: new ToolRegistry({
      connector: new FakeConnector("delivered"),
      draftRepository: createInMemoryDraftRepository(),
    }),
  });
  return NextResponse.json({ ...result, traces: toolContext.traces });
}
