# Eval 校验与执行边界

`npm run eval` 当前执行 `scripts/validate-eval.rb`。它会自动检查：

- `docs/eval-cases.yaml` 包含 20～30 个场景，当前为 24 个；
- 场景名称唯一，必填字段齐全，分类属于 Canonical Model；
- 期望工具列表不包含 `resend_message`、SQL、Shell 等禁用工具；
- `requires_confirmation`、`must_include`、`must_not` 等字段类型正确；
- 场景引用的 Fixture 有多少已经存在。

这一步是“契约级校验”，不会调用模型、数据库、Kafka、Redis 或真实 IM，因此不会把缺少生产数据的场景误报成执行通过。当前只有本地 Fake Connector 的固定 Fixture 可以用于单元测试；要运行完整 24 场景，需要为每个 `setup.fixture` 提供数据源并接入确定性的 Eval Runner。

完成真实 Runner 后，应额外输出每个场景的：实际分类、证据完整性、Trace 字段、禁用工具拦截结果和失败原因，并将结果保存到独立的 Eval 报告，而不是修改场景预期。
