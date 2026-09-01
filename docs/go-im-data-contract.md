# IM-Grpc 数据契约与 Adapter 设计

> Day 5 分析产物（2026-08-28）。本文基于 `/Users/yllmis/go_projects/IM-Grpc` 的静态代码分析，记录原始数据语义、现有查询能力、Canonical Model 映射和缺失事实。本次未启动 MySQL、MongoDB、Redis、Kafka 或 WebSocket 服务，因此运行时行为标记为“待验证”的部分不能视为已确认生产事实。

## 1. 目标与方法

本文不是数据库表结构抄录，也不是 `GoIMConnector` 的实现。它是 Adapter 的前置契约，用于回答：

1. `IM-Grpc` 当前能提供哪些可验证事实；
2. 原始字段如何映射到 `MessageFact`、`DeliveryFact`、`ConnectionFact` 和 `Evidence`；
3. 哪些字段存在但语义不可靠；
4. Agent 应通过什么受控路径取得事实；
5. 哪些能力只是缺少安全查询接口，哪些事实根本没有被记录；
6. 哪些诊断能力暂不可用，Adapter 必须返回 `unsupported_capability`。

数据契约不要求所有 IM 使用相同表结构、字段名或 RPC。不同 IM 的差异由 Connector Adapter 映射到统一 Canonical Model：

```text
Agent
  -> Tool Service（参数校验、权限、超时、审计、脱敏）
  -> GoIMConnector（IM-Grpc 字段与状态映射）
  -> Diagnosis Query Service（可选的内部受控查询层）
  -> 现有 RPC / 只读数据库查询 / 日志查询 / 事件存储
```

`Diagnosis Query Service` 属于 IM 侧或公司内部基础设施。它可以把技术人员已经能够稳定、重复执行的只读排查步骤封装成固定接口，但 Agent 不获得数据库、Redis、Kafka、日志平台、SQL 或 Shell 的直接权限。

采用以下判断原则：

- 技术人员能通过明确条件稳定查到、且结果具有确定语义的事实，可以封装为受控工具数据源；
- 只存在于临时日志或进程内存中的信息，在没有稳定查询与关联方式前只能作为待验证线索；
- 依赖个人经验或猜测的结论不能标记为已确认事实；
- 系统从未记录的事实无法通过 Adapter 补出，只能返回 `unsupported_capability`，或在后续增加观测事件。

证据等级：

| 等级 | 含义 |
| --- | --- |
| 已确认 | 数据结构、写入路径和读取路径在代码中一致 |
| 部分支持 | 能取得数据，但时间、关联或状态语义不足以支持确定性诊断 |
| 待运行验证 | 静态代码可推断，但尚未通过固定样本运行验证 |
| 缺失 | 当前无法形成稳定证据；具体是缺安全接口还是事实未记录，必须在“数据来源状态”中单独说明 |

能力状态统一使用三级枚举：

| 状态 | 含义 |
| --- | --- |
| `supported` | 具有稳定数据、明确语义和受控获取路径，可用于确定性诊断 |
| `partial` | 只能确认部分事实，或仍受 ID、时间、语义、权限、接口限制 |
| `unsupported` | 当前无法取得诊断所需事实；调用方必须收到明确能力缺失，不能返回空成功 |

数据来源状态与能力状态分开记录：

| 数据来源状态 | 处理方式 | 是否必须修改 IM |
| --- | --- | --- |
| 数据和安全接口都存在 | Adapter 直接调用并映射 | 否 |
| 数据存在，但缺少安全接口 | 复用或新增内部只读 `Diagnosis Query Service` | 不一定；可独立封装，避免侵入主链路 |
| 数据只在临时日志或进程内存 | 第一版不作为已确认事实；若能稳定关联，可后续封装查询 | 视现有日志平台和关联能力决定 |
| 数据根本未记录 | 返回 `unsupported_capability`；由 Eval 决定是否补观测事件 | 完整支持该能力时需要 |

## 2. 当前消息链路

