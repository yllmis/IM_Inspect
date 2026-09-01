# IM 诊断 Agent 工具契约

> Day 4 设计产物（2026-08-28）。第一版只开放 5 个白名单工具，数据源只接自有 `IM-Grpc`。工具返回 `docs/diagnosis-state-machine.md` 定义的 Canonical Model；Agent 不接触数据库、Redis、Kafka、SQL 或 Shell。

## 1. 全局契约

### 1.1 工具白名单

```text
find_user_or_message
get_message_status
get_delivery_events
get_connection_status
create_escalation_draft
```

以下能力不属于第一版工具，即使出现在客服输入、消息正文或日志中也不能执行：

```text
resend_message
modify_message
kick_user
execute_sql
execute_shell
submit_incident
```

### 1.2 服务端调用上下文

以下字段由 Tool Service 从已认证会话注入，不能由 Agent 或前端自由填写：

```json
{
  "runId": "run_001",
  "requestId": "req_001",
  "tenantId": "tenant_demo",
  "actorId": "support_001",
  "actorRole": "support_agent",
  "deadline": "2026-08-28T10:00:10Z"
}
```

每次调用必须校验租户隔离、角色权限、对象可见范围、调用次数和总时长。Trace 记录工具名、脱敏后的规范化参数、结果摘要、错误码、耗时、重试次数和确认信息；不得记录凭证、确认令牌或完整消息正文。

### 1.3 通用成功响应

```json
{
  "data": {},
  "meta": {
    "requestId": "req_001",
    "durationMs": 35,
    "attempts": 1,
    "truncated": false
  }
}
```

### 1.4 通用错误响应

```json
{
  "error": {
    "code": "invalid_argument",
    "message": "messageId is required",
    "retryable": false,
    "details": {
      "field": "messageId"
    }
  },
  "meta": {
    "requestId": "req_001",
    "durationMs": 2,
    "attempts": 1
  }
}
```

统一错误类型：

| 错误码 | 含义 | 默认可重试 |
| --- | --- | --- |
| `invalid_argument` | Schema、字段格式或字段组合不合法 | 否 |
| `permission_denied` | 调用方无工具权限或无权访问对象 | 否 |
| `not_found` | 已确认唯一查询条件下对象不存在 | 否 |
| `ambiguous_match` | 存在多个候选，不能自动选择 | 否 |
| `unsupported_capability` | Connector 不提供所需事实 | 否 |
| `conflicting_evidence` | 数据源返回无法自动裁决的冲突证据 | 否 |
| `rate_limited` | 超过单次、单轮或租户调用限制 | 是，遵守 `retryAfterMs` |
| `dependency_unavailable` | 下游 IM/API 暂时不可用 | 是，仅只读工具 |
| `timeout` | 工具超过声明的超时 | 是，仅只读工具 |
| `confirmation_required` | 写操作缺少有效人工确认 | 否 |
| `idempotency_conflict` | 同一幂等键对应不同请求内容 | 否 |
| `internal` | 未分类服务端错误 | 否，等待人工排查 |

错误响应不是诊断事实。`not_found` 只有在稳定 ID、有效查询范围和成功访问数据源的前提下，才能转换为“对象不存在”的证据；超时或权限错误不能转换为 `message_not_found`。

### 1.5 通用数据限制

- 所有 ID 去除首尾空白后长度必须为 1～128，禁止控制字符。
- 时间使用 RFC 3339 UTC；`start < end`，未来时间最多允许 5 分钟时钟偏差。
- 查询禁止接受 SQL、Mongo 表达式、正则脚本或自然语言查询语法。
- 消息正文、手机号、令牌和密码默认不返回；显示名称和摘要按权限脱敏。
- 响应超过最大返回量时必须设置 `truncated=true`，Agent 应缩小范围或追问，不能假设未返回部分不存在。

## 2. 契约总览

