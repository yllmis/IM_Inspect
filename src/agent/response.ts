import { z } from "zod";

import {
  DiagnosisClassificationSchema,
  DiagnosisResult,
} from "../domain/diagnosis";

export const GeneratedAgentReplySchema = z
  .object({
    classification: DiagnosisClassificationSchema,
    reply: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type GeneratedAgentReply = z.infer<typeof GeneratedAgentReplySchema>;

export interface AgentResponse {
  reply: string;
  diagnosis: DiagnosisResult;
  draft?: unknown;
}

export function fallbackReply(result: DiagnosisResult): string {
  switch (result.classification) {
    case "message_not_found":
      return "未查询到该消息记录，请确认消息 ID 是否正确。";
    case "write_failed":
      return "已确认消息持久化失败，建议升级给研发排查。";
    case "not_delivered":
      return "消息已持久化，但查询范围内没有确认的投递结果，建议升级排查。";
    case "receiver_offline":
      return "已确认投递时接收者处于离线状态，建议升级排查。";
    case "ack_timeout":
      return "消息投递后未在规定时间内收到 ACK，建议升级排查。";
    case "delivered":
      return "已确认消息成功投递。";
    default:
      return result.missingInformation.length > 0
        ? `还需要补充：${result.missingInformation.join("、")}。`
        : "目前证据不足，暂时无法确定消息异常原因。";
  }
}
