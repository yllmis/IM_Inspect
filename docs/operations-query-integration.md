# OperationsQuery 接入参考

## 1. 这是什么

OperationsQuery 是 IM 侧提供给诊断 Agent 的**只读查询门面**。它的目标不是替换现有的用户 RPC、消息 RPC 或存储，而是把技术人员已经能够执行的安全查询，包装成稳定、可鉴权、可限时、可审计的接口。

```text
Agent Tool
  -> GoIMConnector（TypeScript Adapter）
  -> OperationsQuery（IM 侧只读门面）
  -> 现有 RPC / 查询服务 / 观测事件
```

本项目提供的是推荐契约和参考实现。接入方可以：

- 直接实现这组 gRPC RPC；
- 在已有内部服务上提供语义等价的 HTTP/gRPC 接口；
- 继续保留原有 RPC，由 OperationsQuery 在 IM 内部调用它们；
- 如果某项事实没有被记录，明确返回 `unsupported`，而不是猜测或返回空成功。

Agent 不直接访问 MongoDB、Redis、Kafka、日志平台、SQL 或 Shell。`GoIMConnector` 只负责调用受控查询门面并映射为 Canonical Model。

## 2. 推荐 RPC

| RPC | 用途 | 成功但无数据 | 不能伪造的语义 |
| --- | --- | --- | --- |
| `FindUserReference` | 按 `userId` 或昵称查用户引用 | `users=[]` | 多个匹配不能自动选择 |
| `GetMessageRecord` | 查询单条消息元数据，不返回正文 | `found=false` | `found=false` 只表示查询成功且无记录 |
| `GetMessageTimeline` | 查询消息生命周期事件 | 空事件列表需结合完整性字段 | 不完整时间线不能当成完整无事件 |
| `GetDeliveryTimeline` | 查询按接收方拆分的投递事件 | 空事件列表需结合完整性字段 | 不能把“未记录”当成“未投递” |
| `GetConnectionObservations` | 查询当前或历史连接观测 | 无观测 | 当前在线不能冒充历史在线 |
| `GetCapabilities` | 声明实例实际支持能力 | 不适用 | 不得虚报 `supported` |

完整 proto 参考位于 [`src/connectors/go-im/proto/operations.proto`](../src/connectors/go-im/proto/operations.proto)。IM-Grpc 的服务实现位于其 `apps/operations/rpc` 模块；这里的 proto 副本用于让 Agent 项目能够独立加载客户端，不依赖开发机绝对路径。

## 3. 字段和错误约束

### 3.1 消息查询

`GetMessageRecord` 至少返回：

```json
{
  "found": true,
  "messageId": "msg_001",
  "conversationId": "conv_001",
  "senderId": "user_a",
  "receiverId": "user_b",
  "createdAt": "1760000000000000000",
  "observedAt": "1760000000000000000",
  "source": "chat_log"
}
```

时间使用 UnixNano 字符串或等价的 64 位整数。JavaScript 端不能把 UnixNano 直接当普通 `number` 运算，否则可能超过安全整数范围；GoIMConnector 使用 `BigInt` 转换成 ISO 时间。

查询成功但无记录：

```json
{
  "found": false,
  "messageId": "msg_missing",
  "observedAt": "1760000000000000000",
  "source": "chat_log"
}
```

依赖超时、不可用或鉴权失败必须使用 gRPC 错误码表达：

| gRPC 状态 | Connector 错误 | 处理 |
| --- | --- | --- |
| `DEADLINE_EXCEEDED` | `timeout` | 不产生 MessageFact，可按只读策略有限重试 |
| `UNAVAILABLE` | `dependency_unavailable` | 有限重试，耗尽后安全失败 |
| `INVALID_ARGUMENT` | `invalid_argument` | 不重试，追问或拒绝 |
| `PERMISSION_DENIED` / `UNAUTHENTICATED` | `permission_denied` | 不重试，不泄露资源是否存在 |
| `UNIMPLEMENTED` | `unsupported_capability` | 返回能力不支持 |

超时不能映射成 `found=false`，否则 Agent 会把“没有查到”误诊断成“消息不存在”。

### 3.2 时间线完整性

时间线响应必须携带：

```json
{
  "events": [],
  "complete": false,
  "truncated": true,
  "coverageStatus": "partial",
  "eventsDropped": "2"
}
```

`coverageStatus` 只能是 `complete`、`partial` 或 `unknown`。存在截断、丢弃、采集关闭或覆盖范围未知时，不能返回 `complete=true`。Agent 因此可以区分：

- 查询完整且为空：可以支持“当前查询范围没有事件”的事实；
- 查询不完整且为空：只能返回证据不足，不能支持“没有投递”。

### 3.3 能力声明

`GetCapabilities` 的每个能力取值只能是：

```text
supported | partial | unsupported
```

当前 Connector 映射：

| OperationsQuery | Canonical Model 能力 |
| --- | --- |
| `messageRecord` | `messageLookup` |
| `deliveryEvents` | `deliveryEvents` |
| `historicalConnection` | `historicalPresence` |
| `ackHistory` | `ackTracking` |
| `writeFailureEvents` | `writeFailureEvents` |

如果能力查询失败，参考实现默认全部标记为 `unsupported`，宁可安全停止，也不虚报能力可用。

## 4. 安全边界

- 只开放查询 RPC，不提供任意 SQL、Shell、重发、修改消息、踢用户或事故提交接口。
- 通过 `x-im-service-token` 进行服务身份认证；Token 不写入 Trace 和错误正文。
- 每次调用携带 `requestId` 和 `runId`，便于 IM 侧审计和问题回放。
- 查询必须有服务端最大 limit、时间范围和 deadline；不能由模型无限扩大范围。
- 返回最小字段，不返回消息正文、密码、手机号、Token、头像原始数据或完整日志。
- OperationsQuery 内部可以复用旧 RPC，但应在门面层统一 not-found、超时、权限和能力语义。
- 返回的 `messageId`、`userId` 必须与请求对象一致；不一致时 Connector 拒绝生成 Canonical Fact。

## 5. 版本和上线建议

推荐先以兼容方式增加 OperationsQuery，不修改原有业务 RPC 的行为：

1. 先上线服务和鉴权，但默认只读、限流和旁路运行。
2. 先启用 `GetCapabilities`、`GetMessageRecord`，用固定 Fixture 和测试消息验证映射。
3. 再逐项启用投递事件和连接观测；没有真实观测时保持 `partial/unsupported`。
4. Agent 侧通过 `Connector` 接口切换 `FakeConnector` 与 `GoIMConnector`，不修改诊断引擎和工具契约。
5. 观察超时率、权限拒绝、返回截断和 `observation_gap` 后，再扩大查询范围。

这套方式的核心收益是：IM 主业务链路继续使用原有 RPC 和存储，诊断 Agent 只依赖稳定的查询语义；未来换成另一种 IM 时，只需实现同一 `Connector` 接口或提供语义等价的查询门面。

## 6. Agent 侧配置

```sh
GO_IM_OPERATIONS_GRPC_URL=127.0.0.1:9100
GO_IM_SERVICE_TOKEN=replace-with-server-side-token
GO_IM_OPERATIONS_PROTO_PATH=
```

`GO_IM_SERVICE_TOKEN` 只能放在服务端环境变量中，不能放进浏览器代码、客服输入或模型上下文。真实服务联调前，先运行：

```sh
npm run typecheck
npm test -- --run src/connectors/go-im/go-im-connector.test.ts
npm run lint
```
