import { describe, expect, it, vi } from "vitest";
import { createDomainGoIMConnector } from "../connectors/go-im/go-im-connector";

// 工厂路由测试不发网络请求，真实 gRPC 和鉴权由独立联调测试验证。
vi.mock("../connectors/go-im/go-im-connector", () => ({
  createDomainGoIMConnector: vi.fn(async () => ({ synthetic: true })),
  createGoIMConnector: vi.fn(async () => ({ synthetic: true })),
}));

import { FakeConnector } from "../connectors/fake/fake-connector";
import {
  ConnectorConfigurationError,
  createConnectorFromEnvironment,
  readConnectorMode,
} from "./connector-runtime";

describe("Connector runtime", () => {
  it("默认使用可重复的 Fake Connector", async () => {
    const connector = await createConnectorFromEnvironment({});
    expect(connector).toBeInstanceOf(FakeConnector);
    expect(connector.getCapabilities().messageLookup).toBe("supported");
  });

  it("允许选择指定的 Fake Fixture", async () => {
    const connector = await createConnectorFromEnvironment({
      IM_INSPECT_CONNECTOR: "fake",
      FAKE_CONNECTOR_FIXTURE: "receiver_offline",
    });
    expect(connector).toBeInstanceOf(FakeConnector);
    expect(connector.getCapabilities().historicalPresence).toBe("supported");
  });

  it("Go IM 模式缺少地址时拒绝启动，而不是回退到 Fake", async () => {
    await expect(
      createConnectorFromEnvironment({ IM_INSPECT_CONNECTOR: "go-im" }),
    ).rejects.toMatchObject({
      name: "ConnectorConfigurationError",
      code: "go_im_address_missing",
    });
  });

  it("拒绝拼写错误的 Connector 模式", () => {
    expect(() => readConnectorMode("goim")).toThrow(
      ConnectorConfigurationError,
    );
  });

  it("领域模式不回退到旧地址或 Fake", async () => {
    await expect(
      createConnectorFromEnvironment({
        IM_INSPECT_CONNECTOR: "go-im",
        GO_IM_QUERY_CONTRACT: "domain",
        GO_IM_OPERATIONS_GRPC_URL: "127.0.0.1:9100",
      }),
    ).rejects.toMatchObject({ code: "go_im_address_missing" });
  });

  it("公网领域查询拒绝明文传输服务凭证", async () => {
    await expect(
      createConnectorFromEnvironment({
        IM_INSPECT_CONNECTOR: "go-im",
        GO_IM_MESSAGE_GRPC_URL: "example.com:9100",
        GO_IM_MESSAGE_SERVICE_TOKEN: "test-only",
        GO_IM_INSECURE: "true",
      }),
    ).rejects.toMatchObject({
      name: "ConnectorConfigurationError",
      code: "invalid_mode",
    });
  });

  it("出现部分新配置时也必须校验，不能静默调用旧入口", async () => {
    await expect(
      createConnectorFromEnvironment({
        IM_INSPECT_CONNECTOR: "go-im",
        GO_IM_OPERATIONS_GRPC_URL: "127.0.0.1:9100",
        GO_IM_USER_GRPC_URL: "127.0.0.1:19103",
      }),
    ).rejects.toMatchObject({ code: "go_im_address_missing" });
  });

  const directEnvironment = {
    IM_INSPECT_CONNECTOR: "go-im",
    GO_IM_QUERY_CONTRACT: "domain",
    GO_IM_MESSAGE_GRPC_URL: "example.com:10002",
    GO_IM_USER_GRPC_URL: "example.com:10000",
    GO_IM_OBSERVATION_GRPC_URL: "example.com:9100",
    GO_IM_MESSAGE_SERVICE_TOKEN: "message-test-only",
    GO_IM_USER_SERVICE_TOKEN: "user-test-only",
    GO_IM_OBSERVATION_SERVICE_TOKEN: "observation-test-only",
    GO_IM_INSECURE: "true",
  };

  it("自用环境只有显式允许远程明文才分流，仍带各自凭证", async () => {
    vi.mocked(createDomainGoIMConnector).mockClear();
    await createConnectorFromEnvironment({
      ...directEnvironment,
      GO_IM_ALLOW_INSECURE_REMOTE: "true",
    });
    expect(createDomainGoIMConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          address: "example.com:10002",
          insecure: true,
          serviceToken: "message-test-only",
        }),
        user: expect.objectContaining({
          address: "example.com:10000",
          insecure: true,
          serviceToken: "user-test-only",
        }),
        observation: expect.objectContaining({
          address: "example.com:9100",
          insecure: true,
          serviceToken: "observation-test-only",
        }),
      }),
    );
  });

  it("显式允许远程明文不绕过服务凭证校验", async () => {
    await expect(
      createConnectorFromEnvironment({
        ...directEnvironment,
        GO_IM_ALLOW_INSECURE_REMOTE: "true",
        GO_IM_USER_SERVICE_TOKEN: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_mode" });
  });

  it("风险开关拒绝非布尔值，不能用 truthy 字符串放行", async () => {
    await expect(
      createConnectorFromEnvironment({
        ...directEnvironment,
        GO_IM_ALLOW_INSECURE_REMOTE: "yes",
      }),
    ).rejects.toMatchObject({ code: "invalid_mode" });
  });
});
