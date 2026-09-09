import { z } from "zod";

export const EvidenceKindSchema = z.enum([
  "message",
  "delivery",
  "connection",
  "write",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

// Evidence stores a bounded canonical value, never an arbitrary database row
// or raw log object. The opaque id/source pair is the reference for audits.
export const EvidenceValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const EvidenceSchema = z
  .object({
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(128),
    kind: EvidenceKindSchema,
    observedAt: z.string().datetime({ offset: true }),
    field: z.string().min(1).max(128),
    value: EvidenceValueSchema,
    metadata: z
      .record(z.string().max(256))
      .refine((value) => Object.keys(value).length <= 10, {
        message: "evidence metadata cannot contain more than 10 fields",
      })
      .optional(),
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
