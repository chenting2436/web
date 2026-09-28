# SkyViewLab 原卡片版功能等价迁移总清单

> 文档状态：用户已确认（v1.0）  
> 制定日期：2026-09-08  
> 唯一功能基线：`D:\code\web\SkyViewLab-Internal-push-worktree`  
> 基线提交：`8a754dcdb8ab97c7a90ca588693a17b21ee1f41b`  
> 目标项目：React `web_react`、Go `backend_go`、Python `backend_python`，三者保持独立  
> 当前总判定：**NO-GO；以下项目全部通过后，才可称为“完整迁移”或“生产可交付”。**

本清单综合以下资料，冲突时按“用户当前决定 → 原卡片版功能事实 → 后端生产要求 → 开源映射 → 重构蓝图实施顺序”记录并提请审查：

- `D:\code\web\PRODUCTION_REBUILD_BLUEPRINT.md`
- `D:\softwaredata\weixindata\xwechat_files\wxid_u841bd6qj0ou22_4467\msg\file\2026-09\BACKEND-REQUIREMENTS.md`
- `D:\softwaredata\weixindata\xwechat_files\wxid_u841bd6qj0ou22_4467\msg\file\2026-09\GITHUB-OPEN-SOURCE-MAPPING.md`

## 1. 本清单怎样理解“照搬原卡片版”

- [ ] 以原卡片版最新本地提交为唯一功能事实来源；需求文档用于补齐生产后端，不凭空改变原功能。
- [ ] 保留首页、栏目页、卡片顺序、独立工作台入口、工作台主要分区、字段、操作、状态流转和结果语义。
- [ ] 前端用 React 重新实现，不复制原生 JS 的不安全做法；不要求逐像素复刻，但操作位置与使用路径必须可对应。
- [ ] 每个复杂工作台必须有独立 React 页面和组件，不能再用一个通用 `/tools/:slug` 表单冒充迁移完成。
- [ ] 首页保留旋转地球、星空与时钟；页面保持简洁，不恢复填充型统计数字、口号或大段宣传文案。
- [ ] 原版浏览器本地数据要可迁移，但登录、角色、成绩、审核、协作、权益和审计必须改为服务端权威。
- [ ] 原版的演示算法必须标注“本地预览/规则计算”，不能包装成真实模型、真实 NiFi 或真实生产任务。
- [ ] 原版仅跳转百度的工程卡片保留卡片位置，但明确标为“规划中”；它们属于后续绿地产品，不计入本次等价迁移完成数。
- [ ] 直接运行的开源依赖与仅供 UI/工作流参考的 GitHub 仓库必须分开记录，禁止写成虚假的“已集成”。
- [ ] 任何勾选项都要附代码、测试或运行证据；只看见页面、只返回 HTTP 200、只有模拟数据均不算完成。

## 2. 基线证据与冻结项

- [x] 已定位 32 个旧入口：1 个首页、31 个 `pages/*.html` 页面。
- [x] 已确认 20 个真实独立工作台：教学 8、科研 9、工程 3。
- [x] 已确认工程栏目另有 9 张百度占位卡，不属于已有工作台。
- [x] 已运行旧版自动化基线：27 个测试文件，109 项通过、0 项失败。
- [x] 已读取 `BACKEND-REQUIREMENTS.md`，作为生产数据、权限、审计和运行时补齐依据。
- [x] 已读取 `GITHUB-OPEN-SOURCE-MAPPING.md`，作为依赖、借鉴边界和许可证依据。
- [ ] 为 32 个入口生成页面截图、主要交互录像和 DOM/字段清单，形成不可变基线包。
- [ ] 为每个旧版导入/导出格式保存至少一个合法样例、一个边界样例和一个恶意样例。
- [x] 把 109 项旧测试纳入新仓库的兼容回归门禁；verification/verify-gate-a.ps1 会实时重跑并要求 109/109 通过，新增测试不得替代旧基线测试。
- [ ] 冻结首批真实样例数据及期望结果，包括遥感、地震、环境噪声、数据清洗、判题和文档解析。

## 3. 单个模块的“完成定义”

每个模块只有同时满足以下条件，状态才可从 `进行中` 改为 `完成`：

- [ ] **结构等价**：原页面入口、主要区域、标签页/视图、字段、快捷键、响应式行为均有对应关系。
- [ ] **交互等价**：新建、编辑、运行、停止、保存、恢复、筛选、搜索、批量操作和异常路径均可使用。
- [ ] **React 原生实现**：没有 iframe 套旧页，没有把复杂功能缩成通用 JSON/文本表单。
- [ ] **Go 权威模型**：实体、状态机、版本、OpenAPI 3.1 契约、数据库迁移和并发冲突策略齐全。
- [ ] **Python 真实能力**：适用模块使用真实解析/计算任务；算法版本、参数、输入哈希、日志和产物可追溯。
- [ ] **权限与租户隔离**：未登录、无权限、跨账号、跨课程、跨项目、跨租户测试全部通过。
- [ ] **审计与可观测**：关键动作带 `requestId`，审计不可由普通用户修改，日志不泄露密钥或敏感正文。
- [ ] **导入导出完整**：原格式可导入，新格式有 schemaVersion；往返不丢字段，恶意文件被拒绝。
- [ ] **外部运行时真实**：Judge0、AI、Crossref/OpenAlex、NiFi 等显示真实配置与任务状态；不可用时明确降级。
- [ ] **质量门禁**：单元、契约、集成、E2E、视觉、性能、安全和恢复测试均有报告。
- [ ] **运维可交付**：监控、告警、备份恢复、数据保留、许可证、运行手册和回滚方案齐全。
- [ ] **业务验收**：产品方按旧版逐项核对并签字，验收证据链接已填入模块台账。

## 4. 32 个入口与 React 路由清单

旧 `.html` 地址必须保留兼容跳转；表中 React 路由是新的唯一正式入口。

| ID | 原卡片版入口 | React 正式路由 | 性质 | 验收状态 |
|---|---|---|---|---|
| N01 | `index.html` | `/` | 首页：地球与时钟 | [ ] |
| N02 | `pages/research.html` | `/research` | 科研卡片总览 | [ ] |
| N03 | `pages/engineering.html` | `/engineering` | 工程卡片总览 | [ ] |
| N04 | `pages/teaching.html` | `/teaching` | 教学卡片总览 | [ ] |
| N05 | `pages/team.html` | `/team` | 团队主页 | [ ] |
| N06 | `pages/login.html` | `/login` | 登录与注册 | [ ] |
| N07 | `pages/profile.html` | `/profile` | 个人中心 | [ ] |
| N08 | `pages/students.html` | `/students` | 学生管理 | [ ] |
| N09 | `pages/paid-features.html` | `/paid-features` | 功能与权益管理 | [ ] |
| N10 | `pages/comments.html` | `/comments` | 讨论工作台 | [ ] |
| N11 | `pages/homework.html` | `/homework` | 作业与评分工作台 | [ ] |
| T01 | `pages/python-lab.html` | `/python-lab` | 教学工作台 | [ ] |
| T02 | `pages/daily-practice.html` | `/daily-practice` | 教学工作台 | [ ] |
| T03 | `pages/project-workspace.html` | `/project-workspace` | 教学工作台 | [ ] |
| T04 | `pages/data-lab.html` | `/data-lab` | 教学工作台 | [ ] |
| T05 | `pages/ai-report.html` | `/ai-report` | 教学工作台 | [ ] |
| T06 | `pages/python-english.html` | `/python-english` | 教学工作台 | [ ] |
| T07 | `pages/ai-assessment.html` | `/ai-assessment` | 教学工作台 | [ ] |
| T08 | `pages/project-submission.html` | `/project-submission` | 教学工作台 | [ ] |
| R01 | `pages/paper-writing.html` | `/paper-writing` | 科研工作台 | [ ] |
| R02 | `pages/disaster-remote-sensing.html` | `/disaster-remote-sensing` | 科研工作台 | [ ] |
| R03 | `pages/seismic-physics.html` | `/seismic-physics` | 科研工作台 | [ ] |
| R04 | `pages/patent-transfer.html` | `/patent-transfer` | 科研工作台 | [ ] |
| R05 | `pages/skill-evolution.html` | `/skill-evolution` | 科研工作台 | [ ] |
| R06 | `pages/knowledge-system.html` | `/knowledge-system` | 科研工作台 | [ ] |
| R07 | `pages/research-radar.html` | `/research-radar` | 科研工作台 | [ ] |
| R08 | `pages/mine-safety-radar.html` | `/mine-safety-radar` | 科研工作台 | [ ] |
| R09 | `pages/research-automation.html` | `/research-automation` | 科研工作台 | [ ] |
| E01 | `pages/data-gateway.html` | `/data-gateway` | 工程工作台 | [ ] |
| E02 | `pages/ambient-noise-imaging.html` | `/ambient-noise-imaging` | 工程工作台 | [ ] |
| E03 | `pages/ai-patent-disclosure.html` | `/ai-patent-disclosure` | 工程工作台 | [ ] |
| X01 | `pages/course-tools.html` | `/teaching` | 兼容跳转，不另造功能 | [ ] |

路由兼容补充：

- [ ] 上述全部 `/pages/*.html` 旧地址做 301/308 或客户端兼容跳转，并保留查询参数。
- [ ] 当前 `/tools/:slug` 仅作临时兼容跳转，正式导航不得再进入通用工具页。
- [ ] 未登录跳转后可返回原目标页；无权限返回 403 页面，不用“隐藏卡片”代替服务端授权。
- [ ] 每条正式路由具备加载、空数据、无权限、失败、离线/重试和 404 状态。

`course-tools.html?tool=` 的旧书签按原版行为兼容：

| 旧 `tool` 值 | React 正式路由 |
|---|---|
| `daily-practice` | `/daily-practice` |
| `project-workspace` | `/project-workspace` |
| `data-lab` | `/data-lab` |
| `python-english` | `/python-english` |
| `ai-assessment` | `/ai-assessment` |
| `project-submission` | `/project-submission` |
| 空值或未知值 | `/teaching` |