```text
客户端 WebSocket Message
  -> im-ws: conversation.chat
  -> Kafka: msgChatTransfer
  -> task-mq: MsgChatTransfer.Consume
  -> MongoDB: chat_log
  -> MongoDB: conversation 更新
  -> task-mq 的 WebSocket client
  -> im-ws: push handler
  -> 接收方 WebSocket 连接（若存在）
```

对应代码：

- WebSocket 入口：`apps/im/ws/internal/handler/conversation/conversation.go`
- Kafka 消息结构：`apps/task/mq/mq/mq.go`
- Kafka 生产者：`apps/task/mq/mqclient/msgtransfer.go`
- Kafka 消费与持久化：`apps/task/mq/internal/handler/msgTransfer/msgChatTransfer.go`
- 推送到 WebSocket 服务：`apps/task/mq/internal/handler/msgTransfer/msgTransfer.go`
- 推送到接收方连接：`apps/im/ws/internal/handler/push/push.go`

当前链路有三个重要语义边界：

1. 发送方收到的 `status=sent` 只表示 Kafka `Push` 返回成功，即消息进入异步处理链路；它不表示已持久化、已推送或接收方已收到。
2. `task-mq` 的 WebSocket client 写入成功只表示消息写到 `im-ws` 连接；`push` handler 找不到接收方连接时直接返回 `nil`，上游无法区分“接收方离线”和“推送成功”。
3. 当前 WebSocket ACK 机制默认没有启用，并且它确认的是客户端入站请求处理，不是接收方对业务消息的持久化送达 ACK。

## 3. `users` 数据契约

### 3.1 原始结构

来源：

- `apps/user/models/usersmodel_gen.go:45`
- `deploy/sql/user.sql:1`
- `apps/user/rpc/user.proto:8`

| 原始字段 | 类型 | 代码语义 | Canonical 用途 | 结论 |
| --- | --- | --- | --- | --- |
| `id` | `varchar(24)` | 用户稳定 ID | `userId` | 已确认 |
| `nickname` | `varchar(24)` | 用户显示名称 | 定位候选的 `displayName` | 已确认，但不能作为稳定 ID |
| `phone` | `varchar(20)` | 登录/查找字段 | 可用于受控精确定位 | 敏感字段，不能返回给 Agent |
| `status` | `tinyint` | proto 注释为“是否锁住” | 不映射到连接状态 | 已确认不是在线状态 |
| `avatar`、`sex` | - | 展示字段 | 诊断不需要 | 不进入 Canonical Model |
| `created_at`、`updated_at` | timestamp | 用户记录时间 | 第一版诊断不需要 | 不映射 |

### 3.2 查询能力

现有 `user-rpc`：

```text
GetUserInfo(id)        # 稳定 ID 精确查询
FindUser(name/phone/ids)
```

`FindUser(name)` 使用 `nickname LIKE %name%`，可能返回多个用户；`find_user_or_message` 必须保留全部有限候选并返回 `multiple/ambiguous_match`，不能随机选择。`FindUser(phone)` 是精确查询，但手机号只能在后端使用和脱敏。

### 3.3 Adapter 映射

```text
UserEntity.id       -> candidate.userId
UserEntity.nickname -> candidate.displayName
UserEntity.status   -> 不映射到 ConnectionFact
```

能力结论：用户稳定 ID 和昵称候选查询可用；用户查询不提供租户字段，真实接入前需要明确对象可见性和服务间权限。

## 4. `chat_log` 数据契约

### 4.1 原始结构

来源：

- `apps/im/immodels/chatlogtypes.go:10`
- `apps/im/immodels/chatlogmodelgen.go:20`
- `apps/im/rpc/im.proto:9`

