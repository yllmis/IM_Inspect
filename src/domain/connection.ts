import { z } from "zod";

import { EvidenceSchema } from "./evidence";

export const ConnectionStateSchema = z.enum(["online", "offline", "unknown"]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const ConnectionFactSchema = z
  .object({
    userId: z.string().min(1).max(128),
    state: ConnectionStateSchema,
    observedAt: z.string().datetime({ offset: true }).optional(),
    connectionId: z.string().min(1).max(128).optional(),
    historical: z.boolean(),
    evidence: z.array(EvidenceSchema),
    metadata: z.record(z.string()).optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.historical && !connection.observedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedAt"],
        message: "historical connection facts require observedAt",
      });
    }
  });
export type ConnectionFact = z.infer<typeof ConnectionFactSchema>;