- [ ] 兼容入口支持 GET/HEAD，保留合法 query；`returnTo` 只允许站内地址，阻止开放重定向。
- [ ] React 任意正式路由直接刷新不返回 404；未知旧地址和未知 `/tools/:slug` 返回真正的 404。

## 5. 共用平台能力清单

### 5.1 React 前端（只放在 `web_react`）

- [ ] 面向正式用户的页面不显示“原型”“仅供评审”等研发状态横幅；交付状态只进入内部清单与验收记录，未完成能力则不伪装为已完成。
- [ ] 原卡片版自带确定性样例的工作台首屏直接载入完整样例结果与图表，不再要求用户先点击“加载演示”才能看到功能。
- [ ] 建立共享 App Shell：顶部导航、账号菜单、语言、面包屑、通知和工作区切换。
- [ ] 三个栏目页恢复原卡片分组、名称、顺序和独立入口，同时删除填充型数字与宣传段落。
- [ ] 建立统一但不强制同构的表格、对话框、文件上传、任务进度、版本历史、审计摘要和错误状态组件。
- [ ] 所有业务请求只访问 Go API；React 不连接数据库、对象存储、Judge0、远程 AI、NiFi 或科研 Worker。
- [ ] 权限组件只改善体验，不作为安全边界；服务端 401/403/409/429/5xx 均有明确反馈。
- [ ] 支持中文与英文，稳定错误码由前端翻译；日期按 Asia/Shanghai 显示、传输使用 UTC。
- [ ] 完成键盘导航、焦点管理、对比度、表单标签、图表替代文本和屏幕阅读器测试。
- [ ] Chrome、Edge 当前稳定版及主流桌面/平板尺寸通过视觉回归。
- [ ] 保持 Sites 友好的独立前端项目规范；构建产物只含公开配置，后端地址按环境注入且不携带任何秘密。

### 5.2 Go 主业务与控制面（只放在 `backend_go`）

- [ ] 模块化领域：身份、组织/课程、成员、权益、讨论、作业、项目、文件、工作区、科研项目、任务、审计、通知。
- [ ] 全部接口维护 OpenAPI 3.1；接口以 `/api/v1` 开头，错误返回稳定 `error.code` 与 `requestId`。
- [ ] PostgreSQL 为结构化数据权威；业务数据默认软删除，可编辑资源使用 ETag/version，冲突返回 409。
- [ ] Redis 只用于会话、限流、缓存、锁和短期任务状态，不作为唯一业务存储。
- [ ] 统一幂等键覆盖提交、上传完成、运行任务、导入、导出和外部服务调用。
- [ ] 使用事务 Outbox 发送任务和通知，失败可重试且不会重复产生不可逆业务结果。
- [ ] 所有资源查询自动附加组织、课程、项目、所有者或成员范围。
- [ ] Go 不执行用户 Python/Shell，不在进程内解析不可信 Office 宏，不保存供应商明文密钥。

### 5.3 Python 科研与文档 Worker（只放在 `backend_python`）

- [ ] Worker 只消费 Go 发出的受控任务，不对浏览器暴露第二套业务 API。
- [ ] 覆盖文档抽取/OCR、数据画像与转换、遥感、地震、环境噪声、检索、质量审计和导出生成。
- [ ] 每个任务固定代码/模型/依赖版本，记录参数、随机种子、输入哈希、输出哈希和运行环境。
- [ ] 任务支持 queued/running/succeeded/failed/cancelled、百分比进度、取消、超时和安全重试。
- [ ] CPU、内存、GPU、磁盘、网络和执行时长配额可配置；临时文件有清理与隔离策略。
- [ ] 算法失败返回可读错误与诊断产物，不向前端暴露服务器绝对路径或堆栈秘密。

### 5.4 身份、权限、审计和协作

- [ ] Secure + HttpOnly + SameSite 会话 Cookie、CSRF、防暴力破解、会话设备管理和管理员 MFA。
- [ ] 密码使用 Argon2id 或经评审的强哈希；删除旧版明文密码和固定生产账号。
- [ ] 至少支持 student、teacher、admin、super_admin，并结合资源归属进行细粒度授权。
- [ ] 功能权益与角色权限分开；修改浏览器状态不能获得角色、功能或数据权限。
- [ ] 审计覆盖登录、角色、权益、成员、上传、导出、提交、评分、运行、恢复和系统配置。
- [ ] 审计事件包含操作者、资源、动作、结果、时间、IP/设备摘要、requestId 和前后版本引用。
- [ ] 两个真实账号可完成讨论回复、通知、作业发布/提交/批改和项目协作，不依赖同一浏览器缓存。

### 5.5 文件、任务与外部服务

- [ ] S3 兼容对象存储保存原文件和产物；数据库只保存元数据与对象引用。
- [ ] 上传采用受控分片/预签名流程，校验大小、MIME、扩展名、SHA-256、重复文件和病毒。
- [ ] 防御 ZIP Slip、Zip bomb、CSV 公式注入、路径穿越、恶意正则、伪 MIME 和宏文件。
- [ ] 下载经过权限判断并签发短时链接；敏感导出支持水印、二次确认和审计。
- [ ] Judge0 独立隔离部署；隐藏用例和凭据永不进入浏览器、React 构建包或普通日志。
- [ ] 远程 AI 统一走 Go 网关，密钥托管、模型白名单、用量、脱敏、取消和外发策略齐全。
- [ ] Crossref/OpenAlex 统一走服务端代理，具备缓存、限流、来源标记、失败重试和使用政策记录。
- [ ] NiFi 适配器只有连接真实环境并完成部署回读后，才能标为“已连接”；浏览器模拟必须单独标识。
- [ ] URL 导入在服务端执行，阻止 localhost、内网、云元数据地址、重定向绕过和超大响应。

### 5.6 生产运行与公网隔离

- [ ] dev/test/staging/production 数据、密钥、域名和对象存储完全隔离。
- [ ] 公网展示版使用独立构建，不包含内部 API、真实数据、种子账号、内部项目 ID 或服务商配置。
- [ ] CI 扫描前端产物中的密钥、隐藏用例、内网地址、固定密码和真实用户数据，命中即阻断。
- [ ] 指标覆盖流量、错误率、延迟、队列、任务、数据库、存储、登录失败、Judge0 和 AI 用量。
- [ ] 核心读请求 P95 < 500ms、普通写请求 P95 < 800ms、登录 P95 < 1.5s；超过 5 秒的工作异步化。
- [ ] 完成数据库与对象存储备份、时间点恢复、恢复演练、RPO/RTO 记录和故障运行手册。

## 6. 核心页面与协作功能

### N01 首页：旋转地球与时钟

- [ ] 保留固定导航、Three.js 星空/太阳/轨道/旋转地球/云层/夜景/大气层及 Canvas 降级。
- [ ] 保留模拟时钟、数字时钟、日期与时区正确性，处理后台标签页与系统时间变化。
- [ ] 删除“12+”“8”“9”等填充统计、口号和大段介绍；首屏只留下必要导航、地球与时钟。
- [ ] 若保留公告、新闻、日历，必须来自真实 CMS/日程数据；没有真实数据时显示简洁空状态而非假内容。
- [ ] 测试低性能设备、WebGL 不可用、`prefers-reduced-motion`、窗口缩放和资源加载失败。

### N02–N04 科研、工程、教学卡片总览

- [ ] 保留原版分组、卡片名称、顺序和入口；每张真实功能卡进入对应独立工作台。
- [ ] 卡片的可见性、禁用状态和直接访问权限与服务端权益一致。
- [ ] 不放填充型 KPI；只显示真实任务状态、未读数或明确的“规划中”。
- [ ] 工程 9 张占位卡禁止继续跳转百度，按第 10 节处理。

### N06–N08 登录、注册、个人中心、学生管理

- [ ] 迁移登录/注册字段：学号、姓名、密码、确认密码、邮箱、六位验证码及错误提示。
- [ ] 验证码改为服务端发送与校验，不在页面直接显示；注册、登录、找回密码均限流。
- [ ] 个人中心保留资料、安全、学习/项目概览入口；资料更新、换绑、改密和会话退出有审计。
- [ ] 学生管理支持服务端搜索、筛选、分页、详情、状态、角色、课程、权益和批量受控操作。
- [ ] 任何页面不展示密码；不迁移旧明文密码，用户必须走首次激活/重置流程。
- [ ] 删除生产默认 `admin`、`20260001` 固定账号；测试种子只存在隔离环境。

### N09 功能与权益管理

- [ ] 迁移原 33 项功能目录及卡片映射，保留其中 21 项教学/科研功能被强制免费的原业务含义。
- [ ] 建立 Feature、Plan、FeaturePolicy、Entitlement、Grant 及生效/过期/撤销状态。
- [ ] 管理员修改功能策略需二次确认、版本控制和审计；客户端篡改开关无效。
- [ ] 未建设订单、支付、退款前只显示“免费/未开放”，不得宣称已具备真实收费能力。

### N10 讨论工作台

- [ ] 恢复搜索、筛选、排序、全部已读、新建、主从列表、详情、回复时间线和未读状态。
- [ ] 支持 course/research 上下文，open/answered/resolved 状态和 normal/medium/high 优先级。
- [ ] 管理员/教师具备置顶、优先级、解决、删除/恢复和审核能力，普通用户权限受限。
- [ ] 建立 Thread、Message、Participant、Mention、ReadCursor、Notification、Moderation、Context 模型。
- [ ] 回复并发使用 ETag，通知幂等；删除采用软删除，敏感操作和内容版本可审计。

### N11 作业与评分工作台

