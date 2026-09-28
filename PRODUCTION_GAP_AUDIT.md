# SkyViewLab 生产差距审计

审计日期：2026-09-07  
审计对象：`web_react`、`backend_go`、`backend_python`  
旧版能力基线：`SkyViewLab-Internal-push-worktree`，提交 `8a754dcdb8ab97c7a90ca588693a17b21ee1f41b`  
目标能力与开源参考：见 `PRODUCTION_REBUILD_BLUEPRINT.md`

## 1. 发布结论

当前版本判定为 **NO-GO**，只允许作为本地原型评审，不允许接入真实企业、科研、教学成绩或安全生产数据。

- 24/24 个工作台 slug 有路由，不等于 24 个工作台已经迁移。
- 旧仓库中约 20 个工作台有本地浏览器实现，但旧仓库本身仍是 review build，不是生产系统。
- `warning-platform`、`uav-inspection`、`fusion-console`、`emergency-console` 在旧仓库中只有外链卡片，必须作为四个绿地产品建设，不能计入“旧版迁移完成率”。
- 当前 Go 后端的领域迁移完整度保守评估低于 20%；多租户为 0%；审计与可观测性约 5%。
- 当前 Python 工具多数是单次 JSON 表单、模板、关键词或简化公式；不能作为正式科研、法律、安全或教学判定。

已有的正向原型基础包括：React 前后端目录分离、Go/Python 服务边界、随机会话 token、HttpOnly/SameSite Cookie、CORS 白名单、请求体上限、HTTP timeout、SQLite WAL/外键、共享记录 revision 和非 root Go 容器。这些基础可以保留或迁移，但不足以改变 NO-GO 结论。

## 2. 用户指定的六项验收基线

| 基线 | 当前事实 | 生产阻断 | 放行证据 |
| --- | --- | --- | --- |
| 真实能力 | 多数动作是规则、模板、字符串或短数组计算；浏览器还能自行写入“运行成功” | 无真实领域输入、真实算法/服务、质量基准和人工审批 | 每项旧功能映射到 API、UI、数据、运行时和测试；黄金数据集或契约测试通过 |
| 数据模型 | 项目与工作台状态主要保存为 `state_json/input_json/result_json/data_json` | 无字段化领域实体、租户约束、状态机、正式迁移和大数据存储 | PostgreSQL 版本化 migration、约束/索引/事务、对象元数据、恢复演练 |
| 权限 | 两个演示账号、内存会话；项目/运行/计算可匿名；协作记录缺租户字段 | 匿名调用、跨用户读取、学生可修改评分字段 | OIDC/MFA、tenant/workspace、服务端 RBAC/ReBAC、字段级命令和越权测试 |
| 审计 | `workbench_runs` 由浏览器自报，协作 JSON 可覆盖/删除 | 运行、评分、审批、导出均不可证明，无法用于科研或企业追责 | append-only 审计事件，关联 actor/tenant/trace/input/algorithm/artifact hash |
| 导入导出 | 主要通过 JSON、data URL 和 Base64；真实文件格式与大文件不成立 | 无对象存储、流式上传、扫描、格式保真、checksum 与保留策略 | S3 兼容对象存储、分片上传、扫描、派生链、格式 golden 与往返测试 |
| 外部运行时 | Python 同机 subprocess；Crossref/OpenAlex 少量同步请求；其他多为未接入 | 无安全沙箱、队列、NiFi/Judge0/GDAL/ObsPy/OCR/模型网关等真实适配 | 私网 Worker、服务身份、耐久任务、配额/取消/恢复、provider 契约与故障演练 |

生产验收还必须补充 API 契约、可观测性、可靠性、安全工程、灾备和许可证/SBOM；这几项不能作为“后续优化”跳过。

## 3. P0 证据审计

### P0-1：路由覆盖被误当成完整迁移

