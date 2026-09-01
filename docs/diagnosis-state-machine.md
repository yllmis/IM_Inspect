# IM 客服消息异常诊断状态机与 Canonical Model

> 设计契约（2026-08-28）。本文定义 Agent 的生命周期、跨 IM 的统一事实模型和确定性诊断规则。当前仓库仍以设计为主；未实现的字段和能力不能被视为已有生产事实。

## 1. 目标与边界

系统接收客服关于“消息发出但对方没收到”的自然语言描述，逐步补齐诊断上下文，调用受控工具获取 IM 事实，由确定性诊断引擎输出分类，再由 Agent 生成客服回复和研发升级单草稿。

职责边界：

- Agent/LLM：理解自然语言、提取候选字段、追问、选择允许的下一步工具、解释确定性结果、生成话术和草稿。
- Connector：访问一个具体 IM 的受控 API 或只读数据视图，将外部字段转换为 Canonical Model，并声明能力缺口。
- 诊断引擎：只根据结构化事实、能力和证据冲突规则分类；不访问数据库，不调用模型。
- Tool Service：校验参数、鉴权、限流、超时、重试、脱敏和写操作确认。

第一版只有一个数据源：自有 `IM-Grpc`。不允许 Agent 直连 MongoDB、MySQL、Redis、Kafka，不允许任意 SQL/Shell、自动重发、修改消息、踢用户下线或直接提交事故。

## 2. Agent 状态机

### 2.1 状态定义

| 状态 | 含义 | 允许的离开条件 |
| --- | --- | --- |
| `received` | 收到一轮客服输入，尚未解析 | 初始化 `runId`、Trace 和上下文后进入 `extracting_context` |
| `extracting_context` | 从输入中提取候选 ID、时间范围和问题类型 | 提取完成后进入 `selecting_tool` 或 `awaiting_information` |
| `awaiting_information` | 缺少定位或诊断必需信息，等待客服补充 | 收到补充信息回到 `received`；客服结束则进入 `completed` |
| `selecting_tool` | 根据当前上下文、能力和上一步结果选择一个白名单工具 | 选定工具进入 `calling_tool`；无合法工具则进入 `evaluating_evidence` |
| `calling_tool` | 执行一次已校验的工具调用 | 成功/业务错误进入 `evaluating_evidence`；超时/不可重试错误进入 `failed` |
| `evaluating_evidence` | 合并工具结果，检查证据充分性和冲突 | 需要更多事实回到 `selecting_tool`；信息不足进入 `awaiting_information`；足够则进入 `generating_response` |
| `generating_response` | 将诊断结果转换为客服回复，必要时准备升级草稿 | 需要保存草稿进入 `draft_ready`；否则进入 `completed` |
| `draft_ready` | 已生成可编辑的升级单草稿，但尚未提交 | 客服确认保存后进入 `awaiting_confirmation`；放弃则进入 `completed` |
| `awaiting_confirmation` | 等待明确的人类确认写操作 | 后端验证 `confirmed`、权限和幂等键后才可保存；拒绝/过期进入 `completed` |
| `completed` | 本轮已产生最终结果，不再调用工具 | 终态 |
| `failed` | 不可恢复错误、安全策略拒绝或重试耗尽 | 终态，必须说明失败原因 |
| `stopped` | 达到调用次数、总时长或上下文预算上限 | 终态，结果只能标为未完成或 `insufficient_data` |

### 2.2 合法转移

```text
received -> extracting_context
extracting_context -> awaiting_information | selecting_tool
awaiting_information -> received | completed
selecting_tool -> calling_tool | evaluating_evidence
calling_tool -> evaluating_evidence | failed
evaluating_evidence -> selecting_tool | awaiting_information | generating_response
generating_response -> draft_ready | completed
draft_ready -> awaiting_confirmation | completed
awaiting_confirmation -> completed | failed

任意非终态 -> failed       # 不可恢复错误或安全拒绝
任意循环状态 -> stopped    # 达到硬上限
```

状态机约束：