- [ ] 恢复教师/学生不同视图、筛选、主从详情、作业编辑、发布、关闭、重开和版本。
- [ ] 恢复任务说明、资源、要求、Rubric、学生草稿、提交/重交、附件、反馈和评分。
- [ ] 状态机：assignment draft/published/closed；submission draft/submitted/late/revision/graded。
- [ ] 建立 Course、Enrollment、Assignment、Requirement、Rubric/Criterion、Submission/Version、Grade、Feedback、Attachment。
- [ ] 截止时间与迟交由服务端判定；成绩、教师反馈和已提交版本不能由学生修改。
- [ ] 兼容旧版最多 4 文件、单文件 1MB/合计 2MB 的导入；新服务限额可配置且经过文件安全流程。

### N05 团队主页

- [ ] 保留导师区、快捷卡片、成员区和招募信息的原结构。
- [ ] 原版静态成员与 11 个百度链接全部替换为真实 CMS/成员数据；未配置时明确显示“待配置”。
- [ ] 公开字段与内部字段分开，成员可控制公开范围；后台更新、发布与撤回有审计。

## 7. 教学工作台逐项清单

### T01 Python 编译器（Python 实验室工作台）

- [x] 恢复深色 IDE 布局：运行状态栏、活动栏、Files/Packages、编辑区、可调整终端和工具栏。
- [x] 恢复虚拟文件/文件夹的新建、嵌套、重命名、删除、文件树展开、多标签、脏状态和查找替换。
- [x] 恢复模板、保存、运行、停止、重置、`Ctrl+S`、`Ctrl+Enter`、stdin、argv、环境变量和 `requirements.txt`。
- [x] 恢复受限终端语义：Python 文件/模块/单元测试/`-c`、pip 及原版受支持的文件命令。
- [x] 浏览器 Pyodide 0.28.3 模式保留为明确的本地运行模式；停止必须真正销毁 Worker。
- [ ] 建立 PythonWorkspace、WorkspaceFile/Revision/Snapshot、LayoutPreference、RunRecord 和配额模型。
- [ ] JSON 工作区兼容导入导出，自动保存、断网草稿、快照恢复和并发 409 均可验证。
- [ ] 服务端代码执行如以后启用，必须进入独立隔离沙箱；普通 Go/Python Web 进程禁止执行不可信代码。

当前兼容进展：T01 已升级为 Jupyter 式专用 React 层叠实验台，直接加载课程任务、三单元 Notebook、Monaco 编辑器、xterm 终端、文件/依赖、脚本、数据表、变量检查、富输出、验收和交付；保留六文件基准、四类模板、运行参数与受限终端语义，并新增逐单元/全部运行、Notebook 状态/证据、IPYNB 和完整备份。浏览器通过 Pyodide 0.28.3 Worker 运行代码，停止和重置会真正销毁 Worker；工作区变更、Notebook 保存、单元证据、快照与版本经过 Go 项目/作业/审计边界，Python 只负责安全模型校验和导出，不在普通服务进程执行工作区代码。生产远程执行已选定 Jupyter Server + JupyterHub + KubeSpawner 独立适配路线，但逐用户 Pod、镜像/依赖供应链、资源网络配额、对象存储、CAS 与跨租户演练仍未完成，因此 T01 尚不计为远程沙箱生产完成。

### T02 日常做题（每日一练）

- [x] 完整迁移原 120 题及 Python/数据/AI 分类、难度 1–3、单选/判断/多选/填空四种题型。
- [x] 恢复搜索、分类、难度、全部/未答/错题/收藏筛选、即时反馈、解析和掌握度统计。
- [x] 恢复 10/20/30/50 题、10/20/30/45/60 分钟模拟考试，计时、跳题、自动交卷和结果页完整。
- [ ] 建立 QuestionBank/Version、Topic、Question/Choice、PracticeSession/Answer、Favorite、ExamAttempt、LearnerStats。
- [x] 练习即时反馈与考试延迟反馈严格分开；答案、可接受填充值和解析在作答前不得下发。
- [x] 考试开始、结束、倒计时和评分使用服务端时间；刷新可恢复，到时自动提交，成绩不可由客户端改写。
- [ ] 教师可编辑、校验、版本化和发布题库；目录升级后旧作答与统计仍可追溯到原题版本。
- [ ] 扫描 React 包、接口和浏览器存储，确认不存在隐藏答案；完成跨账号与跨课程隔离测试。

当前兼容进展：T02 已升级为专用 React 层叠练习台，进入页面自动载入卡片版 120 题；恢复三类题库、三档难度、四种题型、搜索与四类学习筛选、收藏/错题/即时解析、分主题掌握图、考试组卷、答题卡、服务端倒计时、刷新恢复、自动交卷、逐题复盘、考试历史和 CSV/Markdown/JSON 交付。公开题目投影不含答案、可接受填充值或解析；练习只在提交单题后返回该题反馈，考试使用只含题目 ID 和服务端时间的 HMAC 签名凭证，统一交卷后才返回解析。当前 QuestionBank/Attempt 等仍保存在 Go 通用项目 JSON 状态而非独立关系表，教师编辑/发布权限、正式课程/账号绑定、跨租户负向矩阵、独立统计投影和真实 PostgreSQL 演练未完成，因此 T02 尚不计为生产领域模型完成。

### T03 在线项目开发

- [ ] 恢复项目组合、新建/切换、标题、目标、成员、周期、截止时间、阶段笔记和健康概览。
- [ ] 恢复看板/列表/时间线三视图，任务新建编辑删除、优先级、标签、负责人、截止日期和拖拽流转。
- [ ] 恢复里程碑、最近 30 条活动、当前项目 JSON 导入导出和旧单项目结构升级。
- [ ] 原版“归档即删除”改为可恢复软归档；导入项目生成新 ID 并清楚标记为副本。
- [ ] 建立 Project、Member/Role、Iteration、Task、Milestone、NoteRevision、ActivityEvent、Snapshot、ImportJob。
- [ ] 活动由服务端生成，普通客户端不能伪造；成员字符串正规化为 owner/maintainer/member/viewer 关系。
- [ ] 多人并发编辑使用版本控制，冲突不静默覆盖；三视图与逾期计算完成 E2E 验收。

### T04 数据处理（数据实验室）

- [x] 恢复 OpenRefine 风格首页和工作台：项目创建/打开、facet、历史、画像、聚合、数据网格和分页。
- [ ] 支持 CSV/TSV/TXT/JSON/XML/XLS/XLSX，含预览、Sheet、表头行、跳过行、嵌套 JSON 展平和 XML 记录识别。
- [ ] 保留 50,000 行、200 列、2,000,000 单元格的兼容限制与明确截断警告；大规模服务端模式另设配额。
- [x] 恢复类型/缺失/唯一/完整度/重复、高频值、统计量、IQR 离群、12 桶直方图和分组聚合。
- [x] 恢复过滤/facet、单元格编辑、填充、去空行、去重、改名、删除、拆分、新增列、永久排序。
- [x] 操作历史支持重放、撤销、重做、跳转和分叉；表达式严格白名单，禁止任意 JS/eval。
- [ ] 建立 DataProject、SourceFile、DatasetSchema、ColumnProfile、Operation、HistoryCursor、Snapshot、ExportJob、Artifact。
- [ ] Python 与浏览器预览对同一黄金数据的结果一致；所有大文件解析、画像、重放和导出走异步任务。
- [ ] 完整项目 ZIP、操作 JSON、CSV/TSV/XLSX/JSON/HTML/聚合 CSV 均可往返，并通过恶意文件测试。

### T05 AI辅助解释与报告（AI 报告）

- [x] 恢复仪表盘、材料/证据、证据对话、完整报告、审计、版本、导出、设置八个独立视图。
- [ ] 恢复多项目、8 类报告、章节模板、材料选择、证据检索、流式生成、手工编辑、审计、差异和恢复。
- [ ] 支持 PDF/DOCX/XLS/XLSX/PPTX/HTML/XML/JSON/CSV/TSV/MD/TXT/代码、粘贴与安全 URL 导入。
- [ ] 扫描 PDF 进入 OCR 路径；分块、来源定位、SHA-256、选中材料范围和引用 chunk 必须稳定可追溯。
- [ ] 建立 ReportProject/Member、Source、EvidenceChunk、GenerationJob、PromptTemplateVersion、Chat、Document/Version、Audit/Issue、Artifact。
- [x] 本地 WebLLM/WebGPU 模式继续独立可用，显示模型下载/运行/取消/释放状态；不得伪装为服务端模型。
- [ ] 远程模型只经 Go AI 网关；取消浏览器自填 endpoint/key，SSE 支持断线恢复和真实取消。
- [ ] Python 负责抽取/OCR/分块/检索/规则审计/DOCX/ZIP；版本不可变，恢复操作生成新版本。（除正式 OCR 外已完成；扫描 PDF 会进入明确的 `ocr-required` 状态，不伪造提取结果。）
- [x] MD/HTML/TXT/来源索引 JSON/DOCX/完整 ZIP 导出通过引用、覆盖率与往返验收。

### T06 Python 英文授课

- [x] 恢复 Dashboard、Exams、Vocabulary、References、Leaderboard、Manage 六个视图。
- [x] 完整迁移 8 组 64 个词、4 套 32 题考试和 8 个参考指南。
- [x] 恢复 Learn/Cards/Quiz/Speak/Type 五种词汇模式及题目/选项打乱、服务端计时、题图、快捷键、70% 及格和复盘。
- [ ] 恢复 XP、等级、连续学习、奖项、掌握度与活动，但由不可变服务端事件计算并保证幂等。
- [x] SpeechSynthesis/识别不可用时有降级；未接真实发音评分前必须写明“用户自评”，不得宣称 AI 评分。
- [ ] 建立 LearningCatalog/Version、VocabularySet/Term、Exam/Question/Choice、Reference、Progress/Mastery、Attempt/Answer、XPEvent/Award/Streak。
- [x] 支持旧词汇 JSON 与考试 TXT 格式，错误精确定位行/字段；新增完整进度导出与隐私控制。
- [x] 排行榜仅显示明确加入的真实用户，最小披露且绝不填充虚构账号。

