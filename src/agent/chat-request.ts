import { z } from "zod";

import { IdentifierSchema } from "../connectors/connector";
import { TargetSwitchDecisionSchema } from "./session-state";

/**
 * ChatRequest 只描述客服可以提交的内容。身份、权限和确认令牌必须由服务端认证层注入，
 * 因此这里使用 strict Schema 显式拒绝这些额外字段。
 */
export const ChatRequestSchema = z
  .object({
    sessionId: IdentifierSchema.optional(),
    text: z.string().trim().min(1).max(20_000),
    action: TargetSwitchDecisionSchema.optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
