import { z } from "zod";

export const ToolErrorCodeSchema = z.enum([
  "invalid_argument",
  "tool_not_found",
  "permission_denied",
  "not_found",
  "ambiguous_match",
  "unsupported_capability",
  "conflicting_evidence",
  "rate_limited",
  "dependency_unavailable",
  "timeout",
  "confirmation_required",
  "idempotency_conflict",
  "internal",
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ConnectorCapabilityStatusSchema = z.enum([
  "supported",
  "partial",
  "unsupported",
]);
export type ConnectorCapabilityStatus = z.infer<
  typeof ConnectorCapabilityStatusSchema
>;

export const ConnectorCapabilitiesSchema = z.record(
  ConnectorCapabilityStatusSchema,
);
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;

export const ToolErrorSchema = z
  .object({
    code: ToolErrorCodeSchema,
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  })
  .strict();
export type ToolError = z.infer<typeof ToolErrorSchema>;
