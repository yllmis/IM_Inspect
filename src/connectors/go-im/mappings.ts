import { status as grpcStatus } from "@grpc/grpc-js";

import { ConnectorCapabilities, ToolError } from "../../domain/errors";
import { Evidence } from "../../domain/evidence";
import { MessageFact } from "../../domain/message";
import { ConnectionFact } from "../../domain/connection";
import { DeliveryFact } from "../../domain/delivery";
import {
  RawCapabilities,
  RawConnectionObservation,
  RawConnectionResponse,
  RawCurrentConnection,
  RawDeliveryEvent,
  RawDeliveryTimelineResponse,
  RawFindUserReferenceResponse,
  RawMessageRecord,
  RawSearchMessagesResponse,
} from "./schemas";

const NANOSECONDS_PER_MILLISECOND = BigInt(1_000_000);

/** UnixNano -> ISO；使用 BigInt，避免 1.7e18 超出 Number.MAX_SAFE_INTEGER。 */
export function unixNanoToIso(value: string | number): string | undefined {
  let nano: bigint;
  try {
    nano = BigInt(String(value));
  } catch {
    return undefined;
  }
  if (nano <= BigInt(0)) return undefined;
  const millis = nano / NANOSECONDS_PER_MILLISECOND;
  const date = new Date(Number(millis));
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function requiredObservedAt(value: string | number, subject: string): string {
  const iso = unixNanoToIso(value);
  if (!iso) throw new Error(`${subject} is missing observedAt`);
  return iso;
}

function evidence(
  id: string,
  source: string,
  kind: Evidence["kind"],
  observedAt: string,
  field: string,
  value: string | number | boolean | null,
): Evidence {
  return {
    id: id || `${source}:${field}`,
    source,
    kind,
    observedAt,
    field,
    value,
  };
}

export function mapMessageRecord(
  raw: RawMessageRecord,
  requestedMessageId: string,
): MessageFact | null {
  if (!raw.found) return null;
  if (!raw.messageId || raw.messageId !== requestedMessageId) {
    throw new Error("Go IM query returned a different messageId");
  }
  const observedAt = requiredObservedAt(raw.observedAt, "message record");
  const createdAt = unixNanoToIso(raw.createdAt);
  const source = raw.source || "operations-query";
  return {
    messageId: raw.messageId,
    conversationId: raw.conversationId || undefined,
    senderId: raw.senderId || undefined,
    receiverId: raw.receiverId || undefined,
    status: "persisted",
    exists: true,
    persisted: true,
    createdAt,
    statusAt: observedAt,
    evidence: [
      evidence(
        `${source}:${raw.messageId}:record`,
        source,
        "message",
        observedAt,
        "message_record",
        "found",
      ),
    ],
    metadata: {
      readState: raw.readState,
      eventsAvailable:
        raw.eventsState === "unknown" ? "unknown" : String(raw.eventsAvailable),
      eventsState: raw.eventsState,
    },
  };
}

export function mapUserMatches(raw: RawFindUserReferenceResponse): Array<{
  entityType: "user";
  userId: string;
  receiverId?: string;
  displayName?: string;
  observedAt: string;
  evidence: Evidence[];
}> {
  return raw.users.map((user) => {
    const observedAt = requiredObservedAt(user.observedAt, "user reference");
    const source = "operations-query";
    return {
      entityType: "user" as const,
      userId: user.userId,
      displayName: user.displayName || undefined,
      observedAt,
      evidence: [
        evidence(
          `${source}:user:${user.userId}`,
          source,
          "message",
          observedAt,
          "user_reference",
          user.userId,
        ),
      ],
    };
  });
}

/** 搜索结果仍是候选定位，不是 MessageFact；必须由后续 get_message_status 确认。 */
export function mapMessageMatches(raw: RawSearchMessagesResponse): Array<{
  entityType: "message";
  userId: string;
  receiverId?: string;
  createdAt: string;
  conversationId?: string;
  messageId: string;
  observedAt: string;
  evidence: Evidence[];
}> {
  return raw.messages.map((message) => {
    const observedAt = requiredObservedAt(
      raw.observedAt,
      "message search response",
    );
    const source = "operations-query";
    const createdAt = requiredObservedAt(
      message.createdAt,
      "message creation time",
    );
    return {
      entityType: "message" as const,
      userId: message.senderId,
      receiverId: message.receiverId,
      createdAt,
      conversationId: message.conversationId || undefined,
      messageId: message.messageId,
      observedAt,
      evidence: [
        evidence(
          `${source}:search:${message.messageId}`,
          source,
          "message",
          observedAt,
          "message_search_candidate",
          message.messageId,
        ),
      ],
    };
  });
}

function deliveryStatus(eventType: string): DeliveryFact["result"] {
  const type = eventType.toLowerCase();
  if (type.includes("timeout")) return "timeout";
  if (type.includes("failed") || type === "receiver_offline") return "failed";
  if (
    type.includes("success") ||
    type.includes("succeed") ||
    type.includes("delivered") ||
    type === "ack_received"
  )
    return "success";
  if (
    type.includes("attempt") ||
    type.includes("queued") ||
    type.includes("sent")
  )
    return "attempted";
  return "unknown";
}

export function mapDeliveryEvent(
  raw: RawDeliveryEvent,
  requestedMessageId: string,
): DeliveryFact {
  if (!raw.messageId || raw.messageId !== requestedMessageId) {
    throw new Error(
      "Go IM query returned a delivery event for another messageId",
    );
  }
  const attemptedAt = requiredObservedAt(raw.occurredAt, "delivery event");
  const result = deliveryStatus(raw.eventType);
  const source = raw.source || "operations-query";
  const errorCode =
    raw.errorCode ||
    (result === "failed"
      ? raw.eventType || "delivery_failed"
      : result === "timeout"
        ? "timeout"
        : undefined);
  return {
    messageId: raw.messageId,
    receiverId: raw.receiverId || undefined,
    attemptId: raw.attemptId || undefined,
    attemptedAt,
    result,
    deliveredAt: result === "success" ? attemptedAt : undefined,
    ackedAt: raw.eventType.toLowerCase().startsWith("ack_")
      ? attemptedAt
      : undefined,
    errorCode,
    evidence: [
      evidence(
        raw.eventId || `${source}:${raw.messageId}:${attemptedAt}`,
        source,
        "delivery",
        attemptedAt,
        "delivery_event",
        raw.eventType || "unknown",
      ),
    ],
    metadata: raw.evidence ? { evidence: raw.evidence } : undefined,
  };
}

export function mapDeliveryTimeline(
  raw: RawDeliveryTimelineResponse,
  requestedMessageId: string,
): {
  events: DeliveryFact[];
  coverageStatus: "complete" | "partial" | "unknown";
  eventsDropped: number;
} {
  if (raw.messageId && raw.messageId !== requestedMessageId) {
    throw new Error(
      "Go IM query returned a timeline for another messageId",
    );
  }
  return {
    events: raw.events.map((event) =>
      mapDeliveryEvent(event, requestedMessageId),
    ),
    coverageStatus: raw.coverageStatus,
    eventsDropped: Number(BigInt(raw.eventsDropped)),
  };
}

function connectionFromCurrent(
  current: RawCurrentConnection,
  userId: string,
): ConnectionFact {
  const observedAt = requiredObservedAt(
    current.observedAt,
    "current connection",
  );
  const source = current.source || "unknown";
  return {
    userId,
    state:
      current.source === "unknown"
        ? "unknown"
        : current.online
          ? "online"
          : "offline",
    observedAt,
    connectionId: current.connectionId || undefined,
    historical: false,
    evidence: [
      evidence(
        `${source}:${userId}:${observedAt}`,
        source,
        "connection",
        observedAt,
        "connection_state",
        current.online,
      ),
    ],
  };
}

function connectionFromObservation(
  observation: RawConnectionObservation,
  userId: string,
): ConnectionFact {
  const observedAt = requiredObservedAt(
    observation.observedAt,
    "connection observation",
  );
  const state =
    observation.state === "online" || observation.state === "offline"
      ? observation.state
      : "unknown";
  const source = "operations-query";
  return {
    userId,
    state,
    observedAt,
    connectionId: observation.connectionId || undefined,
    historical: true,
    evidence: [
      evidence(
        `${source}:${userId}:${observedAt}`,
        source,
        "connection",
        observedAt,
        "connection_state",
        state,
      ),
    ],
  };
}

export function mapConnectionResponse(
  raw: RawConnectionResponse,
  userId: string,
): ConnectionFact | null {
  const latest = [...raw.observations].sort((a, b) =>
    Number(BigInt(b.observedAt) - BigInt(a.observedAt)),
  )[0];
  // at 查询优先使用历史观测；current 只是没有历史样本时的兜底，避免把当前状态冒充过去状态。
  return latest
    ? connectionFromObservation(latest, userId)
    : raw.current
      ? connectionFromCurrent(raw.current, userId)
      : null;
}

function capability(
  value: string,
): "supported" | "partial" | "unsupported" | "unknown" {
  return value === "supported" || value === "partial" || value === "unknown"
    ? value
    : "unsupported";
}

export function mapCapabilities(raw: RawCapabilities): ConnectorCapabilities {
  return {
    messageLookup: capability(raw.messageRecord),
    messageSearch: capability(raw.messageSearch),
    deliveryEvents: capability(raw.deliveryEvents),
    historicalPresence: capability(raw.historicalConnection),
    ackTracking: capability(raw.ackHistory),
    writeFailureEvents: capability(raw.writeFailureEvents),
  };
}

export function mapGrpcError(error: unknown): ToolError {
  const grpcError = error as { code?: number; message?: string };
  const code = grpcError.code;
  const message = grpcError.message || "Go IM query request failed";
  switch (code) {
    case grpcStatus.DEADLINE_EXCEEDED:
      return {
        code: "timeout",
        message: "Go IM query request timed out",
        retryable: true,
      };
    case grpcStatus.UNAVAILABLE:
      return { code: "dependency_unavailable", message, retryable: true };
    case grpcStatus.RESOURCE_EXHAUSTED:
      return { code: "rate_limited", message, retryable: true };
    case grpcStatus.INVALID_ARGUMENT:
      return { code: "invalid_argument", message, retryable: false };
    case grpcStatus.PERMISSION_DENIED:
    case grpcStatus.UNAUTHENTICATED:
      return {
        code: "permission_denied",
        message: "Go IM query permission denied",
        retryable: false,
      };
    case grpcStatus.NOT_FOUND:
      return { code: "not_found", message, retryable: false };
    case grpcStatus.UNIMPLEMENTED:
      return { code: "unsupported_capability", message, retryable: false };
    default:
      return { code: "internal", message, retryable: false };
  }
}
