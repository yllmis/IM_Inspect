import { z } from "zod";

export const EvidenceKindSchema = z.enum([
  "message",
  "delivery",
  "connection",
  "write",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(128),
    kind: EvidenceKindSchema,
    observedAt: z.string().datetime({ offset: true }),
    field: z.string().min(1).max(128),
    value: z.unknown(),
    metadata: z.record(z.string()).optional(),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const EvidenceConflictSchema = z
  .object({
    subject: z.string().min(1).max(256),
    evidence: z.array(EvidenceSchema).min(1),
    resolution: z.string().min(1).max(512),
  })
  .strict();
export type EvidenceConflict = z.infer<typeof EvidenceConflictSchema>;