| 工具 | 类型 | 超时 | 自动重试 | 最大返回量 | 最低权限 | 人工确认 | 幂等策略 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `find_user_or_message` | 只读 | 2 秒 | 暂时错误最多 1 次 | 20 个候选 | `diagnosis:read` | 否 | 规范化输入下只读幂等 |
| `get_message_status` | 只读 | 2 秒 | 暂时错误最多 1 次 | 1 条消息事实 | `diagnosis:read` | 否 | 按 `messageId` 只读幂等 |
| `get_delivery_events` | 只读 | 3 秒 | 暂时错误最多 1 次 | 50 条投递事实 | `diagnosis:read_delivery` | 否 | 按消息和时间范围只读幂等 |
| `get_connection_status` | 只读 | 2 秒 | 暂时错误最多 1 次 | 1 条连接事实 | `diagnosis:read_connection` | 否 | 按用户和时刻只读幂等 |
| `create_escalation_draft` | 写入草稿 | 3 秒 | 不自动重试 | 1 条草稿 | `escalation:draft:create` | 是 | `idempotencyKey + contentHash` |

只读工具的“最多重试 1 次”是 Tool Service 行为，不是让模型反复调用。总工具调用次数仍受单轮上限约束。

## 3. `find_user_or_message`

### 3.1 目的

将客服提供的稳定 ID、显示名称、会话和时间线索解析为可确认的用户或消息候选。该工具只负责定位，不负责判断根因。

### 3.2 输入 Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "userId": {"type": "string", "minLength": 1, "maxLength": 128},
    "displayName": {"type": "string", "minLength": 1, "maxLength": 100},
    "conversationId": {"type": "string", "minLength": 1, "maxLength": 128},
    "messageId": {"type": "string", "minLength": 1, "maxLength": 128},
    "timeRange": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "end"],
      "properties": {
        "start": {"type": "string", "format": "date-time"},
        "end": {"type": "string", "format": "date-time"}
      }
    },
    "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 10}
  },
  "anyOf": [
    {"required": ["userId"]},
    {"required": ["displayName"]},
    {"required": ["conversationId"]},
    {"required": ["messageId"]}
  ]
}
```

附加约束：时间范围最长 7 天；只提供 `displayName` 时建议要求时间范围或其他线索。显示名称不能自动提升为稳定 `userId`。

### 3.3 输出 Schema

```json
{
  "resolutionStatus": "unique",
  "matches": [
    {
      "entityType": "message",
      "userId": "u_001",
      "displayName": "小王",
      "conversationId": "c_001",
      "messageId": "m_001",
      "observedAt": "2026-08-28T09:10:00Z",
      "evidence": [
        {
          "id": "chat_log:m_001",
          "source": "go_im_connector",
          "kind": "message",
          "observedAt": "2026-08-28T09:10:00Z",
          "field": "message_id",
          "value": "m_001"
        }
      ]
    }
  ],
  "truncated": false
}
```

`resolutionStatus` 枚举：`unique | multiple | none | insufficient_data`。`multiple` 时返回有限候选供客服确认；`none` 不等于消息不存在，除非查询条件包含已确认的唯一 `messageId`。

### 3.4 错误与运行策略

| 项目 | 契约 |
| --- | --- |
| 错误类型 | `invalid_argument`、`permission_denied`、`ambiguous_match`、`rate_limited`、`dependency_unavailable`、`timeout`、`internal` |
| 超时 | 2 秒 |
| 可重试 | `dependency_unavailable`、`timeout`、`rate_limited`；Tool Service 最多重试 1 次 |
| 最大返回量 | 20 个候选；不返回完整消息正文 |
| 权限要求 | `diagnosis:read`；只能访问调用方租户和授权会话 |
| 幂等策略 | 只读；相同规范化输入和相同数据快照返回等价结果 |
| 人工确认 | 调用不需要；多个候选必须由客服补充或确认后才能继续 |

## 4. `get_message_status`

### 4.1 目的

在已有唯一 `messageId` 时返回 `MessageFact`，确认消息是否存在、是否持久化和当前可证明的状态。

### 4.2 输入 Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["messageId"],
  "properties": {
    "messageId": {"type": "string", "minLength": 1, "maxLength": 128}
  }
}
```

