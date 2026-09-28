# SkyViewLab 分离式后端

当前后端分为三个独立进程：

- `backend_go/cmd/server`：浏览器唯一访问的 Go Control Plane，负责开发会话、租户作用域、项目、审计和作业状态。
- `backend_go/cmd/worker`：独立作业领取进程，只通过带 Worker 身份的内部 API 驱动任务。
- `backend_python`：Python Compute Plane，仅接受 Go 的 HMAC 服务签名，不对浏览器公开。

React 前端使用 `http://localhost:8080/api/v1`。计算必须经过“创建作业 → Worker 领取 → Go 签名调用 Python → 服务端写入终态”；旧直接运行接口和客户端上报运行终态均被拒绝。

> 这仍是 Gate B 的单机开发适配器，不是生产部署。PostgreSQL、OIDC 和 OpenFGA 的代码纵切已存在，但尚未通过真实服务端到端验收；SQLite 队列、开发账号、本地授权 fallback 和本机 Worker 只用于联调。Temporal、S3、集中式审计与可观测系统仍未接通。

## 本机容器联调

复制 `backend-compose.env.example` 为 Compose 命令实际读取、且不提交版本库的 `.env.backend`，填写两个至少 32 字符的随机密钥和显式开发账号。不要复用生产凭据，也不要把填写后的文件发给他人。

```powershell
Copy-Item backend-compose.env.example .env.backend
docker compose --env-file .env.backend -f backend-compose.yml config
docker compose --env-file .env.backend -f backend-compose.yml up --build
```

该编排只把 Go API 绑定到 `127.0.0.1:8080`。Python 8000 端口只在内部网络可见；代码执行开发开关始终关闭。当前工作站尚未安装 Docker，因此还需要在具备 Docker 的验收机上补做镜像构建、健康检查和重启恢复测试。

## 不使用容器时

变量必须按进程最小注入，只有明确成对使用的值需要一致；不要把整组环境复制给三个进程：

- Go API ↔ Python：只共享 `SERVICE_HMAC_SECRET`（至少 32 个 UTF-8 字节）；Worker 不需要这个密钥。
- Go API ↔ Worker：开发模式只共享 `WORKER_ID`/`WORKER_TOKEN`（token 至少 32 个 UTF-8 字节）；API 还用 `WORKER_CAPABILITIES_JSON` 绑定目录 slug/action，Python 不需要这些变量。
- 仅 Go API：`DEV_MODE=true`、显式开发账号、`DATABASE_ADAPTER=sqlite-development`、`DATABASE_FILE=./data/skyviewlab.db` 和 `DEV_AUTHORIZATION_FALLBACK=true`；不要同时设置 `DATABASE_URL`。
- 仅 Python：`APP_ENV=development`，同时保持 `ALLOW_UNSIGNED_DEV_REQUESTS=false`、`ALLOW_UNSAFE_LOCAL_CODE_EXECUTION=false`。
- 仅 Go API：`PYTHON_REQUEST_TIMEOUT=30s` 是同步上游预算（`1s..8m`）；`JOB_TERMINAL_PERSIST_TIMEOUT=30s` 是提交 job/run、outbox 与审计的独立预算（`5s..2m`）。HTTP 写超时覆盖两个预算并额外留 15 秒；它们都不能替代 Temporal。
- 仅 Worker：`GO_CONTROL_PLANE_URL=http://127.0.0.1:8080`；它不接收 HMAC、数据库、OIDC 或 OpenFGA Secret。

浏览器会话的写操作必须携带精确匹配 `CORS_ORIGINS` 的 `Origin`。开发环境只允许 `http://localhost[:port]` 或 `http://127.0.0.1[:port]`；生产至少配置一个规范化 HTTPS origin，禁止通配符、路径、凭据、查询和片段。恶意 Origin 以及携带会话 Cookie 但缺失 Origin 的写请求都会在认证/业务处理前返回 403；无 Cookie 的 Worker Bearer 与受控 CLI 请求保持兼容。

依次启动：

```powershell
# backend_python
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# backend_go
go run ./cmd/server

# backend_go（另一终端）
go run ./cmd/worker

# web_react
npm run dev -- --port 4182
```

所有变量应由当前终端、受控 `.env` 加载器或 Secret Manager 注入；不要把真实值写进命令历史、源码或 README。

## 生产配置契约

生产 Go API 必须同时满足以下各组契约；任一组缺失都应 fail-closed，而不是回退到本地实现。

### PostgreSQL

