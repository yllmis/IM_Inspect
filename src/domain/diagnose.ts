import { ConnectionFact } from "./connection";
import {
  DiagnosisInput,
  DiagnosisInputSchema,
  DiagnosisResult,
  DiagnosisResultSchema,
} from "./diagnosis";
import { DeliveryFact } from "./delivery";
import { Evidence, EvidenceConflict } from "./evidence";

const unresolvedConflict = "未自动裁决，需人工或数据源修复";

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  const context = DiagnosisInputSchema.parse(input);
  const conflicts = findConflicts(context);
  const unsupportedCapabilities = Object.entries(context.capabilities ?? {})
    .filter(([, status]) => status === "unsupported")
    .map(([capability]) => capability)
    .sort();

  for (const toolError of context.toolErrors ?? []) {
    if (toolError.error.code !== "unsupported_capability") continue;
    const capability = toolError.error.details?.capability;
    unsupportedCapabilities.push(
      typeof capability === "string"
        ? capability
        : capabilityByTool[toolError.tool],
    );
  }

  const base = {
    possibleCauses: [] as string[],
    unsupportedCapabilities: unique(unsupportedCapabilities),
    message: context.message,
    deliveries: context.deliveries,
    connection: context.connection,
    toolErrors: context.toolErrors,
  };

  if (
    (context.matchResolution && context.matchResolution !== "unique") ||
    context.toolErrors?.some((item) => item.error.code === "ambiguous_match")
  ) {
    return result({
      ...base,
      classification: "insufficient_data",
      facts: [],
      evidence: [],
      missingInformation: ["uniqueMessageMatch"],
      recommendedAction: "ask_for_more_info",
    });
  }

  if (!context.messageId) {
    return result({
      ...base,
      classification: "insufficient_data",
      facts: [],
      evidence: [],
      missingInformation: ["messageId"],
      recommendedAction: "ask_for_more_info",
    });
  }

  if (conflicts.length > 0 || hasToolError(context, "conflicting_evidence")) {
    return result({
      ...base,
      classification: "insufficient_data",
      facts: [],
      evidence: uniqueEvidence(conflicts.flatMap((item) => item.evidence)),
      missingInformation: conflicts.length > 0 ? [] : ["conflictEvidence"],
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      recommendedAction: "escalate",
    });
  }

  const message = context.message;
  if (!message) {
    return insufficient(base, missingFromToolErrors(context, "messageStatus"));
  }

  // 分类顺序固定；先处理阻断条件，再让更强、更具体的事实覆盖一般状态。
  const messageEvidence = message.evidence.filter(
    (item) => item.kind === "message",
  );
  if (!message.exists && messageEvidence.length > 0) {
    if (isUnsupported(context, "messageLookup")) {
      return insufficient(base, ["supportedCapability:messageLookup"]);
    }
    return result({
      ...base,
      classification: "message_not_found",
      facts: [`消息 ${context.messageId} 不存在`],
      evidence: uniqueEvidence(messageEvidence),
      missingInformation: [],
      recommendedAction: "reply",
    });
  }

  const writeEvidence = message.evidence.filter(
    (item) => item.kind === "write",
  );
  if (message.persisted === false && writeEvidence.length > 0) {
    if (isUnsupported(context, "writeFailureEvents")) {
      return insufficient(base, ["supportedCapability:writeFailureEvents"]);
    }
    return result({
      ...base,
      classification: "write_failed",
      facts: [`消息 ${context.messageId} 持久化失败`],
      evidence: uniqueEvidence(writeEvidence),
      missingInformation: [],
      recommendedAction: "escalate",
    });
  }

  const successfulDelivery = context.deliveries?.find(
    (delivery) =>
      delivery.result === "success" &&
      delivery.evidence.some((item) => item.kind === "delivery"),
  );
  if (successfulDelivery) {
    if (isUnsupported(context, "deliveryEvents")) {
      return insufficient(base, ["supportedCapability:deliveryEvents"]);
    }
    return result({
      ...base,
      classification: "delivered",
      facts: [`消息 ${context.messageId} 已成功投递`],
      evidence: uniqueEvidence(
        successfulDelivery.evidence.filter((item) => item.kind === "delivery"),
      ),
      missingInformation: [],
      recommendedAction: "reply",
    });
  }

  const correlatedAttempt = findCorrelatedAttempt(
    context.deliveries,
    context.connection,
  );
  if (correlatedAttempt && context.connection) {
    if (isUnsupported(context, "historicalPresence")) {
      return insufficient(base, ["supportedCapability:historicalPresence"]);
    }
    return result({
      ...base,
      classification: "receiver_offline",
      facts: [`接收者 ${context.connection.userId} 在投递时离线`],
      evidence: uniqueEvidence([
        ...correlatedAttempt.evidence.filter(
          (item) => item.kind === "delivery",
        ),
        ...context.connection.evidence.filter(
          (item) => item.kind === "connection",
        ),
      ]),
      missingInformation: [],
      recommendedAction: "escalate",
    });
  }

  const timedOutDelivery = context.deliveries?.find(
    (delivery) =>
      delivery.result === "timeout" &&
      Boolean(delivery.attemptedAt) &&
      delivery.evidence.some((item) => item.kind === "delivery"),
  );
  if (timedOutDelivery) {
    if (isUnsupported(context, "ackTracking")) {
      return insufficient(base, ["supportedCapability:ackTracking"]);
    }
    return result({
      ...base,
      classification: "ack_timeout",
      facts: [`消息 ${context.messageId} 的 ACK 已超时`],
      evidence: uniqueEvidence(
        timedOutDelivery.evidence.filter((item) => item.kind === "delivery"),
      ),
      missingInformation: [],
      recommendedAction: "escalate",
    });
  }

  const failedDelivery = context.deliveries?.find(
    (delivery) =>
      delivery.result === "failed" &&
      delivery.evidence.some((item) => item.kind === "delivery"),
  );
  const confirmedEmptyDeliveryQuery =
    message.persisted === true &&
    context.deliveries?.length === 0 &&
    context.deliveryQuery?.complete === true;
  if (
    message.persisted === true &&
    (failedDelivery || confirmedEmptyDeliveryQuery)
  ) {
    if (isUnsupported(context, "deliveryEvents")) {
      return insufficient(base, ["supportedCapability:deliveryEvents"]);
    }
    const evidence = failedDelivery
      ? failedDelivery.evidence.filter((item) => item.kind === "delivery")
      : [context.deliveryQuery!.evidence, ...message.evidence];
    return result({
      ...base,
      classification: "not_delivered",
      facts: [
        failedDelivery
          ? `消息 ${context.messageId} 投递失败`
          : `消息 ${context.messageId} 已持久化，但完整查询范围内没有投递事件`,
      ],
      evidence: uniqueEvidence(evidence),
      missingInformation: [],
      recommendedAction: "escalate",
    });
  }

  const missingInformation: string[] = [];
  if (message.persisted === false && writeEvidence.length === 0) {
    missingInformation.push("writeFailureEvidence");
  }
  if (context.deliveries === undefined) {
    missingInformation.push("deliveryEvents");
  } else if (
    context.deliveries.length === 0 &&
    !context.deliveryQuery?.complete
  ) {
    missingInformation.push("completeDeliveryQuery");
  } else if (
    context.deliveries.some((delivery) => delivery.result === "attempted") &&
    !context.connection
  ) {
    missingInformation.push("historicalPresenceOrDeliveryResult");
  } else {
    missingInformation.push("conclusiveDeliveryEvidence");
  }

  const confirmed = confirmedMessageFacts(context.messageId, message);
  return insufficient(
    base,
    unique(missingInformation),
    confirmed.facts,
    confirmed.evidence,
  );
}