| 原始字段 | 写入来源 | Canonical 映射 | 结论 |
| --- | --- | --- | --- |
| `_id` | Kafka 消费者生成 `bson.NewObjectID()` | `MessageFact.messageId` | 已确认，但存在客户端 ID 关联缺口 |
| `conversationId` | WebSocket 输入或服务生成 | `MessageFact.conversationId` | 已确认 |
| `sendId` | 已认证 WebSocket 连接用户 | `MessageFact.senderId` | 已确认 |
| `recvId` | 客户端消息参数 | `MessageFact.receiverId` | 已确认，仍需对象权限校验 |
| `sendTime` | `im-ws` 使用 `time.Now().UnixNano()` | `MessageFact.createdAt` | 可映射，单位固定为纳秒；待验证时钟一致性 |
| `status` | 未找到赋值或更新代码 | 不读取原值，映射为 `unknown` | 字段存在但语义缺失 |
| `readRecords` | 发送者默认已读；后续 mark-read 更新 | 独立“已读证据”候选 | 不能等同于 WebSocket ACK |
| `createAt/updateAt` | Insert 中自动赋值代码被注释 | 暂不使用 | 可能为空 |
| `msgContent` | 客户消息正文 | 不进入 Agent 默认响应 | 敏感内容，需脱敏/不返回 |

### 4.2 可证明的事实

如果按 Mongo `_id` 成功查询到 `chat_log`：

```json
{
  "exists": true,
  "persisted": true,
  "status": "persisted"
}
```

这里的 `persisted` 是由“记录存在于 `chat_log`”确定性推导，不依赖未维护的原始 `status` 字段。不能进一步推导 `queued`、`delivered` 或 `acknowledged`。

若 Mongo 查询明确返回 `ErrNotFound`，且 `messageId` 是已确认的 Mongo ID，可以支持 `exists=false`。但现有 `GetChatLog` RPC 将所有查询错误包装为通用数据库错误，没有稳定暴露 `not_found`，需要在诊断读取接口中修正。

### 4.3 已读记录的边界

`readRecords` 表示业务“已读”，不是传输层 ACK。对于单聊，如果能够验证接收方主动执行 `conversation.markRead`，它是“接收方至少看到/处理过该消息”的强证据，可以在后续设计中支持 `delivered`；第一版在没有契约测试前不把它自动映射为 `DeliveryFact.ackedAt`。

## 5. `conversation` 数据契约

`IM-Grpc` 有两个相关 Mongo 模型：

1. `conversation`：会话全局聚合，包含 `conversationId`、`total`、`seq` 和最新 `ChatLog`；
2. `conversations`：按 `userId` 保存用户自己的 `conversationList`。

来源：

- `apps/im/immodels/conversationtypes.go`
- `apps/im/immodels/conversationmodelgen.go`
- `apps/im/immodels/conversationstypes.go`
- `apps/im/immodels/conversationsmodelgen.go`

| 字段 | 语义 | 诊断用途 |
| --- | --- | --- |
| `conversationId` | 会话稳定 ID | 消息定位和权限关联 |
| `chatType` | 单聊/群聊 | 确定接收方语义 |
| `total` | 会话累计消息数 | 辅助一致性检查，不证明某条消息投递 |
| `seq` | 会话序列字段 | 当前写入链路未见明确推进语义，待验证 |
| `msg` | 最新消息快照 | 辅助定位，不能替代 `chat_log` 查询 |
| `conversationList` | 用户会话视图 | 验证用户与会话关联 |

`ConversationModel.UpdateMsg` 在写入 `chat_log` 后执行。如果 `chat_log` 插入成功而会话更新失败，会出现部分成功；当前没有持久化失败事件记录这一状态。

## 6. Redis 在线用户契约

来源：

- key：`pkg/constants/redis.go`
- 登录写入：`apps/user/api/internal/logic/user/loginlogic.go:46`
- WebSocket 关闭删除：`apps/im/ws/im.go:74`
- 好友/群在线查询：`apps/social/api/internal/logic/*online*.go`

当前语义不是严格的“WebSocket 当前在线”：

- 用户 HTTP 登录成功时写入 `online:users`；
- WebSocket 连接建立时未看到对应 `HSET`；
- WebSocket 关闭时执行 `HDEL`；
- 没有连接事件时间、心跳时间、连接 ID 或历史记录。