- 设置 `DEV_MODE=false`、`DATABASE_ADAPTER=postgresql`，并保证 `DATABASE_FILE` 为空。`DATABASE_URL` 必须使用 `sslmode=verify-full`，并固定搜索路径，例如 `postgresql://.../skyviewlab?sslmode=verify-full&options=-csearch_path%3Dpg_catalog%2Cpublic`。
- 正常 API 启动必须保持 `DATABASE_MIGRATE=false`。它会先校验 checksum 迁移账本，再以 `current_user` 校验 PostgreSQL 角色危险属性、5 个非管理员服务角色双向无继承、数据库/schema、表/序列/函数所有权、表级与列级权限、完整 public 函数清单、未知 view/materialized view/foreign table、RLS policy 清单、审计 append-only ACL 与迁移账本只读 ACL；校验不通过时不会创建 HTTP handler。
- `DEV_MODE=false` 且 `DATABASE_MIGRATE=true` 会进入一次性 migration-only 路径：仅使用 migrator DSN 迁移并退出，不读取 Worker、OIDC、OpenFGA 或 Python 凭据，也不监听端口。migrator DSN 不得出现在任何长期服务的 Secret 中；只有 Go API 使用独立 runtime DSN 并设置 `DATABASE_MIGRATE=false`。独立 Worker 不直连数据库，禁止向它注入 `DATABASE_URL` 或任何数据库凭据。
- runtime 对 `audit_events`、`audit_heads` 均只有读取权。它只可执行两个逐签名允许的 migrator-owned `SECURITY DEFINER` 函数：`append_audit_event_v3` 用事务 RLS 身份校验 scope 后串行追加带 UTF-8 字节长度边界的审计链，`resolve_session_identity_v1` 只按一个 SHA-256 会话摘要解析并触碰仍有效的身份；二者都固定 search path，ACL 精确限制为 owner/runtime，runtime 没有 grant option，PUBLIC 与第三方角色均不可执行。任何未登记的 public-schema 函数都会阻断启动。
- 迁移 009、011、012 都是停机安全切换：先停止并排空旧实例，再依次执行 PG001–PG012、ACL lockdown、runtime live verifier，最后启动新版本，禁止混合滚动旧 writer。PG012 在任何 DDL 或重封存前，会先用 PG011 已封存契约双向验真全部 public policy/function/noninternal trigger，缺失、额外、空哈希或定义漂移均拒绝升级。旧 v1/v2 PostgreSQL 事件继续逐条只读验真；v1 兼容 pgx 微秒截断，超过 10,000 个旧事件会拒绝在线迁移，需在停写的离线恢复快照上先做完整预检与容量评估。
- `COOKIE_SECURE=true`，清空全部开发账号变量。数据库 URL、证书与凭据必须来自 Secret Manager。
- 代码已包含 PostgreSQL 方言、显式迁移、复合租户外键、`TIMESTAMPTZ`/`JSONB`、事务本地且每次全量覆盖的服务端 RLS context、作业 `FOR UPDATE SKIP LOCKED` 和审计链 head lock；当前环境没有真实 PostgreSQL E2E，尚未验证升级、回滚、备份恢复、故障切换、连接池和容量。

### OIDC / Keycloak

- 必填：`OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`OIDC_REDIRECT_URL`、`OIDC_WEB_RETURN_URL`、`OIDC_TENANT_CLAIM=tenant_id`、`OIDC_WORKSPACE_CLAIM=workspace_id`，以及由密钥管理系统注入、标准 padded base64 编码的 32 字节 `OIDC_TRANSACTION_KEY`。
- 保持 `OIDC_ALLOW_INSECURE_HTTP=false`；`OIDC_MAX_TOKEN_LIFETIME` 默认 `1h`。客户端必须是 confidential client，使用 Authorization Code + PKCE S256，关闭 implicit flow 和 direct access grants。
- `OIDC_REDIRECT_URL` 必须与 Keycloak 客户端登记值逐字符一致，例如 `https://api.example.com/api/v1/auth/oidc/callback`；不允许通配符回调。`OIDC_WEB_RETURN_URL` 是服务端固定的登录完成页面，浏览器参数不能覆盖。
- Keycloak 用户必须填写自定义属性 `skyviewlab_tenant_id` 与 `skyviewlab_workspace_id`。realm 模板将它们映射为 ID token 中的 `tenant_id` 与 `workspace_id`，并同时提供 `email`、`email_verified` 和 `name`。
- OIDC 只证明身份，不授予业务角色。上线前必须先在本地业务库预配用户、租户、工作区及 active membership；角色以本地 membership 为准，Keycloak role 不进入会话授权。
- 共享事务存储代码已落地：state 只保存 SHA-256，nonce 与 PKCE verifier 使用 AES-256-GCM 密文持久化，并通过原子 `DELETE ... RETURNING` 保证多副本中最多一次消费；state 与 session 的生成/到期判断都以数据库 wall clock 为唯一权威。每个成功入口还会在同一事务保留一条随机、不可由 callback/abort 删除的短时 admission 标记，跨副本窗口不依赖当前 pending state 数量。开发直连模式额外使用 RemoteAddr 来源网段和进程全局限流；生产应用只使用进程全局与数据库共享窗口，并故意忽略不可信 `Forwarded`/`X-Forwarded-For`，因此可信 TLS 网关/WAF 的客户端来源限流是发布前置条件。真实 Keycloak + PostgreSQL 并发回调、数据库故障切换、密钥轮换、会话撤销、多副本滥用和滚动发布演练完成前，OIDC 仍是生产 NO-GO。

### OpenFGA

