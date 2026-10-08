import type { Connector } from "../connectors/connector";
import { FakeConnector } from "../connectors/fake/fake-connector";
import {
  createDomainGoIMConnector,
  createGoIMConnector,
} from "../connectors/go-im/go-im-connector";

export type ConnectorMode = "fake" | "go-im";

export class ConnectorConfigurationError extends Error {
  constructor(
    readonly code: "invalid_mode" | "go_im_address_missing",
    message: string,
  ) {
    super(message);
    this.name = "ConnectorConfigurationError";
  }
}

/**
 * Connector 工厂是本地演示与真实 IM 的切换边界。
 * Route 和 Agent 只依赖 Connector 接口，不能自行读取 Go IM 地址或选择 Fixture。
 */
export async function createConnectorFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Connector> {
  const mode = readConnectorMode(environment.IM_INSPECT_CONNECTOR);
  if (mode === "fake") {
    return new FakeConnector(environment.FAKE_CONNECTOR_FIXTURE ?? "delivered");
  }

  const bootstrapContext = {
    tenantId: "tenant_demo",
    actorId: "connector_bootstrap",
    requestId: "connector_bootstrap",
    runId: "connector_bootstrap",
  };
  // 已有旧配置保持可运行；只要出现任何新领域配置，就必须完整校验，不能静默回退。
  const hasDomainConfiguration = Object.keys(environment).some(
    (key) => /^GO_IM_(MESSAGE|USER|OBSERVATION)_/.test(key) && environment[key],
  );
  const contractMode =
    environment.GO_IM_QUERY_CONTRACT?.trim() ||
    (environment.GO_IM_OPERATIONS_GRPC_URL && !hasDomainConfiguration
      ? "legacy"
      : "domain");
  if (contractMode !== "domain" && contractMode !== "legacy") {
    throw new ConnectorConfigurationError(
      "invalid_mode",
      "GO_IM_QUERY_CONTRACT must be domain or legacy",
    );
  }
  if (contractMode === "domain") {
    const endpoint = (kind: "MESSAGE" | "USER" | "OBSERVATION") => {
      const address = environment[`GO_IM_${kind}_GRPC_URL`]?.trim();
      const serviceToken = emptyToUndefined(
        environment[`GO_IM_${kind}_SERVICE_TOKEN`],
      );
      if (!address)
        throw new ConnectorConfigurationError(
          "go_im_address_missing",
          `GO_IM_${kind}_GRPC_URL is required in domain mode`,
        );
      if (!serviceToken)
        throw new ConnectorConfigurationError(
          "invalid_mode",
          `GO_IM_${kind}_SERVICE_TOKEN is required in domain mode`,
        );
      const insecure = readBoolean(environment.GO_IM_INSECURE, false);
      const allowInsecureRemote = readBoolean(
        environment.GO_IM_ALLOW_INSECURE_REMOTE,
        false,
        "GO_IM_ALLOW_INSECURE_REMOTE",
      );
      // 远程明文默认拒绝；自用环境显式接受风险时可启用，仍必须携带服务凭证。
      if (
        insecure &&
        !allowInsecureRemote &&
        !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(address)
      ) {
        throw new ConnectorConfigurationError(
          "invalid_mode",
          "domain mode requires TLS for non-loopback endpoints",
        );
      }
      return {
        address,
        serviceToken,
        insecure,
        protoPath: emptyToUndefined(environment[`GO_IM_${kind}_PROTO_PATH`]),
        rootCertificatePath: emptyToUndefined(environment.GO_IM_TLS_CA_PATH),
      };
    };
    return createDomainGoIMConnector({
      message: endpoint("MESSAGE"),
      user: endpoint("USER"),
      observation: endpoint("OBSERVATION"),
      bootstrapContext,
    });
  }

  const address = environment.GO_IM_OPERATIONS_GRPC_URL?.trim();
  if (!address) {
    throw new ConnectorConfigurationError(
      "go_im_address_missing",
      "GO_IM_OPERATIONS_GRPC_URL is required in go-im mode",
    );
  }

  return createGoIMConnector({
    address,
    serviceToken: emptyToUndefined(environment.GO_IM_SERVICE_TOKEN),
    protoPath: emptyToUndefined(environment.GO_IM_OPERATIONS_PROTO_PATH),
    insecure: readBoolean(environment.GO_IM_INSECURE, true),
    bootstrapContext,
  });
}

export function readConnectorMode(value?: string): ConnectorMode {
  const normalized = value?.trim().toLowerCase() || "fake";
  if (normalized === "fake" || normalized === "go-im") return normalized;
  throw new ConnectorConfigurationError(
    "invalid_mode",
    "IM_INSPECT_CONNECTOR must be fake or go-im",
  );
}

function emptyToUndefined(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  key = "GO_IM_INSECURE",
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConnectorConfigurationError(
    "invalid_mode",
    `${key} must be true or false`,
  );
}