- Python 目录无条件把 24 个工具标成 `available: true`：`backend_python/app/tools/dispatcher.py:50-53`。
- Go 只提供通用项目、版本、运行和共享 JSON 记录：`backend_go/internal/api/server.go:82-109`、`backend_go/internal/store/project_store.go:85-126`。
- React 绝大多数工作台复用同一个动态表单组件：`web_react/components/tool-workbench.tsx:108-340`。
- 放行门槛：24 个工作台分别建立“旧功能 → 新领域实体 → API → React 专用界面 → 运行时 → 导入导出 → 测试证据”的可追踪矩阵。

### P0-2：身份、匿名接口和租户隔离不成立

- 仅有两个硬编码身份和默认密码：`backend_go/internal/api/server.go:128-139`、`backend_go/cmd/server/main.go:20-23`、`backend-compose.yml:27-30`。
- 会话保存在单进程内存：`backend_go/internal/api/server.go:41-55,140-154,688-704`。
- 未登录请求落入全局共享 `guest` scope；项目、运行、协作和 Python 计算缺统一认证：`server.go:209-233,236-413,631-685`。
- 协作记录没有 `tenant_id/scope`：`backend_go/internal/store/project_store.go:118-126,287-305`。
- 放行门槛：企业 OIDC/SAML、MFA、组织/空间/成员模型；所有非公开接口强制认证；所有查询强制可信租户条件；跨组织/课程/用户 IDOR 测试为零泄漏。

### P0-3：学生可修改自己的评分，字段级授权可绕过

- 提交更新只恢复作者/学生身份，`score`、`feedback`、`gradedBy`、状态、量规和版本等字段仍信任客户端：`backend_go/internal/api/server.go:516-546`。
- 没有校验作业发布、截止、迟交、量规总分，也没有 `(tenant_id, assignment_id, student_id)` 唯一约束。
- 放行门槛：学生提交/修订、教师评分/退回、作业发布使用不同命令 DTO 和服务端状态机；字段级越权请求返回 403/422；业务约束在事务和数据库中双重保证。

### P0-4：运行证据可以由浏览器伪造

- `POST /api/projects/{id}/runs` 接收客户端自报的状态、结果、错误和耗时：`backend_go/internal/api/server.go:376-412`。
- React 先调用 Python，再单独写入一条“完成/失败”记录：`web_react/components/tool-workbench.tsx:197-223`。
- 放行门槛：仅服务端创建 job/run；Worker 回写状态和结果；记录输入、代码/算法/环境、产物 hash 和 trace；最终记录不可由外部客户端直接创建。

### P0-5：Python 代码执行可绕过，且能绕开 Go 网关

- Python 工具入口无身份校验：`backend_python/app/main.py:83-92`。
- Compose 把 Python `8000` 直接映射到宿主机：`backend-compose.yml:2-10`。
- “沙箱”只是 AST 黑名单并在同机同用户 subprocess 中运行：`backend_python/app/tools/teaching.py:21-79`；可通过动态导入等方式绕过，且没有 CPU、内存、PID、磁盘、网络和系统调用隔离。
- 放行门槛：Python 仅在私网；Go→Worker 使用服务身份/mTLS；用户代码运行在一次性容器、gVisor 或 microVM 中，默认无网络、只读根文件系统并强制全部资源和输出配额。

### P0-6：长任务同步阻塞，没有耐久任务系统

- FastAPI 的 `async` 入口直接同步调用 `run_tool()`：`backend_python/app/main.py:88-92`。
- AI 评测可顺序执行最多 30 次、每次 4 秒；背景噪声互相关存在高复杂度循环；外部文献请求同步等待。
- 放行门槛：超过 500 ms 的工作全部进入持久化任务，支持幂等、取消、重试、优先级、租约、死信、进度、宕机恢复和每租户配额；不同领域使用隔离 Worker pool。

### P0-7：领域数据与文件存储不成立

- 核心业务普遍进入任意 JSON；迁移只有启动时 `CREATE TABLE IF NOT EXISTS`：`backend_go/internal/store/project_store.go:81-128`。
- Python payload 是无总体约束的 `dict[str, Any]`：`backend_python/app/schemas.py:25-27`。
- ZIP 在内存生成后整体 Base64 放入 JSON：`backend_python/app/tools/professional.py:550-562`。
- 放行门槛：PostgreSQL 版本化 migration；关键状态、唯一性和租户约束入库；文件进入对象存储并做大小/MIME/hash/恶意内容/解压扫描；大结果分页或形成可下载产物，不得静默截断。

