# 六组 Agent 对照实验

`npm run eval:ablation` 使用同一批 41 个固定 Fixture 运行六组离线对照实验。实验的目的不是证明某个模型更聪明，而是验证 Agent 架构边界是否减少事实误判、上下文浪费和危险写入。

## 实验矩阵

| 编号 | 对照 | 处理 | 主要指标 |
| --- | --- | --- | --- |
| 1 | 单个 `diagnose_message_issue` | 细粒度只读工具 | 调用次数、审计事件、危险操作拦截 |
| 2 | 普通自然语言 Prompt | `facts/evidence/missingInformation/possibleCauses` | Schema、证据字段、工具错误是否被提升为事实 |
| 3 | 原始 Fixture/日志 | Tool 层结构化摘要 | 字符数、注入载荷、证据完整性 |
| 4 | 接受模型 `classification` | `diagnose()` 决定最终分类 | 对抗性错误分类拦截、工具错误误判 |
| 5 | 完整历史对话 | StateStore 工作状态和 `buildModelContext` | 上下文字符数、messageId 保留、摘要不可作证据 |
| 6 | 信任前端 `confirmed=true` | 服务端 Token、`contentHash`、幂等键 | 权限拒绝、伪造 Token 拒绝、重复草稿 |

## 解释实验状态

- `measured`：调用了仓库中的确定性代码或固定 Fixture，指标可以在本地复现。
- `boundary_simulation`：为了比较架构接口，模拟了尚未接入生产的另一种边界；它不能解释为真实 LLM 质量或生产性能结论。

实验不使用生产数据库，不把 Gold Label 写入 Agent 状态，也不把 Fixture 当作生产事实。高层工具和普通 Prompt 的对照目前是接口边界模拟；如果以后实现真正的高层工具或外部模型基线，应保持相同 Fixture、输入、模型版本和预算后重新运行。

## 运行

```sh
npm run eval:ablation
```

输出包含每组的对照条件、处理条件、指标、结论和限制。六组实验不能替代 41 个场景的确定性 Eval；它们用于解释为什么选择当前架构。
