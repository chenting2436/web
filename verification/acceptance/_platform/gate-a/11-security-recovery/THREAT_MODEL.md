# Gate A 威胁模型

状态：首版 STRIDE 基线。适用范围为浏览器、Go API、PostgreSQL、对象存储、Temporal/Worker、Python 计算面以及 Judge0、AI、Crossref/OpenAlex、NiFi 等外部适配器。

## 信任边界

~~~mermaid
flowchart LR
  U[User browser] -->|HTTPS + session + CSRF/Origin| G[Go API]
  I[OIDC IdP] -->|signed tokens| G
  G -->|transaction + RLS context| P[(PostgreSQL)]
  G -->|short-lived signed operations| O[(Object storage)]
  G -->|outbox/task reference| T[Temporal]
  T -->|workload identity + scoped job| W[Python/isolated workers]
  G -->|server adapters| X[Judge0 / AI / scholarly APIs / NiFi]
  G --> A[Append-only audit + telemetry]
~~~

信任边界 TB1 为公网浏览器到 Go；TB2 为 IdP 到 Go；TB3 为 Go 到数据面；TB4 为控制面到 Worker；TB5 为 Go 到第三方；TB6 为生产到可观测/归档系统。Python 和第三方均不因为位于内网而默认可信。

## 高价值资产

- 身份绑定、会话、MFA 状态、角色、权益与授权 tuple。
- 学生答案、隐藏判题用例、成绩、审核和不可变提交版本。
- 论文、专利、矿山、安全与科研原始数据及导出。
- 用户代码、工作流、secret_ref、供应商凭据和对象存储签名。
- 科学输入、算法/模型版本、随机种子、结果、批准记录和数据血缘。
- 审计链、备份、恢复凭据、构建产物、SBOM 与镜像签名。

## 风险登记

| ID | STRIDE | 场景 | 主要控制 | 必须提供的验收证据 |
|---|---|---|---|---|
| TM-01 | S | 伪造会话或 OIDC 回调 | PKCE、state/nonce 一次性、严格 issuer/audience/JWKS、HttpOnly Cookie | 多副本登录、重放、错误 issuer/key/nonce 负向 E2E |
| TM-02 | T/E | 客户端改角色、成绩、权益或任务终态 | Go 权威模型、OpenFGA、字段规则、RLS、响应投影 | 跨角色/跨资源矩阵和数据库直连负向测试 |
| TM-03 | R | 用户否认发布、评分、导出或审批 | 事务内审计链、requestId、版本引用、签名 checkpoint | 篡改检测、并发链、大链读取与 WORM 归档演练 |
| TM-04 | I | 隐藏用例、密钥、内部地址进入前端或日志 | 服务端保管、secret_ref、日志脱敏、构建扫描 | 前端产物、API、日志和错误响应秘密扫描 |
| TM-05 | D | 大 JSON、慢请求、ZIP bomb、大文件压垮 API | 体积/时间/并发配额、流式上传、解压比限制、异步化 | 413/429、超时、磁盘配额和队列背压压测 |
| TM-06 | E | 跨 tenant/course/project 枚举资源 | 分层 scope、OpenFGA、RLS、404 concealment | 正向/负向对账及撤权时效测试 |
| TM-07 | T/E | worker 伪造成功、重放完成或越权领取 | workload identity、job/action scope、lease epoch、fence、幂等终态 | 过期 fence、双完成、宕机重领与取消竞态 |
| TM-08 | T/I | 恶意 Office/PDF/影像/miniSEED 触发解析器漏洞 | 隔离容器、无网、资源限额、扫描、固定依赖 | EICAR/畸形/超大/解析炸弹样例与逃逸测试 |
| TM-09 | T | ZIP Slip、路径穿越、伪 MIME、CSV 公式注入 | 规范化路径、内容探测、白名单、导出转义 | 恶意 fixtures 必须被稳定错误码拒绝 |
| TM-10 | I/E | URL 导入访问 localhost、内网或云元数据 | DNS/IP 双校验、禁私网、限制重定向/协议/响应大小 | DNS rebinding、redirect、IPv6、169.254.169.254 测试 |
| TM-11 | I | 敏感科研/专利正文发往公有 AI | 项目级外发策略、脱敏、审批、供应商 allowlist | 默认拒绝、审批后最小载荷、审计与取消测试 |
| TM-12 | T/R | 模拟结果被伪装为真实 NiFi/科学/法律结论 | 来源/算法/环境标识、人工审批、不可变产物哈希 | UI/导出显示来源、版本、质量与批准者 |
| TM-13 | D/T | Outbox/Temporal 重复投递造成重复副作用 | 事务 outbox、consumer dedupe、幂等外部键、DLQ | 重复/乱序/网络断开/恢复演练 |
| TM-14 | T/I | 依赖投毒或许可证不兼容 | commit/digest 锁定、SBOM、SCA、签名、NOTICE、法务状态 | 可复现构建、镜像签名和许可证批准 |
| TM-15 | D | 审计全链 O(N) 成为热路径拒绝服务 | 增量签名 checkpoint、有界验证、读取配额 | 百万级链性能与篡改恢复测试 |
| TM-16 | T | 备份损坏、跨环境恢复或恢复覆盖新数据 | 加密、不可变备份、分环境密钥、PITR、恢复审批 | 定期隔离恢复、RPO/RTO 及失败回滚记录 |

## 安全默认值

- 生产缺少 IdP、OpenFGA、数据库 TLS、密钥、镜像 digest 或审计依赖时启动失败。
- 外部 AI、Judge0、NiFi、URL 导入和服务端用户代码执行默认关闭；显式配置和通过验收后逐项开放。
- 上传文件在扫描完成前不可被业务页面下载、解析或分享。
- 科学与法律结果默认为 draft；自动任务不能自行变成 approved/published。
- 不将堆栈、服务器路径、SQL、对象 key、token、prompt 正文或用户原文写入普通日志。

## 复核时点

每个新文件格式、新外部服务、新执行器、新角色、跨租户共享功能和生产拓扑变更都必须更新此模型。Critical/High 未闭环时保持 NO-GO。

