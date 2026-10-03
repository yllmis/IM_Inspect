import { z } from "zod";

import {
  ConnectionStatusInput,
  ConnectionStatusInputSchema,
  Connector,
  ConnectorResult,
  DeliveryEventsInput,
  DeliveryEventsInputSchema,
  DeliveryEventsPage,
  DeliveryEventsPageSchema,
  FindUserOrMessageInput,
  FindUserOrMessageInputSchema,
  FindUserOrMessageResult,
  FindUserOrMessageResultSchema,
  MessageLookupInput,
  MessageLookupInputSchema,
} from "../connector";
import type { ConnectionFact } from "../../domain/connection";
import { ConnectionFactSchema } from "../../domain/connection";
import { MessageFact, MessageFactSchema } from "../../domain/message";
import { ConnectorCapabilitiesSchema, ToolError } from "../../domain/errors";
import { ConnectorCapabilities } from "../../domain/errors";
import { ConnectorRequestContext } from "../../tools/context";
import {
  OperationsQueryClient,
  OperationsQueryGrpcClient,
  OperationsQueryGrpcClientOptions,
} from "./client";
import {
  mapCapabilities,
  mapConnectionResponse,
  mapDeliveryTimeline,
  mapGrpcError,
  mapMessageMatches,
  mapMessageRecord,
  mapUserMatches,
  unixNanoToIso,
} from "./mappings";
import {
  RawCapabilitiesSchema,
  RawConnectionResponseSchema,
  RawDeliveryTimelineResponseSchema,
  RawFindUserReferenceResponseSchema,
  RawMessageRecordSchema,
  RawSearchMessagesResponseSchema,
} from "./schemas";

const SOURCE = "go-im-operations-query";
const UNKNOWN_CAPABILITIES: ConnectorCapabilities = {
  // 隧道/网络/权限导致 GetCapabilities 失败时只能标记 unknown。
  // 标记 unsupported 会被 Tool 层提前拦截，掩盖真正的 dependency_unavailable。
  messageLookup: "unknown",
  messageSearch: "unknown",
  deliveryEvents: "unknown",
  historicalPresence: "unknown",
  ackTracking: "unknown",
  writeFailureEvents: "unknown",
};