因此 Redis 值最多只能作为低可信的当前状态提示，不能支持 `receiver_offline`：

```json
{
  "state": "unknown",
  "historical": false,
  "unsupportedCapabilities": ["historicalPresence"]
}
```

即使当前 Redis 中没有用户，也不能证明消息投递时用户离线；即使存在，也可能只代表用户登录过而不是当前存在有效 WebSocket 连接。

## 7. Kafka 消息流程与关联 ID

### 7.1 当前消息结构

`MsgChatTransfer` 包含：

```text
conversationId
chatType
sendId
recvId / recvIds
sendTime
mType
content
```

它不包含：

```text
messageId
clientMessageId
correlationId
requestId
deliveryAttemptId
```

### 7.2 关键关联问题

当前入口给发送方返回：

```json
{"msgId": "<WebSocket Message.Id>", "status": "sent"}
```

但 Kafka 消费者随后重新生成：

```go
msgId := bson.NewObjectID()
```

因此客户端掌握的 `msgId` 与 Mongo `chat_log._id` 没有稳定映射。这会直接影响：

- 客服用用户提供的消息 ID 查询；
- Kafka 入队、消费、持久化和推送的 Trace 关联；
- 写入失败和重复消费的定位；
- 幂等与重复投递诊断。

### 7.3 失败和重复风险

- Kafka `Push` 失败会同步返回错误，但没有形成可查询的 `write_failed` 事件。
- 消费者写 `chat_log` 失败时返回 error，但没有持久化失败记录。
- `chat_log` 成功、`conversation` 更新失败时消费者也返回 error；如果框架重试，消费者每次重新生成 Mongo ID，静态代码上存在重复消息记录的风险，需运行验证。
- 没有消费 attempt、partition、offset 或统一 correlation ID 暴露给诊断工具。

## 8. WebSocket ACK 契约

### 8.1 当前实现

代码提供三种模式：

```text
NoAck
OnlyAck
RigorAck
```

默认超时为 30 秒、默认失败次数为 5，但 `im-ws` 启动代码中的 `WithAck(RigorAck)` 被注释，因此当前默认是 `NoAck`。

### 8.2 ACK 的真实语义

现有 ACK 逻辑作用于 `im-ws` 收到的客户端入站 `Message`：服务端先给该连接发送 ACK，等待该客户端回复，再将原始消息交给路由 handler。它不是“接收方对业务消息 `msgId` 的送达确认”。

此外：

- `ackTime`、`errCount` 和队列保存在进程内存；
- ACK 成功和超时只写日志；
- 服务重启后无法查询；
- 没有持久化的 `messageId -> ackAt` 记录；
- 推送给接收方使用直接 `srv.Send`，未建立业务消息投递 ACK 事件。

结论：当前 ACK 不能映射为 `DeliveryFact.ackedAt`，也不能支持 `ack_timeout` 分类。

## 9. 当前消息状态

| 阶段 | 当前可观察内容 | Canonical 状态 | 可信度 |
| --- | --- | --- | --- |
| WebSocket 已接收 | 入口 handler 正在执行 | 不持久化 | 缺少查询接口 |
| Kafka Push 成功 | 向发送方返回 `sent` | 最多解释为“进入处理链路” | 部分支持，不等于 `queued` 的持久事实 |
| Kafka 消费开始 | stdout 日志 | 不映射 | 不可查询、不稳定 |
| Mongo 插入成功 | `chat_log` 记录存在 | `persisted` | 已确认 |
| 会话更新成功 | `conversation.total/msg` 更新 | 辅助事实 | 不证明投递 |
| 写入 WebSocket 服务 | `WsClient.Send` 返回 nil | 不映射为 delivered | 只到达网关 |
| 接收方无连接 | `push.single` 返回 nil | 当前不记录 | 无法区分离线和成功 |
| 接收方 socket write 成功 | `srv.Send` 返回 nil | 最多是传输尝试成功 | 没有事件持久化 |
| 接收方已读 | `readRecords` 更新 | 可作为后续 delivered 强证据 | 待契约测试 |