### P0-8：安全、法律和科研输出容易被误认为正式结论

- 初始差距审计时，自动化“执行”只检查字符串是否含 `fail`，矿山分类使用关键词，预警为单值阈值，无人机只做异常排序，应急只规范化任务，TRL 按证据数量计数，“同行评审”为关键词缺失统计。此处保留原始审计事实；预警、无人机、融合和应急后续已完成绿地纵切，当前边界以 `PRODUCTION_REBUILD_PROGRESS.md` 为准。
- 证据位置：`backend_python/app/tools/research.py:142-296,355-374`、`engineering.py:132-239`、`professional.py:142-161,225-230`。
- 放行门槛：未完成校准数据、模型/规则版本、适用边界、人工审批和回放证据前，接口与 UI 必须显示“原型/模拟/规则结果”，不得显示可被误解的正式安全、法律或科研结论。

### P0-9：没有不可变审计和端到端可观测性

- Go 基本只有启动/失败/关机日志；Python 只有 request ID 响应头；health 固定返回 ok。
- `workbench_runs` 不是审计，因为内容可由客户端伪造。
- 放行门槛：OpenTelemetry 串联浏览器请求、Go、队列、Python/外部服务、数据库和对象；结构化日志脱敏；审计事件 append-only；有 SLO、告警、运行手册和故障演练。

### P0-10：React 只是通用表单壳，不是领域工作台

- 24 个工具路由全部进入同一个 `ToolWorkbench`：`web_react/app/tools/[slug]/page.tsx:41`。
- 字段定义只支持 `text/textarea/number/select`，全部工具合计仅约 61 个 action：`web_react/lib/tool-definitions.ts:1-7`。
- 虽然依赖中列有 Recharts，但应用代码没有真实图表调用；也未形成地图/栅格、波形/频谱、DAG、图谱、虚拟表格、专业编辑器或文件预览。
- 排除依赖和构建产物后，React 项目当前没有自动化测试；旧仓库有 27 个测试文件，实跑为 109 pass / 0 fail，但旧测试本身也只证明 review build。
- 放行门槛：每个工作台必须按蓝图实现专用信息架构和真实图表；图表只能消费可追溯真实数据；关键任务有组件、无障碍、端到端、失败恢复和大数据性能测试。

### P0-11：容器和交付链尚未达到生产要求

- Go 非 root 镜像没有为 `/app/data` 建立明确权限，named volume 可能无法初始化 SQLite：`backend_go/Dockerfile:8-13`、`backend-compose.yml:32-37`。
- `COOKIE_SECURE=false`，服务明文暴露；镜像 tag 可变，缺 SBOM、签名和完整安全扫描。
- 放行门槛：生产 profile 无默认密码、强制 TLS/Secure Cookie；Python 不发布主机端口；固定镜像 digest；非 root 新 volume 冒烟通过；制品具备 SBOM、签名、漏洞/secret/许可证报告和回滚说明。

## 4. 逐工作台差距登记

下表是发布判定摘要；完整功能、图表、数据模型、权限、导入导出和参考仓库在 `PRODUCTION_REBUILD_BLUEPRINT.md` 中逐项列明。

