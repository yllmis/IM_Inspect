# IM Inspect

面向客服的 IM 消息异常诊断 Agent。项目当前按小步垂直切片开发。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-255%20passed-2ea44f)](#开发与验证)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

## 文档导航

| 主题                           | 入口                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| 项目目标、用户和第一版边界     | [项目说明](docs/project-brief.md)                                |
| MVP 分层架构                   | [MVP 架构图](docs/mvp-architecture.md)                           |
| Agent 执行过程                 | [Agent 时序图](docs/agent-sequence.md)                           |
| 状态机与统一事实模型           | [诊断状态机与 Canonical Model](docs/diagnosis-state-machine.md)  |
| 五个工具的输入、输出和安全边界 | [工具契约](docs/tool-contracts.md)                               |
| 接入真实 IM 的推荐查询门面     | [OperationsQuery 接入参考](docs/operations-query-integration.md) |
| Go IM 字段和能力分析           | [Go IM 数据契约](docs/go-im-data-contract.md)                    |
| 真实 Go IM Connector 实现      | [`src/connectors/go-im/`](src/connectors/go-im/)                 |
| Eval 场景和执行边界            | [Eval Runner](docs/eval-runner.md)                               |
| Trace 查询和回放               | [Trace 查询与回放](docs/trace-query-and-replay.md)               |

> OperationsQuery 是本项目推荐的 IM 侧只读诊断查询门面。它是一个可替换的接口契约，不是要求所有 IM 使用相同数据库、RPC 或表结构；接入方也可以提供语义等价的查询服务，再由 Connector 做映射。

## 当前阶段

- 设计基线：项目说明、诊断状态机、工具契约、Go IM 数据契约和 Eval 场景。
- 领域模型：Next.js/TypeScript 项目骨架、基于 Zod 的 Canonical Model Schema，以及不依赖 LLM 的确定性诊断引擎。
- Connector：正式 Connector 接口、Fake Connector、6 个固定核心 Fixture，以及已实现的 `GoIMConnector`。GoIMConnector 只调用 IM-Grpc 的只读 `OperationsQuery`，不直连 MongoDB、Redis、Kafka 或旧 RPC。
- OperationsQuery 接入：已提供 `OperationsQueryGrpcClient`、最小 proto 契约、原始响应 Zod 校验、UnixNano 时间转换、状态/错误/能力映射和 messageId 关联校验。
- Agent Loop：已接入结构化上下文提取、4 个只读诊断工具、逐次事实合并、确定性诊断、受控回复和重复调用停止规则；升级草稿写操作不进入普通诊断循环。
- 多轮状态：保留内存 `StateStore` 用于单元测试，API 已接入 `MySqlStateStore`；使用相同 `sessionId` 继续诊断，并通过 `version` 乐观锁阻止并发覆盖。
- 工具结果边界：投递查询在 Connector 源头使用 `timeRange + limit`，显式返回完整性、截断和安全来源引用；Tool 层再执行字段白名单、脱敏、异常摘要和响应字节上限，模型只接收按用途裁剪的工作摘要。
- 升级草稿：独立的 `prepare/confirm` API 使用 10 分钟一次性令牌、内容哈希、会话版本和幂等键；诊断快照、确认记录和草稿写入 MySQL，Agent Loop 不持有写权限。
- 尚未完成：真实 Go IM 服务的端到端联调、生产认证系统接入和基于真实数据的性能验证。开发环境仍使用固定 Fixture，不声称代表生产数据。

## 架构图

- [MVP 架构图](docs/mvp-architecture.md)
- [Agent 时序图](docs/agent-sequence.md)

## 真实 IM 接入路径

接入方不需要为了 Agent 改写原有消息发送、投递或存储主链路。推荐在 IM 侧增加一个隔离的、只读的 OperationsQuery 门面：

```text
Agent Tool
  -> GoIMConnector
  -> OperationsQuery（只读查询、鉴权、边界和错误语义）
  -> IM 现有 RPC / 查询服务 / 观测事件
```

OperationsQuery 的价值是把 IM 内部的 RPC 语义、数据库字段和错误码隔离在 IM 侧。Agent 只依赖稳定的业务语义，例如 `found=false`、`coverageStatus=partial` 和 `unsupported_capability`，不需要知道 `GetChatLog` 或具体表结构。完整的请求/响应字段、错误语义、能力声明和上线策略见 [OperationsQuery 接入参考](docs/operations-query-integration.md)。

最小接入顺序：

1. 先实现 `GetCapabilities` 和 `GetMessageRecord`，验证鉴权、超时和 `found=false` 语义。
2. 再按实际可观测性接入投递时间线和连接观测；没有记录的能力必须返回 `unsupported`，不能用空数组伪造。
3. 在 Agent 侧配置 `GO_IM_OPERATIONS_GRPC_URL` 和 `GO_IM_SERVICE_TOKEN`，使用 `GoIMConnector` 替换 `FakeConnector`。
4. 先运行 Connector 单测和固定 Eval，再进行隔离环境的端到端联调。

## 本地命令

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run eval
npm run eval:failures
npm run eval:escalation-workflow
npm run eval:judge
npm run eval:ci
npm run eval:escalation
```

### 开发与验证

提交前建议运行：

```sh
npm run format
npm run typecheck
npm test
npm run lint
```

真实 MySQL 或 Go IM 服务不是普通单测的前置条件。未配置外部服务时，测试使用固定 Fixture；真实集成测试必须显式配置对应环境变量。

## MySQL

复制环境变量模板并填写本地凭据：

```sh
cp .env.example .env.local
```

创建独立数据库和最小权限账号后执行迁移：

```sh
npm run db:migrate
```

应用通过 Repository/Store 接口访问 MySQL；Agent、模型和工具均不能直接执行 SQL。当前迁移创建会话状态、诊断结果、升级草稿及短期确认记录。

升级草稿接口使用服务端 `DEMO_SUPPORT_API_TOKEN` 验证 Bearer Token。第一版身份固定映射为演示客服，接入公司登录系统时只需替换认证适配器：

```text
POST /api/escalation-drafts/prepare  { sessionId, summary }
POST /api/escalation-drafts/confirm  { sessionId, confirmationToken }
```

客户端不能提交 `actorId`、`tenantId`、权限、诊断分类、证据或 `confirmed=true`。

如需运行真实 MySQL Repository 集成测试，将 `MYSQL_TEST_URL` 指向隔离的测试数据库，然后执行：

```sh
npm run test:mysql
```

未配置 `MYSQL_TEST_URL` 时，普通测试会明确跳过 MySQL 集成用例，不会连接或修改本地数据库。

设计文档校验：

```sh
npm run eval
```

`npm run eval` 会启动确定性的 Eval Runner：加载场景、初始化 Fake Connector、运行 Agent、检查分类/字段/证据/工具/危险操作并输出结果表。缺少 Fixture 的场景会标记为 `not_run`；`npm run eval:contract` 只做 YAML 契约校验。详见 [Eval 校验与执行边界](docs/eval-runner.md)。

`npm run eval:failures` 会按 `failureCategories`（一级责任边界）和
`failureReasons`（具体断点）记录失败案例，并可通过 `--before <报告路径>` 比较修改前后
的失败场景、是否引入新问题和失败案例减少数。报告同时记录场景、Fixture 和 Gold Label
指纹，防止通过修改测试数据制造失败减少。详见 [失败案例记录与回归比较](docs/failure-analysis.md)。

`npm run eval:escalation-workflow` 会独立验证升级草稿的服务端准备、确认、过期、内容变更和幂等边界；它不调用模型，也不会提交外部事故单。

`npm run eval:judge` 使用 `.env.local` 中的 Mimo 配置，对确定性检查通过的已执行场景
做外部语言质量评估；`npm run eval:ci` 还会把 Judge 不可用、未执行场景和低于
`EVAL_JUDGE_MIN_AVERAGE` 的结果作为失败。LLM Judge 是补充门禁，不替代确定性诊断、
权限和安全检查。

开发和测试使用本地固定数据，不需要生产凭证。Agent 不直接访问 MongoDB、MySQL、Redis、Kafka、SQL 或 Shell。
