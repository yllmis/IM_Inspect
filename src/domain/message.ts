import { z } from "zod";

import { EvidenceSchema } from "./evidence";

export const MessageStatusSchema = z.enum([
  "created",
  "persisted",
  "queued",
  "delivering",
  "delivered",
  "acknowledged",
  "failed",
  "unknown",
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

const optionalId = z.string().min(1).max(128);
const optionalTimestamp = z.string().datetime({ offset: true });

export const MessageFactSchema = z
  .object({
    messageId: optionalId,
    conversationId: optionalId.optional(),
    senderId: optionalId.optional(),
    receiverId: optionalId.optional(),
    status: MessageStatusSchema,
    exists: z.boolean(),
    // 成功返回的 MessageFact 必须明确报告 true、false 或未知 null。
    persisted: z.boolean().nullable(),
    createdAt: optionalTimestamp.optional(),
    statusAt: optionalTimestamp.optional(),
    evidence: z.array(EvidenceSchema).max(20),
    metadata: z
      .record(z.string().max(256))
      .refine((value) => Object.keys(value).length <= 10)
      .optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (!message.exists && message.persisted === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["persisted"],
        message: "persisted cannot be true when exists is false",
      });
    }
  });
export type MessageFact = z.infer<typeof MessageFactSchema>;