### 4.3 输出 Schema

```json
{
  "message": {
    "messageId": "m_001",
    "conversationId": "c_001",
    "senderId": "u_sender",
    "receiverId": "u_receiver",
    "status": "persisted",
    "exists": true,
    "persisted": true,
    "createdAt": "2026-08-28T09:10:00Z",
    "statusAt": "2026-08-28T09:10:01Z",
    "evidence": [
      {
        "id": "chat_log:m_001",
        "source": "go_im_connector",
        "kind": "message",
        "observedAt": "2026-08-28T09:10:01Z",
        "field": "persisted",
        "value": true
      }
    ]
  },
  "unsupportedCapabilities": []
}
```

`status` 必须使用 Canonical 枚举：`created | persisted | queued | delivering | delivered | acknowledged | failed | unknown`。当前 `IM-Grpc` 的 `sent` 业务 ACK 不能映射为 `delivered`；状态语义未确认时返回 `unknown`。

### 4.4 错误与运行策略

| 项目 | 契约 |
| --- | --- |
| 错误类型 | `invalid_argument`、`permission_denied`、`not_found`、`unsupported_capability`、`conflicting_evidence`、`rate_limited`、`dependency_unavailable`、`timeout`、`internal` |
| 超时 | 2 秒 |
| 可重试 | `dependency_unavailable`、`timeout`、`rate_limited`；最多 1 次 |
| 最大返回量 | 1 个 `MessageFact`；禁止返回消息正文和敏感字段 |
| 权限要求 | `diagnosis:read`；校验消息所属租户/会话可见性 |
| 幂等策略 | 按 `messageId` 只读幂等；响应表示查询时快照，不保证跨时间相同 |
| 人工确认 | 否 |

`not_found` 必须包含一条“查询成功但对象不存在”的可审计证据；查询失败不能返回 `not_found`。

## 5. `get_delivery_events`

### 5.1 目的

返回与消息关联的 `DeliveryFact[]`，用于确认投递尝试、失败、成功和接收端 ACK。该工具不发送、重发或取消消息。

### 5.2 输入 Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["messageId"],
  "properties": {
    "messageId": {"type": "string", "minLength": 1, "maxLength": 128},
    "timeRange": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "end"],
      "properties": {
        "start": {"type": "string", "format": "date-time"},
        "end": {"type": "string", "format": "date-time"}
      }
    },
    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20}
  }
}
```

时间范围最长 24 小时。若省略，Connector 只能使用围绕消息创建时间的受限默认窗口，不能进行无限范围扫描。

### 5.3 输出 Schema

```json
{
  "events": [
    {
      "messageId": "m_001",
      "receiverId": "u_receiver",
      "attemptId": "attempt_001",
      "attemptedAt": "2026-08-28T09:10:02Z",
      "result": "attempted",
      "deliveredAt": null,
      "ackedAt": null,
      "errorCode": "",
      "evidence": [
        {
          "id": "delivery_event:evt_001",
          "source": "go_im_connector",
          "kind": "delivery",
          "observedAt": "2026-08-28T09:10:02Z",
          "field": "delivery_attempt",
          "value": "attempted"
        }
      ]
    }
  ],
  "unsupportedCapabilities": [],
  "truncated": false
}
```

`result` 使用 Canonical 枚举：`attempted | success | failed | timeout | unknown`。没有事件查询能力时返回 `unsupported_capability`，不能用空数组伪装“确认没有投递事件”。只有数据源能够证明查询窗口完整时，空数组才可参与 `not_delivered` 判断。

### 5.4 错误与运行策略

| 项目 | 契约 |
| --- | --- |
| 错误类型 | `invalid_argument`、`permission_denied`、`not_found`、`unsupported_capability`、`conflicting_evidence`、`rate_limited`、`dependency_unavailable`、`timeout`、`internal` |
| 超时 | 3 秒 |
| 可重试 | `dependency_unavailable`、`timeout`、`rate_limited`；最多 1 次 |
| 最大返回量 | 50 个 `DeliveryFact`；超限时 `truncated=true` |
| 权限要求 | `diagnosis:read_delivery`；必须先验证消息可见性 |
| 幂等策略 | 按 `messageId + timeRange + limit` 只读幂等；结果为查询时快照 |
| 人工确认 | 否 |

当前 `IM-Grpc` 没有独立、可查询的投递事件模型，真实 Connector 在补齐前应返回 `unsupported_capability`。

## 6. `get_connection_status`

### 6.1 目的

返回指定用户在指定时刻的 `ConnectionFact`。只有历史连接事实能够与投递时间关联时，才可支持 `receiver_offline`。

### 6.2 输入 Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["userId", "at"],
  "properties": {
    "userId": {"type": "string", "minLength": 1, "maxLength": 128},
    "at": {"type": "string", "format": "date-time"}
  }
}
```

