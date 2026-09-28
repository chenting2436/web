# SkyViewLab Go Control Plane（Gate B 地基）

Go 服务是 React 唯一可以访问的业务入口。本阶段已经建立统一认证、tenant/workspace 服务端作用域、持久会话、append-only 审计和服务端作业/运行契约。SQLite 仅是开发与测试适配器；PostgreSQL 最小适配器与显式迁移已经落地，但整体产品仍受下方 NO-GO 门禁约束。

## OpenAPI 契约与漂移门禁

稳定控制面契约位于 [`api/openapi.yaml`](./api/openapi.yaml)，版本为 OpenAPI 3.1。文件使用 JSON 语法（JSON 是 YAML 的严格子集），因此无需给生产模块增加 YAML 解析或代码生成依赖，同时仍可直接交给支持 OpenAPI 3.1 的校验器、文档工具和 SDK 生成器。

契约覆盖当前全部 `/api/v1` 路由及方法，明确区分公开入口、`skyviewlab_session` HttpOnly Cookie、OIDC 关联 Cookie 和内部 Worker Bearer；浏览器写操作的 `Origin`、作业 `Idempotency-Key`、统一 `data/error + requestId` envelope、请求/上游响应大小边界，以及固定拒绝的直接执行/客户端运行终态端点也都属于契约。临时 `/api` 兼容前缀只在 `DEV_MODE=true` 时注册并被显式排除在稳定契约之外；生产不会暴露该别名，新客户端只能面向 `/api/v1`。

`internal/api/openapi_contract_test.go` 会从 `server.go` 反向提取已注册路由，与契约做双向覆盖检查，并校验 operationId 唯一性、响应定义、成功/失败 envelope、生产写操作安全方案、Origin 门禁、幂等键和关键枚举。增删路由或改变状态值时若未同步契约，测试会直接失败。协作记录中的 `data` 和工作台状态当前仍是开放对象，并以 `x-domain-schema-status: partial` 标记；这份控制面契约不代表各工作台领域 schema 已经达到生产完成态。

## 本地开发启动

开发账号没有内置默认值。只有显式开启 `DEV_MODE=true` 并提供账号与密码后，本地登录才可用。

```powershell
$env:DEV_MODE='true'
$env:DEMO_ACCOUNT='admin@example.local'
$env:DEMO_PASSWORD='请提供至少12字符的本地专用密码'
$env:STUDENT_ACCOUNT='student@example.local'
$env:STUDENT_PASSWORD='请提供至少12字符的本地专用密码'
$env:DEV_TENANT_ID='tenant-dev'
$env:DEV_WORKSPACE_ID='workspace-dev'
$env:SERVICE_HMAC_SECRET='请提供至少32字节的服务签名密钥'
$env:WORKER_TOKEN='请提供至少32字节的Worker令牌'
$env:WORKER_ID='local-worker-1'
$env:WORKER_CAPABILITIES_JSON='[{"slug":"paper-writing","actions":["outline","audit"]}]'
$env:DATABASE_ADAPTER='sqlite-development'
$env:DATABASE_FILE='./data/skyviewlab.db'
$env:DEV_AUTHORIZATION_FALLBACK='true'
go run ./cmd/server
```

默认地址为 `http://127.0.0.1:8080`。除健康检查、工具目录和登录入口之外，所有浏览器业务 API 都要求有效的 HttpOnly 会话 Cookie；`/api/v1/internal/jobs/*` 只接受服务端绑定精确 scope 的 Worker Bearer。旧 `/api` 与稳定 `/api/v1` 路径暂时并存，新调用应使用 `/api/v1`。

Cookie 会话的 POST/PUT/PATCH/DELETE 等写操作必须携带精确命中 `CORS_ORIGINS` 的 `Origin`；缺失、重复、空值或未授权来源都会 fail-closed 为 403。生产 `CORS_ORIGINS` 至少包含一个规范化 HTTPS origin，且禁止通配符、路径、凭据、查询和片段；开发 HTTP 仅允许 localhost/127.0.0.1。无 Cookie 的内部 Worker Bearer 与受控 CLI 请求不依赖浏览器 Origin。

