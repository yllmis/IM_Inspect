# 本地部署与演示

本文只描述本地或隔离测试环境。不要把生产密码、Token、真实用户数据、数据库 Dump 或未脱敏日志复制到本仓库。

## 1. 前置条件

- Node.js 22（建议使用当前 LTS）和 npm；
- MySQL 8.x，并创建独立的 `im_inspect` 数据库及最小权限账号；
- 一个有效的 MiMo API Key；
- 仅在真实 IM 模式下：可访问的 `OperationsQuery` gRPC 服务。

安装依赖并创建本地配置：

```sh
npm install
cp .env.example .env.local
```

`.env.local` 已被 Git 忽略。填写 MiMo 和 MySQL 配置后执行迁移：

```sh
npm run db:migrate
```

开发启动：

```sh
npm run dev
```

生产方式本地验证：

```sh
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:3000`。不要同时运行 `next dev` 和 `next build`，两者会共同写入 `.next`。

如需在本地 UI 演示升级草稿和 Trace 权限流程，可显式启用固定演示身份：

```env
DEMO_SUPPORT_AUTO_AUTH=true
```

该开关在 `NODE_ENV=production` 时无效；生产环境必须接入 Bearer Token/JWT 等真实认证。

## 2. Fake Connector 演示

Fake Connector 使用固定 Fixture，不访问真实 IM，适合演示和回归：

```env
IM_INSPECT_CONNECTOR=fake
FAKE_CONNECTOR_FIXTURE=delivered
```

也可以只对本次进程覆盖模式：

```sh
npm run dev:fake
```

核心 Fixture 与测试消息 ID：

| Fixture | 消息 ID | 预期分类 |
| --- | --- | --- |
| `delivered` | `msg_delivered` | `delivered` |
| `message_missing` | `msg_missing` | `message_not_found` |
| `write_failed` | `msg_write_failed` | `write_failed` |
| `not_delivered` | `msg_not_delivered` | `not_delivered` |
| `receiver_offline` | `msg_receiver_offline` | `receiver_offline` |
| `ack_timeout` | `msg_ack_timeout` | `ack_timeout` |

例如切换场景后重启 Next.js，再输入“查询 `msg_ack_timeout` 为什么没有收到 ACK”。Fixture 是测试数据，不代表生产效果。

## 3. Go IM Connector

Go IM 模式只调用只读 `OperationsQuery`，不直连 MongoDB、Redis、Kafka、SQL 或 Shell：

```env
IM_INSPECT_CONNECTOR=go-im
GO_IM_OPERATIONS_GRPC_URL=127.0.0.1:9100
GO_IM_SERVICE_TOKEN=
GO_IM_OPERATIONS_PROTO_PATH=
GO_IM_INSECURE=true
```

当 OperationsQuery 在远程服务器上只绑定 `127.0.0.1:9100` 时，不应把 9100 暴露到公网。开发联调先在本机建立 SSH 隧道：

```sh
ssh -N \
  -L 127.0.0.1:19100:127.0.0.1:9100 \
  root@<IM_SERVER_IP>
```

保持该终端运行，并将 Agent 配置为：

```env
IM_INSPECT_CONNECTOR=go-im
GO_IM_OPERATIONS_GRPC_URL=127.0.0.1:19100
GO_IM_INSECURE=true
GO_IM_SERVICE_TOKEN=<只保存在本地服务端环境中的查询服务 Token>
```

这里的 `GO_IM_INSECURE=true` 只表示本地 Agent 到本地 SSH 端口使用明文 gRPC；跨公网部分由 SSH 加密。不要把 `0.0.0.0:9100` 与明文 gRPC 组合后直接暴露公网。生产环境优先使用内网/VPN；确需公网时必须同时配置 gRPC TLS、来源 IP 白名单、主机防火墙和服务 Token。

本地无 TLS 时使用 `GO_IM_INSECURE=true`；部署环境应使用 TLS 并设为 `false`。启用服务鉴权时，`GO_IM_SERVICE_TOKEN` 必须与 OperationsQuery 服务端一致，只放在服务端环境变量中。

启动 Agent：

```sh
npm run dev:go-im
```

如果 `GO_IM_OPERATIONS_GRPC_URL` 缺失，接口返回 `connector_not_configured`；系统不会静默改用 Fake 数据。真实 Connector 集成测试见：

```sh
npm run test:go-im
```

未配置真实地址、令牌和隔离测试 ID 时，用例会明确显示为 `skipped`，不算测试通过。

## 4. 可选启动 IM-Grpc OperationsQuery

本项目不在 Next.js 中编译或启动 Go 服务。若本机同时存在 `/Users/yllmis/go_projects/IM-Grpc`，先启动它依赖的 MongoDB、etcd、user-rpc 和 social-rpc，再运行：

```sh
cd /Users/yllmis/go_projects/IM-Grpc
go run ./apps/operations/rpc/operations.go \
  -f ./apps/operations/rpc/etc/dev/operations.yaml
```

示例配置默认使用容器主机名 `mongo`、`etcd`，并关闭服务鉴权和投递观测。直接在宿主机运行时，应创建未提交的本地配置副本，改成实际可访问的地址；不要把密码或 Token 写回仓库。远程容器推荐映射为 `127.0.0.1:9100:9100`，由 SSH 隧道、内网或 VPN 提供访问。OperationsQuery 可以独立启动，但其可用能力取决于依赖和观测数据，未记录的能力必须返回 `unsupported` 或 `partial`。

## 5. Eval 与验证