原始 `ChatLog.Status` 当前没有写入或更新语义。`GoIMConnector` 不应读取其零值并猜测状态。

## 10. 现有 RPC/API 能力

### 10.1 可复用 RPC

| RPC | 用途 | Adapter 使用建议 | 缺口 |
| --- | --- | --- | --- |
| `user.User/GetUserInfo` | 按稳定 ID 查询用户 | 可复用 | 需要服务身份和对象权限 |
| `user.User/FindUser` | 按昵称、手机号、ID 列表查询 | 可用于候选定位 | 昵称模糊匹配，需限制返回量和脱敏 |
| `im.Im/GetChatLog` | 按 `msgId` 或会话时间范围查询 | 可作为消息读取基础 | 不暴露 `Status/CreateAt/UpdateAt`；not-found 错误不明确 |
| `im.Im/GetConversations` | 查询用户会话列表 | 可验证用户/会话关联 | 不提供投递事实 |

### 10.2 不建议直接复用的 HTTP 行为

`im-api` 的 `ChatLogReq` 包含 `msgId`，但 `GetChatLogLogic` 调用 RPC 时没有传递 `MsgId`，因此 HTTP `/v1/im/chatlog` 当前无法可靠按消息 ID 查询。Adapter 第一版应使用受控 gRPC client，或新增专用只读诊断 RPC，而不是依赖该 HTTP 路径。

### 10.3 缺失接口

```text
GetDeliveryEvents(messageId, timeRange)
GetHistoricalConnectionStatus(userId, at)
GetMessageWriteEvents(messageId/correlationId)
GetAckEvent(messageId, receiverId)
GetConnectorCapabilities()
```

现有 RPC 拦截器主要做错误转换，没有看到针对诊断服务的细粒度数据权限契约；接入前需要服务身份、租户/对象权限、查询上限和审计。

“缺失接口”不等于“必须修改 IM 主业务代码”。应先判断事实位于哪一层：

| 所需事实 | 当前数据位置 | 当前获取路径 | 结论 |
| --- | --- | --- | --- |
| 用户身份与候选 | MySQL `users` | 已有 `user-rpc` | 数据和接口都有，Adapter 可复用 |
| 消息持久化记录 | Mongo `chat_log` | 已有 `im-rpc`，但字段和错误语义不完整 | 数据存在、接口部分可用；优先封装受控读取接口 |
| 当前在线提示 | Redis `online:users` | 无面向诊断的专用接口 | 数据存在但语义不足；即使增加接口也不能证明历史在线状态 |
| Kafka 入队/消费失败 | 返回值和临时日志 | 无稳定关联查询 | 只有临时信息，第一版不可作为确定事实 |
| 接收方投递结果 | 函数返回值，离线时还可能静默成功 | 无持久记录 | 关键事实未记录 |
| 历史连接状态 | 无 | 无 | 事实未记录 |
| 业务消息 ACK | 无；现有 ACK 是另一种协议语义 | 无 | 事实未记录 |

因此第一版可以在不修改 `IM-Grpc` 主链路的情况下开发 Agent、Domain、Tool Service、Fake Connector 和 `GoIMConnector` 的已支持部分。真实 Connector 遇到未记录事实时必须明确返回能力缺失。

## 11. Canonical Model 映射

### 11.1 `MessageFact`

