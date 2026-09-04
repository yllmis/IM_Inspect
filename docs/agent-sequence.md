# IM Inspect Agent 时序图

> 该图展示一次“消息未收到”诊断请求的受控混合循环。模型负责提出下一步，代码负责校验、执行、聚合事实和最终分类。

```mermaid
sequenceDiagram
    autonumber
    actor CS as 客服
    participant API as Next.js API
    participant A as Agent Loop
    participant LLM as MiMo
    participant R as Tool Registry
    participant C as Connector
    participant F as Fake/GoIM Connector
    participant D as diagnose()
    participant Repo as Draft Repository

    CS->>API: POST /api/chat {text}
    API->>API: 创建 requestId/runId、权限、deadline、调用预算
    API->>A: runAgent(text, model, registry, context)

    A->>LLM: 提取候选 messageId/userId/timeRange
    LLM-->>A: 候选上下文（不是事实）
    A->>A: Zod 校验候选上下文

    alt 缺少定位信息
        A-->>CS: 追问 messageId 或其他必要线索
    else 信息足够
        loop 受控工具循环（最多步数/调用数/截止时间）
            A->>LLM: 提供当前上下文和已返回工具结果
            LLM-->>A: 选择一个白名单工具及参数
            A->>R: execute(toolName, args, context)
            R->>R: 白名单、权限、Schema、预算、重复调用检查

            alt 参数非法 / 无权限 / 未确认写操作
                R-->>A: ToolError（不是诊断事实）
                A->>D: 合并 toolErrors 后重新评估
            else 只读工具
                R->>C: 调用 Connector 方法
                C->>F: 查询 Fixture 或受控 IM 接口
                F-->>C: 原始结果或 Connector 错误
                C-->>R: Canonical Model / ConnectorResult
                R->>R: 超时、有限重试、脱敏、Trace
                R-->>A: ToolResponse
                A->>A: 聚合 MessageFact、DeliveryFact、ConnectionFact、Evidence
                A->>D: diagnose(DiagnosisInput)
            end

            alt 已得到确定性分类
                D-->>A: DiagnosisResult（最终分类）
                A->>LLM: 解释已确认事实并生成客服话术
                LLM-->>A: 回复文本（不能改分类）
            else 证据不足且可继续查询
                D-->>A: insufficient_data + missingInformation
            else 证据冲突 / 能力不支持 / 达到硬上限
                D-->>A: 停止原因和安全说明
            end
        end
    end

    opt 诊断建议升级且客服明确确认
        A->>LLM: 生成升级单草稿文本
        LLM-->>A: 草稿候选内容
        A->>R: create_escalation_draft（带 confirmationToken）
        R->>R: 校验权限、确认绑定、contentHash、幂等键
        R->>Repo: 保存或复用草稿
        Repo-->>R: draft / reused
        R-->>A: 草稿结果
    end

    A-->>API: 结构化执行结果、DiagnosisResult、Trace
    API-->>CS: 客服回复、事实、证据和必要的后续动作
```

## 关键控制点

1. **候选字段不等于事实**：LLM 从客服文字中提取的 `messageId` 只能作为工具参数候选；只有 Connector 成功返回并通过 Schema、关联 ID 和权限校验后，才能进入诊断输入。
2. **工具错误不等于业务结论**：超时、权限不足和下游不可用必须原样保留为 `toolError`，不能改写成“消息不存在”或“投递失败”。
3. **最终分类由代码决定**：`diagnose()` 根据 Canonical Model 和证据优先级返回分类，模型只能解释该结果。
4. **写操作单独受控**：模型不能自行提交事故；`create_escalation_draft` 需要服务端确认、权限、内容哈希和幂等键。
5. **循环有硬上限**：达到最大步骤、最大工具调用次数或 deadline 时停止，并返回 `insufficient_data` 或明确的工具错误。
