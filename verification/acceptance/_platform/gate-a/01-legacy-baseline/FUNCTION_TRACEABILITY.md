# 原卡片版功能追踪矩阵

状态：Gate A 基线。此表把旧功能入口绑定到旧源码、旧数据、现有测试和目标边界；“已登记”不表示已迁移。

## 判定规则

- 正式完成必须同时交付专用 React 页面、Go 权威模型、适用的 Python/外部运行时、权限、审计、导入导出和测试。
- `page-assets.json` 保存 32 个页面的全部 `src`/`href` 引用；本表只列主要业务源码。
- “旧测试”写“缺”表示原卡片版没有独立自动化覆盖，新迁移必须新增测试，不能据此降低验收标准。
- 目标组件名是领域边界，不要求所有页面使用完全相同的布局。

## 核心入口

| ID | 原入口/主要源码 | 旧数据 | 旧测试 | React 目标 | Go/Python 目标 | 状态 |
|---|---|---|---|---|---|---|
| N01 | `index.html`；`earth-clock-3d.js`、`earth-clock-file-fallback.js` | 无权威业务数据 | `professional-ui.test.js` 部分覆盖 | `HomePage`、`EarthScene`、`ClockPanel` | 无领域后端；真实公告如保留则走 Go CMS | 已登记 |
| N02 | `research.html`；`paid-gate.js` | 权益、本地语言 | 缺 | `ResearchOverview`、原卡片分组 | Go 功能目录/权益 | 已登记 |
| N03 | `engineering.html`；`paid-gate.js` | 权益、本地语言 | `engineering-workbenches-ui.test.js` 部分覆盖 | `EngineeringOverview`、12 张原卡片 | Go 功能目录/权益；9 张占位不建假 API | 已登记 |
| N04 | `teaching.html`；`paid-gate.js` | 权益、本地语言 | 缺 | `TeachingOverview`、原两组 8 张卡 | Go 功能目录/课程绑定/权益 | 已登记 |
| N05 | `team.html` | 静态人员与百度链接 | 缺 | `TeamPage`、导师/快捷/成员/招募区 | Go CMS/公开成员资料 | 已登记 |
| N06 | `login.html`；`auth.js` | `cardVersionUsers`、`cardVersionCurrentUser` | 缺 | `LoginPage`、`RegisterPanel`、`VerificationForm` | Go OIDC/身份/会话；不迁密码 | 已登记 |
| N07 | `profile.html`；`auth.js` | 用户资料与语言 | 缺 | `ProfilePage`、资料/安全/学习区 | Go Profile/Session/Security | 已登记 |
| N08 | `students.html`；`student-management.js` | `cardVersionUsers` | 缺 | `StudentsPage`、筛选/表格/详情 | Go User/StudentProfile/RoleBinding/Enrollment | 已登记 |
| N09 | `paid-features.html`；`paid-management.js` | `cardVersionPaidFeatures` | 缺 | `FeaturePolicyPage`、目录/策略/授予 | Go Feature/Plan/Policy/Entitlement/Grant | 已登记 |
| N10 | `comments.html`；`comments-workbench.js` | `skyviewInternalCommentsV1` | `account-collaboration.test.js` | `DiscussionWorkbench`、主从列表/回复/审核 | Go Discussion/Message/ReadCursor/Notification/Audit | 已登记 |
| N11 | `homework.html`；`homework-workbench.js` | `skyviewInternalHomeworkV1` | `account-collaboration.test.js` | `HomeworkWorkbench`、教师/学生完整流程 | Go Course/Assignment/Rubric/Submission/Grade/File | 已登记 |

## 教学工作台