| Canonical 字段 | IM-Grpc 来源 | 获取路径 | 映射规则 | 是否需要修改 IM |
| --- | --- | --- | --- | --- |
| `messageId` | `chat_log._id` | `im-rpc` 或受控消息查询接口 | 使用 Mongo ObjectID hex；当前无法与入口 `msg.Id` 对齐 | 第一版否；解决客户端 ID 关联时需要补充 |
| `conversationId` | `chat_log.conversationId` | 同上 | 直接映射 | 否 |
| `senderId` | `chat_log.sendId` | 同上 | 直接映射 | 否 |
| `receiverId` | `chat_log.recvId` | 同上 | 直接映射；群聊时表示 group ID，不是单个用户 | 否 |
| `exists` | `GetChatLog(msgId)` | 受控 RPC | 成功返回为 true；明确 not-found 为 false | 需要修正或封装 not-found 语义，不要求改存储模型 |
| `persisted` | `chat_log` 记录存在 | 受控 RPC | 存在时为 true；查询失败为 nil/未知 | 否 |
| `status` | 确定性推导 | Connector 本地映射 | 存在时最多 `persisted`；否则 `unknown`，不读取未维护的原始 status | 否 |
| `createdAt` | `sendTime` | 受控 RPC | `time.Unix(0, sendTime)`；待验证时钟来源 | 可能需要查询接口补充字段 |
| `statusAt` | 无可靠字段 | 无 | 暂为空 | 完整状态时间线需要新增观测数据 |
| `evidence` | chat log 记录引用 | Connector 生成 | `id=chat_log:<mongoId>`，不包含正文 | 否 |

### 11.2 `DeliveryFact`

当前没有可靠映射。`WsClient.Send`、接收方 socket write 和日志都没有形成可查询的持久化投递事件。Adapter 应返回：

```text
unsupported_capability: deliveryEvents
unsupported_capability: ackTracking
```

| Canonical 信息 | 当前来源 | 获取路径 | 当前映射 | 是否需要修改 IM |
| --- | --- | --- | --- | --- |
| 投递尝试时间与目标 | 无稳定记录 | 无 | 不映射 | 完整支持时需要新增结构化投递事件 |
| 投递结果与错误 | 函数返回值和临时日志 | 无稳定关联查询 | 不作为已确认事实 | 完整支持时需要持久化 attempt/result |
| `ackedAt` | 无业务消息 ACK | 无 | 不映射 | 完整支持时需要定义并记录业务 ACK |
| 能力缺失 | Connector 能力声明 | `GetConnectorCapabilities` 或静态配置 | 返回 `deliveryEvents/ackTracking=unsupported` | 第一阶段不需要 |

增加一个读取现有日志的接口也不能自动获得完整投递事实，因为接收方离线分支没有可靠记录。要完整支持，需要先补充结构化投递事件，再由受控接口读取。

### 11.3 `ConnectionFact`

Redis 在线数据只能形成低可信当前提示：

```text
state      -> unknown（诊断模式默认）
historical -> false
evidence   -> 不用于 receiver_offline
```

Adapter 应返回 `unsupported_capability: historicalPresence`，不能把 Redis 当前值映射成投递时状态。

| Canonical 信息 | 当前来源 | 获取路径 | 当前映射 | 是否需要修改 IM |
| --- | --- | --- | --- | --- |
| 当前连接提示 | Redis `online:users` | 可选的内部只读查询接口 | `state=unknown`、`historical=false`，不用于确定分类 | 第一阶段不需要 |
| 消息发生时连接状态 | 无历史事件 | 无 | 不映射 | 支持 `receiver_offline` 时需要新增历史连接事件 |
| 连接建立/断开时间 | 无 | 无 | 不映射 | 完整支持时需要 |
| 能力缺失 | Connector 能力声明 | `GetConnectorCapabilities` 或静态配置 | 返回 `historicalPresence=unsupported` | 第一阶段不需要 |

第一版可以不提供连接事实。若只需要展示低可信“当前提示”，可以由内部查询服务读取 Redis；它仍不能证明消息投递时的在线状态。

## 12. Connector 能力矩阵

```json
{
  "messageLookup": "partial",
  "deliveryEvents": "unsupported",
  "historicalPresence": "unsupported",
  "ackTracking": "unsupported",
  "writeFailureEvents": "unsupported"
}
```

`messageLookup=partial` 表示当前可以按 Mongo ID 确认记录存在和持久化，但客户端 ID 关联与 RPC `not_found` 语义仍不完整。能力值必须由 Connector 返回，Agent 不根据某个字段是否非空自行猜测能力。

