import { DiagnosisResult } from "../domain/diagnosis";

export type AgentStopReason =
  | "diagnosed"
  | "ask_for_information"
  | "max_steps"
  | "max_calls"
  | "deadline"
  | "tool_error"
  | "no_progress";

export interface StopRuleInput {
  steps: number;
  maxSteps: number;
  callsUsed: number;
  maxCalls: number;
  deadline: number;
  now?: number;
  diagnosis?: DiagnosisResult;
  repeatedCall?: boolean;
  toolError?: boolean;
}

export interface StopDecision {
  stop: boolean;
  reason?: AgentStopReason;
}

export function evaluateStopRules(input: StopRuleInput): StopDecision {
  if (input.steps >= input.maxSteps) return { stop: true, reason: "max_steps" };
  if (input.callsUsed >= input.maxCalls)
    return { stop: true, reason: "max_calls" };
  if ((input.now ?? Date.now()) >= input.deadline)
    return { stop: true, reason: "deadline" };
  if (input.toolError) return { stop: true, reason: "tool_error" };
  if (input.repeatedCall) return { stop: true, reason: "no_progress" };
  if (input.diagnosis?.recommendedAction === "ask_for_more_info") {
    return { stop: true, reason: "ask_for_information" };
  }
  if (
    input.diagnosis &&
    input.diagnosis.classification !== "insufficient_data"
  ) {
    return { stop: true, reason: "diagnosed" };
  }
  return { stop: false };
}
