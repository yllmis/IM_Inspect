import {
  ConnectionStatusInput,
  ConnectionStatusInputSchema,
  Connector,
  ConnectorResult,
  DeliveryEventsInput,
  DeliveryEventsInputSchema,
  DeliveryEventsPage,
  FindUserOrMessageInput,
  FindUserOrMessageInputSchema,
  FindUserOrMessageResult,
  MessageLookupInput,
  MessageLookupInputSchema,
} from "../connector";
import type { ConnectorRequestContext } from "../../tools/context";
import {
  ConnectorCapabilities,
  ConnectorCapabilityStatus,
  ToolError,
} from "../../domain/errors";
import { ConnectionFact } from "../../domain/connection";
import { DeliveryFact } from "../../domain/delivery";
import { MessageFact } from "../../domain/message";
import { Fixture, FixtureBehavior, loadFixture } from "./fixture-loader";

export type FakeConnectorOperation =
  | "findUserOrMessage"
  | "getMessageStatus"
  | "getDeliveryEvents"
  | "getConnectionStatus";

export interface FakeConnectorCall {
  operation: FakeConnectorOperation;
  input: unknown;
  requestContext?: ConnectorRequestContext;
}

const capabilityByOperation: Record<
  FakeConnectorOperation,
  keyof ConnectorCapabilities
> = {
  findUserOrMessage: "messageLookup",
  getMessageStatus: "messageLookup",
  getDeliveryEvents: "deliveryEvents",
  getConnectionStatus: "historicalPresence",
};

export class FakeConnector implements Connector {
  readonly calls: FakeConnectorCall[] = [];
  private readonly fixture: Readonly<Fixture>;

  constructor(fixtureName: string, fixtureDirectory?: string) {
    this.fixture = loadFixture(fixtureName, fixtureDirectory);
  }