## 13. 诊断分类支持矩阵

| 分类 | 能力状态 | 能确认什么 | 不能确认什么 | 使用条件 | 完整支持条件 |
| --- | --- | --- | --- | --- | --- |
| `message_not_found` | `partial` | 已确认 Mongo ID 查询到记录时，可证明消息存在 | 用客户端入口 ID 查询不到时，不能证明消息不存在 | 输入是合法 Mongo ID，且查询接口明确区分 not-found 与依赖故障 | 统一或持久化客户端 ID 映射，并稳定返回 not-found |
| `write_failed` | `unsupported` | 无 | Kafka 入队、消费、Mongo 写入或会话更新在哪一步失败 | 无；第一版返回能力缺失 | 持久化带关联 ID 的写入生命周期失败事件 |
| `not_delivered` | `unsupported` | 无 | 是否尝试投递、是否找到连接、socket write 是否成功 | 无；第一版返回能力缺失 | 记录完整、可查询的投递 attempt 与结果 |
| `receiver_offline` | `unsupported` | Redis 只能提供低可信当前提示 | 消息投递时接收方是否离线 | 当前 Redis 值不得用于确定分类 | 记录带服务端时间的连接建立、断开和过期事件 |
| `ack_timeout` | `unsupported` | 无；现有 ACK 不属于业务消息 ACK | 接收方是否在截止时间内确认业务消息 | 无；第一版返回能力缺失 | 定义并持久化业务消息 ACK 及 deadline |
| `delivered` | `partial` | 经契约测试确认的接收方已读记录可作为强证据候选 | 未读消息是否已经到达客户端 | 必须验证 `readRecords` 的写入身份、时间和单聊语义 | 持久化投递成功或业务 ACK 事件 |
| `insufficient_data` | `supported` | 能明确列出已知事实、缺失信息和不支持能力 | 不能替代具体根因 | Connector 必须返回 typed capability 和错误 | 保持确定性降级即可 |

## 14. 缺失数据清单

### 独立投递事件

需要记录消息在每次投递中的目标、时间、结果、错误和 attempt ID。当前只有函数返回值和日志。

### 历史连接状态

需要连接建立、断开、心跳过期等事件及服务端时间。当前 Redis 只有不可靠的当前集合。

### ACK 持久化

需要明确“接收方对业务消息的 ACK”语义，并保存 `messageId/receiverId/ackedAt`。当前内存 ACK 是另一层协议。

### 写入失败记录

需要记录 Kafka 入队失败、消费失败、Mongo 插入失败和会话更新失败，不能只输出日志或返回 error。

### Kafka 消息关联 ID

需要在进入 Kafka 前生成稳定 `messageId` 或 `correlationId`，贯穿发送响应、Kafka、Mongo、投递和 ACK。

### 故障注入能力

当前未发现固定 fixture、failpoint 或测试配置。需要仅在 dev/test 启用的确定性故障注入，至少支持：

```text
message_write_failure
delivery_timeout
receiver_offline
ack_timeout
duplicate_delivery
```

## 15. `GoIMConnector` 设计

Adapter 位于 `IM_Inspect/connectors/goim`，只依赖受控 client interface，不复制 `IM-Grpc` 的持久化层：

```go
type GoIMConnector struct {
	users       UserReader
	messages    MessageReader
	deliveries  DeliveryReader
	connections ConnectionReader
}

type UserReader interface {
	GetUser(ctx context.Context, userID string) (UserRecord, error)
	FindUsers(ctx context.Context, query UserQuery) ([]UserRecord, error)
}

type MessageReader interface {
	GetMessage(ctx context.Context, messageID string) (MessageRecord, error)
	FindMessages(ctx context.Context, query MessageQuery) ([]MessageRecord, error)
}
```

第一阶段只实现 `UserReader` 和 `MessageReader`。`DeliveryReader`、`ConnectionReader` 在真实接口补齐前返回 typed `unsupported_capability`，而不是空成功响应。

错误映射：