export interface GoIMConnectorOptions {
  client: OperationsQueryClient;
  capabilities: ConnectorCapabilities;
  /** 能力初始化失败必须保留真实错误，不能伪装成“能力不支持”。 */
  bootstrapFailure?: ToolError;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * GoIMConnector 是 IM 适配器：OperationsQuery 的协议字段在这里变成 Agent 的 Canonical Model。
 * 它不连接数据库，也不调用 diagnose；诊断分类仍由确定性诊断引擎负责。
 */
export class GoIMConnector implements Connector {
  private readonly client: OperationsQueryClient;
  private readonly capabilities: ConnectorCapabilities;
  private readonly bootstrapFailure?: ToolError;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: GoIMConnectorOptions) {
    this.client = options.client;
    this.capabilities = ConnectorCapabilitiesSchema.parse(options.capabilities);
    this.bootstrapFailure = options.bootstrapFailure;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  getCapabilities(): ConnectorCapabilities {
    return { ...this.capabilities };
  }

  async findUserOrMessage(
    input: FindUserOrMessageInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<FindUserOrMessageResult>> {
    const parsed = FindUserOrMessageInputSchema.parse(input);
    if (
      parsed.conversationId &&
      !parsed.messageId &&
      !parsed.userId &&
      !parsed.displayName
    ) {
      return this.failure(
        "unsupported_capability",
        "OperationsQuery does not expose conversation lookup",
        false,
        { capability: "conversationLookup" },
      );
    }
    if (parsed.messageId) {
      const result = await this.getMessageRecord(parsed.messageId, context);
      if (!result.ok) return result as ConnectorResult<FindUserOrMessageResult>;
      if (!result.data) {
        return this.success({
          resolutionStatus: "none",
          matches: [],
          truncated: false,
        });
      }
      const message = result.data;
      return this.success({
        resolutionStatus: "unique",
        matches: [
          {
            entityType: "message",
            messageId: message.messageId,
            // FindMatch.userId 表示消息发送方；接收方通过后续 MessageFact 保留。
            userId: message.senderId,
            receiverId: message.receiverId,
            conversationId: message.conversationId,
            observedAt:
              message.statusAt ?? message.createdAt ?? this.now().toISOString(),
            evidence: message.evidence,
          },
        ],
        truncated: false,
      });
    }
    if (parsed.userId && parsed.timeRange) {
      const capabilityError = this.requireCapability("messageSearch");
      if (capabilityError)
        return capabilityError as ConnectorResult<FindUserOrMessageResult>;
      try {
        const raw = RawSearchMessagesResponseSchema.parse(
          await this.client.searchMessages(
            {
              senderId: parsed.userId,
              startTime: toUnixNano(parsed.timeRange.start),
              endTime: toUnixNano(parsed.timeRange.end),
              limit: parsed.limit,
            },
            context,
            this.deadline(context),
          ),
        );
        const matches = mapMessageMatches(raw);
        // 数据源也可能返回错对象；Schema 只能验形状，这里再验查询关联关系。
        if (
          raw.messages.some(
            (row) =>
              row.senderId !== parsed.userId ||
              !/^[a-f0-9]{24}$/i.test(row.messageId) ||
              BigInt(row.createdAt) <
                BigInt(toUnixNano(parsed.timeRange!.start)) ||
              BigInt(row.createdAt) > BigInt(toUnixNano(parsed.timeRange!.end)),
          )
        )
          throw new Error(
            "message search returned a row outside the requested scope",
          );
        if (!unixNanoToIso(raw.observedAt))
          throw new Error("message search is missing observedAt");
        return this.success(
          FindUserOrMessageResultSchema.parse({
            resolutionStatus:
              matches.length === 0
                ? "none"
                : matches.length === 1 && !raw.truncated
                  ? "unique"
                  : "multiple",
            matches: matches.slice(0, parsed.limit),
            truncated: raw.truncated || matches.length > parsed.limit,
          }),
        );
      } catch (error) {
        return this.failureFrom(error);
      }
    }
    const capabilityError = this.requireCapability("messageLookup");
    if (capabilityError)
      return capabilityError as ConnectorResult<FindUserOrMessageResult>;
    try {
      const raw = RawFindUserReferenceResponseSchema.parse(
        await this.client.findUserReference(
          {
            userId: parsed.userId,
            nickname: parsed.displayName,
            limit: parsed.limit,
          },
          context,
          this.deadline(context),
        ),
      );
      const matches = mapUserMatches(raw).map((match) => ({ ...match }));
      return this.success(
        FindUserOrMessageResultSchema.parse({
          resolutionStatus:
            matches.length === 0
              ? "none"
              : matches.length === 1
                ? "unique"
                : "multiple",
          matches,
          truncated: raw.users.length > parsed.limit,
        }),
      );
    } catch (error) {
      return this.failureFrom(error);
    }
  }

  async getMessageStatus(
    input: MessageLookupInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<MessageFact>> {
    const parsed = MessageLookupInputSchema.parse(input);
    const capabilityError = this.requireCapability("messageLookup");
    if (capabilityError) return capabilityError as ConnectorResult<MessageFact>;
    try {
      const raw = RawMessageRecordSchema.parse(
        await this.client.getMessageRecord(
          { messageId: parsed.messageId },
          context,
          this.deadline(context),
        ),
      );
      if (!raw.found) {
        const observedAt = unixNanoToIso(raw.observedAt);
        if (!observedAt)
          throw new Error("not-found message response is missing observedAt");
        return this.success({
          messageId: parsed.messageId,
          status: "unknown",
          exists: false,
          persisted: null,
          statusAt: observedAt,
          evidence: [
            {
              id: `${SOURCE}:${parsed.messageId}:not-found`,
              source: raw.source || SOURCE,
              kind: "message",
              observedAt,
              field: "message_record",
              value: "not_found",
            },
          ],
        });
      }
      return this.success(
        MessageFactSchema.parse(mapMessageRecord(raw, parsed.messageId)),
      );
    } catch (error) {
      return this.failureFrom(error);
    }
  }

  async getDeliveryEvents(
    input: DeliveryEventsInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<DeliveryEventsPage>> {
    const parsed = DeliveryEventsInputSchema.parse(input);
    const capabilityError = this.requireCapability("deliveryEvents");
    if (capabilityError)
      return capabilityError as ConnectorResult<DeliveryEventsPage>;
    try {
      const raw = RawDeliveryTimelineResponseSchema.parse(
        await this.client.getDeliveryTimeline(
          { messageId: parsed.messageId, limit: parsed.limit },
          context,
          this.deadline(context),
        ),
      );
      const mapped = mapDeliveryTimeline(raw, parsed.messageId);
      const effectiveTimeRange =
        parsed.timeRange ?? this.timeRangeForEvents(mapped.events);
      const truncated = raw.truncated || mapped.eventsDropped > 0;
      const events = parsed.timeRange
        ? mapped.events.filter((event) => {
            const timestamp =
              event.attemptedAt ?? event.deliveredAt ?? event.ackedAt;
            return timestamp
              ? Date.parse(timestamp) >= Date.parse(effectiveTimeRange.start) &&
                  Date.parse(timestamp) <= Date.parse(effectiveTimeRange.end)
              : false;
          })
        : mapped.events;
      return this.success(
        DeliveryEventsPageSchema.parse({
          events: events.slice(0, parsed.limit),
          complete:
            raw.complete && mapped.coverageStatus === "complete" && !truncated,
          truncated,
          coverageStatus: mapped.coverageStatus,
          eventsDropped: mapped.eventsDropped,
          effectiveTimeRange,
          sourceReference: `${SOURCE}:${parsed.messageId}:delivery`,
        }),
      );
    } catch (error) {
      return this.failureFrom(error);
    }
  }

  async getConnectionStatus(
    input: ConnectionStatusInput,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<ConnectionFact>> {
    const parsed = ConnectionStatusInputSchema.parse(input);
    const capabilityError = this.requireCapability("historicalPresence");
    if (capabilityError)
      return capabilityError as ConnectorResult<ConnectionFact>;
    try {
      const raw = RawConnectionResponseSchema.parse(
        await this.client.getConnectionObservations(
          {
            userId: parsed.userId,
            at: toUnixNano(parsed.at),
            includeCurrent: true,
            limit: 20,
          },
          context,
          this.deadline(context),
        ),
      );
      const connection = mapConnectionResponse(raw, parsed.userId);
      if (!connection)
        return this.failure(
          "not_found",
          "connection observation was not found",
          false,
          { userId: parsed.userId },
        );
      return this.success(ConnectionFactSchema.parse(connection));
    } catch (error) {
      return this.failureFrom(error);
    }
  }

  private getMessageRecord(
    messageId: string,
    context: ConnectorRequestContext,
  ): Promise<ConnectorResult<MessageFact | null>> {
    const capabilityError = this.requireCapability("messageLookup");
    if (capabilityError)
      return Promise.resolve(
        capabilityError as ConnectorResult<MessageFact | null>,
      );
    return this.client
      .getMessageRecord({ messageId }, context, this.deadline(context))
      .then((value) => {
        const raw = RawMessageRecordSchema.parse(value);
        return this.success(
          raw.found
            ? MessageFactSchema.parse(mapMessageRecord(raw, messageId))
            : null,
        );
      })
      .catch((error) => this.failureFrom(error));
  }

  private deadline(context: ConnectorRequestContext): number {
    // ToolRegistry 还有一层超时；Connector 自己设置 deadline，避免 gRPC 无限等待。
    void context;
    return Date.now() + Math.max(1, Math.min(10_000, this.timeoutMs));
  }

  private defaultTimeRange(): { start: string; end: string } {
    const end = this.now();
    return {
      start: new Date(end.getTime() - 86_400_000).toISOString(),
      end: end.toISOString(),
    };
  }

  private timeRangeForEvents(
    events: Array<{
      attemptedAt?: string;
      deliveredAt?: string;
      ackedAt?: string;
    }>,
  ): { start: string; end: string } {
    const timestamps = events
      .flatMap((event) => [event.attemptedAt, event.deliveredAt, event.ackedAt])
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value));
    if (timestamps.length === 0) return this.defaultTimeRange();
    return {
      start: new Date(Math.min(...timestamps) - 1).toISOString(),
      end: new Date(Math.max(...timestamps) + 1).toISOString(),
    };
  }

  private requireCapability(
    capability: string,
  ): ConnectorResult<never> | undefined {
    if (this.bootstrapFailure) {
      return this.failure(
        this.bootstrapFailure.code,
        this.bootstrapFailure.message,
        this.bootstrapFailure.retryable,
        this.bootstrapFailure.details,
      );
    }
    if (this.capabilities[capability] === "unsupported") {
      return this.failure(
        "unsupported_capability",
        `${capability} is not supported by Go IM`,
        false,
        { capability },
      );
    }
    return undefined;
  }

  private success<T>(data: T): ConnectorResult<T> {
    return { ok: true, source: SOURCE, data };
  }

  private failure<T = never>(
    code: ToolError["code"],
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
  ): ConnectorResult<T> {
    return {
      ok: false,
      source: SOURCE,
      error: { code, message, retryable, details },
    };
  }

  private failureFrom<T = never>(error: unknown): ConnectorResult<T> {
    const mapped = mapGrpcError(error);
    return this.failure(
      mapped.code,
      mapped.message,
      mapped.retryable,
      mapped.details,
    );
  }
}

/** 启动时读取一次能力，之后每个请求复用快照，避免模型运行中能力漂移。 */
export async function createGoIMConnector(
  options: OperationsQueryGrpcClientOptions & {
    bootstrapContext: ConnectorRequestContext;
  },
): Promise<GoIMConnector> {
  const client = new OperationsQueryGrpcClient(options);
  try {
    const raw = RawCapabilitiesSchema.parse(
      await client.getCapabilities(
        options.bootstrapContext,
        Date.now() + 3_000,
      ),
    );
    return new GoIMConnector({ client, capabilities: mapCapabilities(raw) });
  } catch (error) {
    // 能力读取失败时保留真实依赖错误；不能把权限/网络故障伪装成能力不支持。
    return new GoIMConnector({
      client,
      capabilities: UNKNOWN_CAPABILITIES,
      bootstrapFailure: mapGrpcError(error),
    });
  }
}

function toUnixNano(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new z.ZodError([]);
  return (BigInt(millis) * BigInt(1_000_000)).toString();
}
