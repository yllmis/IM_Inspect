import { z } from "zod";

import { EvidenceSchema } from "./evidence";

export const DeliveryStatusSchema = z.enum([
  "attempted",
  "success",
  "failed",
  "timeout",
  "unknown",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

// The Go IM contract calls this value DeliveryResult. Keep both names while the
// TypeScript domain uses the clearer status terminology.
export const DeliveryResultSchema = DeliveryStatusSchema;
export type DeliveryResult = DeliveryStatus;

export const DeliveryFactSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    receiverId: z.string().min(1).max(128).optional(),
    attemptId: z.string().min(1).max(128).optional(),
    attemptedAt: z.string().datetime({ offset: true }).optional(),
    result: DeliveryStatusSchema,
    deliveredAt: z.string().datetime({ offset: true }).optional(),
    ackedAt: z.string().datetime({ offset: true }).optional(),
    errorCode: z.string().min(1).max(128).optional(),
    evidence: z.array(EvidenceSchema),
    metadata: z.record(z.string()).optional(),
  })
  .strict()
  .superRefine((delivery, context) => {
    if (delivery.result === "success" && !delivery.deliveredAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveredAt"],
        message: "successful delivery requires deliveredAt",
      });
    }
    if (delivery.result === "failed" && !delivery.errorCode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "failed delivery requires errorCode",
      });
    }
  });
export type DeliveryFact = z.infer<typeof DeliveryFactSchema>;