function insufficient(
  base: Pick<
    DiagnosisResult,
    | "possibleCauses"
    | "unsupportedCapabilities"
    | "message"
    | "deliveries"
    | "connection"
    | "toolErrors"
  >,
  missingInformation: string[],
  facts: string[] = [],
  evidence: Evidence[] = [],
): DiagnosisResult {
  return result({
    ...base,
    classification: "insufficient_data",
    facts,
    evidence: uniqueEvidence(evidence),
    missingInformation,
    recommendedAction: "ask_for_more_info",
  });
}

function result(value: DiagnosisResult): DiagnosisResult {
  return DiagnosisResultSchema.parse(value);
}

function hasToolError(
  input: DiagnosisInput,
  code: NonNullable<DiagnosisInput["toolErrors"]>[number]["error"]["code"],
): boolean {
  return input.toolErrors?.some((item) => item.error.code === code) ?? false;
}

function missingFromToolErrors(
  input: DiagnosisInput,
  fallback: string,
): string[] {
  const failures = (input.toolErrors ?? []).map(
    (item) => `${item.tool}:${item.error.code}`,
  );
  return failures.length > 0 ? unique(failures) : [fallback];
}

function findCorrelatedAttempt(
  deliveries: DeliveryFact[] | undefined,
  connection: ConnectionFact | undefined,
): DeliveryFact | undefined {
  if (
    !connection ||
    !connection.historical ||
    connection.state !== "offline" ||
    !connection.observedAt ||
    !connection.evidence.some((item) => item.kind === "connection")
  ) {
    return undefined;
  }

  return deliveries?.find(
    (delivery) =>
      delivery.result === "attempted" &&
      delivery.attemptedAt === connection.observedAt &&
      delivery.receiverId === connection.userId &&
      delivery.evidence.some((item) => item.kind === "delivery"),
  );
}

