import { z } from "zod";

// proto-loader 使用 longs:String，避免 UnixNano 在 JS number 中丢失精度；测试也允许传 number。
const LongSchema = z
  .union([z.string(), z.number().int()])
  .refine((value) => /^-?\d+$/.test(String(value)), "invalid UnixNano")
  .transform(String);
const OptionalLongSchema = LongSchema.optional().default("0");

export const RawUserReferenceSchema = z
  .object({
    userId: z.string(),
    displayName: z.string().optional().default(""),
    status: z.number().int().optional().default(0),
    observedAt: OptionalLongSchema,
  })
  .passthrough();
export type RawUserReference = z.infer<typeof RawUserReferenceSchema>;

export const RawFindUserReferenceResponseSchema = z
  .object({ users: z.array(RawUserReferenceSchema).default([]) })
  .passthrough();
export type RawFindUserReferenceResponse = z.infer<
  typeof RawFindUserReferenceResponseSchema
>;

export const RawMessageReferenceSchema = z
  .object({
    messageId: z.string(),
    conversationId: z.string().optional().default(""),
    senderId: z.string().optional().default(""),
    receiverId: z.string().optional().default(""),
    createdAt: OptionalLongSchema,
  })
  .passthrough();
export type RawMessageReference = z.infer<typeof RawMessageReferenceSchema>;

export const RawSearchMessagesResponseSchema = z
  .object({
    messages: z.array(RawMessageReferenceSchema).max(21),
    truncated: z.boolean(),
    observedAt: OptionalLongSchema,
  })
  .passthrough();
export type RawSearchMessagesResponse = z.infer<
  typeof RawSearchMessagesResponseSchema
>;

export const RawMessageRecordSchema = z
  .object({
    found: z.boolean(),
    messageId: z.string().optional().default(""),
    conversationId: z.string().optional().default(""),
    senderId: z.string().optional().default(""),
    receiverId: z.string().optional().default(""),
    createdAt: OptionalLongSchema,
    source: z.string().optional().default("operations-query"),
    observedAt: OptionalLongSchema,
    chatType: z.number().int().optional().default(0),
    msgType: z.number().int().optional().default(0),
    readState: z.string().optional().default("unknown"),
    readStateNote: z.string().optional().default(""),
    eventsAvailable: z.boolean().optional().default(false),
    note: z.string().optional().default(""),
  })
  .passthrough();
export type RawMessageRecord = z.infer<typeof RawMessageRecordSchema>;

const RawMessageEventSchema = z
  .object({
    eventId: z.string().optional().default(""),
    eventVersion: z.number().int().optional().default(0),
    eventType: z.string().optional().default(""),
    messageId: z.string().optional().default(""),
    clientMessageId: z.string().optional().default(""),
    correlationId: z.string().optional().default(""),
    conversationId: z.string().optional().default(""),
    senderId: z.string().optional().default(""),
    receiverId: z.string().optional().default(""),
    attemptId: z.string().optional().default(""),
    occurredAt: OptionalLongSchema,
    source: z.string().optional().default("operations-query"),
    errorCode: z.string().optional().default(""),
    sequence: OptionalLongSchema,
    metadata: z.record(z.string()).optional().default({}),
  })
  .passthrough();
export type RawMessageEvent = z.infer<typeof RawMessageEventSchema>;

export const RawMessageTimelineResponseSchema = z
  .object({
    events: z.array(RawMessageEventSchema).default([]),
    complete: z.boolean().optional().default(false),
    truncated: z.boolean().optional().default(false),
    nextCursor: z.string().optional().default(""),
    messageId: z.string().optional().default(""),
    coverageStatus: z
      .enum(["complete", "partial", "unknown"])
      .optional()
      .default("unknown"),
    eventsDropped: OptionalLongSchema,
  })
  .passthrough();
export type RawMessageTimelineResponse = z.infer<
  typeof RawMessageTimelineResponseSchema
>;

export const RawDeliveryEventSchema = z
  .object({
    eventId: z.string().optional().default(""),
    eventType: z.string().optional().default(""),
    messageId: z.string().optional().default(""),
    receiverId: z.string().optional().default(""),
    attemptId: z.string().optional().default(""),
    occurredAt: OptionalLongSchema,
    source: z.string().optional().default("operations-query"),
    errorCode: z.string().optional().default(""),
    metadata: z.record(z.string()).optional().default({}),
    evidence: z.string().optional().default("operations-query"),
  })
  .passthrough();
export type RawDeliveryEvent = z.infer<typeof RawDeliveryEventSchema>;

export const RawDeliveryTimelineResponseSchema = z
  .object({
    events: z.array(RawDeliveryEventSchema).default([]),
    complete: z.boolean().optional().default(false),
    truncated: z.boolean().optional().default(false),
    nextCursor: z.string().optional().default(""),
    messageId: z.string().optional().default(""),
    coverageStatus: z
      .enum(["complete", "partial", "unknown"])
      .optional()
      .default("unknown"),
    eventsDropped: OptionalLongSchema,
  })
  .passthrough();
export type RawDeliveryTimelineResponse = z.infer<
  typeof RawDeliveryTimelineResponseSchema
>;

export const RawConnectionObservationSchema = z
  .object({
    connectionId: z.string().optional().default(""),
    instanceId: z.string().optional().default(""),
    state: z.string().optional().default("unknown"),
    observedAt: OptionalLongSchema,
    reason: z.string().optional().default(""),
  })
  .passthrough();
export type RawConnectionObservation = z.infer<
  typeof RawConnectionObservationSchema
>;

export const RawCurrentConnectionSchema = z
  .object({
    online: z.boolean(),
    connectionId: z.string().optional().default(""),
    instanceId: z.string().optional().default(""),
    observedAt: OptionalLongSchema,
    source: z.string().optional().default("unknown"),
  })
  .passthrough();
export type RawCurrentConnection = z.infer<typeof RawCurrentConnectionSchema>;

export const RawConnectionResponseSchema = z
  .object({
    observations: z.array(RawConnectionObservationSchema).default([]),
    current: RawCurrentConnectionSchema.nullable().optional().default(null),
    complete: z.boolean().optional().default(false),
    truncated: z.boolean().optional().default(false),
    nextCursor: z.string().optional().default(""),
    note: z.string().optional().default(""),
    coverageStatus: z
      .enum(["complete", "partial", "unknown"])
      .optional()
      .default("unknown"),
    eventsDropped: OptionalLongSchema,
  })
  .passthrough();
export type RawConnectionResponse = z.infer<typeof RawConnectionResponseSchema>;

export const RawCapabilitiesSchema = z
  .object({
    messageRecord: z.string().optional().default("unsupported"),
    messageTimeline: z.string().optional().default("unsupported"),
    deliveryEvents: z.string().optional().default("unsupported"),
    historicalConnection: z.string().optional().default("unsupported"),
    ackHistory: z.string().optional().default("unsupported"),
    writeFailureEvents: z.string().optional().default("unsupported"),
    messageSearch: z.string().optional().default("unsupported"),
    readConfirmation: z.string().optional().default("unsupported"),
    observedAt: OptionalLongSchema,
    observationEnabled: z.string().optional().default("unknown"),
    ackMode: z.string().optional().default("unknown"),
  })
  .passthrough();
export type RawCapabilities = z.infer<typeof RawCapabilitiesSchema>;
