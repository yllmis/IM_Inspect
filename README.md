# IM Inspect

面向客服的 IM 消息异常诊断 Agent。项目当前按小步垂直切片开发。

## 当前阶段

- 设计基线：项目说明、诊断状态机、工具契约、Go IM 数据契约和 Eval 场景。
- 领域模型：Next.js/TypeScript 项目骨架、基于 Zod 的 Canonical Model Schema，以及不依赖 LLM 的确定性诊断引擎。
- Connector：正式 Connector 接口、Fake Connector，以及 6 个固定核心 Fixture（消息缺失、写入失败、未投递、接收者离线、ACK 超时、成功投递）。
- Agent Loop：已接入结构化上下文提取、4 个只读诊断工具、逐次事实合并、确定性诊断、受控回复和重复调用停止规则；升级草稿写操作不进入普通诊断循环。
- 多轮状态：已接入 `AgentSessionState`、内存 `StateStore`、乐观版本控制和按用途裁剪的模型上下文；API 使用相同 `sessionId` 继续诊断。本地内存状态不具备跨进程持久性。
- 尚未实现：GoIMConnector 和 Eval Runner。

## 架构图

- [MVP 架构图](docs/mvp-architecture.md)
- [Agent 时序图](docs/agent-sequence.md)

## 本地命令

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

设计文档校验：

```sh
ruby -e 'require "yaml"; x = YAML.load_file("docs/eval-cases.yaml"); abort unless (20..30).include?(x["cases"].length)'
```

开发和测试使用本地固定数据，不需要生产凭证。Agent 不直接访问 MongoDB、MySQL、Redis、Kafka、SQL 或 Shell。
