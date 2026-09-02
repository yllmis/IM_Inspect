import { describe, expect, it } from "vitest";

import { Connector } from "../connector";
import { FakeConnector, capabilityStatusFor } from "./fake-connector";
import { loadFixture } from "./fixture-loader";

const fixtureNames = [
  "message_missing",
  "write_failed",
  "not_delivered",
  "receiver_offline",
  "ack_timeout",
  "delivered",
] as const;

const observedAt = "2026-09-02T10:00:00Z";

describe("fixed fixtures", () => {
  it.each(fixtureNames)("loads %s with validated facts", (fixtureName) => {
    const fixture = loadFixture(fixtureName);
    expect(fixture.source.name).toBe(fixtureName);
    expect(fixture.source.observedAt).toBe(observedAt);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.message)).toBe(true);
    expect(Object.isFrozen(fixture.deliveries)).toBe(true);
  });
});

describe("FakeConnector", () => {
  it("implements the formal Connector interface", () => {
    const connector: Connector = new FakeConnector("delivered");
    expect(connector.getCapabilities().messageLookup).toBe("supported");
  });

  it("returns missing message without inferring a write failure", async () => {
    const connector = new FakeConnector("message_missing");
    const result = await connector.getMessageStatus({
      messageId: "msg_missing",
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data).toMatchObject({
        messageId: "msg_missing",
        exists: false,
        persisted: null,
      });
    }
  });

  it("returns explicit write failure evidence", async () => {
    const connector = new FakeConnector("write_failed");
    const result = await connector.getMessageStatus({
      messageId: "msg_write_failed",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.persisted).toBe(false);
      expect(result.data.evidence.some((item) => item.kind === "write")).toBe(
        true,
      );
    }
  });

  it("distinguishes an empty delivery result from unsupported presence", async () => {
    const connector = new FakeConnector("not_delivered");
    const deliveries = await connector.getDeliveryEvents({
      messageId: "msg_not_delivered",
    });
    const connection = await connector.getConnectionStatus({
      userId: "user_not_delivered",
      at: observedAt,
    });

    expect(deliveries).toMatchObject({ ok: true, data: [] });
    expect(connection).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
  });

  it("returns a historical offline connection", async () => {
    const connector = new FakeConnector("receiver_offline");
    const result = await connector.getConnectionStatus({
      userId: "user_receiver_offline",
      at: observedAt,
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data).toMatchObject({
        userId: "user_receiver_offline",
        state: "offline",
        historical: true,
      });
    }
  });

  it("maps ACK timeout and successful delivery facts", async () => {
    const timeoutConnector = new FakeConnector("ack_timeout");
    const timeout = await timeoutConnector.getDeliveryEvents({
      messageId: "msg_ack_timeout",
    });
    expect(timeout).toMatchObject({ ok: true });
    if (timeout.ok) expect(timeout.data[0]?.result).toBe("timeout");

    const deliveredConnector = new FakeConnector("delivered");
    const delivered = await deliveredConnector.getDeliveryEvents({
      messageId: "msg_delivered",
    });
    expect(delivered).toMatchObject({ ok: true });
    if (delivered.ok) {
      expect(delivered.data[0]).toMatchObject({
        result: "success",
        deliveredAt: "2026-09-02T09:59:31Z",
      });
    }
  });

  it("records validated inputs for every call", async () => {
    const connector = new FakeConnector("delivered");
    await connector.getMessageStatus({ messageId: "msg_delivered" });
    await connector.getDeliveryEvents({ messageId: "msg_delivered" });
    await connector.getConnectionStatus({
      userId: "user_delivered",
      at: observedAt,
    });

    expect(connector.calls).toHaveLength(3);
    expect(connector.calls.map((call) => call.operation)).toEqual([
      "getMessageStatus",
      "getDeliveryEvents",
      "getConnectionStatus",
    ]);
  });

  it("is deterministic across repeated calls", async () => {
    const connector = new FakeConnector("delivered");
    const first = await connector.getMessageStatus({
      messageId: "msg_delivered",
    });
    const second = await connector.getMessageStatus({
      messageId: "msg_delivered",
    });
    expect(second).toEqual(first);
  });

  it("does not leak facts for a different message or user", async () => {
    const connector = new FakeConnector("receiver_offline");
    const message = await connector.getMessageStatus({
      messageId: "other_message",
    });
    const connection = await connector.getConnectionStatus({
      userId: "other_user",
      at: observedAt,
    });

    expect(message).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(connection).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("reports unsupported capability explicitly", async () => {
    const connector = new FakeConnector("message_missing");
    expect(capabilityStatusFor(connector, "getConnectionStatus")).toBe(
      "unsupported",
    );
    const result = await connector.getConnectionStatus({
      userId: "user_missing_receiver",
      at: observedAt,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
  });
});