| ID | 原卡片名称；主要源码 | 旧数据 | 旧测试 | React 目标 | Go/Python/外部运行时 | 状态 |
|---|---|---|---|---|---|---|
| T01 | Python 编译器；`python-lab.js` | `cardVersionPythonWorkspaceV2`、LayoutV1、RunHistoryV1 | 缺 | 专用 IDE、文件树、编辑器、终端、Worker 适配 | Go Workspace/Version/Run；浏览器 Pyodide；服务端执行另行隔离 | 已登记 |
| T02 | 日常做题；`course-tools.js`、`daily-practice.css` | `skyviewInternalDailyPracticeV1` | `daily-practice-scroll.test.js` | 练习、考试、计时、题图、错题/收藏 | Go QuestionBank/Session/Attempt/Stats；答案服务端保密 | 已登记 |
| T03 | 在线项目开发；`course-tools.js` | `skyviewInternalProjectWorkspaceV1` | 缺 | 项目组合、看板/列表/时间线、里程碑 | Go Project/Member/Task/Milestone/Activity/Snapshot | 已登记 |
| T04 | 数据处理；`data-refine-engine.js`、`data-refine-pro.js` | `skyviewInternalDataLabV1`、`skyviewOpenRefineProjectsV1` | `data-refine-engine.test.js`、`data-refine-ui.test.js` | OpenRefine 风格专用工作台 | Go Project/Operation/Artifact；Python 解析/画像/重放/导出 | 已登记 |
| T05 | AI辅助解释与报告；`webllm-report-engine.js`、`webllm-report-app.js` | `skyviewWebLLMReportWorkspaceV1` | `webllm-report-engine.test.js`、`webllm-report-ui.test.js` | 材料/证据/对话/报告/审计/版本/导出/设置 | Go Report/AI Gateway/SSE；Python 抽取/OCR/检索/导出；本地 WebLLM | 已登记 |
| T06 | Python 英文授课；`twoez-python-*` | `skyview2EZPythonEnglishV1` | `twoez-python-engine.test.js`、`twoez-python-ui.test.js` | 六视图课程与五种学习模式 | Go Catalog/Progress/Attempt/XP；浏览器语音；Python 发音评分可选 | 已登记 |
| T07 | AI 测试与提交；`judge0-assessment-*` | `skyviewJudge0AssessmentV2` | `judge0-assessment-engine.test.js`、`judge0-assessment-ui.test.js` | Judge0 IDE、题库、运行/提交、结果/历史 | Go JudgeTask/HiddenCase/Submission/Quota；独立 Judge0 | 已登记 |
| T08 | 项目提交；`course-tools.js` | `skyviewInternalProjectSubmissionV1` | 缺 | Manifest、文件清单、预检、打包、审核 | Go Submission/Version/File/Review/Grade；Python 静态检查/打包 | 已登记 |

## 科研工作台

| ID | 原卡片名称；主要源码 | 旧数据 | 旧测试 | React 目标 | Go/Python/外部运行时 | 状态 |
|---|---|---|---|---|---|---|
| R01 | 论文写作；`ars-paper-engine.js`、`ars-paper-app.js` | `skyviewARSPaperWorkspaceV1` | `ars-paper-engine.test.js`、`ars-paper-ui.test.js` | 十视图、十阶段、证据/审稿/修订 | Go Paper/Reference/Review/Version/AI Gateway；Python 文档导出；Crossref | 已登记 |
| R02 | 灾害遥感；`remote-sensing-engine.js`、`remote-sensing-pro.js` | `skyviewResearchRemoteSensingV1` | `remote-sensing-engine.test.js`、`remote-sensing-ui.test.js` | 六视图影像/筛查/评估/验证 | Go Project/Scene/Job/Validation；Python rasterio/GDAL 科学任务 | 已登记 |
| R03 | 地震与物理；`seismic-physics-engine.js`、`seismic-physics-pro.js` | `skyviewResearchSeismicPhysicsV1` | 缺 | 九面板波形、谱、拾取、事件和物理结果 | Go SeismicProject/Pick/Catalog；Python ObsPy 类任务 | 已登记 |
| R04 | 专利转化；`patent-transfer-engine.js`、`patent-transfer-pro.js` | V1、`skyviewPatentTransferProV2` | 缺 | 九标签检索/新颖性/权利要求/FTO/转化 | Go Patent/PriorArt/Claim/FTO/TRL/Valuation/Docket；外部核验 | 已登记 |
| R05 | Skill 进化；`skill-evolution-engine.js`、`skill-evolution-pro.js` | V1、`skyviewSkillEvolutionProV2` | `skill-evolution-engine.test.js`、`skill-evolution-ui-smoke.test.js` | 八标签 spec/workflow/test/trace/release | Go Skill/Contract/Evaluation/Release；隔离评测运行时 | 已登记 |
| R06 | 知识系统；`knowledge-system-db.js`、engine/parser/pro | `SkyViewLabKnowledgeSystem` IndexedDB | `knowledge-system-engine.test.js`、`knowledge-system-ui-smoke.test.js` | 八标签导入/文档/检索/问答/图谱/归档 | Go KB/ACL/Conversation/Citation；Python 解析/OCR/索引/检索；对象存储 | 已登记 |
| R07 | 研究雷达；`research-radar-engine.js`、`research-radar-pro.js` | `skyviewResearchRadarV1` | `research-radar-engine.test.js`、`research-radar-ui-smoke.test.js` | 八标签发现/馆藏/图谱/证据/告警/联动 | Go Record/Library/Monitor/Notification；Crossref/OpenAlex 代理 | 已登记 |
| R08 | AI+矿山安全研究雷达；共享 `research-radar-*` | `skyviewMineSafetyRadarV1` | 与 R07 共用测试，缺独立隔离测试 | 独立矿山 mode、分类/风险/工程就绪度 | 与 R07 共用能力但数据空间和权限独立；Python 分类可选 | 已登记 |
| R09 | 研究自动化；`research-tools.js` | `skyviewResearchAutomationV1` | 缺 | 工作流画布、节点配置、运行、审批、日志/血缘 | Go Workflow/Version/Run/Approval；Temporal/Worker；Preview 分离 | 已登记 |