当前兼容纵切说明：XP 事件、掌握证据、考试会话和导出已经进入 Go 项目/作业与 Python 计算链路，重复事件键会幂等拒绝；但事件仍随通用工作台项目 JSON 持久化，尚未落独立领域表和数据库 append-only 约束，因此上述两项生产数据模型门禁继续保持未完成。

### T07 AI 测试与提交（Judge0 测评）

- [ ] 恢复 Judge0 IDE 布局：命令栏、语言/参数、运行/提交、题库筛选、题面、Monaco、输入输出和历史。
- [ ] 完整迁移 15 题、60 测试用例及 Python/C++/JavaScript/Java starter；30 个隐藏用例移出前端源码。
- [ ] 建立 LanguageWhitelist、Task/Version、PublicCase、HiddenCase、Submission、CaseRun、Artifact、ExecutionQuota。
- [ ] Go 受控代理 Judge0，完成语言白名单、批量提交/顺序回退、状态 1–14、轮询、超时、评分和配额。
- [ ] 隐藏用例独立受限存储；学生只看到允许的状态，不能看到输入、期望输出或推断型错误细节。
- [ ] 浏览器不可直连 Judge0；Judge0 运行容器限制 CPU、内存、PID、磁盘、网络、进程和时间。
- [ ] 自定义题、目录、历史 JSON 和源文件下载兼容；教师题目发布与隐藏用例管理分权并审计。
- [ ] AI 诊断不接触隐藏用例；扫描构建包、网络和浏览器存储，确认隐藏内容和凭据为零。

### T08 项目提交

- [ ] 恢复 Python/数据/研究三类模板、Manifest 字段、六项检查、文件/文件夹拖放和相对路径。
- [ ] 恢复 readiness、文件清单、预检、生成 ZIP、草稿、清空、打包历史及教师审核。
- [ ] 状态支持 draft/submitted/revision/approved，四个 25 分项、评论、重交和独立成绩发布。
- [ ] 建立 ProjectSubmission/Version、Manifest、Checklist、File、ValidationResult、PackageJob/Artifact、Review、RubricScore、GradePublish。
- [ ] 已提交版本不可变；允许从旧版派生新版本，截止时间、迟交与审核权限由服务端判定。
- [ ] 服务端重算 SHA-256、MIME、路径、大小，执行查毒与危险附件策略；学生不能写教师审核字段。
- [ ] ZIP 保留 `manifest.json` schemaVersion 2、README、`CHECKSUMS.sha256` 和 `attachments/<相对路径>`。
- [ ] 上传可断点/重试且最终提交幂等；ZIP 兼容导入、签名下载、审核导出和中断恢复通过测试。

## 8. 科研工作台逐项清单

### R01 论文写作

- [x] 恢复 dashboard/research/evidence/draft/integrity/review/revision/finalize/process/settings 十个视图。
- [x] 恢复十阶段状态机：research、write、integrity_pre、review、revise、re_review、re_revise、integrity_final、finalize、process。
- [x] 恢复研究问题/框架/方法/提纲/章节、文献、主张—证据、实验、资产、决策、活动与作者确认。
- [x] 恢复双诚信门禁、五角色审稿、修订回复、再审、版本快照、披露与最终定稿，不允许跳过必需门禁。
- [ ] 建立 PaperProject、ResearchQuestion、Method、Outline/Section、Reference、Claim/EvidenceLink、Experiment/Asset、Review/Revision、Version/Finalization。
- [ ] BibTeX 导入与 DOI 规范化；Crossref 经 Go 代理，记录来源、核验时间和状态，不允许模型伪造引用或实验。
- [ ] 远程 AI 只经网关，记录模型、模板、选中证据、输入/输出哈希与人工接受/拒绝状态。
- [x] 输出 BibTeX、MD、HTML、LaTeX、DOCX、材料护照 JSON、过程 MD 和投稿 ZIP，并通过引用与往返验收。

当前兼容进展：R01 已建立专用 React 工作台，打开路由即显示完整十视图与十阶段流水线；项目、作业、不可变版本和作者确认经 Go 控制面与受限 Worker，结构稿、BibTeX/DOI、双完整性核验、五角色审稿、复审、快照和全部交付格式由 Python 执行。真实链路已验证 10 个阶段、9 个实证章节、7 类失败模式、5 个审稿角色、DOI 规范化以及有效 DOCX/投稿 ZIP（8 个约定文件）。独立 PaperProject/Reference/Claim 等 Go 领域表、真正由 Go 发起的 Crossref 出站代理、组织级 AI 网关和生产部署仍未完成，因此 R01 尚不计为生产完成。

### R02 灾害遥感

- [x] 恢复 overview/change/screening/assessment/validation/reports 六个视图及影像、直方图、区域、4×4、分区和证据图表。
- [x] 兼容 GeoTIFF/PNG/JPEG 输入、双时相/波段映射、预设、CRS/NoData/分辨率 QA 和 100 万像素本地预览限制。
- [x] 恢复 NDVI loss、dNBR、NDWI、RGB CVA、亮度/差异；Otsu、分位数、手动阈值和归一化/偏移/形态学/连通域。
- [x] 恢复对象与分区指标、验证样本、precision/recall/F1/IoU、证据链和报告。
- [ ] 建立 RemoteSensingProject/Event/AOI、Scene/BandMapping、ProcessingJob、Zone/ObjectResult、Annotation/Validation、Artifact/Report。
- [ ] 大影像直传对象存储；Python 使用固定 GDAL/rasterio 等版本异步处理，记录输入、参数、CRS、算法/模型、环境与结果哈希。
- [x] 合成演示与真实处理使用 `processingMode` 明确区分；浏览器不得直连模型服务。
- [x] CSV、GeoJSON、mask PNG、GeoTIFF、MD/HTML/ZIP 导出坐标和统计一致，使用黄金影像验证公差。

当前兼容进展：R02 已建立专用 React 六视图工作台，打开路由即载入完整合成基准并显示双时相影像、变化强度、掩膜、直方图、候选类别、斑块、4×4 分区与验证指标；GeoTIFF/PNG/JPEG 在浏览器解析后统一通过 Go 作业边界交给 Python，未直连计算服务。Python 已实现六种算法、三类阈值、NoData/CRS/分辨率质检、偏移、辐射归一化、形态学、连通域、验证与全部约定导出，确定性黄金基准固定为 1531 个变化像元、3 个斑块和 16 个分区。真实链路已验证任务成功、坐标与统计一致、PNG/GeoTIFF 文件头和 ZIP 清单有效。独立 RemoteSensing 领域表、对象存储直传、固定 GDAL/rasterio 生产镜像、大影像异步瓦片化及领域专家黄金影像签字仍未完成，因此 R02 尚不计为生产完成。

### R03 地震与物理

- [ ] 恢复原 9 个分析面板、工作流导航和 CSV/TXT/JSON/miniSEED 2/3 输入；生产扩展格式另行标明。
- [ ] 恢复插值、去趋势、taper、滤波、灵敏度，FFT/Welch/STFT/Hilbert、STA/LTA/AIC 和人工拾取。
- [ ] 恢复 SNR、CAV、Arias、极化、P-S 距离等指标，以及波形/包络拾取、PSD、STFT 热图和粒子运动图。
- [ ] 建立 SeismicProject、Waveform/StationMetadata/InstrumentResponse、ProcessingRun、Pick/Revision、Event/Catalog、Artifact/Validation。
- [ ] Python 任务记录 ObsPy/算法版本、输入哈希、参数、单位、随机种子、人工修改与结果谱系。
- [ ] 本地教学算法与正式处理通过 `processingMode` 区分；正式事件目录发布需审核且版本不可变。
- [ ] 输出处理波形、PSD、事件、拾取 CSV 及 MD/HTML/ZIP；建立独立黄金波形和容差测试。

### R04 专利转化

- [ ] 恢复 overview/disclosure/search/novelty/claims/FTO/transfer/docket/archive 九个标签页。
- [ ] 恢复专利规范化/去重/BM25/EPO CQL/技术景观、特征矩阵、could-would 分析、权利要求树与 lint。
- [ ] 恢复 FTO 初筛与免责声明、TRL 证据、NPV/估值情景、成熟度、期限、归档和版本。
- [ ] 建立 PatentProject、Invention/Feature、PriorArt/Family/LegalStatusCheck、Claim/Graph、FTOIssue、TRLEvidence、ValuationScenario、Docket/Version。
- [ ] 专利状态、家族和法律状态不能只相信导入值；正式结论保留官方核验来源、时间和人工确认。
- [ ] CSV/TSV/JSON、项目 JSON 和证据指纹导入；各类 CSV/MD/HTML/ZIP 输出通过 schema 与往返测试。
- [ ] 明确“检索辅助/初筛”而非法律意见；关键结论必须由具备权限的人复核签署。

### R05 Skill 进化

- [ ] 恢复 overview、spec+contract、workflow、tests、run+trace、evaluation、security+provenance、releases 八个标签页。
- [ ] 恢复 frontmatter/SemVer、受限 JSON Schema、DAG、确定性白名单步骤、断言、基线、p50/p95、覆盖率和安全扫描。
- [ ] 建立 Skill、Definition/Contract、Resource/Step、EvaluationSet/Case/Run/Assertion/Score、Version、ReleaseEvidence、Artifact。
- [ ] 上传 Skill ZIP 兼容最多 100 文件、5MB；导入 registry/skill JSON，输出 registry/evaluation 和带 manifest/checksum 的 Skill ZIP。
- [ ] 禁止服务端直接执行上传的 Shell/Python/任意脚本；未来执行必须使用签名包、白名单、隔离 Worker 和严格网络策略。
- [ ] 发布需功能与安全双门禁，保留审批、制品签名、回滚目标和可复现评测证据。

### R06 知识系统

