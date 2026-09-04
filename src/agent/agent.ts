import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import {
  ConnectionStatusInputSchema,
  DeliveryEventsInputSchema,
  FindUserOrMessageInputSchema,
  MessageLookupInputSchema,
} from "../connectors/connector";
import { diagnose } from "../domain/diagnose";
import { DiagnosisInput, DiagnosisResult } from "../domain/diagnosis";
import { createToolContext, ToolContext, ToolResponse } from "../tools/context";
import { ToolName, ToolRegistry } from "../tools/registry";
import { CandidateContext, emptyCandidateContext } from "./extract-context";
import { fallbackReply } from "./response";
import { SYSTEM_PROMPT } from "./system-prompt";

const DraftInputSchema = z.record(z.unknown());

export interface AgentInput {
  text: string;
  model: Parameters<typeof generateText>[0]["model"];
  toolContext: ToolContext;
  registry: ToolRegistry;
  maxSteps?: number;
}

export interface AgentExecutionResult {
  status: "completed" | "awaiting_information" | "stopped" | "failed";
  reply: string;
  diagnosis: DiagnosisResult;
  candidateContext: CandidateContext;
  toolCalls: Array<{
    name: string;
    args: unknown;
    response: ToolResponse<unknown>;
  }>;
  steps: number;
  stopReason?: string;
  modelText: string;
}

export async function runAgent(
  input: AgentInput,
): Promise<AgentExecutionResult> {
  const calls: AgentExecutionResult["toolCalls"] = [];
  const cache = new Map<string, ToolResponse<unknown>>();
  const execute = async (name: ToolName, args: unknown) => {
    const key = `${name}:${JSON.stringify(args)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const response = await input.registry.execute(
      name,
      args,
      input.toolContext,
    );
    cache.set(key, response);
    calls.push({ name, args, response });
    return response;
  };

  const tools = {
    find_user_or_message: tool({
      description: "根据稳定 ID 或有限线索定位用户或消息。",
      inputSchema: FindUserOrMessageInputSchema,
      execute: (args) => execute("find_user_or_message", args),
    }),
    get_message_status: tool({
      description: "查询指定消息的持久化和当前状态。",
      inputSchema: MessageLookupInputSchema,
      execute: (args) => execute("get_message_status", args),
    }),
    get_delivery_events: tool({
      description: "查询指定消息的投递事件。",
      inputSchema: DeliveryEventsInputSchema,
      execute: (args) => execute("get_delivery_events", args),
    }),
    get_connection_status: tool({
      description: "查询接收者在指定时刻的连接事实。",
      inputSchema: ConnectionStatusInputSchema,
      execute: (args) => execute("get_connection_status", args),
    }),
    create_escalation_draft: tool({
      description: "在人工确认后保存升级单草稿，不提交事故。",
      inputSchema: DraftInputSchema,
      execute: (args) => execute("create_escalation_draft", args),
    }),
  };

  const result = await generateText({
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: input.text,
    tools,
    stopWhen: stepCountIs(input.maxSteps ?? 8),
    maxRetries: 0,
  });

  const diagnosisInput: DiagnosisInput = { rawText: input.text };
  for (const call of calls) {
    if (!call.response.ok) continue;
    const data = call.response.data as Record<string, unknown>;
    if (call.name === "get_message_status")
      diagnosisInput.message = data.message as DiagnosisInput["message"];
    if (call.name === "get_delivery_events")
      diagnosisInput.deliveries = data.events as DiagnosisInput["deliveries"];
    if (call.name === "get_connection_status")
      diagnosisInput.connection =
        data.connection as DiagnosisInput["connection"];
    if (call.name === "find_user_or_message") {
      const matches = data.matches as Array<Record<string, unknown>>;
      if (data.resolutionStatus === "unique" && matches?.[0]) {
        diagnosisInput.messageId = matches[0].messageId as string | undefined;
        diagnosisInput.userId = matches[0].userId as string | undefined;
        diagnosisInput.conversationId = matches[0].conversationId as
          string | undefined;
        diagnosisInput.matchResolution = "unique";
      } else if (data.resolutionStatus) {
        diagnosisInput.matchResolution =
          data.resolutionStatus as DiagnosisInput["matchResolution"];
      }
    }
  }
  const diagnosis = diagnose(diagnosisInput);
  const lastCall = calls.at(-1);
  const status =
    diagnosis.recommendedAction === "ask_for_more_info"
      ? "awaiting_information"
      : diagnosis.classification === "insufficient_data"
        ? "stopped"
        : "completed";
  return {
    status,
    reply: result.text || fallbackReply(diagnosis),
    diagnosis,
    candidateContext: emptyCandidateContext(),
    toolCalls: calls,
    steps: result.steps.length,
    stopReason: lastCall && !lastCall.response.ok ? "tool_error" : undefined,
    modelText: result.text,
  };
}

export { createToolContext };
