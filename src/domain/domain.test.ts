import { describe, expect, it } from "vitest";

import { ConnectionFactSchema } from "./connection";
import { DeliveryFactSchema } from "./delivery";
import { DiagnosisInputSchema, DiagnosisResultSchema } from "./diagnosis";
import { ToolErrorSchema } from "./errors";
import { EvidenceSchema } from "./evidence";
import { MessageFactSchema } from "./message";

const evidence = {
  id: "chat_log:msg_001",
  source: "fake_connector",
  kind: "message" as const,
  observedAt: "2026-08-31T10:00:00Z",
  field: "persisted",
  value: true,
};

describe("canonical domain schemas", () => {
  it("accepts a valid evidence record", () => {
    expect(EvidenceSchema.parse(evidence)).toEqual(evidence);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      EvidenceSchema.parse({ ...evidence, rawMessageContent: "secret" }),
    ).toThrow();
  });

  it("rejects a persisted message that does not exist", () => {
    expect(() =>
      MessageFactSchema.parse({
        messageId: "msg_001",
        status: "persisted",
        exists: false,
        persisted: true,
        evidence: [evidence],
      }),
    ).toThrow("persisted cannot be true when exists is false");
  });

  it("requires persisted and accepts an explicit unknown value", () => {
    expect(() =>
      MessageFactSchema.parse({
        messageId: "msg_missing",
        status: "unknown",
        exists: false,
        evidence: [],
      }),
    ).toThrow();

    expect(
      MessageFactSchema.parse({
        messageId: "msg_missing",
        status: "unknown",
        exists: false,
        persisted: null,
        evidence: [],
      }).persisted,
    ).toBeNull();
  });

  it("requires success and failure delivery details", () => {
    expect(() =>
      DeliveryFactSchema.parse({
        messageId: "msg_001",
        result: "success",
        evidence: [],
      }),
    ).toThrow("successful delivery requires deliveredAt");

    expect(() =>
      DeliveryFactSchema.parse({
        messageId: "msg_001",
        result: "failed",
        evidence: [],
      }),
    ).toThrow("failed delivery requires errorCode");
  });

  it("requires an observation time for historical connection facts", () => {
    expect(() =>
      ConnectionFactSchema.parse({
        userId: "user_001",
        state: "offline",
        historical: true,
        evidence: [],
      }),
    ).toThrow("historical connection facts require observedAt");
  });

  it("rejects an inverted diagnosis time range", () => {
    expect(() =>
      DiagnosisInputSchema.parse({
        rawText: "查询消息 msg_001",
        messageId: "msg_001",
        timeRange: {
          start: "2026-08-31T11:00:00Z",
          end: "2026-08-31T10:00:00Z",
        },
      }),
    ).toThrow("start must be before end");
  });

  it("accepts an insufficient-data diagnosis result", () => {
    const result = DiagnosisResultSchema.parse({
      classification: "insufficient_data",
      facts: [],
      evidence: [],
      possibleCauses: [],
      missingInformation: ["messageId"],
      unsupportedCapabilities: [],
      recommendedAction: "ask_for_more_info",
    });

    expect(result.classification).toBe("insufficient_data");
  });

  it("accepts a typed retryable tool error", () => {
    const error = ToolErrorSchema.parse({
      code: "timeout",
      message: "get_message_status timed out",
      retryable: true,
      details: { timeoutMs: 2000 },
    });

    expect(error.code).toBe("timeout");
  });
});