  async findUserOrMessage(
    input: FindUserOrMessageInput,
    requestContext?: ConnectorRequestContext,
  ): Promise<ConnectorResult<FindUserOrMessageResult>> {
    const parsed = FindUserOrMessageInputSchema.parse(input);
    this.calls.push({
      operation: "findUserOrMessage",
      input: parsed,
      requestContext,
    });
    const behavior = this.behaviorFor("findUserOrMessage");
    if (behavior.kind === "error") {
      return this.failure(
        "findUserOrMessage",
        behavior.code,
        behavior.message,
        behavior.retryable,
        behavior.details,
      );
    }
    if (behavior.kind === "empty") {
      return this.respond("findUserOrMessage", parsed, {
        resolutionStatus: "none",
        matches: [],
        truncated: false,
      });
    }
    if (behavior.kind === "unsupported") {
      return this.failure(
        "findUserOrMessage",
        "unsupported_capability",
        `${behavior.capability} is not supported by this connector`,
        false,
        { capability: behavior.capability },
      );
    }
    const defaultMatch = {
      entityType: "message" as const,
      userId: this.fixture.message.receiverId,
      displayName: this.fixture.message.metadata?.displayName,
      conversationId: this.fixture.message.conversationId,
      messageId: this.fixture.message.messageId,
      observedAt:
        this.fixture.message.statusAt ??
        this.fixture.message.createdAt ??
        this.fixture.source.observedAt,
      evidence: this.fixture.message.evidence,
    };
    const lookupMatches = this.fixture.lookupMatches ?? [defaultMatch];
    const matches = lookupMatches.filter((match) => {
      if (parsed.messageId && parsed.messageId !== match.messageId)
        return false;
      if (parsed.userId && parsed.userId !== match.userId) return false;
      if (parsed.displayName && match.displayName !== parsed.displayName)
        return false;
      if (
        parsed.conversationId &&
        parsed.conversationId !== match.conversationId
      )
        return false;
      return true;
    });
    const boundedMatches = matches.slice(0, parsed.limit);
    return this.respond("findUserOrMessage", parsed, {
      resolutionStatus:
        matches.length === 0
          ? "none"
          : matches.length === 1
            ? "unique"
            : "multiple",
      matches: boundedMatches,
      truncated: matches.length > parsed.limit,
    });
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      messageLookup: this.capabilityFor("getMessageStatus"),
      deliveryEvents: this.capabilityFor("getDeliveryEvents"),
      historicalPresence: this.capabilityFor("getConnectionStatus"),
    };
  }

  async getMessageStatus(
    input: MessageLookupInput,
    requestContext?: ConnectorRequestContext,
  ): Promise<ConnectorResult<MessageFact>> {
    const parsed = MessageLookupInputSchema.parse(input);
    this.calls.push({
      operation: "getMessageStatus",
      input: parsed,
      requestContext,
    });
    const behavior = this.fixture.behavior.getMessageStatus;
    if (behavior.kind === "error") {
      return this.failure(
        "getMessageStatus",
        behavior.code,
        behavior.message,
        behavior.retryable,
        behavior.details,
      );
    }
    if (behavior.kind === "unsupported") {
      return this.failure(
        "getMessageStatus",
        "unsupported_capability",
        `${behavior.capability} is not supported by this connector`,
        false,
        { capability: behavior.capability },
      );
    }
    if (parsed.messageId !== this.fixture.message.messageId) {
      return this.failure(
        "getMessageStatus",
        "not_found",
        "message fact does not match requested messageId",
        false,
      );
    }
    return this.respond("getMessageStatus", parsed, this.fixture.message);
  }

  async getDeliveryEvents(
    input: DeliveryEventsInput,
    requestContext?: ConnectorRequestContext,
  ): Promise<ConnectorResult<DeliveryEventsPage>> {
    const parsed = DeliveryEventsInputSchema.parse(input);
    this.calls.push({
      operation: "getDeliveryEvents",
      input: parsed,
      requestContext,
    });
    if (parsed.messageId !== this.fixture.message.messageId) {
      return this.failure(
        "getDeliveryEvents",
        "not_found",
        "delivery facts do not match requested messageId",
        false,
      );
    }
    const effectiveTimeRange =
      parsed.timeRange ?? this.defaultDeliveryTimeRange();
    const behavior = this.behaviorFor("getDeliveryEvents");
    const matchingEvents =
      behavior.kind === "empty"
        ? []
        : this.fixture.deliveries.filter((event) =>
            isEventWithinRange(event, effectiveTimeRange),
          );
    const truncated = matchingEvents.length > parsed.limit;
    return this.respond("getDeliveryEvents", parsed, {
      events: matchingEvents.slice(0, parsed.limit),
      complete: !truncated,
      truncated,
      effectiveTimeRange,
      sourceReference: `fixture:${this.fixture.source.name}:delivery-events`,
    });
  }

  async getConnectionStatus(
    input: ConnectionStatusInput,
    requestContext?: ConnectorRequestContext,
  ): Promise<ConnectorResult<ConnectionFact>> {
    const parsed = ConnectionStatusInputSchema.parse(input);
    this.calls.push({
      operation: "getConnectionStatus",
      input: parsed,
      requestContext,
    });
    const behavior = this.fixture.behavior.getConnectionStatus;
    if (behavior.kind !== "success") {
      return this.respond<ConnectionFact>(
        "getConnectionStatus",
        parsed,
        undefined,
      );
    }
    if (parsed.userId !== this.fixture.message.receiverId) {
      return this.failure(
        "getConnectionStatus",
        "not_found",
        "connection fact does not match requested userId",
        false,
      );
    }
    if (!this.fixture.connection) {
      return this.failure(
        "getConnectionStatus",
        "not_found",
        "no connection fact in fixture",
        false,
      );
    }
    return this.respond("getConnectionStatus", parsed, this.fixture.connection);
  }

  private respond<T>(
    operation: FakeConnectorOperation,
    input: unknown,
    data: T | undefined,
  ): ConnectorResult<T> {
    const behavior = this.behaviorFor(operation);
    switch (behavior.kind) {
      case "success":
        if (data === undefined) {
          return this.failure(
            operation,
            "internal",
            "success behavior requires fixture data",
            false,
          );
        }
        return { ok: true, source: this.fixture.source.name, data };
      case "empty":
        if (operation === "getDeliveryEvents") {
          if (data === undefined) {
            return this.failure(
              operation,
              "internal",
              "empty delivery behavior requires bounded query metadata",
              false,
            );
          }
          return { ok: true, source: this.fixture.source.name, data };
        }
        return this.failure(
          operation,
          "internal",
          "empty behavior is only valid for delivery events",
          false,
        );
      case "error":
        return {
          ok: false,
          source: this.fixture.source.name,
          error: this.toError(behavior),
        };
      case "unsupported":
        return this.failure(
          operation,
          "unsupported_capability",
          `${behavior.capability} is not supported by this connector`,
          false,
          { capability: behavior.capability, input },
        );
      default:
        throw new Error("unsupported fixture behavior");
    }
  }

  private behaviorFor(operation: FakeConnectorOperation): FixtureBehavior {
    if (operation === "findUserOrMessage") {
      return (
        this.fixture.behavior.findUserOrMessage ??
        this.fixture.behavior.getMessageStatus
      );
    }
    return this.fixture.behavior[operation];
  }

  private defaultDeliveryTimeRange(): { start: string; end: string } {
    const end = Date.parse(this.fixture.source.observedAt);
    return {
      start: new Date(end - 86_400_000).toISOString(),
      end: new Date(end).toISOString(),
    };
  }

  private failure(
    operation: FakeConnectorOperation,
    code: ToolError["code"],
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ): ConnectorResult<never> {
    return {
      ok: false,
      source: this.fixture.source.name,
      error: { code, message, retryable, details },
    };
  }

  private toError(
    behavior: Extract<FixtureBehavior, { kind: "error" }>,
  ): ToolError {
    return {
      code: behavior.code,
      message: behavior.message,
      retryable: behavior.retryable,
      details: behavior.details,
    };
  }

  private capabilityFor(
    operation: FakeConnectorOperation,
  ): ConnectorCapabilityStatus {
    const behavior = this.behaviorFor(operation);
    return behavior.kind === "unsupported" ? "unsupported" : "supported";
  }
}

function isEventWithinRange(
  event: DeliveryFact,
  range: { start: string; end: string },
): boolean {
  const timestamp = event.attemptedAt ?? event.deliveredAt ?? event.ackedAt;
  if (!timestamp) return false;
  const observedAt = Date.parse(timestamp);
  return (
    observedAt >= Date.parse(range.start) && observedAt <= Date.parse(range.end)
  );
}

export function capabilityStatusFor(
  connector: Connector,
  operation: FakeConnectorOperation,
): ConnectorCapabilityStatus {
  const key = capabilityByOperation[operation];
  return connector.getCapabilities()[key];
}
