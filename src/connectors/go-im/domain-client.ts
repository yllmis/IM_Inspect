import { resolve } from "node:path";
import type { ConnectorRequestContext } from "../../tools/context";
import {
  QueryGrpcClient,
  type GoIMQueryClient,
  type QueryGrpcClientOptions,
} from "./client";
import {
  RawCapabilitiesSchema,
  RawMessageRecordSchema,
  RawSearchMessagesResponseSchema,
} from "./schemas";
import type { ToolError } from "../../domain/errors";
import { mapGrpcError } from "./mappings";

export interface DomainQueryClientOptions {
  message: QueryGrpcClientOptions;
  user: QueryGrpcClientOptions;
  observation: QueryGrpcClientOptions;
}

/**
 * 领域路由是适配器内部的职责：Tools / Agent 仍只看到统一 Connector。
 * 三种 RPC 使用各自的地址和凭证，不回退到旧 OperationsQuery 或直连数据库。
 */
export class DomainQueryGrpcClient implements GoIMQueryClient {
  capabilityFailures: Record<string, ToolError> = {};
  private readonly message: QueryGrpcClient;
  private readonly user: QueryGrpcClient;
  private readonly observation: QueryGrpcClient;

  constructor(options: DomainQueryClientOptions) {
    const opened: QueryGrpcClient[] = [];
    try {
      this.message = new QueryGrpcClient(
        {
          ...options.message,
          protoPath:
            options.message.protoPath ??
            resolve("src/connectors/go-im/proto/message_query.proto"),
        },
        "im.MessageQuery",
      );
      opened.push(this.message);
      this.user = new QueryGrpcClient(
        {
          ...options.user,
          protoPath:
            options.user.protoPath ??
            resolve("src/connectors/go-im/proto/user_query.proto"),
        },
        "user.UserQuery",
      );
      opened.push(this.user);
      this.observation = new QueryGrpcClient(
        options.observation,
        "operations.ObservationQuery",
      );
    } catch (error) {
      opened.forEach((client) => client.close());
      throw error;
    }
  }

  close() {
    this.message.close();
    this.user.close();
    this.observation.close();
  }

  async getMessageRecord(
    ...args: Parameters<GoIMQueryClient["getMessageRecord"]>
  ) {
    const record = RawMessageRecordSchema.parse(
      await this.message.getMessageRecord(...args),
    );
    // MessageQuery 不查询观测数据。没有查询事件，不能声称 eventsAvailable=false。
    return {
      ...record,
      source: "chat_log",
      eventsState: "unknown",
      note: "event-availability-not-queried",
    };
  }

  searchMessages(...args: Parameters<GoIMQueryClient["searchMessages"]>) {
    return this.message.searchMessages(...args);
  }
  findUserReference(...args: Parameters<GoIMQueryClient["findUserReference"]>) {
    return this.user.findUserReference(...args);
  }
  getMessageTimeline(
    ...args: Parameters<GoIMQueryClient["getMessageTimeline"]>
  ) {
    return this.observation.getMessageTimeline(...args);
  }
  getDeliveryTimeline(
    ...args: Parameters<GoIMQueryClient["getDeliveryTimeline"]>
  ) {
    return this.observation.getDeliveryTimeline(...args);
  }
  getConnectionObservations(
    ...args: Parameters<GoIMQueryClient["getConnectionObservations"]>
  ) {
    return this.observation.getConnectionObservations(...args);
  }

  async getCapabilities(context: ConnectorRequestContext, deadline: number) {
    // 观测能力只描述观测。领域查询用受限只读探测确认可用，不能按地址已填写虚报 supported。
    this.capabilityFailures = {};
    const [observation, record, search] = await Promise.allSettled([
      this.observation
        .getCapabilities(context, deadline)
        .then((raw) => RawCapabilitiesSchema.parse(raw)),
      this.message
        .getMessageRecord(
          { messageId: "000000000000000000000000" },
          context,
          deadline,
        )
        .then((raw) => RawMessageRecordSchema.parse(raw)),
      this.message
        .searchMessages(
          {
            senderId: "im-inspect-capability-probe",
            startTime: "1",
            endTime: "2",
            limit: 1,
          },
          context,
          deadline,
        )
        .then((raw) => RawSearchMessagesResponseSchema.parse(raw)),
    ]);
    // 观测服务故障只能影响观测能力，不能阻止独立的消息记录查询。
    if (observation.status === "rejected") {
      for (const capability of [
        "deliveryEvents",
        "historicalPresence",
        "ackTracking",
        "writeFailureEvents",
      ]) {
        this.capabilityFailures[capability] = mapGrpcError(observation.reason);
      }
    }
    if (record.status === "rejected")
      this.capabilityFailures.messageLookup = mapGrpcError(record.reason);
    if (search.status === "rejected")
      this.capabilityFailures.messageSearch = mapGrpcError(search.reason);
    const observed =
      observation.status === "fulfilled"
        ? observation.value
        : RawCapabilitiesSchema.parse({
            deliveryEvents: "unknown",
            historicalConnection: "unknown",
            ackHistory: "unknown",
            writeFailureEvents: "unknown",
          });
    return {
      ...observed,
      messageRecord: record.status === "fulfilled" ? "supported" : "unknown",
      messageSearch: search.status === "fulfilled" ? "supported" : "unknown",
    };
  }
}
