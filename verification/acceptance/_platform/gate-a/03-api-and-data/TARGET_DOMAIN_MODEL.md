# Gate A 目标领域模型

状态：首版架构基线。此文档定义目标边界，不代表数据库表已经全部实现。现有 PG001–PG012 只覆盖平台骨架；后续迁移必须按纵向切片补表、约束、索引、RLS、回滚和真实 PostgreSQL 证据。

## 统一规则

- 所有业务行必须含 id、tenant_id、created_at、updated_at；可修改聚合含单调递增 version，删除默认使用 deleted_at。
- 资源范围从 tenant → organization/course/workspace → project/resource → artifact/run 逐层收窄；查询不得接受客户端传入的范围作为唯一授权依据。
- PostgreSQL 保存权威元数据；原文件、产物和大二进制进入 S3 兼容对象存储；队列/缓存不得成为唯一业务副本。
- 时间存 UTC，显示时由 React 转换为 Asia/Shanghai；金额用最小货币单位；科学量必须同时保存数值、单位、坐标系/参考系和质量标记。
- schema_version 属于可导入/导出的载荷；数据库迁移版本和领域资源 version 是不同概念。
- 关键写入在同一事务中更新业务资源、审计链和 outbox；外部副作用通过幂等 consumer 执行。

## 核心关系图

