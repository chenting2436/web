# SkyViewLab Gate B 基础设施

本目录实现生产蓝图的第一批可审查基础服务：PostgreSQL、Keycloak、OpenFGA、Temporal、S3 兼容对象存储和 OpenTelemetry Collector。它是 **Gate B 验收骨架**，不是“生产环境已完成”的声明。

## 边界

- React Sites、Go 控制面和 Python 计算面分别构建与发布。
- 浏览器只访问经 TLS 反向代理暴露的 Go API 和 Keycloak OIDC 页面。
- OpenFGA、Temporal、PostgreSQL、对象存储管理口和 Python Worker 都只能位于私网。
- `compose.local.yml` 只为本机验收把依赖绑定到 `127.0.0.1`；禁止用于互联网部署。
- `otel/collector.yaml` 当前只使用 debug exporter，便于验证 trace 契约。生产必须替换为企业观测后端，并完成脱敏、访问控制和保留策略。
- `temporal` 当前仍使用 auto-setup 与 development dynamic config，只是依赖连通性占位；未配置 mTLS、Authorizer 和正式 schema lifecycle，属于生产 P0/NO-GO，不能承载真实作业。
- Go 已具备 PostgreSQL、OIDC 与 OpenFGA 的代码纵切，但本目录只编排依赖服务，不代表应用已完成真实环境端到端验收。

## 启动前门禁

1. 从 `.env.example` 创建不提交版本库的 `.env`，填写所有空值；Compose 对必需变量使用 `:?`，缺失时必须直接失败。
2. 所有镜像必须固定到安全评审通过的不可变 digest；生成 SBOM 并完成漏洞和许可证扫描。
3. 将 `KEYCLOAK_PUBLIC_URL`、`KEYCLOAK_ADMIN_URL`、`SKYVIEWLAB_WEB_ORIGIN` 替换为真实 HTTPS 地址，并把 `KEYCLOAK_PROXY_TRUSTED_ADDRESSES` 限定为反向代理地址。反向代理必须覆盖而不是追加 `X-Forwarded-*`，管理端和 9000 管理口不得公网暴露。
4. Keycloak 中的 Go 客户端必须保持 confidential、Authorization Code + PKCE S256，并关闭 implicit flow 和 direct access grants。`OIDC_REDIRECT_URL` 必须与 Go 的公开回调 `https://<api-host>/api/v1/auth/oidc/callback` 逐字符一致，禁止通配符。realm 模板把用户属性 `skyviewlab_tenant_id`、`skyviewlab_workspace_id` 分别映射到 `tenant_id`、`workspace_id`；每个用户必须填写这两个属性，并在首次登录前在业务库预配对应用户和 active membership。Keycloak role 不作为业务授权来源。
5. 首次导入 realm 后立即移除/轮换 bootstrap admin 密码，使用受控管理员账号和 MFA。
6. 为 OpenFGA 配置独立 TLS 证书和随机预共享密钥；使用带认证的 FGA CLI 或受控部署任务发布 `openfga/authorization-model.fga`，记录 store id 和不可变 model id；应用不能自动覆盖已发布模型。
   Go 必须同时配置 `OPENFGA_API_URL`、`OPENFGA_STORE_ID`、`OPENFGA_AUTHORIZATION_MODEL_ID`、`OPENFGA_API_TOKEN` 和 `OPENFGA_MODEL_SHA256`。`OPENFGA_API_TOKEN` 必须与服务端 `OPENFGA_PRESHARED_KEYS` 中的一个密钥一致；SHA-256 是 `ReadAuthorizationModel` 响应中 `authorization_model` 的规范化 JSON 哈希，readiness 会校验 model id、关系契约和哈希；生产禁止 `DEV_AUTHORIZATION_FALLBACK=true`。
   工作区成员必须显式写入 workspace tuple，租户普通成员不会自动读取全部工作区；提交进入锁定状态时必须在同一业务事务/outbox 流程中撤销 `draft_editor` tuple。
7. 为 MinIO/S3 创建独立应用账号、bucket policy、对象锁/版本、生命周期和审计；应用不得使用 root 凭据。
8. 配置 PostgreSQL TLS、备份、PITR、连接池、监控和每个服务的最小权限。Go 生产配置必须使用 `DATABASE_ADAPTER=postgresql`，让 `DATABASE_URL` 同时包含 `sslmode=verify-full` 和 `options=-csearch_path%3Dpg_catalog%2Cpublic`，并清空 `DATABASE_FILE`。长期 API 以 runtime DSN、`DATABASE_MIGRATE=false` 启动，并在监听前执行应用侧最小权限门禁；受控发布任务才可使用 migrator DSN、`DATABASE_MIGRATE=true`，该模式迁移后立即退出且不会启动 HTTP。两个 DSN 必须来自相互隔离的 Secret，不能复用。初始化脚本仅用于全新验收环境，不是升级工具。

## 当前生产 NO-GO

- PostgreSQL adapter 与迁移代码已存在，但没有真实 PostgreSQL 的集成、升级/回滚、备份恢复、故障切换和容量 E2E。
- OIDC discovery/JWKS、Authorization Code + PKCE、回调和本地 membership 绑定代码已存在。PG005 共享登录事务表仅保存 state SHA-256 与 AES-256-GCM 密文，并通过原子消费支持多副本；生产 Go 实例必须共享由 KMS/Secret Manager 注入的 32 字节 `OIDC_TRANSACTION_KEY`。当前仍没有真实 Keycloak + PostgreSQL 并发回调、滚动重启与故障切换 E2E。
- OpenFGA Check client 已存在并固定 model ID、模型 SHA 和 API token，但当前关系主要由请求时 contextual tuples 提供；业务关系变化尚未通过持久 tuple 同步可靠写入 OpenFGA，也没有撤权时效、对账和修复闭环。
- Transactional outbox 已具备幂等入队、受限 relay scope、claim capability、epoch、数据库时钟 lease/heartbeat、领取超时恢复、重试、最大尝试、dead-letter 与确认；作业创建和终态事件已与 job/run/审计在同一事务提交或回滚。其他领域尚未全部接线，也没有正式 relay/消费者、幂等 sink、告警、清理和对账闭环。
- 上述任一项未完成真实环境正向、负向与故障演练前，均不得宣称生产可用。

## 本机验收

安装 Docker Compose 后，先使用配置检查，再启动两份合并配置：

```powershell
docker compose --env-file .env -f compose.foundation.yml -f compose.local.yml config
docker compose --env-file .env -f compose.foundation.yml -f compose.local.yml up -d
```

当前工作站未安装 Docker，因此本轮只能完成静态审查；在有 Docker 的验收机上必须补做镜像拉取、健康检查、重启恢复和备份恢复演练。

## 生产仍待完成

- Go 的 PostgreSQL/OIDC/OpenFGA 真实环境验收、OIDC 共享密钥轮换/多副本故障演练、持久 OpenFGA tuple 同步与 outbox relay，以及 Temporal client 和对象元数据仓库。
- Python Worker 的 Temporal Worker 化、容器/microVM 沙箱、领域 Worker pool 和对象产物接口。
- TLS 反向代理、企业 Secret Manager/KMS、AV 扫描、观测后端和告警。
- Kubernetes manifests/Helm、NetworkPolicy、Pod Security、资源配额、PDB/HPA、灾备和容量验证。

只有上述项目和 `PRODUCTION_GAP_AUDIT.md` 中的 Gate B 验收全部通过，才可进入首批工作台生产实现。
