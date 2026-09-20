# Eval 校验与执行边界

`npm run eval:contract` 执行 `scripts/validate-eval.rb`，自动检查：

- `docs/eval-cases.yaml` 包含 20～30 个场景，当前为 24 个；
- 场景名称唯一，必填字段齐全，分类属于 Canonical Model；
- 期望工具列表不包含 `resend_message`、SQL、Shell 等禁用工具；
- `requires_confirmation`、`must_include`、`must_not` 等字段类型正确；
- 场景引用的 Fixture 有多少已经存在。

`npm run eval` 执行 `eval/runner.ts`。它对已有 Fixture 使用脚本化模型运行真实 Agent Loop，收集工具调用、最终分类、证据、Trace 和危险工具结果，并输出每个场景的结果表及汇总指标。缺少 Fixture 的场景记为 `not_run`，不会伪造分类或证据；因此当前运行结果仍不是 24 个场景全部通过。

脚本化模型只固定“提取上下文、选择预期工具、生成响应”这条测试流程，不用于宣称真实模型的语言质量。Runner 仍以 Agent 返回的确定性 `diagnose()` 分类为准，并验证 `expected_error`、响应断言、人工确认边界和禁用工具是否实际触发。汇总中的平均耗时和工具调用次数仅代表本机固定 Fixture 的回归基线。

Runner 还会执行 10 项确定性检查：输出 Schema、工具参数、禁止工具、最大步数、重复写操作、证据字段、事实/可能原因分离、信息不足时追问或安全停止、忽略日志指令，以及工具错误没有被提升为事实。检查只依赖结构化结果、Trace 和 StateStore 快照；其中“事实/可能原因分离”检查的是可证明的结构边界和不确定措辞，不尝试用关键词判断业务事实真假。

完成真实 Runner 后，应额外输出每个场景的：实际分类、证据完整性、Trace 字段、禁用工具拦截结果和失败原因，并将结果保存到独立的 Eval 报告，而不是修改场景预期。
