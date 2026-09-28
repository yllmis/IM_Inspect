import {
  credentials,
  loadPackageDefinition,
  Metadata,
  ServiceError,
} from "@grpc/grpc-js";
import { loadSync, PackageDefinition } from "@grpc/proto-loader";
import { resolve } from "node:path";

import type { ConnectorRequestContext } from "../../tools/context";
import {
  RawCapabilities,
  RawConnectionResponse,
  RawDeliveryTimelineResponse,
  RawFindUserReferenceResponse,
  RawMessageRecord,
  RawMessageTimelineResponse,
} from "./schemas";

export interface OperationsQueryClient {
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

export interface OperationsQueryGrpcClientOptions {
  address: string;
  serviceToken?: string;
  protoPath?: string;
  insecure?: boolean;
}

type UnaryClient = {
  [method: string]: (
    request: unknown,
    metadata: Metadata,
    options: { deadline: Date },
    callback: (error: ServiceError | null, response: unknown) => void,
  ) => void;
};

/**
 * 传输层只负责 OperationsQuery gRPC，不负责 Canonical Model 或诊断分类。
 * 这样更换 Go IM 地址/认证方式时，不会把协议细节泄漏到工具和 Agent。
 */
export class OperationsQueryGrpcClient implements OperationsQueryClient {
  private readonly client: UnaryClient;
  private readonly serviceToken?: string;

  constructor(options: OperationsQueryGrpcClientOptions) {
    const protoPath =
      options.protoPath ?? resolve(__dirname, "proto/operations.proto");
    const definition: PackageDefinition = loadSync(protoPath, {
      longs: String,
      enums: String,
      defaults: true,
      keepCase: false,
    });
    const loaded = loadPackageDefinition(definition) as unknown as {
      operations?: {
        OperationsQuery: new (address: string, creds: unknown) => UnaryClient;
      };
    };
    const Service = loaded.operations?.OperationsQuery;
    if (!Service)
      throw new Error("OperationsQuery service is missing from proto");
    this.client = new Service(
      options.address,
      options.insecure === false
        ? credentials.createSsl()
        : credentials.createInsecure(),
    );
    this.serviceToken = options.serviceToken;
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