`/api/v1/live` 只表示进程存活；`/api/v1/ready` 会检查数据库、身份源、逐资源授权、服务签名/Worker 配置和 Python readiness；兼容路径 `/api/v1/health` 与 readiness 等价。工作台公开状态枚举固定为 `prototype`、`planned`、`security-blocked`，并附带服务端权威的 `executionAllowed`，不再使用笼统的 `available=true`。

## 企业 OIDC / Keycloak 登录

生产登录采用 Go BFF 持有的 Authorization Code + PKCE（S256）流程。浏览器从 `GET /api/v1/auth/oidc/start` 进入身份服务，Keycloak 只能回调 `GET /api/v1/auth/oidc/callback`。回调成功后，Go 签发自己的 HttpOnly 会话，并且只跳转到运维配置的固定 `OIDC_WEB_RETURN_URL`；请求参数不能覆盖该地址。

生产环境变量契约如下：

```text
OIDC_ISSUER_URL=https://identity.example.com/realms/skyviewlab
OIDC_CLIENT_ID=skyviewlab-control-plane
OIDC_CLIENT_SECRET=<由密钥管理系统注入的 confidential client 密钥>
OIDC_REDIRECT_URL=https://api.example.com/api/v1/auth/oidc/callback
OIDC_WEB_RETURN_URL=https://web.example.com/auth/complete
OIDC_TENANT_CLAIM=tenant_id
OIDC_WORKSPACE_CLAIM=workspace_id
OIDC_MAX_TOKEN_LIFETIME=1h
OIDC_ALLOW_INSECURE_HTTP=false
OIDC_TRANSACTION_KEY=<由密钥管理系统注入、32 个随机字节的标准 padded base64>
```

`OIDC_REDIRECT_URL` 必须与 Keycloak confidential client 中登记的精确 redirect URI 完全一致。客户端应启用 Standard Flow 和 PKCE S256，关闭 implicit flow 与 direct access grants，ID token 使用 RS256，并映射 `email`、`email_verified`、`name`、`tenant_id`、`workspace_id`。Go 会校验签名、issuer、audience/azp、nonce、签发/过期时间、最长令牌寿命和已验证邮箱；缺少或不匹配均 fail-closed。`OIDC_MAX_TOKEN_LIFETIME` 默认 1 小时，服务端硬上限为 24 小时。

OIDC 只负责证明外部身份，不决定业务权限。用户、租户、工作区和 active membership 必须预先存在于本地数据库；邮箱会去除首尾空白并统一为小写，租户内由大小写不敏感唯一索引消除歧义。首次登录仅把“已验证邮箱”绑定到该本地用户，以后按 issuer + subject 稳定识别。最终角色始终来自本地 active membership，Keycloak realm/client role 不会写入会话权限。`POST /api/v1/auth/login` 仍只在显式 `DEV_MODE=true` 时可用。

生产登录事务默认复用 PostgreSQL，不再保存在单个 Go 进程中。随机 state 只以 SHA-256 摘要作为主键落库；nonce 与 PKCE verifier 合并后由 AES-256-GCM 加密，AAD 同时绑定 issuer、client ID、state 和过期时间。回调通过数据库 `DELETE ... RETURNING` 原子取走记录，因此同一 state 在并发副本间也最多只有一个消费者。创建事务会在同一数据库事务中清除过期项并执行全局容量门禁；PostgreSQL 使用 advisory transaction lock 协调并发创建。每个成功入口还会保留随机且不返回浏览器的短时 admission 标记，callback/abort 只能消费 state，不能回收跨副本窗口额度。

