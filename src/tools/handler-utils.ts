import { z } from "zod";

import { ConnectorResult } from "../connectors/connector";
import { ConnectionFact, ConnectionFactSchema } from "../domain/connection";
import { DeliveryFact, DeliveryFactSchema } from "../domain/delivery";
import { ToolError } from "../domain/errors";
import { Evidence, EvidenceSchema } from "../domain/evidence";
import { MessageFact, MessageFactSchema } from "../domain/message";
import {
  connectorRequestContext,
  ToolContext,
  ToolServiceError,
} from "./context";

export function requireCapability(
  connector: { getCapabilities(): Record<string, string> },
  capability: string,
) {
  if (connector.getCapabilities()[capability] === "unsupported") {
    throw new ToolServiceError(
      "unsupported_capability",
      `${capability} is not supported by this connector`,
      false,
      { capability },
    );
  }
}

export function connectorContext(context: ToolContext) {
  return connectorRequestContext(context);
}

export function unwrapConnector<T>(result: ConnectorResult<T>): T {
  if (!result.ok) {
    const error: ToolError = result.error;
    throw new ToolServiceError(
      error.code,
      error.message,
      error.retryable,
      error.details,
    );
  }
  return result.data;
}

export function unwrapConnectorWithSource<T>(result: ConnectorResult<T>): {
  source: string;
  data: T;
} {
  if (!result.ok) {
    const error: ToolError = result.error;
    throw new ToolServiceError(
      error.code,
      error.message,
      error.retryable,
      error.details,
    );
  }
  return { source: result.source, data: result.data };
}

export function parseResult<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export function sanitizeEvidence(raw: Evidence): Evidence {
  const evidence = EvidenceSchema.parse(raw);
  return EvidenceSchema.parse({
    id: evidence.id,
    source: evidence.source,
    kind: evidence.kind,
    observedAt: evidence.observedAt,
    field: evidence.field,
    value: evidence.value,
  });
}

export function sanitizeMessageFact(raw: MessageFact): MessageFact {
  const message = MessageFactSchema.parse(raw);
  return MessageFactSchema.parse({
    messageId: message.messageId,
    conversationId: message.conversationId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    status: message.status,
    exists: message.exists,
    persisted: message.persisted,
    createdAt: message.createdAt,
    statusAt: message.statusAt,
    evidence: message.evidence.map(sanitizeEvidence),
  });
}

export function sanitizeDeliveryFact(raw: DeliveryFact): DeliveryFact {
  const delivery = DeliveryFactSchema.parse(raw);
  return DeliveryFactSchema.parse({
    messageId: delivery.messageId,
    receiverId: delivery.receiverId,
    attemptId: delivery.attemptId,
    attemptedAt: delivery.attemptedAt,
    result: delivery.result,
    deliveredAt: delivery.deliveredAt,
    ackedAt: delivery.ackedAt,
    errorCode: delivery.errorCode,
    evidence: delivery.evidence.map(sanitizeEvidence),
  });
}

export function sanitizeConnectionFact(raw: ConnectionFact): ConnectionFact {
  const connection = ConnectionFactSchema.parse(raw);
  return ConnectionFactSchema.parse({
    userId: connection.userId,
    state: connection.state,
    observedAt: connection.observedAt,
    connectionId: connection.connectionId,
    historical: connection.historical,
    evidence: connection.evidence.map(sanitizeEvidence),
  });
}