1. `received` 必须先经过 `extracting_context`，客服文字、日志和模型输出都是不可信输入。
2. `extracting_context` 产生的是候选字段；字段只有被 Connector/工具确认后，才可参与诊断事实。
3. 每轮最多调用一个工具；默认总调用上限为 6 次、总耗时上限为 10 秒，具体值由 Tool Service 配置。
4. 只读工具只允许有限、可审计的重试；写工具不自动重试，必须使用幂等键。
5. `stopped`、`failed` 或证据不足时不得输出具体根因作为确定结论。
6. `create_escalation_draft` 只能生成/保存草稿；任何外部提交都不属于第一版工具。

## 3. Canonical Model

Canonical Model 表达“诊断需要的语义事实”，不复制任意 IM 的数据库表，也不暴露 MongoDB、MySQL、Redis 或 Kafka 字段。字段命名使用稳定的领域语义；原始字段只放在受控的 `metadata` 中，不能被 Agent 当作诊断依据。

### 3.1 基础类型

```go
type MessageStatus string

const (
	MessageCreated      MessageStatus = "created"
	MessagePersisted    MessageStatus = "persisted"
	MessageQueued       MessageStatus = "queued"
	MessageDelivering   MessageStatus = "delivering"
	MessageDelivered    MessageStatus = "delivered"
	MessageAcknowledged MessageStatus = "acknowledged"
	MessageFailed       MessageStatus = "failed"
	MessageUnknown      MessageStatus = "unknown"
)

type DeliveryResult string

const (
	DeliveryAttempted DeliveryResult = "attempted"
	DeliverySuccess   DeliveryResult = "success"
	DeliveryFailed    DeliveryResult = "failed"
	DeliveryTimeout   DeliveryResult = "timeout"
	DeliveryUnknown   DeliveryResult = "unknown"
)

type ConnectionState string

const (
	ConnectionOnline  ConnectionState = "online"
	ConnectionOffline ConnectionState = "offline"
	ConnectionUnknown ConnectionState = "unknown"
)

type Evidence struct {
	ID         string            `json:"id"`         // 外部事件/记录的稳定 ID
	Source     string            `json:"source"`     // connector、工具或数据视图名称
	Kind       string            `json:"kind"`       // message、delivery、connection、write
	ObservedAt time.Time         `json:"observedAt"` // 事实发生/被观测的服务端时间
	Field      string            `json:"field"`      // 支持该事实的字段或事件类型
	Value      any               `json:"value"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}
```

`ObservedAt` 必须说明是事件发生时间还是查询时间；优先使用服务端事件时间。无法确认时间语义时，不得用于判断“投递时在线”或 ACK 超时。

### 3.2 `MessageFact`

```go
type MessageFact struct {
	MessageID      string            `json:"messageId"`
	ConversationID string            `json:"conversationId,omitempty"`
	SenderID       string            `json:"senderId,omitempty"`
	ReceiverID     string            `json:"receiverId,omitempty"`
	Status         MessageStatus     `json:"status"`
	Exists         bool              `json:"exists"`
	Persisted      *bool             `json:"persisted,omitempty"`
	CreatedAt      *time.Time        `json:"createdAt,omitempty"`
	StatusAt       *time.Time        `json:"statusAt,omitempty"`
	Evidence       []Evidence        `json:"evidence"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}
```

约束：`Exists=false` 必须来自已确认的唯一查询结果；查询失败、权限不足或 ID 不明确不能伪装成不存在。`Persisted=nil` 表示未知，不等于 `false`。

### 3.3 `DeliveryFact`

```go
type DeliveryFact struct {
	MessageID   string            `json:"messageId"`
	ReceiverID  string            `json:"receiverId,omitempty"`
	AttemptID   string            `json:"attemptId,omitempty"`
	AttemptedAt *time.Time        `json:"attemptedAt,omitempty"`
	Result      DeliveryResult    `json:"result"`
	DeliveredAt *time.Time        `json:"deliveredAt,omitempty"`
	AckedAt     *time.Time        `json:"ackedAt,omitempty"`
	ErrorCode   string            `json:"errorCode,omitempty"`
	Evidence    []Evidence        `json:"evidence"`
	Metadata    map[string]string `json:"metadata,omitempty"`
}
```

`Result=success` 只表示 Connector 有明确的投递成功事件；`AckedAt` 只有在接收端 ACK 事件存在时才填写。没有投递事件不能推导为投递失败。

### 3.4 `ConnectionFact`

```go
type ConnectionFact struct {
	UserID       string            `json:"userId"`
	State        ConnectionState   `json:"state"`
	ObservedAt   *time.Time        `json:"observedAt,omitempty"`
	ConnectionID string            `json:"connectionId,omitempty"`
	Historical   bool              `json:"historical"`
	Evidence     []Evidence        `json:"evidence"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}