`OIDC_TRANSACTION_KEY` 必须是标准 padded base64，解码后恰好 32 字节，并由密码学安全随机源生成；所有 API 副本必须读取同一个密钥版本。开发环境未提供该变量时会显式使用仅进程内的有界内存实现；生产环境缺少密钥、密钥长度错误、未使用 PostgreSQL 或 schema 未达到 PG005 都会拒绝启动。当前采用单活动密钥：轮换时应先停止创建新登录流程，等待至少一个登录事务 TTL（当前默认 5 分钟）或清空 `oidc_login_transactions`，再统一切换所有副本，避免旧密文在滚动期间无法解密。

## OpenFGA 逐资源授权

项目、作业和提交记录的关键读写路由会在读取服务器端资源归属后调用 OpenFGA `POST /stores/{store_id}/check`。用户、tenant、workspace、owner、project/assignment 父子关系全部来自服务端会话和数据库，客户端不能提供或覆盖。关系名称与 `../infra/openfga/authorization-model.fga` 固定一致：workspace/project 使用 `can_view`、`can_edit`，job 使用 `can_view`、`can_cancel`，submission 使用 `can_view`、`can_edit`、`can_grade`。

生产配置必须同时提供：

```text
OPENFGA_API_URL=https://openfga.example.internal
OPENFGA_STORE_ID=<26 字符 store ULID>
OPENFGA_AUTHORIZATION_MODEL_ID=<26 字符 model ULID>
OPENFGA_API_TOKEN=<由密钥管理系统注入的随机预共享密钥>
OPENFGA_MODEL_SHA256=<OpenFGA ReadAuthorizationModel 返回的 authorization_model 规范化 JSON SHA-256>
OPENFGA_TIMEOUT=2s
OPENFGA_ALLOW_INSECURE_HTTP=false
DEV_AUTHORIZATION_FALLBACK=false
```

启动时会校验配置完整性；生产环境禁止匿名 OpenFGA、HTTP 明文、本地 fallback 和未固定模型哈希。Readiness 会读取指定 model ID，核对项目实际使用的 type/relation 契约，并校验配置的模型哈希。OpenFGA 拒绝时返回 403；超时、非 2xx、畸形响应、缺少 `allowed` 或模型不匹配时一律 fail-closed 为 503。

`DEV_AUTHORIZATION_FALLBACK=true` 只允许在显式 `DEV_MODE=true` 下使用，用于没有 OpenFGA 服务的本地开发与单元测试；readiness 会将其标记为 `local-development` 且 `productionReady=false`。当前纵切通过 contextual tuples 映射服务器端已知关系，但尚未把 tenant/workspace/project/course/assignment 的关系变化可靠写入 OpenFGA。正式提交不会获得 `draft_editor`，不能用原记录覆盖；版本化重交尚未落地。持久 tuple 同步、撤权时效、版本化重交、写入幂等、对账修复和真实 OpenFGA 端到端测试完成前，授权仍是明确的生产 NO-GO。

## 作业与运行契约

- `POST /api/v1/projects/{id}/jobs`：创建服务端作业；支持 `Idempotency-Key`，请求体为 `slug/action/input/idempotencyKey`。
- `GET /api/v1/projects/{id}/jobs`、`GET /api/v1/jobs/{id}`：读取作用域内作业。
- `POST /api/v1/jobs/{id}/cancel`：创建者或管理员只能取消 queued 或尚未消费 execution fence 的 claimed 作业；计算已开始后返回 409，避免数据库显示 canceled 而外部副作用仍成功。
- `GET /api/v1/projects/{id}/runs`：读取服务端拥有的运行证据。
- `POST /api/v1/projects/{id}/runs`：固定拒绝，错误码 `RUN_FINALIZATION_FORBIDDEN`。
- `POST /api/v1/tools/{slug}/run`：固定拒绝，错误码 `JOB_API_REQUIRED`。

独立 Worker 使用 `Authorization: Bearer $WORKER_TOKEN` 调用。Bearer 凭据在 Go API 服务端固定绑定到一个 `workerId` 及一组精确的 `tenantId/workspaceId/slug/actions` 领取范围，请求体不能选择或覆盖身份：

