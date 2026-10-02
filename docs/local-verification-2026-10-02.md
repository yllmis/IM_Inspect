# 本地部署验证记录（2026-10-02）

本次只验证本机和合成 Fixture，不使用真实 IM 用户数据，不声明生产收益。

## 实际验证结果

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| MiMo HTTP 与 JSON 输出 | HTTP 200 | 真实 API，合成问题，不代表模型稳定准确率 |
| `npm run test:smoke -- --with-draft` | 通过 | 真实 MiMo + Next.js HTTP + MySQL + Fake Connector |
| 两轮诊断状态 | 分类保持 `write_failed`，版本递增 | 同一合成会话，不把聊天摘要当证据 |
| Trace 查询与回放 | HTTP 200；`executedTools=false` | 单进程，不重新执行工具 |
| 升级草稿 | prepare 201；confirm 200；重复确认复用原草稿 | 本地 MySQL，没有发送外部工单 |
| 伪造身份字段 | HTTP 400 | `tenantId` 和权限不能由客户端提交 |
| `npm test` | 303 通过，10 跳过 | 36 个文件通过；3 个外部集成文件跳过 |
| `npm run test:mysql` | 3/3 通过 | 显式配置的独立测试库；不使用应用库作为测试库 |
| 本地 gRPC 传输 | 5/5 通过 | 合成服务，包含精度、metadata、空结果、权限、超时和非法时间 |
| `npm run eval:contract` | 41 场景，29/29 Fixture 存在 | 只验证契约与资源存在 |
| 普通 Eval | 34/41 通过 | 7 个升级组失败仍保留，不通过修改预期消除失败 |
| 专用升级 Eval | 7/7 通过 | 验证实际 prepare/confirm，普通 Runner 的 7 个差异归为 `eval_harness_gap` |
| `npm run test:go-im`（SSH 隧道） | 5 通过，2 跳过 | 真实 OperationsQuery；2 个可选故障注入 ID 未配置 |
| Go IM Agent 端到端（SSH 隧道） | HTTP 200；`message_not_found` | 真实 MiMo + GoIMConnector + OperationsQuery；使用隔离测试 ID，只读查询 |
| `npm run typecheck` / `npm run lint` | 通过 | 包括新增测试和冒烟脚本 |
| `npm run build` | 通过 | proto 已出现在 Chat Route 的文件追踪清单 |

## 远程 Go IM 联调补充

最初直接对公网地址 `43.140.35.96:9100` 使用只读能力查询进行了验证：

```text
GO_IM_OPERATIONS_GRPC_URL=43.140.35.96:9100
GO_IM_INSECURE=true
GO_IM_TEST_MESSAGE_ID=
npm run test:go-im
```

结果为能力查询在 5 秒 deadline 内超时，外部 TCP 探测也在约 3 秒后超时。后续确认这是预期的部署边界：容器端口映射为 `127.0.0.1:9100:9100`，故意不允许公网直接访问。这次超时证明公网入口未开放，不是 OperationsQuery 服务故障，也不能说明消息不存在。Connector 测试仍按超时失败返回，不把它转换成 `exists=false`。

正确联调方式是在本地建立 `127.0.0.1:19100 -> SSH -> 服务器 127.0.0.1:9100` 的加密转发，再把 `GO_IM_OPERATIONS_GRPC_URL` 设置为 `127.0.0.1:19100`。建立隧道后，能力查询通过，真实 Connector 测试通过 5 项、跳过 2 项可选故障注入测试；随后启动 Go IM Connector 模式的 Next.js，真实 MiMo Agent Loop 通过 `get_message_status` 返回 HTTP 200 和 `message_not_found`。这个分类来自 OperationsQuery 对隔离测试 ID 的成功空结果，不是超时推断。

单测中的 MySQL 用例默认跳过，但单独加载 `.env.local` 后的真实 MySQL 集成命令已经执行通过。这两项不是同一次执行，也不能把它们的跳过计为通过。

## 测试发现的问题与修复

1. 字段提取空对象可以借助默认值通过校验。分离状态 Schema 和模型输出 Schema，要求模型显式返回五个字段；未知值为 `null`。模型提取仍不是已确认事实。
2. 真实模型提取耗时超过工具上下文默认的 10 秒，随后工具在执行前即被拦截为超时。Chat Route 采用 120 秒整轮期限，模型共享取消信号；单工具仍保持独立短超时、有限重试和调用次数限制。
3. 支持 JSON 对象输出不等于已经验证严格 JSON Schema 支持。Agent 与 Judge 采用 MiMo `json_object` 协议，在提示词中描述字段，返回后继续进行 SDK/Zod 校验。SDK 的“服务端 schema 不支持”警告不表示本地校验被关闭。
4. Chat 和 Trace Route 的模块内单例不共享，导致实际查询返回 404。单进程仓储改为通过 `globalThis` 共享，并验证模块重载后引用一致；实际 HTTP 查询和回放均再次通过。
5. proto 默认路径依赖源码 `__dirname`，不适合 Next.js 打包。改为应用根目录路径，并显式添加生产文件追踪。

修复后的整个冒烟命令已重新运行通过；新增 9 个回归测试。Eval 的 Fixture 与 Gold Label 未修改，既有 7 个 Runner 覆盖差异仍如实记录。

失败报告的前后比较显示：失败数仍为 7，新问题未增加，场景/Fixture/Gold Label 指纹均未改变。这只说明本次固定回归没有新增失败，不代表真实模型在所有问题上均稳定正确。

## 保留的限制

- 远程 OperationsQuery 只允许服务器本机访问；本次已通过临时 SSH 隧道完成真实只读联调。仍未配置权限错误和超时故障注入 ID，因此这两种异常路径仍需后续隔离环境补测。本地合成 gRPC 服务不能替代真实 Go IM 链路。
- 生产登录认证尚未接入。演示自动身份在生产环境无效，不能作为生产认证方案。
- Trace 仍为单进程内存仓储；服务重启会丢失，跨实例和长期审计需要另行接入持久化 Repository。
- 本次没有进行真实 IM 性能压测或生产稳定性验证。
- 冒烟测试保存了合成会话和合成草稿用于本地查看，没有自动删除；未提交数据库内容、凭证、确认 Token 或模型原始响应。

运行命令与配置见 [本地部署与演示](./local-deployment.md)。原始 Eval 汇总及失败归因见 `eval/reports/` 中本次生成的报告。