- [ ] 恢复 dashboard/ingest/documents/retrieval/qa/graph/quality/archive 八个标签页。
- [ ] 兼容 PDF/DOCX/CSV/JSON/HTML/XML/RTF/纯文本，30MB 旧上限、SHA 去重、版本、原文件下载和完整备份。
- [ ] 恢复 chunks、CJK grams、BM25 + 向量 + phrase/title + MiniSearch 语义、引用问答、概念图与 Hit@K/MRR。
- [ ] 建立 KnowledgeBase/Member、Document/Version、Chunk/Embedding、IndexJob、Conversation/Message/Citation、Concept/Relation、Revision/Settings。
- [ ] 原文件进对象存储；解析不得执行宏、HTML 脚本或外部资源，OCR/抽取/切块/索引均异步并可重跑。
- [ ] 检索必须在数据库层下推文档 ACL；回答返回 documentId、chunkId、页码/段落定位，引用可回到原文。
- [ ] embedding 记录模型与版本；删除文档后可追踪地清理 chunks、索引、向量和无引用对象。
- [ ] 完整知识库 ZIP 含原件与 checksum，可在空环境恢复；回答 MD 和文件下载通过权限与完整性测试。

### R07 科研雷达

- [ ] 恢复 overview/discover/library/graph/evidence/alerts/transfer/sources 八个标签页和原图表。
- [ ] Crossref/OpenAlex 由 Go 代理，支持真实分页、缓存、限流、超时、重试与来源健康状态；后续源单独配置。
- [ ] DOI/规范化题名去重，保留 providers 数组和各来源摘要；恢复相关性、趋势、OA、主题与共现分析。
- [ ] 恢复 BibTeX/RIS/JSON 导入、收藏/集合/标签/笔记、证据矩阵及转入论文/知识库/专利的动作。
- [ ] 原版手动 alert 基线升级为后台 MonitorRule/Run 调度；新结果产生真实通知，失败可见且不重复发送。
- [ ] 建立 ResearchRecord/Source、SearchRun、LibraryItem/Collection、EvidenceLink、MonitorRule/Run、TransferRecord。
- [ ] 输出 BibTeX、library CSV、alert MD、knowledge MD/JSON 和 backup JSON，来源与去重可复核。

### R08 AI+矿山安全研究雷达

- [ ] 使用与 R07 等价的检索、馆藏、证据、监测、通知和导出能力，但保持独立路由、标签与矿山领域分类。
- [ ] 迁移原矿山分类、风险信号、工程就绪度和展示图表；算法/阈值/人工确认均可追溯。
- [ ] 数据访问范围与普通科研雷达隔离；跨模式复用记录必须通过显式 transfer 并保留来源。
- [ ] 不用离线演示记录冒充真实研究；每条记录清楚标明 provider、演示/真实状态及核验时间。
- [ ] 建立独立 collection 或受约束 mode，完成跨模式、跨项目、跨租户权限测试。

### R09 研究自动化

- [x] 恢复文献/遥感/实验模板、trigger/source/transform/analysis/review/output 节点和画布/配置/历史界面。
- [x] 兼容 `skyview-research-workflow` v1 导入导出；原版确定性浏览器模拟保留为明确的 Preview 模式。
- [ ] 建立 Workflow、Node/Edge/Variable/SecretRef、Version/Schedule、Run/StepRun/Log、Approval、Artifact/Lineage。
- [ ] 正式模式支持白名单节点、条件、并行、重试、补偿、人工审批、取消、版本发布和耐久恢复。
- [ ] 密钥只保存引用，绝不进入工作流 JSON、日志、导出或浏览器；前端不能上传并执行任意程序。
- [ ] Worker 宕机、租约过期、重复消息、部分失败和取消竞态均有测试；运行历史不再只限浏览器 50 条。
- [ ] 每个输出可追溯到输入、节点版本、参数、运行环境和人工审批，Preview 结果不能发布为正式成果。

当前兼容进展：R09 已完成专用 React 层叠任务台、3 套模板、6 类白名单节点、六节点依赖画布、DAG 校验、变量与 SecretRef、调度/并发/重试配置、预览运行与节点追踪、人工审批、取消、失败步骤重试、产物血缘、不可变版本和六类导出；浏览器状态变更经 Go 项目/作业/Worker/审计边界调用 Python。真实链路已验证预览运行在审批点暂停，批准后继续完成并新增产物和血缘，v1 导入会剥离密钥值且不会启动执行。独立领域表、条件/并行/补偿、Temporal 耐久恢复、真实连接器和对象存储仍未完成，因此 R09 尚不计为生产完成。

## 9. 工程工作台逐项清单

### E01 数据网关

- [x] 恢复 NiFi 风格工具栏、无限画布、26 类处理器、连接、队列、拖拽、连线、搜索、缩略图和面包屑。
- [x] 恢复处理器配置标签、Controller Services、参数上下文、访问策略、校验、运行历史、Provenance、lineage 和 replay。
- [x] 恢复开始/停止、复制/粘贴、`Ctrl+S`、积压/反压提示及 FlowFile 路由与队列状态。
- [x] 保留 CSV/TSV/JSON 最多 10,000 行本地预览、转换、质量规则与路由；明确标记为 Preview，不冒充 NiFi 运行。
- [x] 兼容 `skyview-nifi-flow` v2 流程 JSON、CSV/TSV/JSON 输入、流程 JSON 和 provenance JSON 导出。
- [ ] 建立 Dataflow、Processor/Connection/Queue、ParameterContext、Policy、Version、Validation、Deployment、Run、ProvenanceEvent/Lineage。
- [ ] 权限精确覆盖 view、modify、operate、view_data、view_provenance、manage_policy，并验证撤权即时生效。
- [ ] 正式执行通过受控 NiFi API/Registry 或独立 Worker；连接器凭据只使用 `credentialRef`，前端不能读真实值。
- [ ] 正式 Kafka/DB/S3/MQTT/SFTP/HTTP 连接由 Controller Service 管理；验证、部署、回读、停止、回滚与告警有证据。
- [x] 兼容黄金样例：24 条记录得到 23 published、1 quarantined、3 high-risk，队列归零；replay 新 UUID 保留 parent。

当前兼容进展：E01 已完成旧卡片版可见工作流的专用 React 等价重写，前端不直连 Python，项目、作业、版本快照与审计经过 Go，流程解析、白名单校验、质量路由、运行、Provenance 和 replay 由 Python 执行。真实链路实测 26 类处理器、8 条默认连接、23 published、1 quarantined、3 high-risk、119 个 provenance 事件，运行后队列归零；replay 产生新 UUID 并保留 parent，流程 v2 和 provenance JSON 均通过往返。独立 Dataflow/Processor/Queue 等领域表、六类细粒度授权、真实 NiFi/Registry、外部 Controller Service 部署/回读/回滚仍未完成，因此 E01 尚不计为生产完成。

### E02 面波背景噪声成像

- [x] 恢复 overview、stations/data、preprocess、correlation、dispersion、tomography、quality、delivery 八个标签页；React 专用界面已接入。
- [x] 恢复台站/射线、波形、PSD、预处理前后、CCF、频散、层析热图和目标/恢复棋盘图。
- [ ] 兼容原确定性 9 台站、5Hz、600 样点演示数据与多通道 CSV；正式输入增加文件与台站元数据校验。
- [ ] 恢复去趋势、taper、近似带通、RAMN/one-bit、互相关、叠加、2–8 秒周期、阻尼/平滑反演、覆盖和棋盘恢复测试。
- [ ] 建立 AmbientProject、Station/Channel/Waveform、PreprocessConfig、CorrelationPair/Stack、DispersionPick、TomographyGrid/Run、QualityCheck、Artifact。
- [ ] Python 正式计算采用固定 ObsPy/NoisePy 类工具链，记录单位、参数、软件、随机种子、输入与结果哈希。
- [ ] 本地预览与正式运行用 `processingMode` 分开；人工频散拾取、质量批准和成果发布均有版本与审计。
- [ ] 导出项目 JSON、结果 JSON、频散 CSV、台站 CSV、方法 TXT；加入完整产物包和 checksum。
- [ ] 黄金验收：lag=1、seed=42 至少 6/10 对通过，8×6 模型为 48 单元，样例 CSV 采样率为 5Hz。

当前兼容进展：旧版默认 seed `20260809` 的完整流程已在 Python 复写，并与旧 JavaScript 引擎对齐为 18 个台站对、96 个有效频散点、15 条反演观测、80 个网格单元，层析 RMS 与棋盘相关系数在 12 位小数内一致。领域表、正式文件/元数据、叠加、人工批准、完整产物包与清单约定的 seed=42 黄金验收仍未完成，因此 E02 尚不计为生产完成。

### E03 AI+专利交底书工作台

- [x] 保留原 MIT 改编来源 `Dyp130/Patent-assistant`、固定提交 `7123187a1e071b402c4e87ff6d2ce8d1aff825e4` 与许可证/NOTICE，不删除署名。
- [x] 恢复暖白/靛蓝工作台、顶栏、项目列表、设置/状态和 250px 章节栏 + 主编辑区 + 270px 图示/质量栏。
- [x] 恢复核心构思页、生成、编辑、预览、流式状态、图示、质量检查、版本列表和恢复。
- [x] 保留十章：发明名称、技术领域、背景技术、发明目的、技术方案、有益效果、附图说明、具体实施方式、替代方案、关键点与保护点。
- [x] 保留 9 个必填章、替代方案可选的规则；原每章最多 20 版本作为兼容下限，服务端版本不可覆盖。
- [ ] 建立 PatentProject、Disclosure、Concept/Chapter/ChapterVersion、Figure、QualityRun/Issue、AIJob、HumanReview、ExportArtifact。
- [ ] AI 只经 Go 网关，记录模型、模板、证据、流式任务、取消和人工确认；未确认内容不得成为正式交底结论。
- [ ] Python 负责材料抽取、质量规则、图示/文档生成；专利法律与保密审查必须保留人工门禁。
- [x] DOCX、Markdown、`skyview-patent-assistant` JSON 导出和完整往返导入通过测试。

