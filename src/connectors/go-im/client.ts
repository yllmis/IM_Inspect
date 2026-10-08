import {
  credentials,
  loadPackageDefinition,
  Metadata,
  ServiceError,
} from "@grpc/grpc-js";
import { loadSync, PackageDefinition } from "@grpc/proto-loader";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import type { ConnectorRequestContext } from "../../tools/context";
import {
  RawCapabilities,
  RawConnectionResponse,
  RawDeliveryTimelineResponse,
  RawFindUserReferenceResponse,
  RawMessageRecord,
  RawMessageTimelineResponse,
  RawSearchMessagesResponse,
} from "./schemas";

export interface GoIMQueryClient {
  searchMessages(
    request: {
      senderId: string;
      receiverId?: string;
      startTime: string;
      endTime: string;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  findUserReference(
    request: { userId?: string; nickname?: string; limit: number },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  getMessageRecord(
    request: { messageId: string },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  getMessageTimeline(
    request: {
      messageId: string;
      startTime?: string;
      endTime?: string;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  getDeliveryTimeline(
    request: { messageId: string; receiverId?: string; limit: number },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  getConnectionObservations(
    request: {
      userId: string;
      at: string;
      includeCurrent: boolean;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
  getCapabilities(
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown>;
}

/** 迁移期类型别名，不代表新 Connector 继续调用旧服务。 */
export type OperationsQueryClient = GoIMQueryClient;

export interface QueryGrpcClientOptions {
  address: string;
  serviceToken?: string;
  protoPath?: string;
  insecure?: boolean;
  /** 私有 CA 只供服务端 gRPC 使用，不能暴露给浏览器。 */
  rootCertificatePath?: string;
}

export type OperationsQueryGrpcClientOptions = QueryGrpcClientOptions;

export type QueryContract =
  | "operations.OperationsQuery"
  | "operations.ObservationQuery"
  | "im.MessageQuery"
  | "user.UserQuery";

type UnaryClient = {
  [method: string]: (
    request: unknown,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: ServiceError | null, response: unknown) => void,
  ) => void;
} & { close(): void };

/**
 * 传输层只负责指定只读契约的 gRPC，不负责 Canonical Model 或诊断分类。
 * 这样更换 Go IM 地址/认证方式时，不会把协议细节泄漏到工具和 Agent。
 */
export class QueryGrpcClient implements GoIMQueryClient {
  private readonly client: UnaryClient;
  private readonly serviceToken?: string;

  constructor(options: QueryGrpcClientOptions, contract: QueryContract) {
    const protoPath =
      // Next.js 打包后 __dirname 指向 .next，不能再用源码目录定位 proto。
      // 默认路径相对应用根目录；部署到其它目录时仍可显式指定 protoPath。
      options.protoPath ??
      resolve(process.cwd(), "src/connectors/go-im/proto/operations.proto");
    const definition: PackageDefinition = loadSync(protoPath, {
      longs: String,
      enums: String,
      defaults: true,
      keepCase: false,
    });
    const loaded = loadPackageDefinition(definition) as unknown as Record<
      string,
      Record<string, new (address: string, creds: unknown) => UnaryClient>
    >;
    const [namespace, service] = contract.split(".");
    const Service = loaded[namespace]?.[service];
    if (!Service) throw new Error(`${contract} service is missing from proto`);
    this.client = new Service(
      options.address,
      options.insecure === false
        ? credentials.createSsl(
            options.rootCertificatePath
              ? readFileSync(options.rootCertificatePath)
              : undefined,
          )
        : credentials.createInsecure(),
    );
    this.serviceToken = options.serviceToken;
  }

  /** 释放 gRPC 通道，供隔离测试和服务关闭使用；不会执行任何 IM 写操作。 */
  close(): void {
    this.client.close();
  }

  findUserReference(
    request: { userId?: string; nickname?: string; limit: number },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "findUserReference",
      request,
      context,
      deadline,
    ) as Promise<RawFindUserReferenceResponse>;
  }

  searchMessages(
    request: {
      senderId: string;
      receiverId?: string;
      startTime: string;
      endTime: string;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "searchMessages",
      request,
      context,
      deadline,
    ) as Promise<RawSearchMessagesResponse>;
  }

  getMessageRecord(
    request: { messageId: string },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "getMessageRecord",
      request,
      context,
      deadline,
    ) as Promise<RawMessageRecord>;
  }

  getMessageTimeline(
    request: {
      messageId: string;
      startTime?: string;
      endTime?: string;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "getMessageTimeline",
      request,
      context,
      deadline,
    ) as Promise<RawMessageTimelineResponse>;
  }

  getDeliveryTimeline(
    request: { messageId: string; receiverId?: string; limit: number },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "getDeliveryTimeline",
      request,
      context,
      deadline,
    ) as Promise<RawDeliveryTimelineResponse>;
  }

  getConnectionObservations(
    request: {
      userId: string;
      at: string;
      includeCurrent: boolean;
      limit: number;
    },
    context: ConnectorRequestContext,
    deadline: number,
  ) {
    return this.call(
      "getConnectionObservations",
      request,
      context,
      deadline,
    ) as Promise<RawConnectionResponse>;
  }

  getCapabilities(context: ConnectorRequestContext, deadline: number) {
    return this.call(
      "getCapabilities",
      {},
      context,
      deadline,
    ) as Promise<RawCapabilities>;
  }

  private call(
    method: string,
    request: unknown,
    context: ConnectorRequestContext,
    deadline: number,
  ): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const metadata = new Metadata();
      if (this.serviceToken)
        metadata.set("x-im-service-token", this.serviceToken);
      metadata.set("x-request-id", context.requestId);
      metadata.set("x-agent-run-id", context.runId);
      const fn = this.client[method];
      if (!fn) {
        reject(
          Object.assign(
            new Error(`OperationsQuery method ${method} is unavailable`),
            { code: 12 },
          ),
        );
        return;
      }
      fn.call(
        this.client,
        request,
        metadata,
        { deadline: new Date(deadline) },
        (error, response) => {
          if (error) reject(error);
          else resolvePromise(response);
        },
      );
    });
  }
}

/** 旧入口仅用于显式 legacy 配置和兼容测试。 */
export class OperationsQueryGrpcClient extends QueryGrpcClient {
  constructor(options: OperationsQueryGrpcClientOptions) {
    super(options, "operations.OperationsQuery");
  }
}