~~~mermaid
erDiagram
  TENANT ||--o{ ORGANIZATION : contains
  USER ||--o{ IDENTITY : binds
  USER ||--o{ SESSION : owns
  TENANT ||--o{ MEMBERSHIP : scopes
  USER ||--o{ MEMBERSHIP : receives
  ORGANIZATION ||--o{ COURSE : offers
  COURSE ||--o{ ENROLLMENT : has
  USER ||--o{ ENROLLMENT : joins
  FEATURE ||--o{ FEATURE_POLICY : governed_by
  USER ||--o{ ENTITLEMENT : receives
  COURSE ||--o{ ASSIGNMENT : owns
  ASSIGNMENT ||--o{ SUBMISSION : receives
  USER ||--o{ SUBMISSION : authors
  SUBMISSION ||--o{ GRADE : assessed_by
  WORKSPACE ||--o{ PROJECT : contains
  PROJECT ||--o{ PROJECT_VERSION : snapshots
  PROJECT ||--o{ ARTIFACT : produces
  FILE_OBJECT ||--o{ ARTIFACT : backs
  PROJECT ||--o{ JOB : runs
  JOB ||--o{ JOB_ATTEMPT : leases
  JOB ||--o{ ARTIFACT : emits
  PROJECT ||--o{ DISCUSSION : contextualizes
  DISCUSSION ||--o{ MESSAGE : contains
  USER ||--o{ MESSAGE : writes
  TENANT ||--o{ AUDIT_EVENT : records
  TENANT ||--o{ OUTBOX_EVENT : dispatches
~~~

## 教学、科研与工程聚合

~~~mermaid
erDiagram
  PYTHON_WORKSPACE ||--o{ WORKSPACE_FILE : contains
  PYTHON_WORKSPACE ||--o{ RUN_RECORD : executes
  QUESTION_BANK ||--o{ QUESTION : contains
  PRACTICE_SESSION ||--o{ QUESTION_ATTEMPT : records
  PORTFOLIO_PROJECT ||--o{ PROJECT_TASK : plans
  REFINE_PROJECT ||--o{ REFINE_OPERATION : replays
  REPORT ||--o{ EVIDENCE_ITEM : cites
  REPORT ||--o{ REPORT_VERSION : versions
  LEARNING_PROFILE ||--o{ LEARNING_ATTEMPT : progresses
  JUDGE_TASK ||--o{ HIDDEN_CASE : protects
  JUDGE_TASK ||--o{ ASSESSMENT_SUBMISSION : judges
  PROJECT_SUBMISSION ||--o{ SUBMISSION_VERSION : freezes
  PAPER ||--o{ PAPER_CLAIM : argues
  PAPER_CLAIM }o--o{ REFERENCE : cites
  REMOTE_PROJECT ||--o{ SCENE : compares
  REMOTE_PROJECT ||--o{ VALIDATION_SAMPLE : validates
  SEISMIC_PROJECT ||--o{ TRACE : contains
  SEISMIC_PROJECT ||--o{ PICK : interprets
  PATENT_PROJECT ||--o{ PRIOR_ART : evaluates
  SKILL ||--o{ SKILL_RELEASE : publishes
  KNOWLEDGE_BASE ||--o{ KNOWLEDGE_DOCUMENT : indexes
  RADAR_COLLECTION ||--o{ RADAR_RECORD : monitors
  WORKFLOW ||--o{ WORKFLOW_VERSION : versions
  WORKFLOW_VERSION ||--o{ WORKFLOW_RUN : executes
  DATAFLOW ||--o{ PROCESSOR_NODE : contains
  DATAFLOW ||--o{ PROVENANCE_EVENT : traces
  AMBIENT_PROJECT ||--o{ STATION : observes
  AMBIENT_PROJECT ||--o{ DISPERSION_PICK : interprets
  DISCLOSURE ||--o{ DISCLOSURE_CHAPTER : contains
~~~

## 聚合目录与权威边界

| 追踪 | 聚合根 | 关键子实体 | 权威服务 | 大对象/计算边界 |
|---|---|---|---|---|
| N06–N09 | User、Session、Membership、FeaturePolicy、Entitlement | Identity、RoleBinding、Grant | Go + PostgreSQL | IdP 只负责身份认证；授权结论由 Go/OpenFGA |
| N10 | Discussion | Message、Participant、Mention、ReadCursor、Moderation | Go + PostgreSQL | 附件进入对象存储 |
| N11 | Assignment、Submission | Requirement、Rubric、Criterion、Version、Grade、Feedback | Go + PostgreSQL | 附件/导出进入对象存储 |
| T01 | PythonWorkspace | WorkspaceFile、Revision、Snapshot、RunRecord | Go + PostgreSQL | 浏览器 Pyodide 为本地模式；服务端代码另进沙箱 |
| T02 | QuestionBank、PracticeSession | Question、Attempt、Bookmark、Mistake | Go + PostgreSQL | 正确答案和考试题序只在服务端 |
| T03 | PortfolioProject | Member、Task、Milestone、Activity、Snapshot | Go + PostgreSQL | 导出包进入对象存储 |
| T04 | RefineProject | Dataset、Column、Facet、Operation、Snapshot | Go 元数据；Python 计算 | 数据集/结果进入对象存储 |
| T05 | Report | Material、EvidenceItem、Conversation、Version、AuditIssue | Go；Python 文档任务 | AI 只经 Go 网关；原文/导出进入对象存储 |
| T06 | LearningProfile | CatalogItem、Attempt、Mastery、XPEntry、Exam | Go + PostgreSQL | 语音原始数据按策略短期保存 |
| T07 | JudgeTask、AssessmentSubmission | PublicCase、HiddenCase、CaseResult、Quota | Go；独立 Judge0 | 隐藏用例永不进入浏览器 |
| T08 | ProjectSubmission | Manifest、FileBinding、Preflight、Version、Review | Go；Python 检查/打包 | 不可变提交包进入对象存储 |
| R01 | Paper | Claim、Evidence、Reference、Review、Revision | Go；Python 导出 | Crossref 经服务端代理 |
| R02 | RemoteProject | Scene、AOI、ChangeObject、ValidationSample、Metric | Go；Python 科学任务 | 栅格、mask 和报告进入对象存储 |
| R03 | SeismicProject | Trace、ProcessingStep、Pick、Event、Spectrum | Go；Python 科学任务 | miniSEED/波形/谱产物进入对象存储 |
| R04 | PatentProject | Patent、PriorArt、Claim、FTOItem、TRL、Valuation、Docket | Go；外部核验 | 法律结论须人工批准 |
| R05 | Skill | Contract、Workflow、Evaluation、Trace、Release | Go；隔离评测器 | Secret 只用引用，不进版本载荷 |
| R06 | KnowledgeBase | Document、Chunk、IndexVersion、Citation、Conversation | Go；Python 检索 | 原文和索引产物进入对象存储 |
| R07–R08 | RadarCollection | Record、Query、Monitor、Alert、Transfer | Go；Python 可选 | 两种 radar mode 数据空间强隔离 |
| R09 | Workflow | Version、Node、Edge、Run、Approval、RunStep | Go；Temporal/Worker | 凭据只保存 secret_ref |
| E01 | Dataflow | Version、ProcessorNode、Connection、Queue、Policy、Provenance | Go；NiFi 适配器 | 未回读真实 NiFi 状态不得标部署成功 |
| E02 | AmbientProject | Station、WaveformRef、CCF、DispersionPick、TomographyRun | Go；Python 科学任务 | 波形与网格产物进入对象存储 |
| E03 | Disclosure | Chapter、Figure、GenerationJob、QualityIssue、Review、Version | Go；Python/AI 网关 | AI 外发受项目策略控制 |

## 核心状态机

| 实体 | 允许状态 | 关键约束 |
|---|---|---|
| Assignment | draft → published → closed ↔ published | 发布后修改要求生成新版本；关闭/重开需审计 |
| Submission | draft → submitted → revision → submitted → graded，可标 late | 已提交版本不可由学生覆盖；成绩发布单独授权 |
| UploadSession | created → uploading → scanning → accepted/rejected/expired | 未扫描文件不能绑定业务资源 |
| Job | queued → running → succeeded/failed/cancelled | 终态不可回退；每次执行绑定 fence/attempt |
| Import | uploaded → validating → previewed → committed/rejected | preview 不产生正式业务副作用 |
| Export | requested → running → ready/failed/expired | 下载需要短时授权；到期后对象按策略清理 |
| WorkflowVersion | draft → review → approved → published → retired | 发布内容不可变；回滚生成新发布版本 |
| ScientificResult | draft → quality_checked → approved/rejected → published | 算法结果与专家批准分离 |
| Patent/Disclosure review | draft → internal_review → legal_review → approved/rejected | 自动生成内容不得越过人工法律确认 |

## 索引与约束最低线

- 每个租户资源唯一键必须以 tenant_id 开头；外键同时校验父子租户一致。
- 常用活动列表索引使用 (tenant_id, scope_id, deleted_at, updated_at desc, id)；游标由排序字段和 id 组成。
- 幂等记录唯一键为 (tenant_id, actor_id, operation, idempotency_key)，同时保存请求摘要，键重用但请求不同返回 409。
- 外部标识唯一键必须包含 provider；OIDC subject 使用 (issuer, subject)，不得只按邮箱绑定。
- Outbox 以 (available_at, id) claim；consumer 结果以 (consumer, event_id) 去重。
- 审计事件对普通业务角色只读，按 scope 串行链接；删除、更新和 truncate 均由数据库阻止。

## 尚待 Gate B 证实

本模型仍需在真实 PostgreSQL 中验证 RLS、跨租户外键、唯一约束、并发冲突、索引计划、迁移锁、备份恢复和滚动升级。没有这些运行证据时，只能称为 Gate A 架构基线。