```

只有 `Historical=true` 且 `ObservedAt` 与投递尝试时间可关联时，`State=offline` 才能支持 `receiver_offline`。Redis 的“当前在线”不能替代历史连接事实。

### 3.5 `DiagnosisResult`

```go
type DiagnosisClassification string

const (
	MessageNotFound  DiagnosisClassification = "message_not_found"
	WriteFailed      DiagnosisClassification = "write_failed"
	NotDelivered     DiagnosisClassification = "not_delivered"
	ReceiverOffline  DiagnosisClassification = "receiver_offline"
	AckTimeout       DiagnosisClassification = "ack_timeout"
	Delivered        DiagnosisClassification = "delivered"
	InsufficientData DiagnosisClassification = "insufficient_data"
)

type RecommendedAction string

const (
	ActionReply    RecommendedAction = "reply"
	ActionAsk      RecommendedAction = "ask_for_more_info"
	ActionEscalate RecommendedAction = "escalate"
)

type DiagnosisResult struct {
	Classification          DiagnosisClassification `json:"classification"`
	Facts                   []string                `json:"facts"`
	Evidence                []Evidence              `json:"evidence"`
	PossibleCauses          []string                `json:"possibleCauses"`
	MissingInformation      []string                `json:"missingInformation"`
	UnsupportedCapabilities []string                `json:"unsupportedCapabilities"`
	Conflicts               []EvidenceConflict      `json:"conflicts,omitempty"`
	RecommendedAction       RecommendedAction       `json:"recommendedAction"`
}

type EvidenceConflict struct {
	Subject    string     `json:"subject"`
	Evidence   []Evidence `json:"evidence"`
	Resolution string     `json:"resolution"`
}
```

`Facts` 必须可以由 `Evidence` 逐项追溯；`PossibleCauses` 是解释性假设，不能单独触发分类或写操作；`MissingInformation` 是继续追问所需的字段；`UnsupportedCapabilities` 是 Connector 明确不提供的能力；`Conflicts` 记录相互矛盾的证据和确定性处理结果。

## 4. 事实、可能原因、缺失信息和不支持能力

### 已确认事实

只有以下来源可以产生已确认事实：

- 受控 Connector 返回的结构化结果；
- 通过 Schema、权限和关联 ID 校验的服务端事件；
- 可追溯到 `Evidence` 的确定性聚合结果。

客服输入、日志文本、模型输出和字段名相似性都不是事实来源。`displayName` 不能直接作为 `userId`，`sent` 不能直接作为 `delivered`。

### 可能原因

`PossibleCauses` 可以包含“客户端网络波动”“接收端版本异常”等待验证假设，但必须与 `Facts` 分离，并且不能改变 `Classification`。没有证据时允许为空；不允许把“用户认为写入失败”写入 `Facts`。

### 缺失信息

缺失信息分为两类：

- 定位缺失：无法唯一确定 `userId`、`conversationId`、`messageId` 或有效时间范围，Agent 应追问。
- 证据缺失：对象已定位，但没有投递事件、历史连接状态、ACK 或写入结果，诊断引擎应返回 `insufficient_data`，并列出具体缺口。

### 不支持的能力

Connector 必须声明能力，而不是让 Agent 猜测：

```go
type ConnectorCapabilities struct {
	MessageLookup      bool `json:"messageLookup"`
	DeliveryEvents     bool `json:"deliveryEvents"`
	HistoricalPresence bool `json:"historicalPresence"`
	AckTracking        bool `json:"ackTracking"`
	WriteFailureEvents bool `json:"writeFailureEvents"`
}
```

例如只有当前在线查询、没有历史在线事件时，应返回 `unsupportedCapabilities=["historicalPresence"]`。不支持的能力不能通过空数组、默认值或模型推理补齐。

## 5. 确定性诊断分类与证据优先级

诊断引擎按以下规则执行；同一消息有冲突时优先保证“不误报”，而不是选择看起来更合理的状态。

| 分类 | 最小证据 | 不足时的处理 |
| --- | --- | --- |
| `message_not_found` | 已确认唯一 `messageId`，查询结果明确不存在 | 查询失败、权限错误或 ID 不唯一都返回 `insufficient_data` |
| `write_failed` | 写入事件明确失败，且没有持久化成功事实 | 只有状态缺失或用户猜测时返回 `insufficient_data` |
| `not_delivered` | 消息已持久化，且在有效范围内确认没有投递事件，或投递事件明确失败 | 没有投递事件查询能力时返回 `insufficient_data` |
| `receiver_offline` | 投递尝试与历史连接事实可关联，投递时接收方明确离线 | 只有当前在线状态时返回 `insufficient_data` |
| `ack_timeout` | 投递已发起，有服务端时间和 ACK 超时阈值，截止时无 ACK，且无更强失败事实 | 无 ACK 能力、时间不可靠或仍在超时窗口内时返回 `insufficient_data` |
| `delivered` | 明确成功投递事件或接收端 ACK | 仅有 `sent/queued` 状态不能判定 |
| `insufficient_data` | 定位不完整、能力不支持、证据不足或证据冲突 | 列出 `missingInformation`、`unsupportedCapabilities` 或 `conflicts` |

冲突处理规则：

1. 同一 `Evidence` ID 的重复记录先去重；不同来源对同一字段给出不同值时保留全部证据。
2. 无法按来源可信度、事件时间和因果顺序确定真值时，分类统一为 `insufficient_data`。
3. 冲突不得由 LLM 选择；`EvidenceConflict.Resolution` 固定记录“未自动裁决，需人工或数据源修复”。
4. 更强事实覆盖更弱状态只在事件时间和消息 ID 可关联时成立，例如 ACK 可以支持 `delivered`，但当前在线不能覆盖历史离线事件。

## 6. 状态与事实示例

IM 底层常见状态可映射为：

```text
created -> persisted -> queued -> delivering -> delivered -> acknowledged
   \          \           \          \-> failed
    \          \           \-> failed
     \-> failed
