import {
  ConnectionStatusInput,
  ConnectionStatusInputSchema,
  Connector,
  ConnectorResult,
  DeliveryEventsInput,
  DeliveryEventsInputSchema,
  MessageLookupInput,
  MessageLookupInputSchema,
} from "../connector";
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
  "getMessageStatus" | "getDeliveryEvents" | "getConnectionStatus";

export interface FakeConnectorCall {
  operation: FakeConnectorOperation;
  input: unknown;
}

const capabilityByOperation: Record<
  FakeConnectorOperation,
  keyof ConnectorCapabilities
> = {
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

  getCapabilities(): ConnectorCapabilities {
    return {
      messageLookup: this.capabilityFor("getMessageStatus"),
      deliveryEvents: this.capabilityFor("getDeliveryEvents"),
      historicalPresence: this.capabilityFor("getConnectionStatus"),
    };
  }

  async getMessageStatus(
    input: MessageLookupInput,
  ): Promise<ConnectorResult<MessageFact>> {
    const parsed = MessageLookupInputSchema.parse(input);
    this.calls.push({ operation: "getMessageStatus", input: parsed });
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
  ): Promise<ConnectorResult<DeliveryFact[]>> {
    const parsed = DeliveryEventsInputSchema.parse(input);
    this.calls.push({ operation: "getDeliveryEvents", input: parsed });
    if (parsed.messageId !== this.fixture.message.messageId) {
      return this.failure(
        "getDeliveryEvents",
        "not_found",
        "delivery facts do not match requested messageId",
        false,
      );
    }
    return this.respond("getDeliveryEvents", parsed, this.fixture.deliveries);
  }

  async getConnectionStatus(
    input: ConnectionStatusInput,
  ): Promise<ConnectorResult<ConnectionFact>> {
    const parsed = ConnectionStatusInputSchema.parse(input);
    this.calls.push({ operation: "getConnectionStatus", input: parsed });
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
    const behavior = this.fixture.behavior[operation];
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
          return { ok: true, source: this.fixture.source.name, data: [] as T };
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
    }
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
    const behavior = this.fixture.behavior[operation];
    return behavior.kind === "unsupported" ? "unsupported" : "supported";
  }
}

export function capabilityStatusFor(
  connector: Connector,
  operation: FakeConnectorOperation,
): ConnectorCapabilityStatus {
  const key = capabilityByOperation[operation];
  return connector.getCapabilities()[key];
}