```sh
# 确定性 Eval（默认使用 Fake Connector）
npm run eval

# 只校验 Eval YAML 契约
npm run eval:contract

# 失败案例报告
npm run eval:failures

# 三组以上消融/对照实验
npm run eval:ablation

# 升级草稿确认流程
npm run eval:escalation-workflow

# 可选 MiMo Judge；不能替代确定性检查
npm run eval:judge
```

提交前运行：

```sh
npm run format
npm run typecheck
npm test
npm run lint
npm run build
```

## 6. 本地 HTTP 冒烟测试

冒烟测试是一次最短完整流程检查，不替代固定 Eval。它会调用真实 MiMo API（可能产生费用），并在本地 MySQL 保存合成演示会话；`--with-draft` 还会保存一份合成升级草稿，不会重发消息或提交外部工单。

先在一个终端启动指定的 Fake 场景和非生产演示身份：

```sh
DEMO_SUPPORT_AUTO_AUTH=true FAKE_CONNECTOR_FIXTURE=write_failed npm run dev:fake
```

在另一个终端执行：

```sh
npm run test:smoke
npm run test:smoke -- --with-draft
```

脚本固定访问 `127.0.0.1:3000`，验证伪造身份字段被拒绝、确定性分类、关键证据、MySQL 多轮状态版本递增、Trace 查询与只读回放，以及可选的草稿幂等确认。只输出检查状态，不输出确认 Token、模型 Key、密码或消息正文。合成会话和可选草稿保留在本地库供演示查看，不会自动删除。

MiMo 使用已验证的 `response_format=json_object` 协议，提示词描述必要字段，SDK 与 Zod 再校验输出；不依赖服务商强制执行 OpenAI 的 strict `json_schema`。当前整轮 API 运行期限为 120 秒，模型调用共享取消信号；单工具超时和重试上限仍由 ToolRegistry 独立限制。

Go IM 的普通测试新增本机隔离 gRPC 传输验证（`npm test` 包含），覆盖 protobuf 的 int64 精度、追踪 metadata、空结果、权限拒绝、deadline 和非法观测时间。该服务只返回合成数据，不能替代 `npm run test:go-im` 的真实 OperationsQuery 联调。默认 proto 从应用根目录读取，并纳入 Next.js 生产文件追踪；自定义部署仍可设置 `GO_IM_OPERATIONS_PROTO_PATH`。

Trace 当前在同一 Node.js 进程内共享，可以跨 Chat/查询/回放 Route 访问，但进程重启会丢失 Trace，不能用于多实例审计。会话状态和已确认草稿已存入 MySQL；Trace 的长期持久化不是本次单进程演示的保证。

## 7. 环境变量

| 变量 | 必需范围 | 用途 |
| --- | --- | --- |
| `MIMO_BASE_URL` | Agent | OpenAI-compatible 基础地址 |
| `MIMO_MODEL` | Agent | 模型名称 |
| `MIMO_API_KEY` | Agent | 服务端模型凭证 |
| `MYSQL_DATABASE_URL` | Agent | 会话状态、诊断及升级草稿持久化 |
| `MYSQL_POOL_LIMIT` | 可选 | MySQL 连接池上限 |
| `DEMO_SUPPORT_API_TOKEN` | 升级/Trace API | MVP 服务端演示认证；不能传给模型 |
| `DEMO_SUPPORT_AUTO_AUTH` | 本地 UI 可选 | 非生产环境固定演示身份；默认关闭 |
| `IM_INSPECT_CONNECTOR` | Connector | `fake` 或 `go-im`，默认 `fake` |
| `FAKE_CONNECTOR_FIXTURE` | Fake | 固定 Fixture 名称，默认 `delivered` |
| `GO_IM_OPERATIONS_GRPC_URL` | Go IM | OperationsQuery 地址 |
| `GO_IM_SERVICE_TOKEN` | Go IM 可选 | gRPC 服务身份 Token |
| `GO_IM_OPERATIONS_PROTO_PATH` | Go IM 可选 | 自定义 proto 路径；默认使用仓库副本 |
| `GO_IM_INSECURE` | Go IM 可选 | 本地明文 gRPC；默认 `true` |
| `GO_IM_CAPABILITY_REFRESH_MS` | Go IM 可选 | Connector 能力快照刷新间隔，默认 15000ms；不能替代网络健康检查 |
| `MYSQL_TEST_URL` | MySQL 集成测试 | 只能指向隔离测试库 |
| `GO_IM_TEST_*` | Go IM 集成测试 | 隔离环境测试 ID，不提交真实 ID |

所有凭证变量均为服务端变量，禁止添加 `NEXT_PUBLIC_` 前缀。

### 公网直连联调（仅在完成传输层安全后使用）

如果本地开发确实需要直连服务器，OperationsQuery 必须同时满足：

1. gRPC 服务启用 TLS，Agent 设置 `GO_IM_INSECURE=false`；
2. 云安全组和主机防火墙只允许开发机固定公网 IP；
3. 保留服务 Token、请求限流和审计；
4. 最好使用独立的诊断查询端口，不与主业务 RPC 共用；
5. 不把 MongoDB、Redis、Kafka 的端口作为 Agent 访问入口。

仅修改监听地址为 `0.0.0.0:9100`，再配合 `GO_IM_INSECURE=true`，不属于可接受的联调方案。当前服务器仍建议使用回环监听 + SSH 隧道；若要长期稳定开发，优先使用 `autossh`/系统服务自动重连，或把 Agent 部署到同一内网。

## 8. 提交前安全检查

```sh
git status --short
git diff --check
git check-ignore .env.local
```

确认不提交：数据库密码、生产 Token、真实用户或消息数据、数据库 Dump、未脱敏日志，以及没有测试证据的生产收益数字。