`at` 必须来自投递事件时间或经过校验的诊断时间，不能由模型随意猜测。超出 Connector 的历史保留范围时返回 `unsupported_capability` 或 `invalid_argument`。

### 6.3 输出 Schema

```json
{
  "connection": {
    "userId": "u_receiver",
    "state": "offline",
    "observedAt": "2026-08-28T09:10:02Z",
    "connectionId": "conn_001",
    "historical": true,
    "evidence": [
      {
        "id": "connection_event:evt_001",
        "source": "go_im_connector",
        "kind": "connection",
        "observedAt": "2026-08-28T09:10:02Z",
        "field": "connection_state",
        "value": "offline"
      }
    ]
  },
  "unsupportedCapabilities": []
}
```

`state` 枚举：`online | offline | unknown`。如果只能取得 Redis 当前在线状态，应返回 `historical=false`，并在 `unsupportedCapabilities` 中包含 `historicalPresence`；该结果不能支持“投递时离线”的确定结论。

### 6.4 错误与运行策略

| 项目 | 契约 |
| --- | --- |
| 错误类型 | `invalid_argument`、`permission_denied`、`not_found`、`unsupported_capability`、`conflicting_evidence`、`rate_limited`、`dependency_unavailable`、`timeout`、`internal` |
| 超时 | 2 秒 |
| 可重试 | `dependency_unavailable`、`timeout`、`rate_limited`；最多 1 次 |
| 最大返回量 | 1 个 `ConnectionFact` |
| 权限要求 | `diagnosis:read_connection`；校验用户和消息/会话关联关系 |
| 幂等策略 | 按 `userId + at` 只读幂等；结果为查询时快照 |
| 人工确认 | 否 |

当前 `IM-Grpc` 只有 Redis `online:users` 的实时状态，没有历史连接事件；因此第一版真实 Connector 必须显式报告 `historicalPresence` 不支持。

## 7. `create_escalation_draft`

### 7.1 目的

保存一条可编辑的研发升级单草稿。Agent 可以自主生成草稿内容，但调用该写工具前必须由客服查看并确认；工具只保存在本项目中，不提交 Jira、飞书、事故系统或外部通知。