当前兼容进展：E03 已完成旧卡片版可见工作流的 React 等价重写，并通过 Go 项目/作业/受限 Worker 调用 Python；每次保存建立服务端不可变项目快照，章内保留最近 20 版。实测完整链路生成 10 章（9 个必填）、5 项附图、质量完成度 10/10，并通过 DOCX、Markdown 与项目 JSON 往返校验。独立 PatentProject/Disclosure/Chapter 等领域表、组织模型网关、证据绑定、取消/人工确认和法律/保密门禁仍未完成，因此 E03 尚不计为生产完成。

## 10. 工程总览中 9 张原版占位卡

以下卡片在旧版只有百度链接，没有独立页面、数据模型或真实功能。迁移要求是**保留卡片结构但删除百度链接并显示“规划中”**。只有另立产品需求、数据模型和生产验收后，才能升级为工作台。

| ID | 原卡片名称 | 建议未来路由 | 本次迁移要求 | 是否计入 20 个工作台 |
|---|---|---|---|---|
| G01 | 预警平台 | `/warning-platform` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G02 | 融合控制台 | `/fusion-console` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G03 | 决策大屏 | `/decision-screen` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G04 | 稳定性系数测算 | `/stability-factor` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G05 | 综合预警研判 | `/integrated-warning` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G06 | 微震裂隙可视化 | `/microseismic-visualization` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G07 | 无人机裂缝巡检 | `/uav-crack-inspection` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G08 | 点云瘦身与瓦片轻量化 | `/point-cloud-tiling` | [ ] 卡片保留、禁用、标“规划中” | 否 |
| G09 | 位移时间序列预测 | `/displacement-forecast` | [ ] 卡片保留、禁用、标“规划中” | 否 |

- [ ] 当前 React 中为上述占位项制作的简化阈值、排序、时间分桶等 Demo 不计为旧版迁移，也不得标“生产功能”。
- [ ] 未来每个绿地工作台单独完成用户故事、真实数据源、领域指标、权限、审计、失败策略和专家验收。
- [ ] 在绿地功能未完成前，直接输入建议未来路由返回清晰的规划状态或 404，不进入通用工具表单。

## 11. GitHub/开源使用边界

| 类型 | 项目或依赖 | 清单要求 |
|---|---|---|
| 前端实际依赖 | Three.js、Papa Parse、SheetJS、JSZip、PDF.js、Mammoth、MiniSearch、geotiff.js、Seisplotjs、Monaco | [ ] 固定版本、SBOM、许可证、CSP/Worker 兼容和升级测试 |
| 浏览器运行时 | Pyodide、WebLLM | [ ] 固定版本与资源源，显示本地运行状态，提供内网镜像/离线与降级方案 |
| 独立外部服务 | Judge0 Core、Crossref、OpenAlex、Semantic Scholar、OpenAI-compatible、遥感模型服务、NiFi | [ ] 只经后端或受控适配器，记录凭据方式、SLO、限流、熔断和数据策略 |
| 明确代码改编 | `Dyp130/Patent-assistant` MIT | [ ] 固定 commit，保留版权、NOTICE、十章结构与修改说明 |
| UI/工作流参考 | JupyterLab/JupyterLite、Zotero、OpenRefine、QGIS、Plane、Dagster、Open Knowledge Maps、2EZ-exam、Judge0 IDE、Uppy 等 | [ ] 只写“参考”，不复制不兼容代码/品牌，不声称已经集成 |

- [ ] AGPL/GPL 等项目逐项完成法务评估；未经批准不得把其代码混入闭源交付物。
- [ ] 每个引用仓库保存 URL、commit/tag、许可证、使用方式、修改内容、替代方案和负责人。
- [ ] UI 相似性不能造成官方合作或原品牌产品的误导，必要时更换图标、名称和视觉识别。

## 12. 旧浏览器数据迁移清单

### 12.1 统一迁移流程

- [ ] 提供 `POST /api/v1/migrations/browser-data/validate`，只校验和预览，不写正式业务表。
- [ ] 提供 `POST /api/v1/migrations/browser-data/import`，使用 Idempotency-Key，并返回逐模块成功、跳过、冲突和失败明细。
- [ ] 提供 `GET /api/v1/migrations/{migrationId}`，显示进度、对账、错误和人工处理项。
- [ ] 迁移包包含 `schema`、`schemaVersion`、`exportedAt`、模块、记录计数和 SHA-256 manifest。
- [ ] 数据永远重新绑定当前认证账号；不相信包内 userId、ownerId、scope、role、权益、成绩、审批或运行终态。
- [ ] 文件先隔离上传，经过 MIME/大小/SHA-256/查毒后生成 fileId；禁止将 Data URL、Blob URL 或本地绝对路径直接入库。
- [ ] 明文密码、验证码、session/JWT、API key、外部 token、鉴权头、签名 URL、隐藏测试和对象存储密钥一律丢弃。
- [ ] 演示/种子/虚构数据默认跳过；确需保留时只能进入明确标记、与正式项目隔离的演示空间。
- [ ] 迁移前后按实体、版本、附件、checksum 和关键业务值对账；支持幂等重试、部分失败重跑与整批回滚。
- [ ] 切换后 localStorage/IndexedDB 只保留语言、布局等低敏感偏好或明确标识的未同步草稿。

### 12.2 存储键到服务端模型

| 旧键/数据库 | 对应功能 | 目标权威存储 | 迁移处置与安全要求 |
|---|---|---|---|
| `cardVersionUsers` | 账号/学生资料 | users、identities、profiles、student_profiles | 仅进入账号核对/激活；不导入密码、角色、权益或种子账号，邮箱重新验证 |
| `cardVersionCurrentUser` | 当前登录账号 | 服务端 Session | 整键丢弃，不能恢复登录身份 |
| `cardVersionPaidFeatures` | 功能开关 | features、plans、policies、entitlements | 只允许超级管理员审核配置；普通迁移包不产生权益、订单或支付记录 |
| `cardVersionLanguage` | 语言偏好 | user_preferences.locale | 白名单导入，也可继续本地保存为非权威偏好 |
| `SkyViewLabInternalCourseData` / `records` | 账号范围通用容器 | 按内部 key 分派到领域表或 workspace_versions | 不信任 scope/owner/时间；只作源容器，不重复生成业务记录 |
| `skyviewCourseCache:<scope>:<moduleKey>` | IndexedDB 派生缓存 | 不单独入库 | 与 records 择新去重，禁止双份导入 |
| `skyviewCourseCacheMeta:<scope>:<moduleKey>` | 缓存更新时间 | 不作为业务数据 | 仅协助副本选择，不能作为审计时间 |
| `cardVersionPythonWorkspaceV2` | Python 文件工作区 | workspaces、versions、files | 扫描源码秘密；丢弃凭据、绝对路径和危险启动参数 |
| `cardVersionPythonLayoutV1` | Python 布局 | user_preferences | 只接受侧栏/终端尺寸等白名单值 |
| `cardVersionPythonRunHistoryV1` | Python 运行历史 | python_run_history/execution_runs | 标为 legacy；输出脱敏，不能作为服务器执行证据 |
| `skyviewInternalDailyPracticeV1` | 练习与考试 | practice_sessions、answers、stats、attempts | 本地分数标为未核验历史，不能直接转正式成绩 |
| `skyviewInternalProjectWorkspaceV1` | 在线项目 | projects、members、tasks、milestones、activities | owner/成员角色/活动重新校验，演示项目默认跳过 |
| `skyviewInternalProjectSubmissionV1` | 项目提交 | submissions、versions、files、reviews | 学生仅迁本人内容；成绩/评语/通过状态需管理员签名迁移 |
| `skyviewInternalDataLabV1` | 数据处理旧 V1 | data_projects、datasets、operations、files | 与新键去重；只解析声明式操作，禁止执行脚本/URL/表达式 |
| `skyviewOpenRefineProjectsV1` | 数据处理当前版 | data_projects、datasets、operations、versions、files | 文件扫描；操作按自有 schema 白名单重放，不执行任意 JS |
| `skyviewWebLLMReportWorkspaceV1` | AI辅助解释与报告 | report_projects、sources、chunks、versions、ai_jobs | 秘密材料分级；删除 endpoint/key，AI 内容保留 generated 标记 |
| `skyview2EZPythonEnglishV1` | Python 英文授课 | catalogs、learning_progress、attempts、xp_events | 本地得分标为未核验历史，不能直接形成课程成绩 |
| `skyviewJudge0AssessmentV2` | AI 测评 | judge_tasks/versions、submissions、results | 丢弃服务地址、token、AI key、隐藏用例；自定义题需教师审核 |
| `skyviewARSPaperWorkspaceV1` | 论文写作 | paper_projects、references、claims、sections、versions、reviews | 未发表内容高敏；作者/审稿决定重验，AI 内容保留标记 |
| `skyviewResearchRemoteSensingV1` | 灾害遥感 | projects、jobs、artifacts、annotations、validations、files | 丢弃本地路径/Blob URL/任务终态；正式结果基于原始文件重算 |
| `skyviewResearchSeismicPhysicsV1` | 地震与物理 | seismic_projects、jobs、picks、catalog、artifacts、files | 台站位置分级；本地派生结论标 legacy 或正式重算 |
| `skyviewResearchPatentTransferV1` | 专利转化旧 V1 | patent_projects、prior_art、claims、versions | 仅在无 V2 时转换；虚构专利与法律结论不进入正式数据 |
| `skyviewPatentTransferProV2` | 专利转化当前版 | patent_projects、prior_art、claims、FTO、TRL/valuation、docket、versions | V2 优先；去除凭据/审批，官方状态需重新核验 |
| `skyviewResearchSkillEvolutionV1` | Skill 旧 V1 | skills、versions、evaluations | 仅在无 V2 时转换，迁移期间不执行任何步骤或脚本 |
| `skyviewSkillEvolutionProV2` | Skill 当前版 | skills、contracts、workflows、tests、evaluations、releases | V2 优先；只解析不执行，清除 credential/发布状态，ZIP 安全检查 |
| `SkyViewLabKnowledgeSystem` | 知识系统 IndexedDB | knowledge_bases、documents、versions、chunks、embeddings、conversations、citations、files | 见下方 store 规则；原件扫描，正式解析/切块/向量重新生成 |
| `skyviewResearchRadarV1` | 科研雷达 | records、sources、library、monitors/runs | 外部来源重验；旧 alert 标为手动历史，不冒充调度运行 |
| `skyviewMineSafetyRadarV1` | 矿山安全雷达 | 独立 collection 或受约束 mine-safety mode | 不与通用雷达越权混用；丢弃 owner、凭据和运行终态 |
| `skyviewResearchAutomationV1` | 研究自动化 | workflows、versions、runs、steps、logs | 导入不执行；清除 token/任意脚本，旧运行标 simulation |
| `skyviewInternalNiFiDataFlowV2` | 数据网关 | dataflows、versions、deployments、provenance | 清除密码/内部地址/连接秘密；credentialRef 重绑，导入后不自动部署/启动 |
| `skyviewInternalAmbientNoiseImagingV1` | 环境噪声成像 | ambient_projects、jobs、artifacts、files | 台站/波形分级；本地结果标 legacy 或重算，丢弃伪终态 |
| `skyviewPatentAssistantV1` | AI+专利交底书工作台 | patent_projects、disclosures、chapter_versions、figures、ai_jobs | 未公开发明高敏；清除 endpoint/key/审批，演示项目默认跳过 |
| `skyviewInternalCommentsV1` | 讨论 | discussions、messages、participants、read_states、notifications | 作者重新映射；普通用户不能迁置顶/优先级/解决/代他人回复 |
| `skyviewInternalHomeworkV1` | 作业 | assignments、rubrics、submissions/versions、grades、feedback、files | 学生仅迁本人草稿/提交；作业、成绩、反馈和发布状态需受控迁移 |