- `POST /api/v1/internal/jobs/claim`，请求 `{}`。
- `POST /api/v1/internal/jobs/{id}/execute`，请求 `{}`。Go 会从服务端作业读取 tenant/actor/job 并签名调用 Python。
- `POST /api/v1/internal/jobs/{id}/heartbeat`，请求 `{}`，并携带同一 Bearer 与一次性 `X-Skyview-Job-Claim`；过期、失效或被替换的租约返回 409。内置 `execute` 在 Python 调用期间会自行续租，外部 Worker 不需要并发调用 heartbeat。

不存在可由 Worker 直接提交 `status/result` 的 completion 路由。任务终态只能由上述 `execute` 端点在写入 execution fence、续租并完成受签名的 Python 调用后由服务端内部提交；这防止持有调度凭据的进程伪造计算结果。`execute` 的响应也只返回任务 ID 和终态，结果正文、输入、租户、创建者、项目、幂等键及租约字段均不披露给 Worker。

旧客户端仍可带 `workerId`，但它只是 deprecated 的一致性断言；该字段可以省略，一旦出现就必须是符合格式的非空值并与 Bearer 绑定身份完全一致，否则返回 400/403，且不会更改 job、run、outbox 或审计链。另一个合法 Worker 的令牌也不能执行当前 Worker 已领取的作业。

领取候选的数据库 `SELECT` 与随后的 `UPDATE` 在同一事务中使用完全相同的租户、工作区、slug 和 action 条件；无权作业保持 queued，不能“先领取再拒绝”。领取响应只包含 `job.id`、服务端绑定的 `job.workerId`、一次性 claim token、epoch 和租约时间，响应带 `Cache-Control: no-store`；输入、租户、创建者、项目和幂等键不会随领取响应外泄。

开发环境允许 API 使用成对的 `WORKER_ID` + `WORKER_TOKEN`，但还必须显式提供非空的 `WORKER_CAPABILITIES_JSON`，例如上方只授权 `paper-writing` 的两个动作。每项只允许服务端目录中 `executionAllowed=true` 的一个精确 slug 及其独立 action 白名单；服务端再由 `Config` 绑定 `DEV_TENANT_ID`/`DEV_WORKSPACE_ID`，不能生成全局 Worker，也不会在多个 slug 间交叉授予动作。生产环境禁止 inline 共享令牌，必须设置 `WORKER_CREDENTIALS_FILE`，并清空 `WORKER_ID`/`WORKER_TOKEN`/`WORKER_CAPABILITIES_JSON`。密钥文件是严格 JSON；一个 scope 只绑定一个 slug 及其 action 白名单，同一租户/工作区可列多个 slug scope：

```json
{
  "version": 1,
  "workers": [{
    "id": "worker-production-1",
    "token": "<至少 32 字节的随机独立令牌>",
    "scopes": [
      {"tenantId":"tenant-a","workspaceId":"workspace-a","slug":"paper-writing","actions":["outline","audit"]},
      {"tenantId":"tenant-a","workspaceId":"workspace-a","slug":"research-radar","actions":["search","search-openalex"]}
    ]
  }]
}
```

文件上限 64 KiB、最多 256 个 Worker、每个 Worker 最多 64 个 scope、每个 scope 最多 256 个 action。未知字段、尾随 JSON、重复 ID/令牌/scope/action、空 scope、空白包裹值、非法字符、任何 `*` 通配符和弱令牌都会拒绝启动；Unix 系统还要求文件不能向 group/others 开放权限。服务初始化后只保留令牌的 SHA-256 摘要及不可变身份/scope，不保留明文令牌。

API 的 `WORKER_CREDENTIALS_FILE` 是服务端验证清单，不是 Worker 进程的运行环境。每个生产 Worker 只应获得自己的 `WORKER_ID` 与对应 `WORKER_TOKEN`，并设置 `DEV_MODE=false`、`GO_CONTROL_PLANE_URL=https://<control-plane-authority>`；不要把整份凭据清单挂载给 Worker，也不要在 Worker 上设置开发用 `WORKER_CAPABILITIES_JSON`。独立进程支持系统信号优雅退出及空队列/临时错误指数退避。