## 工程工作台

| ID | 原卡片名称；主要源码 | 旧数据 | 旧测试 | React 目标 | Go/Python/外部运行时 | 状态 |
|---|---|---|---|---|---|---|
| E01 | 数据网关；`data-gateway-engine.js`、`data-gateway-pro.js` | `skyviewInternalNiFiDataFlowV2` | `data-gateway-engine.test.js`、`data-gateway-ui-smoke.test.js` | NiFi 风格画布、队列、策略、Provenance/lineage | Go Dataflow/Version/Deployment/Policy；Python 预览处理；独立 NiFi | 已登记 |
| E02 | 面波背景噪声成像；`ambient-noise-engine.js`、`ambient-noise-pro.js` | `skyviewInternalAmbientNoiseImagingV1` | `ambient-noise-engine.test.js`、`engineering-workbenches-ui.test.js` | 八阶段台站/预处理/相关/频散/层析/交付 | Go AmbientProject/Job/Artifact；Python ObsPy/NoisePy 类任务 | 已登记 |
| E03 | AI+专利交底书工作台；`patent-assistant-engine.js`、`patent-assistant-app.js` | `skyviewPatentAssistantV1` | `patent-assistant-engine.test.js`、`patent-assistant-ui.test.js` | 十章、三栏、生成/编辑/图示/质量/版本 | Go Disclosure/Chapter/AIJob/Review；Python 抽取/质量/文档；AI Gateway | 已登记 |

## 兼容入口与占位项

- X01 `course-tools.html` 只负责旧 query 分发到教学正式路由，不单独建设领域模型。
- G01–G09 九张工程卡只冻结名称、顺序和占位状态；它们没有旧工作台源码、旧数据或可迁移生产能力。
- 当前 React `/tools/:slug` 只作为迁移期兼容入口；20 个真实工作台必须最终落到独立正式路由。

## Gate A 测试缺口

- [ ] 为 N02–N09 的卡片、身份、资料、学生、权益和团队页建立独立基线测试。
- [ ] 为 T01、T03、T08 补齐 Python 编译器、在线项目开发、项目提交的旧行为契约测试。
- [ ] 为 R03、R04、R09 补齐地震与物理、专利转化、研究自动化的引擎和 UI 基线测试。
- [ ] 为 R08 增加与通用科研雷达的数据/权限隔离测试。
- [ ] 把现有共享测试拆出明确模块标签，避免一个 UI 冒烟测试掩盖多个工作台缺口。
