# IM Inspect

面向客服的 IM 消息异常诊断 Agent。项目当前按小步垂直切片开发。

## 当前阶段

- 设计基线：项目说明、诊断状态机、工具契约、Go IM 数据契约和 Eval 场景。
- 领域模型：Next.js/TypeScript 项目骨架、基于 Zod 的 Canonical Model Schema，以及不依赖 LLM 的确定性诊断引擎。
- Connector：正式 Connector 接口、Fake Connector，以及 6 个固定核心 Fixture（消息缺失、写入失败、未投递、接收者离线、ACK 超时、成功投递）。
- Agent Loop 已有 Vercel AI SDK 初版骨架；上下文提取、受控混合循环和 Agent 专项测试仍待完善。
- 多轮状态基础：`AgentSessionState`、内存 `StateStore`、受控状态合并、诊断输入投影和按用途裁剪的模型上下文；尚未接入 Agent Loop。
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