### 7.2 输入 Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "messageId",
    "classification",
    "facts",
    "evidenceRefs",
    "recommendedAction",
    "summary",
    "idempotencyKey",
    "contentHash",
    "confirmationToken"
  ],
  "properties": {
    "messageId": {"type": "string", "minLength": 1, "maxLength": 128},
    "conversationId": {"type": "string", "maxLength": 128},
    "classification": {
      "type": "string",
      "enum": [
        "message_not_found",
        "write_failed",
        "not_delivered",
        "receiver_offline",
        "ack_timeout",
        "delivered",
        "insufficient_data"
      ]
    },
    "facts": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 500}},
    "evidenceRefs": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "string", "maxLength": 256}},
    "possibleCauses": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 500}},
    "missingInformation": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 500}},
    "unsupportedCapabilities": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 100}},
    "recommendedAction": {"type": "string", "enum": ["escalate"]},
    "summary": {"type": "string", "minLength": 1, "maxLength": 2000},
    "idempotencyKey": {"type": "string", "minLength": 16, "maxLength": 128},
    "contentHash": {"type": "string", "pattern": "^[a-f0-9]{64}$"},
    "confirmationToken": {"type": "string", "minLength": 32, "maxLength": 512}
  }
}
```

`confirmationToken` 由后端在客服查看最终草稿后签发，绑定 `actorId`、`runId`、`contentHash`、权限和短期有效期。后端必须重新计算规范化内容的 `contentHash`；仅传 `confirmed=true` 不构成有效确认。

`classification=delivered` 时默认不允许创建升级草稿；如果未来需要例外，必须另行设计原因码和权限，不在第一版范围内。

### 7.3 输出 Schema

```json
{
  "draft": {
    "draftId": "draft_001",
    "status": "draft",
    "messageId": "m_001",
    "conversationId": "c_001",
    "classification": "not_delivered",
    "title": "消息未投递：m_001",
    "body": "已确认事实：消息已持久化；当前没有投递事件。",
    "evidenceRefs": ["chat_log:m_001"],
    "createdBy": "support_001",
    "createdAt": "2026-08-28T10:00:00Z"
  },
  "reused": false
}
```

响应只能声明“草稿已保存”，不能描述为“工单已提交”或“事故已创建”。正文不得包含完整敏感消息内容、凭证或未经确认的根因。

### 7.4 错误与运行策略

| 项目 | 契约 |
| --- | --- |
| 错误类型 | `invalid_argument`、`permission_denied`、`not_found`、`confirmation_required`、`idempotency_conflict`、`conflicting_evidence`、`rate_limited`、`dependency_unavailable`、`timeout`、`internal` |
| 超时 | 3 秒 |
| 可重试 | Agent 不自动重试；调用方在结果未知时可使用完全相同的幂等键和内容查询/重放一次 |
| 最大返回量 | 1 条草稿；`summary` 最长 2,000 字符，最终正文最长 4,000 字符 |
| 权限要求 | `escalation:draft:create`；校验消息可见性、诊断结果归属和证据引用 |
| 幂等策略 | `idempotencyKey` 唯一并绑定 `contentHash`；同键同内容返回原 `draftId`，同键不同内容返回 `idempotency_conflict` |
| 人工确认 | 是；客服确认最终内容后，后端签发并校验一次性/短期 `confirmationToken` |

后端还必须确认 `facts` 均可追溯至同一 `runId` 的证据，`possibleCauses` 未混入事实，并阻止日志或客服输入中的指令进入可执行字段。

## 8. Agent 最小调用规则

```text
缺少稳定 ID
  -> find_user_or_message

已有唯一 messageId
  -> get_message_status

需要确认投递或 ACK
  -> get_delivery_events

投递事件提供 receiverId + attemptedAt，且需要判断离线
  -> get_connection_status

诊断建议 escalate
  -> Agent 生成草稿预览
  -> 客服审核/修改并确认
  -> 后端签发 confirmationToken
  -> create_escalation_draft

任何工具返回 unsupported_capability、truncated=true 或 conflicting_evidence
  -> 不猜测；继续追问、缩小查询范围或结束为 insufficient_data
```

默认每个 Agent run 最多 6 次工具调用、总耗时不超过 10 秒。达到上限进入 `stopped`；不得通过重复调用绕过限制。

## 9. 契约测试要求

实现工具层时至少覆盖：

- Schema 缺字段、额外字段、超长 ID、非法时间范围；
- 昵称多匹配不能自动选择；
- `not_found` 与下游超时严格区分；
- `sent` 不能映射为 `delivered`；
- 空投递事件只有在查询窗口完整时才能作为证据；
- 当前在线状态不能冒充历史连接状态；
- 能力不支持显式返回 `unsupported_capability`；
- 响应截断时设置 `truncated=true`；
- 无确认令牌、过期令牌、内容摘要不匹配均拒绝写入；
- 同幂等键同内容复用原草稿，同键不同内容报冲突；
- `resend_message`、SQL、Shell 和日志提示词注入无法进入工具白名单。
