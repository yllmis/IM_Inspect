# IM Inspect

面向客服的 IM 消息异常诊断 Agent。项目当前按小步垂直切片开发。

## 当前阶段

- 设计基线：项目说明、诊断状态机、工具契约、Go IM 数据契约和 Eval 场景。
- 领域模型：Next.js/TypeScript 项目骨架、基于 Zod 的 Canonical Model Schema，以及不依赖 LLM 的确定性诊断引擎。
- Connector：正式 Connector 接口、Fake Connector，以及 6 个固定核心 Fixture（消息缺失、写入失败、未投递、接收者离线、ACK 超时、成功投递）。
- Agent Loop：已接入结构化上下文提取、4 个只读诊断工具、逐次事实合并、确定性诊断、受控回复和重复调用停止规则；升级草稿写操作不进入普通诊断循环。
- 多轮状态：保留内存 `StateStore` 用于单元测试，API 已接入 `MySqlStateStore`；使用相同 `sessionId` 继续诊断，并通过 `version` 乐观锁阻止并发覆盖。
- 工具结果边界：投递查询在 Connector 源头使用 `timeRange + limit`，显式返回完整性、截断和安全来源引用；Tool 层再执行字段白名单、脱敏、异常摘要和响应字节上限，模型只接收按用途裁剪的工作摘要。
- 升级草稿：独立的 `prepare/confirm` API 使用 10 分钟一次性令牌、内容哈希、会话版本和幂等键；诊断快照、确认记录和草稿写入 MySQL，Agent Loop 不持有写权限。
- 尚未实现：GoIMConnector 和真实下游数据驱动的 Eval Runner；当前 `npm run eval` 只做场景契约校验。

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
npm run eval
```

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

`npm run eval` 会检查 24 个场景的字段、分类和禁用工具边界，并报告引用的 Fixture 是否已经存在；它不会调用模型或真实 IM。详见 [Eval 校验与执行边界](docs/eval-runner.md)。

开发和测试使用本地固定数据，不需要生产凭证。Agent 不直接访问 MongoDB、MySQL、Redis、Kafka、SQL 或 Shell。
