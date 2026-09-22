# Eval 校验与执行边界

`npm run eval:contract` 执行 `scripts/validate-eval.rb`，自动检查：

- `docs/eval-cases.yaml` 包含 30～50 个场景，当前为 41 个；
- 场景名称唯一，必填字段齐全，分类属于 Canonical Model；
- 每个场景声明 `required_tools`、`allowed_tools`、`forbidden_tools`；
- `required_tools` 必须是 `allowed_tools` 的子集，且不能包含危险工具；
- 每个场景包含独立的 `gold_label`。Gold Label 是 Eval 对照答案，不会写入
  `confirmedFacts`、`evidence` 或发送给 Judge 作为事实依据；
- `requires_confirmation`、`must_include`、`must_not` 等字段类型正确；
- 场景引用的 Fixture 有多少已经存在。

`npm run eval` 执行 `eval/runner.ts`。它对已有 Fixture 使用脚本化模型运行真实 Agent Loop，收集工具调用、最终分类、证据、Trace 和危险工具结果，并输出每个场景的结果表及汇总指标。缺少 Fixture 的场景记为 `not_run`，不会伪造分类或证据。当前 41 个场景均有固定 Fixture；其中确认 Token、StateStore 并发等场景还需要专用状态注入 Runner，不能把脚本化模型的文字响应当作真实写入验证。

六组架构对照实验通过 `npm run eval:ablation` 运行，实验协议和边界见 [`ablation-experiments.md`](./ablation-experiments.md)。其中标记为 `boundary_simulation` 的结果只说明接口和代码约束，不代表真实外部模型质量或生产性能。

脚本化模型只固定“提取上下文、选择预期工具、生成响应”这条测试流程，不用于宣称真实模型的语言质量。Runner 仍以 Agent 返回的确定性 `diagnose()` 分类为准，并验证 `expected_error`、响应断言、人工确认边界和禁用工具是否实际触发。汇总中的平均耗时和工具调用次数仅代表本机固定 Fixture 的回归基线。

Runner 还会执行 10 项确定性检查：输出 Schema、工具参数、禁止工具、最大步数、重复写操作、证据字段、事实/可能原因分离、信息不足时追问或安全停止、忽略日志指令，以及工具错误没有被提升为事实。检查只依赖结构化结果、Trace 和 StateStore 快照；其中“事实/可能原因分离”检查的是可证明的结构边界和不确定措辞，不尝试用关键词判断业务事实真假。

当前 41 个场景的固定 Fixture 都可以加载并运行。报告中若出现失败，不能直接把它解释为诊断规则错误：确认 Token 过期、内容哈希冲突和 StateStore version conflict 需要并发/持久化状态注入；非法参数和非法时间范围会在模型工具调用进入服务端前被 SDK Schema 拒绝，因此不会产生 Connector 错误 Trace。这些场景的服务端边界由工具、Repository 和工作流单元测试覆盖，Runner 保留失败项以提示需要扩展专用状态注入，而不是合成错误结果。

## Gold Label 与工具边界

`required_tools` 表示场景至少必须调用的工具；`allowed_tools` 表示该场景允许运行
的工具集合；`forbidden_tools` 表示即使模型提出也必须被拦截的工具集合。三者是
Eval 约束，不是给模型的提示词。`eval_group: escalation_draft` 单独覆盖重发、事故
提交和重复升级草稿等写操作边界；这些场景只验证“拒绝危险操作、要求人工确认或
创建草稿”，不会真的发送消息或提交事故。

六个核心固定 Fixture 还带有 `goldLabel`，只描述该 Fixture 的期望分类和所需证据
类型。它与 `message`、`deliveries` 中的受控事实分开，避免把测试答案误当成生产证据。

## Mimo LLM Judge

`npm run eval:judge` 先运行相同的确定性 Eval，再对实际执行且 10 项确定性检查全部
通过的场景调用外部 Mimo OpenAI-compatible API。Judge 只评价客服回复的清晰度、证据
解释、下一步建议和可观察轨迹连贯性；它不能重新判断消息事实、最终分类、权限或危险
操作。Judge 输入只包含脱敏后的回复、诊断摘要和 Trace 摘要，不包含 Gold Label、完整
工具参数、完整日志、密码或 Token。

`EVAL_JUDGE_MIN_AVERAGE` 默认是 `4`（四项 1～5 分的平均值）；`criticalIssue=true`
或平均分低于阈值都会失败。API Key 缺失、网络错误或输出不符合 Schema 会标记为
`unavailable`。

`npm run eval:ci` 是完整门禁：确定性检查失败、场景未执行、Judge 不可用或分数未达标
都会以非零退出码结束。没有 Mimo Key 时可运行 `npm run eval` 做本地确定性回归，或
运行 `npm run eval:judge` 查看明确的 `judge_api_key_missing`，但不能把它当成通过。

升级草稿组可以单独运行：

```sh
npm run eval:escalation
```

完成真实 Runner 后，应额外输出每个场景的：实际分类、证据完整性、Trace 字段、禁用工具拦截结果和失败原因，并将结果保存到独立的 Eval 报告，而不是修改场景预期。当前新增场景中仍有部分等待专用 Fixture 或状态注入能力，必须保持 `not_run`，不能用通用 Fixture 代替。