## Go 到 Python 的服务身份

每个请求以 `SERVICE_HMAC_SECRET` 计算 HMAC-SHA256，并发送：

`X-Skyview-Service`、`X-Skyview-Timestamp`、`X-Skyview-Nonce`、`X-Skyview-Actor`、`X-Skyview-Tenant`、`X-Skyview-Job`、`X-Skyview-Signature`。

签名原文依次为 `skyview-hmac-v1`、method、path、timestamp、nonce、service、actor、tenant、job、原始 body SHA-256，每项独占一行。

## 数据与审计

旧版 `data/workbench-state.json` 不会在服务启动时自动导入。显式身份映射、默认 dry-run、冲突拒绝、幂等 apply 与原子审计的操作步骤见 [`docs/legacy-workbench-state-import.md`](docs/legacy-workbench-state-import.md)。尤其不能把 `guest` 自动绑定到当前登录用户。

SQLite 迁移只服务于开发/测试。PostgreSQL 使用独立、内嵌且带 SHA-256 checksum 的显式迁移；生产必须设置 `DATABASE_ADAPTER=postgresql`，并让 `DATABASE_URL` 同时包含 `sslmode=verify-full` 与固定搜索路径，例如 `options=-csearch_path%3Dpg_catalog%2Cpublic`。生产 API 必须保持 `DATABASE_MIGRATE=false`：启动时除了核对 schema ledger，还会基于 `current_user` 校验角色属性、对象所有权和逐表最小权限矩阵，任何多余权限、缺失权限或未知新表都会拒绝创建 HTTP handler。

`DATABASE_MIGRATE=true` 在 `DEV_MODE=false` 时不是 API 的“自动迁移开关”，而是一次性 migration-only 进程：它只读取 PostgreSQL 配置，以受限 migrator owner 执行 checksum 迁移，成功后立即退出，不读取 Worker/OIDC/OpenFGA/Python 服务凭据，也绝不监听 HTTP。该进程必须使用 migrator DSN；只有长期 Go API 收到独立 runtime DSN。独立 `cmd/worker` 从不直连数据库，不得收到任何 `DATABASE_URL` 或数据库 Secret。开发模式仍保留 SQLite 自动迁移兼容性。生产表使用 `TIMESTAMPTZ`/`JSONB`，tenant/workspace/project/owner 关系由复合外键约束；作业领取使用 `FOR UPDATE SKIP LOCKED`，审计链通过每个 tenant/workspace 的 `audit_heads` 行锁串行追加。

PostgreSQL 的运行账号对 `audit_events` 与 `audit_heads` 都只有 `SELECT`，不能直接追加事件或推进链头。新审计写入只可调用迁移 012 维护、由 migrator 持有的 `SECURITY DEFINER public.append_audit_event_v3(...)`；会话认证在尚无 tenant GUC 时只可调用 `resolve_session_identity_v1(text)`。两个函数均固定 `search_path=pg_catalog,public`，ACL 精确限制为 owner/runtime，runtime 没有 grant option，PUBLIC 与第三方角色均不可执行；public 函数采用完整 allowlist，未知函数会 fail-closed。审计函数校验事务 RLS identity，取得 scope head 锁后才用数据库时钟生成序列化时间，以字段名和值的 UTF-8 字节长度帧计算 v3 SHA-256、插入事件并以 CAS 推进链头；Go 与 SQL 由同一黄金向量锁定。历史 v1/v2 事件保持只读验证，不再通过旧 v2 writer 追加。运行权限门禁还拒绝未知表/视图/物化视图/外表、额外表级或列级 ACL、RLS policy 漂移、危险角色属性，以及 5 个非管理员服务角色任一方向的角色继承。