```

映射必须有 Connector 级契约。底层字段值相同不代表语义相同：`sent` 可能只表示请求进入 Kafka，不能自动映射为 `MessageDelivered`。无法确认的值映射为 `unknown`，由诊断引擎处理为证据不足。

## 7. 工具和 Agent 循环示例

第一版允许的工具：

```text
find_user_or_message       # 只读，确认稳定 ID 和唯一性
get_message_status         # 只读，获取 MessageFact
get_delivery_events        # 只读，获取 DeliveryFact
get_connection_status      # 只读，获取 ConnectionFact；无历史能力时显式返回不支持
create_escalation_draft    # 唯一写操作，只保存草稿且必须幂等
```

示例：

```text
客服：“昨天小王发的消息对方没收到。”
  -> extracting_context：displayName=小王，缺少稳定 userId/messageId
  -> awaiting_information：追问消息 ID 或可验证时间范围
客服补充 messageId
  -> find_user_or_message：确认唯一 userId/messageId
  -> get_message_status：得到 MessageFact
  -> get_delivery_events：得到 DeliveryFact
  -> 必要时 get_connection_status：得到与投递时刻关联的 ConnectionFact
  -> evaluating_evidence：确定性分类
  -> generating_response：生成客服回复
  -> 需要研发介入：create_escalation_draft，进入 draft_ready
```

## 8. 当前接入状态

`/Users/yllmis/go_projects/IM-Grpc` 已有用户、会话、聊天记录、Kafka 消费和 WebSocket ACK 代码，但目前仍缺少独立 `DeliveryEvent`、历史连接事件、持久化失败事件及完整消息状态迁移。因此第一版 `GoIMConnector` 对无法证明的分类必须返回 `insufficient_data`，不能借助模型补全。

实现顺序：先实现这些类型和纯函数诊断引擎，再实现 Fake Connector 与单测；随后为 `IM-Grpc` 增加受控只读诊断接口和可重复故障注入，最后接入真实 Connector、Agent Loop、Trace 和 Eval Runner。