- 必填：`OPENFGA_API_URL`、`OPENFGA_STORE_ID`、`OPENFGA_AUTHORIZATION_MODEL_ID`、`OPENFGA_API_TOKEN`、`OPENFGA_MODEL_SHA256`；保持 `OPENFGA_ALLOW_INSECURE_HTTP=false`，并把 `DEV_AUTHORIZATION_FALLBACK=false`。
- `OPENFGA_AUTHORIZATION_MODEL_ID` 必须固定到已审核发布的不可变 model ID。`OPENFGA_MODEL_SHA256` 是 OpenFGA `ReadAuthorizationModel` 响应中 `authorization_model` 规范化 JSON 的 SHA-256；readiness 会同时校验 ID、模型关系契约和哈希。
- `OPENFGA_API_TOKEN` 必须是独立、至少 32 字符的受管密钥，并与 OpenFGA 服务配置的某个 preshared key 一致。OpenFGA 只能在私网通过 TLS 访问，不允许匿名生产连接。
- 当前 Check 纵切会把服务端已知关系作为 contextual tuples 发送，但 tenant/workspace/project/course/assignment tuple 尚未可靠持久同步到 OpenFGA，也没有完备的撤权时效、幂等写入、对账修复和真实 OpenFGA E2E。因此逐资源授权仍是生产 NO-GO。

### Worker / Python Compute Plane

- `PYTHON_SERVICE_URL` 必须是无凭据、路径、查询或片段的内部 HTTPS authority；生产必须保持 `PYTHON_ALLOW_INSECURE_HTTP=false`。`PYTHON_REQUEST_TIMEOUT` 默认 `30s`、允许 `1s..8m`；`JOB_TERMINAL_PERSIST_TIMEOUT` 默认 `30s`、允许 `5s..2m`。后者必须在目标 PostgreSQL 以 4 MiB 结果、同步复制和同 scope 审计锁争用压测并据 SLO 配置；更长或需跨进程恢复的计算只能进入 Temporal。
- Go 与 Python 共享的 `SERVICE_HMAC_SECRET` 至少 32 个 UTF-8 字节并由 Secret Manager 注入；Python 必须保持未签名请求和不安全本机代码执行开关关闭。
- 生产 Go API 只接受受控 `WORKER_CREDENTIALS_FILE` 作为 Worker 验证注册表，文件内每个凭据绑定精确 tenant/workspace/slug/action；API 进程禁止 inline 的 `WORKER_TOKEN`、`WORKER_ID` 和 `WORKER_CAPABILITIES_JSON`。每个独立 Worker 进程则由 Secret Manager 只注入自己的匹配 `WORKER_ID`/`WORKER_TOKEN`，并设置 `DEV_MODE=false` 与 HTTPS `GO_CONTROL_PLANE_URL`；不要向 Worker 暴露整份注册表。
- 静态 opaque token、同步执行桥和本机进程都只是过渡实现；workload identity/mTLS、轮换吊销、Temporal、容器或 microVM 资源/网络隔离与故障恢复演练完成前仍为生产 NO-GO。

### Transactional outbox 边界

数据库已具备 outbox 表、幂等入队、一次性 claim capability 摘要、epoch、数据库时钟 lease、heartbeat、超时重领、重试、最大尝试、dead-letter 和确认语义。作业创建、成功、失败和取消分别产生 `job.created`、`job.succeeded`、`job.failed`、`job.cancelled`，并与 job/run 状态同事务；事件不复制输入、结果或错误内容。PostgreSQL relay 接口要求显式的 tenant/workspace/event-type scope，未携带受限 scope 的全局领取会 fail-closed。当前仍没有正式 relay 进程、OpenFGA consumer、幂等 sink、告警/清理或真实 PG 故障恢复演练，因此 outbox 仍不能视为完整交付能力。

同步执行桥在 execution fence 后使用独立、可配置且有上限的数据库上下文落终态，避免 Worker HTTP 断连直接取消提交。若该事务预算耗尽，接口返回不可作为重放信号的 503；已开始计算的 lease 随后丢失也不会自动重放。下一次同作用域授权 claim 扫描会把 job/run 原子标为 failed，并写 `job.failed` outbox 与 `job.execution_lease_lost` 审计，要求人工核对外部副作用。当前没有 durable finalize intent 或独立 reaper，若该 scope 不再被扫描，记录可能暂时保持 running；正式 Temporal reconciliation 仍是硬门禁。

## 验证

三层服务启动后，可先运行不需要账号和密码的本地安全冒烟检查：

```powershell
.\verification\verify-local.ps1
```

它会检查 React/Go/Python 就绪状态、24 项能力目录、前端跨域边界，以及未签名直调 Python 和匿名创建作业是否被拒绝。随后执行各项目的完整测试：

```powershell
# Go
go test ./...
go vet ./...

# Python
python -m unittest discover -s tests -v

# React
npm run lint
npm test
npm run build
```

基础设施验收骨架位于 `infra/`，其边界和仍未完成的生产项见 `infra/README.md` 与根目录 `PRODUCTION_REBUILD_PROGRESS.md`。
