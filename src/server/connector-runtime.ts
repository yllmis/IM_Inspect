import type { Connector } from "../connectors/connector";
import { FakeConnector } from "../connectors/fake/fake-connector";
import { createGoIMConnector } from "../connectors/go-im/go-im-connector";

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
    bootstrapContext: {
      tenantId: "tenant_demo",
      actorId: "connector_bootstrap",
      requestId: "connector_bootstrap",
      runId: "connector_bootstrap",
    },
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

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConnectorConfigurationError(
    "invalid_mode",
    "GO_IM_INSECURE must be true or false",
  );
}