`SkyViewLabKnowledgeSystem` 的 workspaces、documents、chunks、blobs、conversations、revisions、settings 各 store 必须分别对账；旧 192 维本地特征只作参考，不直接成为正式 embedding。

`window.cardVersionProfileLanguageBound` 只是旧页面防止重复绑定事件的内存标志，不是 localStorage/IndexedDB 数据，不进入迁移源清单。

### 12.3 导入导出 schema 登记

- [ ] 区分浏览器存储键与文件 schema；`skyview-project`、`skyview-ars-paper`、`skyview-nifi-flow` 等只登记为文件格式。
- [ ] 每个 schema 明确名称、版本、JSON Schema、最大尺寸、压缩规则、允许字段、升级函数和未知字段策略。
- [ ] 每种格式至少完成“旧文件导入 → 编辑 → 新文件导出 → 空环境重导入”的往返测试。
- [ ] CSV 输出防公式注入；ZIP 有 manifest/checksum，导入阻止路径穿越、重复路径和高压缩比攻击。

## 13. 当前代码处置清单

不是全部推倒重来，也不把现有原型误认成成品。以下均为“复用候选”，通过真实环境测试后才可保留：

| 目录 | 可复用候选 | 必须重做/补齐 |
|---|---|---|
| `web_react` | React 独立项目、导航壳、地球时钟首页、基础 API 适配 | 20 个专用工作台、原卡片结构、全部真实交互；淘汰通用 `/tools/:slug` 作为正式页面 |
| `backend_go` | API 分层、OIDC/OpenFGA/RLS、审计 v3、任务/outbox 等已有地基 | 真实 PostgreSQL/授权服务联调、领域模型、状态机、文件/迁移/通知、模块完整 API 与故障恢复 |
| `backend_python` | Worker 边界、任务协议、健康检查与已有测试框架 | 把简化动作替换为真实解析和科学计算，补黄金数据、资源隔离、取消、溯源和产物生成 |
| `infra` | 本地开发编排与配置样例 | test/staging/production 隔离、密钥引用、对象存储、扫描、队列、监控、备份恢复与容量配置 |
| `SkyViewLab-Internal-push-worktree` | 功能、布局、格式、测试的只读基线 | 不再写入；任何差异都登记在验收证据并经产品批准 |

- [ ] 先为现有代码生成保留/替换清单和测试覆盖，不做无法回滚的大批量覆盖。
- [ ] 现有简化 Go/Python 动作若与旧功能不等价，只能标 `prototype`，不得作为正式 API 保留同名语义。
- [ ] 迁移过程中始终保持 React、Go、Python 独立构建、独立镜像和单向调用边界。

## 14. 实施顺序与阶段闸门

### Gate A：范围与基线冻结

- [x] 用户审查并确认本清单（2026-09-08）。
- [x] 固定 32 个入口、20 个真实工作台、9 个占位卡、旧存储键、文件 schema 和 109 项旧测试；证据见 `verification/acceptance/_platform/gate-a/`。
- [x] 为每项建立“旧功能 → React → Go → Python/外部运行时 → 数据 → 测试”追踪编号；见 `FUNCTION_TRACEABILITY.md`。
- [ ] 固定直接依赖与参考仓库的 commit/tag、许可证和使用边界。
- [x] 输出首版 OpenAPI、ER 图、权限矩阵、威胁模型和领域事件目录；证据见 verification/acceptance/_platform/gate-a/03-api-and-data、04-permissions、05-audit-and-provenance、11-security-recovery。

### Gate B：生产地基

- [ ] 真实 PostgreSQL、OIDC、授权服务、RLS、Redis、对象存储、文件扫描、队列、审计和 OpenTelemetry 联调通过。
- [ ] 多副本登录回调、会话撤销、密钥轮换、权限 tuple 对账/撤权和 RLS 双层测试通过。
- [ ] outbox relay、幂等 consumer、dead-letter、告警、任务租约、宕机重领和清理真实运行。
- [ ] Python 使用 workload identity/mTLS 或等价机制，Worker 网络和资源隔离通过。
- [ ] 首页、App Shell、三大栏目页和旧路由兼容先完成，作为后续工作台共同底座。

### Gate C：P0 核心与高风险入口

- [ ] 登录/注册/个人中心/学生、服务端权益、文件、讨论/通知、作业/评分、通用版本与浏览器数据迁移完成。
- [ ] Judge0 服务端代理和隐藏测试保护完成；浏览器到 Python/外部运行时的非必要直连关闭。
- [ ] 两账号完成讨论和作业真实协作；生产构建扫描不到固定密码、密钥、内部地址或隐藏用例。
- [ ] P0 权限、审计、上传下载、迁移对账和恢复演练全部通过后，才进入大规模工作台迁移。

### Gate D：教学工作台批次

- [ ] D1：Python 编译器、日常做题、在线项目开发。
- [ ] D2：数据处理、AI辅助解释与报告。
- [ ] D3：Python 英文授课、AI 测试与提交、项目提交。
- [ ] 每个批次均按独立纵向切片交付 React + Go + Python/运行时 + 数据迁移 + 验收包，不等待最后统一补安全。

### Gate E：P1 科研与知识批次

- [ ] E1：论文写作、AI辅助解释与报告共用 AI/证据底座、AI+专利交底书工作台。
- [ ] E2：知识系统、科研雷达、矿山安全雷达。
- [ ] E3：专利转化、Skill 进化。
- [ ] Crossref/OpenAlex、AI 网关、文档管线、检索与发布门禁完成真实集成，不以本地模拟代替。

### Gate F：P2 科学计算与工程批次

- [ ] F1：灾害遥感、地震与物理、面波背景噪声成像。
- [ ] F2：研究自动化、数据网关与真实 NiFi/Worker 适配。
- [ ] 每个科学模块有真实样例、黄金数据、参考结果、公差、领域指标和领域负责人签字。
- [ ] 大文件、长任务、GPU/CPU 配额、取消、失败重试和宕机恢复完成压力与故障测试。

### Gate G：企业发布

- [ ] 31 个正式功能入口完成，20 个真实工作台均为“生产候选”；9 个占位卡仍单独统计。
- [ ] 全量权限/IDOR、渗透、并发、负载、耐久、混沌、迁移和供应链评审通过。
- [ ] 数据库、对象存储、队列与关键外部依赖完成真实故障/恢复演练和发布回滚演练。
- [ ] SBOM、许可证/NOTICE、镜像签名、容量计划、告警、运行手册和支持责任边界齐全。
- [ ] 产品、领域、架构、安全、运维与法务共同签字后，才可称“完整迁移、企业生产版”。

## 15. 进度状态与汇报口径

每个正式入口或工作台只能处于一个状态：

1. `未开始`
2. `界面复刻中`
3. `旧版功能已对齐`
4. `生产加固中`
5. `生产候选`
6. `生产可用`

- [ ] 只按三组数字汇报：正式入口 `x/31`、真实工作台 `x/20`、平台 Gate `x/7`。
- [ ] 9 个工程占位卡单独报告 `x/9` 的卡片处理状态，不并入功能完成率。
- [ ] “路由存在”“按钮可点”“slug 已注册”“接口 200”不计作“旧版功能已对齐”。
- [ ] 每次更新状态同时填写 commit、环境、测试报告和验收证据路径；没有证据不得升级状态。

## 16. 单模块验收证据包

每个模块使用 `verification/acceptance/<module>/<release>/`，至少包含：