| # | slug | 基线来源 | 当前真实能力 | 当前判定 |
| ---: | --- | --- | --- | --- |
| 1 | `paper-writing` | 旧版十阶段 ARS 流程 | 固定结构稿、正则/BibTeX 简析、关键词审稿 | P0：不得作为学术质量结论；功能重建 P1 |
| 2 | `disaster-remote-sensing` | 旧版浏览器遥感引擎 | 等长数字数组差值和固定 4×4 分区 | P0：无真实栅格、CRS、地图和验证 |
| 3 | `seismic-physics` | 旧版波形/miniSEED 引擎 | 短数组 DFT、平滑、简化 STA/LTA | P0：无时标、台站、响应和事件流程 |
| 4 | `patent-transfer` | 旧版专利分析引擎 | 简化 NPV、关键词 claim/TRL/风险 | P0：不得称 FTO/法律意见；功能重建 P1 |
| 5 | `skill-evolution` | 旧版规范/评测/发布 | 正则扫描和客户端上报门禁 | P0：第三方发布不安全；功能重建 P1 |
| 6 | `research-automation` | 旧版本地模拟 | 拓扑校验和包含 `fail` 的模拟结果 | P0：不得显示真实运行成功 |
| 7 | `knowledge-system` | 旧版多格式/索引/备份 | 单段文本切块与词频共现 | P0：无文件、ACL 下推、索引和恢复 |
| 8 | `research-radar` | 旧版检索/集合/监测 | Crossref/OpenAlex 单次同步查询 | P1：无分页、集合、监测和证据矩阵 |
| 9 | `mine-safety-radar` | 旧版领域筛选基础 | 六类关键词 substring | P0：不得用于安全研判 |
| 10 | `data-gateway` | 旧版 NiFi 风格模拟 | 小段 CSV 映射与 flow JSON 校验 | P0：无真实连接、队列、溯源和重放 |
| 11 | `ambient-noise-imaging` | 旧版预处理/互相关/层析 | 短数组朴素互相关和 DFT | P0：不得做正式地球物理解释 |
| 12 | `patent-disclosure` | 旧版十章专利助手 | 固定十章模板和标题检查 | P0：不得称可直接提交；功能重建 P1 |
| 13 | `warning-platform` | 旧版仅外链，绿地 | 单序列双阈值 | P0：完整安全系统从零建设 |
| 14 | `uav-inspection` | 旧版仅外链，绿地 | 对已输入异常加权排序 | P0：无影像、航线、地图和模型 |
| 15 | `fusion-console` | 旧版仅外链，绿地 | 按时间桶平均 | P0：无流处理、单位、校准和解释 |
| 16 | `emergency-console` | 旧版仅外链，绿地 | 已完成事件、地图、核验、任务、资源、通信、决策、交接和交付纵切 | 仍缺独立领域表、数据库 ACL、真实 GIS/气象/消息网关及跨组织演练；不计入旧版迁移完成率 |
| 17 | `python-lab` | 旧版 Pyodide 多文件实验室 | 单文件同机 subprocess | P0：远程代码执行与资源隔离风险 |
| 18 | `daily-practice` | 旧版 120 题/四题型 | 客户端同时提交答案和标准答案 | P0：考试答案与计分可信性不成立 |
| 19 | `project-workspace` | 旧版 board/list/timeline | 已完成多项目、六状态看板、密集列表/时间线、成员/角色、周期、里程碑、依赖、评论、附件元数据、版本化笔记、活动审计、软归档、快照、燃尽/负载/门禁和多格式交付纵切 | 仍缺独立领域表/数据库 ACL、真实附件与扫描、Webhook/日历双向同步、Plane/Temporal/Dagster 适配、并发冲突合并和真实基础设施协作演练 |
| 20 | `data-lab` | 旧版 OpenRefine 风格工作台 | CSV/TSV 文本和四种简单清洗 | P0：数据丢失/公式注入风险；功能重建 P1 |
| 21 | `ai-report` | 旧版 WebLLM/材料证据 | 关键词排序的摘录模板 | P0：若称 AI/正式报告会误导；功能重建 P1 |
| 22 | `python-english` | 旧版 64 词/五模式/32 题 | 客户端题目和答案的字符串比较 | P1：内容、学习状态和服务端计分均未迁移 |
| 23 | `ai-assessment` | 旧版 Judge0 协议 | 同机 Python + 客户端测试；其他语言文本审查 | P0：沙箱、隐藏测试和成绩可信性不成立 |
| 24 | `project-submission` | 旧版清单/ZIP 流程 | JSON 内文件正文、内存 Base64 ZIP | P0：无真实上传、扫描、对象存储和不可变提交 |
| 25 | `discussions` | 旧版讨论区 | 全局共享 JSON 线程/回复 | P0：无租户隔离，管理字段可被 JSON 绕过 |
| 26 | `homework` | 旧版作业/提交/评分 | 全局共享 JSON 作业与提交 | P0：跨用户读取和学生自改评分 |
| 27 | `admin/identity` | 旧版演示账号与付费页 | 两个硬编码账号和内存会话 | P0：必须建立企业身份、租户、权限和权益模型 |