| IM-Grpc 结果 | Tool/Connector 错误 |
| --- | --- |
| 非法 Mongo ObjectID | `invalid_argument` |
| 明确 `ErrNotFound` | `not_found` |
| 昵称多个结果 | `ambiguous_match` 或 `resolutionStatus=multiple` |
| RPC 超时/不可用 | `timeout` / `dependency_unavailable` |
| 无投递/历史连接接口 | `unsupported_capability` |
| 数据矛盾 | `conflicting_evidence` |

## 16. 分阶段接入与可选观测补充

### 16.1 第一阶段：不修改 IM-Grpc 主链路

先完成 Agent 的核心闭环，并接受真实数据能力不完整：

1. 使用 Fake Connector 覆盖全部 Eval 分类，验证状态机、工具调用、安全限制和确定性诊断；
2. 实现 `GoIMConnector`，优先复用现有 `user-rpc`、`im-rpc`；
3. 对已有数据但接口语义不足的查询，使用小型内部 `Diagnosis Query Service` 封装固定参数、只读、限量、脱敏、可审计的接口；
4. `DeliveryReader`、`ConnectionReader` 等缺少事实来源的能力返回 typed `unsupported_capability`；
5. 不让 Agent 直接连接 MySQL、MongoDB、Redis、Kafka、日志平台或执行任意 SQL/Shell。

这一阶段已经可以开发和测试 Agent，不以七类真实诊断全部可用为前置条件。

### 16.2 第二阶段：由 Eval 决定是否补充 IM 观测

只有 Eval、试用反馈或项目成功标准证明某项能力必要时，才选择对应改造；以下不是 Adapter 开发前的强制清单：

1. **统一消息关联 ID**：在 WebSocket 入口生成或接受受校验的 `messageId/clientMessageId`，写入 Kafka、Mongo、发送响应和 Trace。
2. **诊断事件模型**：新增只追加的 `DeliveryEvent`/`MessageLifecycleEvent`，记录 `queued/persisted/delivery_attempt/delivery_failed/delivered/acked`。
3. **写入失败事件**：在 Kafka Push、消费、Mongo 插入和会话更新失败时写结构化失败记录。
4. **历史连接事件**：记录 `connected/disconnected/heartbeat_expired`，包含用户、连接 ID 和服务端时间。
5. **业务 ACK**：为发送到接收方的业务消息定义 ACK，并持久化 `ackedAt`；不要复用当前入站协议 ACK 的语义。
6. **只读诊断 RPC**：当现有 RPC 或独立查询服务无法满足安全读取时，再在 IM 侧提供明确错误类型和服务权限的接口。
7. **确定性故障注入**：仅 dev/test 开启，使用固定参数触发，不依赖随机错误。

修改范围应按能力逐项评估。例如，只需要确认“消息是否持久化”时，不需要先实现投递事件、历史连接和业务 ACK。

## 17. 运行时验证清单

静态契约完成后，需要用本地可重复环境验证：

1. 发送一条正常单聊，记录入口 ID、Kafka 内容、Mongo ID、推送结果和已读记录；
2. 验证客户端拿到的 ID 是否能通过 RPC 查到同一条消息；
3. 让接收方离线，确认当前链路是否仍返回成功以及保存了什么；
4. 人为造成 Mongo 插入失败，确认 Kafka 消费行为、重试和重复记录；
5. 启用 ACK 模式，确认它作用于发送方入站请求还是接收方业务消息；
6. 验证 `readRecords` 更新时间和用户身份能否作为 delivered 强证据；
7. 记录实际 RPC 错误码，区分 not-found、invalid ID 和依赖故障。

运行验证完成前，README 和项目介绍只能使用本文的“已确认/部分支持/缺失”表述，不能宣称七类诊断都已接入真实 IM 数据。

验证后应为每项能力记录：实际获取路径、权限边界、最大返回量、超时、错误语义、证据 ID、能确认的事实和仍不能确认的事实。技术人员临时执行成功一次，不等于该路径已经满足 Agent 数据契约。