function confirmedMessageFacts(
  messageId: string,
  message: NonNullable<DiagnosisInput["message"]>,
): { facts: string[]; evidence: Evidence[] } {
  const evidence = message.evidence.filter((item) => item.kind === "message");
  if (evidence.length === 0) return { facts: [], evidence: [] };

  if (message.persisted === true) {
    return {
      facts: [`消息 ${messageId} 已持久化`],
      evidence,
    };
  }
  if (message.exists) {
    return {
      facts: [`消息 ${messageId} 存在`],
      evidence,
    };
  }
  return { facts: [], evidence: [] };
}

function isUnsupported(input: DiagnosisInput, capability: string): boolean {
  return input.capabilities?.[capability] === "unsupported";
}

function findConflicts(input: DiagnosisInput): EvidenceConflict[] {
  const conflicts = [...(input.conflicts ?? [])];
  const message = input.message;
  const deliveries = input.deliveries ?? [];

  if (message && input.messageId && message.messageId !== input.messageId) {
    conflicts.push(conflict("messageId", message.evidence));
  }

  const mismatchedDeliveries = deliveries.filter(
    (delivery) => input.messageId && delivery.messageId !== input.messageId,
  );
  if (mismatchedDeliveries.length > 0) {
    conflicts.push(
      conflict(
        "delivery.messageId",
        mismatchedDeliveries.flatMap((delivery) => delivery.evidence),
      ),
    );
  }

  if (message && !message.exists && deliveries.length > 0) {
    conflicts.push(
      conflict("message.exists", [
        ...message.evidence,
        ...deliveries.flatMap((delivery) => delivery.evidence),
      ]),
    );
  }

  if (
    message?.persisted === false &&
    ["persisted", "queued", "delivering", "delivered", "acknowledged"].includes(
      message.status,
    )
  ) {
    conflicts.push(conflict("message.persistenceStatus", message.evidence));
  }

  if (
    message?.status === "delivered" &&
    deliveries.length > 0 &&
    !deliveries.some((delivery) => delivery.result === "success")
  ) {
    conflicts.push(
      conflict("delivery.status", [
        ...message.evidence,
        ...deliveries.flatMap((delivery) => delivery.evidence),
      ]),
    );
  }

  const attempts = new Map<string, DeliveryFact[]>();
  for (const delivery of deliveries) {
    if (!delivery.attemptId) continue;
    attempts.set(delivery.attemptId, [
      ...(attempts.get(delivery.attemptId) ?? []),
      delivery,
    ]);
  }
  for (const [attemptId, facts] of attempts) {
    if (new Set(facts.map((fact) => fact.result)).size > 1) {
      conflicts.push(
        conflict(
          `delivery.attempt:${attemptId}`,
          facts.flatMap((fact) => fact.evidence),
        ),
      );
    }
  }

  const evidenceById = new Map<string, Evidence[]>();
  for (const evidence of collectEvidence(input)) {
    evidenceById.set(evidence.id, [
      ...(evidenceById.get(evidence.id) ?? []),
      evidence,
    ]);
  }
  for (const [evidenceId, evidence] of evidenceById) {
    if (new Set(evidence.map(stableEvidence)).size > 1) {
      conflicts.push(conflict(`evidence:${evidenceId}`, evidence));
    }
  }

  return deduplicateConflicts(conflicts);
}

function conflict(subject: string, evidence: Evidence[]): EvidenceConflict {
  return {
    subject,
    evidence: uniqueEvidence(evidence),
    resolution: unresolvedConflict,
  };
}

function collectEvidence(input: DiagnosisInput): Evidence[] {
  return [
    ...(input.message?.evidence ?? []),
    ...(input.deliveries?.flatMap((delivery) => delivery.evidence) ?? []),
    ...(input.connection?.evidence ?? []),
    ...(input.deliveryQuery ? [input.deliveryQuery.evidence] : []),
  ];
}

function uniqueEvidence(evidence: Evidence[]): Evidence[] {
  const uniqueItems = new Map<string, Evidence>();
  for (const item of evidence) {
    uniqueItems.set(`${item.id}:${stableEvidence(item)}`, item);
  }
  return [...uniqueItems.values()];
}

function stableEvidence(evidence: Evidence): string {
  return JSON.stringify(evidence);
}

function deduplicateConflicts(
  conflicts: EvidenceConflict[],
): EvidenceConflict[] {
  const uniqueItems = new Map<string, EvidenceConflict>();
  for (const item of conflicts) uniqueItems.set(item.subject, item);
  return [...uniqueItems.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const capabilityByTool = {
  find_user_or_message: "messageLookup",
  get_message_status: "messageLookup",
  get_delivery_events: "deliveryEvents",
  get_connection_status: "historicalPresence",
} as const;