### 4.1 旧页面与绿地范围补充

- 旧 `/students` 和 `/paid-features` 的能力在 React 中没有等价路由，`profile` 仍是泛化占位；这些能力已并入蓝图的“组织、用户和权益管理”，但仍须逐页迁移验收。
- 旧团队页的导师/学生与招募内容在当前 React 中有所缩减。这是内容和隐私审查项，不是核心后端工作台；上线前由产品负责人确认真实成员、公开范围和联系方式。
- 旧工程总览共有 12 张卡，只有数据网关、背景噪声和 AI 专利交底有本地工作台；另外 9 张原本都是百度外链。当前 React 只以简化动作覆盖预警、融合、无人机并新增应急，仍缺决策大屏、稳定性系数、微震裂隙、点云轻量化和位移预测等能力。它们已经在蓝图 4.8 按绿地产品登记，不能当作旧 GitHub 已迁移功能。
- 科研、工程和教学总览必须读取服务端 capability/status/entitlement；卡片可见、slug 存在或按钮能点击都不能作为完成证据。
- 新增“科学动画工作室”是用户确认后的绿地科研功能，不属于旧卡片版迁移完成数；当前只承诺浏览器 SVG/时间轴预览、受控项目作业和可复核工程包。ManimGL、FFmpeg、LaTeX、对象存储及 GPU/OpenGL 渲染农场在真实接入和验收前必须保持未配置状态。

## 5. 生产重做的证据门槛

每一个工作台必须形成一份可签字的验收包，至少包含：

1. 旧版功能或绿地需求的编号清单，以及每项对应的新 React 页面、Go API、Python/外部运行时和测试用例。
2. 字段化数据字典、ER 图、状态机、索引、约束、迁移和数据保留规则。
3. 角色—资源—动作—字段—状态的权限矩阵，以及全部拒绝路径的自动化证据。
4. append-only 审计样例，能从一次用户动作追到输入、算法/代码/环境、审批和产物 hash。
5. 所有真实输入/输出格式的 golden fixture、往返测试、错误文件、超限和恶意文件测试。
6. 外部服务的版本、许可证、部署边界、凭据方式、SLO、限流、熔断、故障降级和替换方案。
7. 科学/模型能力的标注数据、参考实现、公差、precision/recall/F1/RMSE 等领域指标与专家签字。
8. 单元、属性、契约、集成、端到端、权限、并发、性能、安全、迁移、备份恢复和混沌测试结果。
9. OpenAPI、运维手册、告警、容量、RPO/RTO、SBOM、许可证 NOTICE、镜像签名和回滚制品。

只有单项验收包完整、P0/P1 为零且真实运行演练通过，该工作台才允许从“原型”改为“生产可用”。

## 6. 实施闸门

1. **Gate A — 基线冻结**：确认 24 个工作台、讨论、作业、管理功能的范围；确认四个绿地模块不按迁移估算。
2. **Gate B — 平台地基**：OIDC/租户/权限/PostgreSQL/对象存储/审计/任务/OpenTelemetry/API 契约全部通过安全测试。
3. **Gate C — 高风险入口**：关闭 Python 直连；替换代码沙箱；重建上传、作业评分和服务端运行记录。
4. **Gate D — 领域批次**：按蓝图的科研、工程、教学顺序逐工作台提交验收包，不能只按页面数量报进度。
5. **Gate E — 企业放行**：全量权限矩阵、负载/耐久、渗透、故障恢复、灾备、许可证和运维评审通过。

在 Gate E 完成前，发布说明不得使用“完整迁移”“企业生产版”或“可用于正式安全决策”等表述。
