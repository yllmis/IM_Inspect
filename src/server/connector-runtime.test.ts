import { describe, expect, it } from "vitest";

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
});