PG006 旧 v1 链预检不会因 pgx 将 `TIMESTAMPTZ` 截断到微秒而跳过哈希验证：它会枚举恰好映射到该微秒的 1,000 个历史 RFC3339Nano 候选，并仍逐事件验证哈希、前驱图、单根、无分叉/环和终点。为避免未知规模进入超长迁移事务，在线恢复上限固定为 10,000 个旧事件；超过即 fail-closed，必须先冻结审计写入，在恢复出的离线快照上运行容量基准和完整预检。本机 worst-case 基准约为 `0.4 ms/event`，仅用于设置保守阈值，不替代目标 PostgreSQL 的演练。

没有可连接的 PostgreSQL 实例时，当前测试只能覆盖方言重绑定、迁移内容/checksum、安全函数静态契约、v1 微秒恢复算法/基准、v3 Go/SQL 黄金向量、配置拒绝规则和 SQLite 事务回滚，不能代替真实 PostgreSQL 函数权限、并发追加、升级/回滚、备份恢复和故障切换演练。迁移 009 的审计 ACL、迁移 011 的 RLS/context 与迁移 012 的 v3 writer 切换都是停机安全转换：必须先停止并排空旧 API，执行全部迁移，再执行权限 lockdown/live verifier，最后只启动同时支持新安全函数与事务 RLS context 的版本；禁止混合滚动旧实例。PG012 会在任何 DDL/重封存前，以 PG011 ledger 双向验真全部 public policy/function/noninternal trigger；真实 PostgreSQL 中 011 后篡改再升级必须失败的负向演练仍是发布门禁。

当前边界仍然包括：PostgreSQL 尚未完成真实环境集成与运维验收；OIDC 适配器、回调端点和负向验证测试已经落地，但尚未完成真实 Keycloak 端到端验收；OpenFGA、Temporal、对象存储和 OpenTelemetry 仍需完成端到端验收。Worker 已改为每个身份独立凭据并由服务端绑定，但当前仍是需要重启轮换的静态 opaque token；短期 workload JWT 或 mTLS、吊销分发和轮换演练完成前仍是生产加固边界。

项目、版本、协作记录/回复、工作台状态、作业、会话和首次 OIDC 绑定的业务变化与对应审计现在都在同一事务提交或回滚。作业生命周期事件也与 job/run 状态同事务进入 transactional outbox；outbox 具备一次性 claim token 摘要、epoch、数据库时钟 lease、heartbeat、宕机重领、最大尝试和 dead-letter。生产领取接口必须携带受限 relay scope，但正式 relay、OpenFGA tuple consumer、sink 幂等、告警/清理和真实 PostgreSQL 故障演练仍未建设；单机 Worker 与同步执行桥不能替代 Temporal。

OIDC 共享事务存储、密文持久化和原子一次性消费代码已经落地；持久 state 和 session 的创建/有效性判断只采用数据库时钟，调用节点的快慢时钟不能延长或提前删除凭据。每次成功 admission 会在同一事务保留一条随机、不可由回调消费的短时数据库标记，因而主动 abort 不能腾空跨副本窗口。开发直连模式使用 RemoteAddr 来源网段与进程全局限流；生产应用只保留进程全局和数据库共享窗口，并忽略不可信代理头，客户端来源限流必须由可信 TLS 网关/WAF 执行。SQLite 内存/文件实现仍只用于开发与测试。真实 PostgreSQL + Keycloak 并发回调、数据库故障切换、密钥轮换、会话撤销、多副本滥用和滚动发布演练完成前，OIDC 仍属于 NO-GO。

已经通过 execution fence 的作业不会因 lease 过期自动重放。下一次同作用域授权 claim 扫描会把这类未确认结果的 job/run 原子标为 failed，同时写入 `job.failed` outbox 与 `job.execution_lease_lost` 审计，要求人工核对外部副作用。它不是独立 reaper；若后续没有同作用域扫描，记录可能继续显示 running，因此正式 Temporal reconciliation 仍是生产硬门禁。