| 目录 | 必须包含的证据 |
|---|---|
| `00-manifest` | 模块/版本、Git commit、镜像 digest、环境、负责人、状态、已知限制和索引 |
| `01-legacy-baseline` | 旧文件、截图/录像、字段/交互、存储 schema、旧测试和经批准差异 |
| `02-react-ui` | 路由、主要旅程 E2E、视觉回归、加载/空/失败/冲突/恢复、无障碍与浏览器报告 |
| `03-api-and-data` | OpenAPI、JSON Schema、ER 图、状态机、约束/索引、迁移 checksum 和回滚结果 |
| `04-permissions` | 角色—租户—空间—资源—动作矩阵、正反向/IDOR 测试、RLS/授权对账和撤权时效 |
| `05-audit-and-provenance` | 一次完整旅程的 audit/request/trace、输入/算法/环境/审批/产物 hash 链 |
| `06-import-export` | 格式表、golden fixture、损坏/超限/恶意样本、往返、扫描和 checksum 报告 |
| `07-runtime-and-science` | 运行时/镜像版本、资源/网络策略、故障注入；科学指标、公差和专家签字 |
| `08-data-migration` | validate/import、幂等、旧新计数与 hash 对账、错误明细、抽样和回滚演练 |
| `09-tests` | 单元、属性、契约、集成、E2E、并发、权限、安全、迁移、混沌及覆盖率 |
| `10-performance-observability` | 数据规模、负载、P50/P95/P99、错误率、资源曲线、dashboard、告警和 trace |
| `11-operations-dr` | 部署、扩容、降级、备份、实际恢复、测得 RPO/RTO、故障手册和回滚制品 |
| `12-supply-chain-license` | SBOM、SCA/镜像扫描、许可证/NOTICE、第三方 commit、法务结论和签名验证 |
| `13-signoff` | 产品、前端、后端、领域、安全、运维、法务签字及风险接受记录 |

- [ ] 证据必须能在干净验收环境复现；仅截图、口头说明或开发机数据库不算证据。
- [ ] 旧版已支持但新架构决定取消的功能，必须有产品签字的差异说明，不能静默遗漏。

## 17. 一票否决（No-Go）

任一项出现即禁止生产发布：

- [ ] 任一真实工作台仍是通用动态表单、静态假数据或模拟计算，却标记为正式可用。
- [ ] 存在生产默认账号、固定密码、明文密码、内存会话，或浏览器仍是角色/权益/成绩/审批权威。
- [ ] 未登录、跨租户/课程/项目、停用/过期权益或枚举资源 ID 可读取/修改数据。
- [ ] 学生可修改成绩/审核，客户端可伪造运行成功、算法版本、审计或最终成果。
- [ ] Python/Worker 被浏览器直连，或用 AST/关键字黑名单冒充用户代码隔离。
- [ ] Judge0 隐藏测试或 AI/Judge0/对象存储密钥进入 HTML、JS、接口响应、日志或浏览器存储。
- [ ] 原始文件以 Base64/Data URL 进入业务 JSON/数据库，上传未扫描，下载无短时授权。
- [ ] 长任务没有耐久队列、状态、进度、取消、幂等、超时、重试、死信或宕机恢复。
- [ ] 外部运行时没有真实联调、固定版本、许可证结论、限流、熔断、降级或替代方案。
- [ ] 旧数据迁移存在丢失、重复、错绑账号、导入密钥，或没有可执行回滚。
- [ ] 科学输出没有黄金数据、公差、领域指标与专家批准，或模拟结果被当作正式结论。
- [ ] 性能门槛不达标、大文件导致主 API 内存不可控，或未完成真实备份恢复演练。
- [ ] 存在未处置的 Critical/High 漏洞、许可证冲突、缺失 SBOM/签名或无法回滚。
- [ ] 9 张旧百度占位卡被计入“已迁移工作台”。

## 18. 开工前业务参数确认表

这些参数不改变“完整迁移”范围，但必须在 Gate A 结束前书面确认：

| 参数 | 建议默认值 | 待确认 |
|---|---|---|
| 租户 | 首期单组织运行，但所有核心表保留 tenant/organization 边界 | [ ] |
| 教师角色 | teacher 与 admin 分开 | [ ] |
| 身份接入 | OIDC 为主；具体学校/企业 SSO 供应方待定 | [ ] |
| 规模 | 峰值并发、年度文件量、最大单文件和科研数据量待给出 | [ ] |
| 敏感数据 | 专利/论文/矿山项目默认禁止发送公有云模型，逐项目授权 | [ ] |
| 通知 | 站内通知必做；邮件/企业微信/短信按渠道确认 | [ ] |
| 数据保留 | 按数据类别制定年限、删除审批、法律保留与用户导出范围 | [ ] |
| Judge0 | 首批语言、并发、网络策略、考试规则和资源上限待定 | [ ] |
| 科研计算 | 真实算法清单、黄金样例、GPU 需求和领域签字人待定 | [ ] |
| 收费 | 未完成支付合规与合同评审前保持免费，不建设虚假付款流程 | [ ] |
| 可用性 | P0 建议至少 RPO 24h/RTO 4h；正式敏感业务目标另行确认 | [ ] |

## 附录 A：图表与可视化对齐台账

图表不是装饰。每张图都必须绑定真实输入、单位、筛选条件、空值/异常值规则、导出数据和可访问的文字摘要。

| 模块 | 必须保留或补齐的可视化 |
|---|---|
| 首页 | 三维地球、星空/太阳/轨道/云层/夜景/大气层；模拟与数字时钟 |
| 日常做题 | 完成/正确/掌握度、考试倒计时、题目导航、结果分布与错题回看 |
| 在线项目 | 看板、任务列表、时间线、项目健康/逾期与里程碑状态 |
| 数据处理 | 数据网格、文本/数值 facet、高频值、12 桶直方图、列画像与聚合表 |
| AI辅助解释与报告 | 证据覆盖、来源索引、审计问题分布、版本差异与生成进度 |
| Python 英文授课 | 等级/XP、掌握度、连续学习、考试题图、复盘和真实排行榜 |
| AI 测试与提交 | 用例通过状态、加权得分、运行状态、资源/耗时和提交历史 |
| 项目提交 | readiness 仪表、六项检查、上传/打包进度与版本状态 |
| 论文写作 | 十阶段流程、主张—证据矩阵、完整性问题、审稿状态和版本差异 |
| 灾害遥感 | 双时相影像、变化 mask、直方图、AOI/对象/4×4/分区、混淆矩阵与验证指标 |
| 地震与物理 | 原始/处理波形、包络与拾取、STA/LTA、PSD、STFT 热图和粒子运动 |
| 专利转化 | 专利景观、特征矩阵、权利要求树、FTO 风险、TRL、NPV 情景和期限时间线 |
| Skill 进化 | DAG、运行 trace、断言结果、p50/p95、覆盖率、安全问题和发布历史 |
| 知识系统 | 检索排名/分数、引用定位、概念关系图、质量指标 Hit@K/MRR 和版本关系 |
| 两个科研雷达 | 年度趋势、OA/主题分布、关键词/作者共现网络、证据矩阵、告警与来源健康 |
| 研究自动化 | 工作流 DAG、节点状态、运行时间线、重试/审批、日志和数据血缘 |
| 数据网关 | 无限画布、连接/队列/反压、缩略图、Provenance 时间线和 lineage 图 |
| 环境噪声成像 | 台站/射线路径、波形、PSD、预处理对比、CCF、频散、层析热图和棋盘恢复 |
| AI+专利交底书工作台 | 章节完成度、图示列表/预览、质量问题、生成状态和版本历史 |

- [ ] 可视化数据可下载或进入对应正式导出，图上数值与后端/产物一致。
- [ ] 科学图保留坐标、单位、色标、图例、NoData/质量遮罩和算法版本；截图不能代替数值产物。
- [ ] 大数据图使用抽样/瓦片/虚拟化，但统计必须说明基于全量还是样本。
- [ ] 同一黄金数据在浏览器预览和 Python 正式计算中的差异处于已批准公差内。

## 附录 B：最低权限动作矩阵

| 领域 | 最低角色/动作边界 |
|---|---|
| 账号与学生 | 用户只改本人资料；teacher 看授权课程学生；admin 管状态/角色；super_admin 管身份与系统配置 |
| 权益 | 用户只读本人权益；admin 管功能策略/授予；高风险批量变更需二次验证 |
| 讨论 | participant 读写授权上下文；teacher/admin 置顶、解决和审核；删除/恢复分权 |
| 作业 | student 草稿/提交本人版本；teacher 管课程作业与评分；成绩发布与修正单独授权 |
| Python 编译器 | workspace viewer/editor/owner；运行、分享、导入、导出、恢复分别授权 |
| 日常做题与 Python 英文授课 | student 只管理本人进度；teacher 管课程目录；发布题库/调整成绩分权 |
| 在线项目 | project viewer/member/maintainer/owner；成员、归档、导出和恢复分别授权 |
| 数据处理/AI辅助解释与报告 | project viewer/editor/owner；敏感数据导出、远程 AI 外发和删除需额外权限 |
| AI 测评 | `judge.run`、task.manage、hidden_case.manage 分离；学生永远不能读取隐藏用例 |
| 项目提交 | student 管本人草稿/新版本；teacher 审核；grade.publish 独立且已提交版本不可改 |
| 论文/专利/知识库 | project viewer/editor/reviewer/owner；正式定稿、法律/质量确认、外发与导出分别授权 |
| 科研雷达 | collection viewer/editor/owner；监测规则、来源配置、跨模块 transfer 与批量导出分别授权 |
| 遥感/地震/面波 | viewer/editor/operator/reviewer；任务运行、人工标注、质量批准和成果发布分别授权 |
| Skill/自动化 | viewer/editor/operator/approver/releaser；运行、审批、发布、回滚、secretRef 使用分别授权 |
| 数据网关 | view、modify、operate、view_data、view_provenance、manage_policy 六项独立授权 |

- [ ] 每个允许路径至少一个正向测试，每个拒绝路径至少一个负向测试。
- [ ] 所有资源按 tenant → organization/course/workspace → project/resource → artifact/run 逐层校验。
- [ ] OpenFGA/等价授权与 PostgreSQL RLS 在真实环境完成一致性、撤权时效和对账修复测试。

## 19. 审查结论栏

- [x] 同意以原卡片版最新提交作为唯一功能基线。
- [x] 同意 20 个真实工作台逐个重写，不使用通用工具表单替代。
- [x] 同意 9 张百度占位卡只保留“规划中”，不计迁移完成率。
- [x] 同意 React → Go → Python/外部运行时的前后端分离边界。
- [x] 同意按 Gate A–G 顺序实施，每个模块以验收证据包为完成依据。
- [x] 审查意见：2026-09-08，用户确认本清单。
