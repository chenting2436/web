# SkyViewLab 生产级重构蓝图与差距审计

更新日期：2026-09-07  
旧版基线：`SkyViewLab-Internal-push-worktree`，提交 `8a754dcdb8ab97c7a90ca588693a17b21ee1f41b`  
当前实现：`web_react` + `backend_go` + `backend_python`

## 1. 结论和边界

当前版本不能作为大型企业生产系统交付。它完成了路由、页面骨架、简单项目保存和部分确定性算法，但“24 个 slug 可访问”不等于“24 个工作台功能等价”。旧仓库本身也是浏览器本地 review build，不是生产系统；本次目标因此不是逐文件照搬，而是以旧版功能为最低产品基线，再补齐企业级身份、授权、审计、对象存储、异步任务、可观测性、灾备和真实计算运行时。

本文中的“参考 GitHub”分为三类：

- **可集成**：许可证和技术边界允许作为库或独立服务接入，仍需固定版本、保留 NOTICE、做安全评审和 SBOM。
- **独立服务**：GPL/AGPL 或大型运行时通过已审查的独立部署和 API 适配，不能把代码随意复制进 SkyViewLab 闭源模块。
- **仅研究工作流/信息架构**：只借鉴公开概念并独立实现，不复制源码、提示词、界面资产、示例内容或品牌。

任何许可证结论都必须在锁定具体 commit 后由法务再次确认。尤其是 ARS 的 CC BY-NC、Dify 的附加条款、AGPL 项目和 README 声称 MIT 但缺少根许可证文件的项目。

## 2. 全平台生产验收基线

### 2.1 目标架构

| 层 | 生产职责 | 建议参考/组件 |
| --- | --- | --- |
| React Web | 每个工作台独立的专业界面；不含数据库和业务密钥；支持无障碍、国际化、大数据虚拟列表和失败恢复 | JupyterLab、OpenRefine、Plane、Judge0 IDE 的信息架构；SkyViewLab 独立实现 |
| Go Control Plane | API 网关、租户、OIDC 会话、细粒度授权、领域命令、元数据、审计、任务编排、下载授权、配额和幂等 | [Keycloak](https://github.com/keycloak/keycloak)、[OpenFGA](https://github.com/openfga/openfga)、[Temporal](https://github.com/temporalio/temporal) |
| Python Compute Plane | 遥感、地震、检索、报告、数据质量等隔离 Worker；不直接管理浏览器会话 | 领域库见各工作台；Temporal Python Worker 或同等级耐久任务执行器 |
| 结构化数据 | 生产使用 PostgreSQL；SQLite 只允许单机开发和测试；字段化领域表、约束、事务、迁移、索引和行级租户隔离 | [pgvector](https://github.com/pgvector/pgvector) 用于可选向量检索 |
| 文件与成果 | S3 兼容对象存储；分片上传、校验和、恶意文件扫描、保留策略、加密和短时签名下载 | [Uppy](https://github.com/transloadit/uppy) 前端；S3/R2/SeaweedFS 等经选型的对象存储 |
| 观测与运维 | JSON 日志、指标、分布式追踪、告警、运行手册、SLO、备份恢复演练 | [OpenTelemetry Go](https://github.com/open-telemetry/opentelemetry-go) 与 Python SDK |

### 2.2 所有工作台共同的硬门禁

1. **真实身份和多租户**：OIDC/SAML、MFA、组织/项目空间、SCIM 或受控用户同步；禁止生产演示密码和内存会话。
2. **服务端授权**：`tenant → workspace → project → artifact/run` 逐层校验；至少有平台管理员、组织管理员、项目负责人、研究员/教师、审核员、学生/成员、只读访客；前端隐藏按钮不能替代授权。
3. **不可抵赖审计**：登录、读取敏感数据、上传、下载、运行、修改、审批、授权、删除、导出均记录 actor、tenant、resource、before/after hash、request/trace id、IP/UA、时间和结果。审计记录禁止普通用户改写。
4. **数据生命周期**：分类分级、加密、保留/销毁策略、软删除、法律保留、租户导出、备份和按目标时间恢复。
5. **对象存储**：原始文件不进入 JSON 或数据库 BLOB；保存 SHA-256、MIME 探测结果、大小、所有者、扫描状态、派生关系和处理版本。
6. **异步计算**：长任务必须排队，可取消、可重试、可恢复、有幂等键、资源配额、并发限制和进度事件；Web 请求线程不得直接跑重计算。
7. **安全执行**：用户代码、模型、文件解析器和第三方连接器必须在容器/沙箱隔离，限制 CPU、内存、PID、磁盘、网络和运行时间；AST 黑名单不算安全沙箱。
8. **API 契约**：OpenAPI、版本化 DTO、JSON Schema、统一错误码、分页/过滤/排序、ETag 或 revision 并发控制、幂等键、速率限制和兼容策略。
9. **可观测性**：业务指标、队列深度、外部依赖、算法版本、数据版本、成本和质量门禁全部可追踪；为关键旅程制定 SLO 和告警。
10. **质量工程**：单元、属性、契约、集成、端到端、权限矩阵、迁移、回滚、负载、安全和科学基准测试；发布必须有 SBOM、依赖/许可证扫描和可回滚制品。

### 2.3 Sites 与前后端分离约束

- `web_react` 继续保留 Sites 项目结构和 `.openai/hosting.json`，仅承担 React 页面、静态资源和前端构建/发布；Go/Python 不写入该项目。
- React 不直接连接数据库、对象存储管理端、Secret Manager 或 Python Worker，只访问公开的 Go Control Plane API。
- `D1/R2` 当前保持 `null`；业务主数据固定进入独立 PostgreSQL/S3 架构。若以后使用 Sites 资源，只能先写清用途和数据边界，不能形成第二套业务事实源。
- 浏览器不得持有服务密钥，也不把论文、专利、成绩、原始影像等敏感业务内容长期留在 localStorage/IndexedDB；仅允许保存无敏感性的界面偏好。
- 每个工作台拆成专用 route/component/schema/tests，继续复用导航、按钮、表单、状态和错误处理等设计系统；禁止把领域能力继续堆入一个通用动态表单。
- 首页继续保留简洁的地球旋转和时钟视觉；总览卡片从服务端 capability、entitlement 和真实健康状态生成，不显示虚构数字、口号或硬编码“可用”。
- Sites 的前端预览/发布和 Go/Python 的部署、迁移、回滚分别执行；前端发布成功不能替代后端与工作台验收。

## 3. 科研工作台

### 3.1 论文研究与写作

- **参考仓库**：[Manubot](https://github.com/manubot/manubot)（BSD-2-Clause-Patent，标识符引用、CSL/Pandoc 和版本化发布）；[Academic Research Skills](https://github.com/Imbad0202/academic-research-skills)（CC BY-NC 4.0，仅研究十阶段、人审关卡和证据治理，不复制内容）；[Zotero](https://github.com/zotero/zotero)（AGPL，API/信息架构参考）；JupyterLab（BSD-3-Clause，工作区布局参考）。
- **完整功能**：研究问题和范围；方法/伦理/数据管理计划；Crossref/OpenAlex/Semantic Scholar 检索；BibTeX/RIS/CSL 导入；去重与全文阅读状态；主张—证据—定位锚点；实验、数据、图表来源；六类论文结构、引用样式；十阶段状态机；双诚信门禁；五角色审稿；逐条回复、修订和再审；定稿、投稿包和流程记录。
- **图表/界面**：十阶段泳道、PRISMA 筛选漏斗、主张—证据二部图、引用完整度矩阵、审稿问题矩阵、版本逐行差异、图表/实验溯源表。
- **数据模型**：`papers, paper_stages, research_questions, methods, sources, source_anchors, claims, claim_evidence, experiments, datasets, figures, manuscript_sections, reviews, review_findings, responses, snapshots, exports`。
- **权限与审计**：作者可编辑；合作者按章节；数据管理员确认来源；审核员只读材料并提交签名审查；负责人放行诚信门禁；所有引用提升、主张强度变化、AI 生成和定稿均审计。
- **导入导出/运行时**：PDF/DOCX/LaTeX/Markdown/BibTeX/RIS/CSL；Markdown/HTML/LaTeX/DOCX/PDF/BibTeX/JSON/ZIP；Pandoc/TeX 运行器、文献 API、可选模型网关均独立运行并记录版本。
- **当前差距（P0）**：只有文本表单、7 段结构稿和规则计数；缺少十阶段状态机、真实文献库、锚点、完整审稿循环、文件解析、排版运行时和专用数据表。

### 3.2 灾害遥感损毁评估

- **参考仓库**：[QGIS](https://github.com/qgis/QGIS)（GPL-2.0+，仅工作流/独立服务）；[SamGeo](https://github.com/opengeos/segment-geospatial)（MIT，可选分割 Worker）；[OpenDroneMap](https://github.com/OpenDroneMap/ODM)（AGPL，独立服务）；GDAL/rasterio/rio-tiler 作为后端地理栅格技术栈。
- **完整功能**：GeoTIFF/COG、多波段和 RGB 导入；CRS/仿射/NoData/分辨率 QA；灾前灾后配准；指数和变化向量；阈值、形态学、连通域、分割模型；矢量标注；4×4 分区与五级严重度；60/40 决策支持分；独立验证；处理图谱与可复现报告。
- **图表/界面**：图层树、地图画布、卷帘/闪烁对比、波段直方图、变化掩膜、对象边界、分区热力图、混淆矩阵、面积/置信度分布、证据链时间线。
- **数据模型**：`incidents, scenes, raster_assets, bands, registrations, analysis_recipes, jobs, masks, objects, zones, validations, evidence_links, reports`，空间字段使用 PostGIS。
- **权限与审计**：分析员运行；复核员独立标注；事件负责人发布；原始影像不可覆盖；每个像元成果能追溯输入、参数、代码/模型和环境。
- **导入导出/运行时**：GeoTIFF/COG/PNG/JPEG/GeoJSON/Shapefile；COG/GeoJSON/CSV/PNG/HTML/ZIP；GDAL 隔离 Worker、可选 GPU 分割服务、瓦片服务。
- **当前差距（P0）**：只接收逗号分隔数字；无文件、CRS、地图、真实栅格、对象存储、空间数据库、模型、验证样本或地理导出。

### 3.3 地震与物理分析

- **参考仓库**：[ObsPy](https://github.com/obspy/obspy)（LGPL-3.0，Python 服务）；[Seisplotjs](https://github.com/crotwell/seisplotjs)（MIT，浏览器波形/miniSEED）；[SeisBench](https://github.com/seisbench/seisbench)（模型和基准，部署前逐模型核对许可证）。
- **完整功能**：miniSEED/SAC/CSV、StationXML、FDSN；三分量波形；去均值/趋势、去响应、滤波、重采样；PSD/STFT；STA/LTA、AIC 和人工拾取；P/S 相、事件关联、定位、震级、目录；算法/人工结果对比和 QC。
- **图表/界面**：多通道波形、频谱/PSD、时频谱、STA/LTA 比、拾取游标、粒子运动、台站/事件地图、震级—时间和 Gutenberg–Richter 图。
- **数据模型**：`networks, stations, channels, waveform_assets, processing_recipes, waveform_segments, picks, arrivals, events, origins, magnitudes, catalogs, qc_findings`。
- **权限与审计**：原始波形只读；自动拾取与人工修改分开记录；目录发布需审核；每个 pick 保留算法/模型、概率、人工作者和版本。
- **导入导出/运行时**：miniSEED/SAC/StationXML/QuakeML/CSV；ObsPy CPU Worker、可选 SeisBench GPU Worker、FDSN 客户端。
- **当前差距（P0）**：仅短数字序列上的简化 DFT/平滑/STA-LTA；无真实格式、响应、时标、台站元数据、拾取编辑、事件定位和专业图形。

### 3.4 专利转化

- **参考仓库**：[Patent2Net v3](https://github.com/Patent2net/P2N-v3)（CeCILL-B，优先独立适配/算法研究）；[python-epo-ops-client](https://github.com/ip-tools/python-epo-ops-client)（Apache-2.0）；PatentsView 官方查询 API；WIPO/EPO 官方规范。
- **完整功能**：发明披露；OPS/PatentsView/用户语料检索；同族、引用、法律状态、IPC/CPC；现有技术矩阵；权利要求树和从属校验；要素覆盖；FTO 初筛；TRL 证据；市场/许可情景、现金流和风险审批。
- **图表/界面**：专利同族树、引用网络、申请时间线、IPC/CPC treemap、权利要求树、要素矩阵、TRL 路线图、估值瀑布图、风险矩阵。
- **数据模型**：`inventions, patent_records, families, legal_events, citations, classifications, prior_art_queries, feature_matrices, claims, trl_evidence, valuation_scenarios, risks, decisions`。
- **权限与审计**：发明人、知识产权经理、代理人、技术审核、财务审核分权；检索式、法律状态核验时间、人工结论和审批签名必须保留。
- **导入导出/运行时**：OPS/PatentsView API、CSV/JSON/BibTeX/PDF；矩阵 XLSX、披露 DOCX、评估 PDF/ZIP；外部 API 有缓存、限流和许可合规。
- **当前差距（P0）**：仅字符串相似和简单 NPV；无真实专利源、家族/法律状态、权利要求图谱、审批、来源核验或专业导出。

### 3.5 Skill 进化

- **参考仓库**：[Agent Skills specification](https://github.com/agentskills/agentskills)（代码 Apache-2.0、文档 CC BY 4.0）；[Promptfoo](https://github.com/promptfoo/promptfoo)（MIT，评测/红队；自定义脚本不在可信 API 进程执行）；[Langfuse](https://github.com/langfuse/langfuse)（核心 MIT，`ee/` 非开源，追踪/数据集）；Dify 只作产品研究且需遵守其附加条款；Flowise 已归档，不选为生产底座。
- **完整功能**：Skill 注册表；SKILL.md 与渐进披露；输入输出 JSON Schema；声明式安全 DAG；数据集、断言、负样本和基线；回归/成本/延迟；trace；静态供应链扫描；SBOM、签名、来源；语义版本、审批、灰度和回滚。
- **图表/界面**：规范编辑器、DAG、测试矩阵、基线对比、回归趋势、trace 瀑布、依赖/SBOM 图、安全发现表、发布时间线。
- **数据模型**：`skills, skill_versions, resources, contracts, workflow_nodes, eval_datasets, eval_cases, assertions, eval_runs, traces, findings, releases, approvals, signatures`。
- **权限与审计**：作者不能单独批准生产发布；安全审核和业务审核双门禁；数据访问级别、工具权限、每次执行和回滚均记录。
- **导入导出/运行时**：Skill ZIP、JSON Schema、测试集 JSONL、SARIF、SBOM、签名；隔离评测 Worker，禁止任意导入脚本直接执行。
- **当前差距（P0）**：只有文本规则检查与布尔发布判断；无真实版本仓库、评测执行、trace、供应链、签名和审批。

### 3.6 研究自动化

- **参考仓库**：[Dagster](https://github.com/dagster-io/dagster) 和 [Prefect](https://github.com/PrefectHQ/prefect)（均 Apache-2.0）；平台耐久编排首选 [Temporal](https://github.com/temporalio/temporal)。
- **完整功能**：流程模板、类型化端口、参数/密钥引用、条件/并行/映射、计划/事件触发、重试/超时/补偿、缓存、人工审批、子流程、运行恢复、日志/指标/血缘、版本和回放。
- **图表/界面**：DAG 画布、运行 Gantt、节点状态、重试热力图、事件时间线、日志流、资产血缘、运行对比。
- **数据模型**：`workflow_definitions, workflow_versions, nodes, edges, schedules, triggers, secrets_refs, runs, task_runs, attempts, events, approvals, artifacts, lineage`。
- **权限与审计**：编辑、发布、执行、审批、查看密钥和取消分权；发布后定义不可变；运行关联准确版本和参数 hash。
- **导入导出/运行时**：版本化 YAML/JSON、OpenAPI connector；Temporal/Prefect/Dagster adapter；Kubernetes/容器 Worker。
- **当前差距（P0）**：只有拓扑排序和同步模拟，没有耐久队列、重试恢复、并行、计划、审批、密钥或真实 Worker。

### 3.7 个人/团队知识系统

- **参考仓库**：[RAGFlow](https://github.com/infiniflow/ragflow)（Apache-2.0）、[AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)（MIT 且需核对自托管条款）、[pgvector](https://github.com/pgvector/pgvector)、Zotero（AGPL，API/信息架构）。
- **完整功能**：多格式上传、OCR、病毒扫描、去重、解析警告、分块预览、元数据/标签、全文+向量+模糊混合检索、过滤、权限感知检索、引用问答、概念图、检索测试集、Hit@K/MRR/nDCG、修订和完整备份。
- **图表/界面**：库树、文档列表、元数据/片段详情、摄取进度、检索分数组成、来源引用、概念关系图、评测趋势、存储/处理状态。
- **数据模型**：`collections, documents, object_assets, parsers, chunks, embeddings, tags, acl_entries, queries, retrieval_hits, conversations, citations, eval_sets, eval_results, revisions`。
- **权限与审计**：个人、团队、项目集合；文档级 ACL 必须下推到检索；下载、共享、重新解析、索引版本和问答引用均审计。
- **导入导出/运行时**：PDF/DOCX/PPTX/XLSX/HTML/XML/邮件/代码/图片 OCR；ZIP 数据库、Markdown/JSON 引用；解析/OCR/embedding Worker、Postgres FTS+pgvector 或专用检索集群。
- **当前差距（P0）**：仅一个文本框的分段和词频；无文件、OCR、对象存储、持久化索引、ACL 下推、向量模型、引用定位或备份恢复。

### 3.8 研究雷达

- **参考仓库/服务**：OpenAlex、Crossref、Semantic Scholar 官方 API；Zotero（集合/元数据交互）；[Open Knowledge Maps](https://github.com/OpenKnowledgeMaps)（主题地图概念）。
- **完整功能**：高级查询、多个数据源、游标分页、API 缓存和速率限制；DOI/标题/作者去重；筛选状态、标签、笔记、集合；引用和主题网络；保存检索与按计划刷新；变更通知；证据矩阵；向论文/知识/专利工作台传递有来源的记录。
- **图表/界面**：文献密集表、年度趋势、主题共现图、引文网络、筛选漏斗、证据矩阵、监测增量时间线。
- **数据模型**：`search_queries, providers, harvest_runs, works, authors, venues, topics, citations, collections, screenings, notes, monitor_baselines, deltas, evidence_cells`。
- **权限与审计**：团队集合、双人筛选、冲突裁决、查询版本和导出日志；记录 API 来源、抓取时间、原始 hash 和归一化版本。
- **导入导出/运行时**：BibTeX/RIS/CSV/JSON；API 抓取 Worker、调度器、缓存和可选图数据库。
- **当前差距（P0）**：同步拉取两个 API 的少量记录；无分页、缓存、重试、监测调度、筛选、引用图、集合、去重审计和服务条款控制。

### 3.9 AI+矿山安全研究雷达

- **参考仓库**：复用研究雷达底座；领域分类器需使用有授权的矿山安全词表、标注集和可解释模型，不能用若干关键词冒充 AI。
- **完整功能**：边坡/冲击地压/瓦斯通风/水害/火灾/粉尘/尾矿/人员设备 taxonomy；方法和传感器识别；现场验证、公开数据/代码、基线、不确定性证据；人工筛选和冲突裁决；工程成熟度证据卡。
- **图表/界面**：taxonomy sunburst、主题趋势、研究机构/现场地图、方法—场景矩阵、就绪度雷达、证据缺口热力图、引用网络。
- **数据模型**：在雷达模型上增加 `domain_taxonomies, labels, classification_runs, classifier_versions, readiness_evidence, field_sites, sensors, validation_claims`。
- **权限与审计**：领域专家确认标签和就绪度；自动分类不能直接发布；保留模型、阈值、解释、人工覆盖和训练数据许可。
- **导入导出/运行时**：分类服务、可选 NLP 模型、领域词表版本；证据矩阵 XLSX/CSV/JSON/PDF。
- **当前差距（P0）**：规则关键词和一句“就绪度”；无受控词表、训练/评测数据、专家复核、模型卡或领域证据链。

## 4. 工程工作台

### 4.1 数据网关

- **参考仓库**：[Apache NiFi](https://github.com/apache/nifi)（Apache-2.0，优先独立部署并通过 REST/Registry 接入）。
- **完整功能**：处理器/关系/连接/队列/进程组；Controller Services；参数上下文和 secret refs；调度、背压、优先级、重试、死信；CSV/JSON/Avro/Parquet schema；DB/Kafka/S3/MQTT/SFTP/HTTP 连接；数据质量、路由；集群状态；版本流程；provenance、lineage 和 replay。
- **图表/界面**：NiFi 风格数据流画布、队列/背压、吞吐/延迟时序、失败率、节点状态、provenance 搜索和 lineage 图。
- **数据模型**：SkyViewLab 只保存 `gateway_connections, flow_refs, deployment_refs, access_policies, run_summaries, provenance_refs`；执行级事件留在 NiFi/日志平台，避免重复造引擎。
- **权限与审计**：流程查看/编辑/操作/部署/下载内容分权；凭据仅进密钥管理；所有远程操作、参数变更和 replay 审计。
- **导入导出/运行时**：NiFi Registry flow definition、schema、连接器配置；真实 NiFi 集群、OIDC/TLS、Registry 和 Secret Manager。
- **当前差距（P0）**：只校验几段 JSON 和在内存处理一小段 CSV；没有画布、NiFi、连接器、队列、背压、provenance、集群或密钥管理。

### 4.2 面波背景噪声成像

- **参考仓库**：[NoisePy](https://github.com/noisepy/NoisePy)（MIT）、[MSNoise](https://github.com/ROBelgium/MSNoise)（EUPL-1.1，优先独立服务并由法务复核网络使用义务）、[SeisLib](https://github.com/fmagrini/seislib)、ObsPy；SeisLib 锁定版本后复核许可证。
- **完整功能**：台站/响应/连续波形归档；时间质量和缺口；去响应、滤波、归一化、谱白化；日互相关、叠加、dv/v；频散拾取和 QC；射线路径、阻尼/平滑反演；分辨率、checkerboard 和不确定性；结果/方法可复现包。
- **图表/界面**：台站地图、连续波形/PSD、互相关函数瀑布、SNR、频散能量图和拾取、ray coverage、速度/异常地图、checkerboard 输入/恢复、残差与 L-curve。
- **数据模型**：`networks, waveform_archives, preprocessing_configs, correlation_jobs, station_pairs, daily_ccf, stacks, dispersion_picks, inversions, grids, rays, qc_metrics, recovery_tests`。
- **权限与审计**：计算者、拾取复核者、反演审批者；人工拾取与自动拾取并存；每个网格单元追溯输入台站对和算法版本。
- **导入导出/运行时**：miniSEED/SAC/StationXML/ASDF/CSV/NetCDF/GeoTIFF；CPU/HPC Worker、NoisePy/ObsPy/SeisLib 环境、可选 Slurm/Kubernetes。
- **当前差距（P0）**：短数组上的近似处理；无归档、响应、日堆叠、真实频散、反演、分辨率测试、地图和 HPC。

### 4.3 AI 专利交底书

- **参考仓库**：[Dyp130/Patent-assistant](https://github.com/Dyp130/Patent-assistant)（MIT，可在保留许可证后适配；仍需法务/专利代理审核）。
- **完整功能**：项目列表、专利类型、核心构思、技术特征分析、十章节、逐章/全部 SSE 生成、编辑/预览、附图清单、自动快照/回滚、提示模板版本、事实核验、Markdown/DOCX。
- **图表/界面**：项目列表；章节树—编辑器—预览三栏；流式生成状态；附图清单；版本 diff；事实/来源/待核验项面板。
- **数据模型**：`patent_drafts, concepts, concept_analyses, chapters, chapter_versions, figures, generation_jobs, prompt_versions, source_evidence, verification_items, exports`。
- **权限与审计**：发明人、代理人、技术审核和定稿审批；AI 内容逐段标记模型/提示/来源；任何已批准版本不可静默覆盖。
- **导入导出/运行时**：Markdown/DOCX/PDF 附件；模型网关、SSE/事件流、DOCX/PDF 排版 Worker。
- **当前差距（P0）**：一次请求生成固定模板；无项目级章节实体、逐章编辑、SSE、附图、真正版本 diff、模型治理和 DOCX。

### 4.4 灾害监测预警平台

- **参考仓库**：[ThingsBoard](https://github.com/thingsboard/thingsboard)（社区版许可证锁定后复核，可独立 IoT 平台）；[Grafana](https://github.com/grafana/grafana)（AGPL，独立服务/信息架构）；Prometheus/Alertmanager。
- **完整功能**：设备/传感器注册、数据接入、质量与校准、实时/历史查询、动态阈值和规则、告警去重/抑制/升级、确认/处置/关闭、通知、维护窗口、值班和复盘。
- **图表/界面**：多轴时序、阈值带、空间地图、热力图、告警时间线、设备可用性、数据缺口、处置 SLA；仪表仅显示真实指标。
- **数据模型**：`sites, assets, devices, sensors, observations, quality_flags, rules, rule_versions, alarms, incidents, acknowledgements, escalations, notifications, maintenance_windows`；高频时序使用 TimescaleDB/时序存储。
- **权限与审计**：设备管理员、规则作者、值班员、现场负责人、只读监管；规则发布双人审批；确认、抑制和关闭均审计。
- **导入导出/运行时**：MQTT/HTTP/Kafka/OPC-UA adapter、Prometheus、通知网关、地图服务。
- **当前差距（P0）**：单数组阈值比较；没有设备、流数据、规则版本、告警生命周期、通知或实时可视化。

### 4.5 无人机巡检

- **参考仓库**：[WebODM](https://github.com/WebODM/WebODM) 与 [ODM](https://github.com/OpenDroneMap/ODM)（AGPL，独立部署/API）；OpenLayers/MapLibre 用于地图；CV 模型按权重许可证单独审核。
- **完整功能**：巡检计划/航线/禁飞区；大文件上传；照片 EXIF/GPS/姿态；摄影测量任务；正射/DSM/点云/3D；缺陷检测和人工标注；复核工单；比较巡检；报告和证据链。
- **图表/界面**：地图航线和覆盖、影像缩略图、正射图层、缺陷框/多边形、3D/点云入口、缺陷分布、严重度趋势、复核队列。
- **数据模型**：`missions, flight_plans, flights, image_assets, camera_metadata, odm_jobs, orthomosaics, point_clouds, detections, annotations, inspections, work_orders, reports`。
- **权限与审计**：飞手、数据处理、算法审核、现场复核、项目负责人；原图与派生成果链、模型版本和人工覆盖均审计。
- **导入导出/运行时**：JPEG/DNG/视频/GeoJSON/KML/LAS/LAZ/OBJ/COG；WebODM/NodeODM、GPU 推理、对象存储和瓦片服务。
- **当前差距（P0）**：对两条异常 JSON 排序；无任务、影像、航线、地图、摄影测量、模型、工单和报告。

### 4.6 多源监测融合

- **参考仓库**：ThingsBoard 的设备/规则概念；[Kepler.gl](https://github.com/keplergl/kepler.gl) 和 OpenLayers 的空间交互；Kafka/Flink 作为可选流处理外部运行时。
- **完整功能**：数据源注册、schema/单位/坐标/时钟治理；流与批接入；缺失/异常/漂移；时间窗口和事件时间；校准；特征和融合规则/模型；置信度与解释；回放、对比和告警输出。
- **图表/界面**：源拓扑、对齐多轴时序、空间地图、缺失热力图、相关矩阵、贡献度、异常时间线、融合前后对比和数据质量面板。
- **数据模型**：`sources, schemas, units, calibration_versions, observations, quality_events, alignment_jobs, feature_sets, fusion_models, model_versions, fused_events, explanations`。
- **权限与审计**：源管理员、数据工程师、模型作者、业务审核；schema/单位/校准/模型发布审批；每个融合结论可追溯原始观测。
- **导入导出/运行时**：MQTT/Kafka/HTTP/files、时序数据库、特征/模型 Worker、模型注册表。
- **当前差距（P0）**：仅按分钟分组；无事件时间、水位线、单位/校准、流处理、模型、解释或数据质量。

### 4.7 应急研判中心

- **参考仓库**：[Ushahidi Platform](https://github.com/ushahidi/platform)（AGPL，独立服务/API/信息架构）；[Sahana Eden](https://github.com/sahana/eden)（锁定版本后复核许可证）；OpenLayers/MapLibre。
- **完整功能**：事件分级、态势地图、报告/传感器/公众线索汇聚、核验、资源/队伍/避难点、任务和依赖、SOP、指挥日志、通知、交接班、决策记录、行动后复盘。
- **图表/界面**：事件地图、时间线、任务 Kanban/Gantt、资源状态、依赖图、通信日志、风险矩阵、决策树和复盘时间轴。
- **数据模型**：`incidents, reports, verifications, map_layers, resources, teams, shelters, tasks, dependencies, decisions, communications, shifts, situation_reports, after_action_reviews`。
- **权限与审计**：指挥员、值班员、现场队伍、信息审核、外部协作、只读监管；敏感位置/人员字段级授权；每个决策记录证据和批准人。
- **导入导出/运行时**：CAP/GeoJSON/KML/CSV、消息/短信/邮件网关、地图、天气和组织通讯录适配。
- **当前差距（P0）**：把一段文本变成任务列表；无真实事件、地图、资源、协同、通信、敏感权限或交接复盘。

### 4.8 旧工程页其余外链能力（全部按绿地建设）

旧 `pages/engineering.html` 有 12 张工程卡，其中只有数据网关、背景噪声和 AI 专利交底具有旧版本地工作台；其余 9 张均跳转到百度。当前 React 的预警、融合、无人机覆盖了其中部分名称，应在 Gate A 合并范围，但不能把外链卡片计作旧 GitHub 已实现能力。为满足“全部内容”的要求，其余能力登记如下：

| 能力 | GitHub 参考与完整功能 | 图表/专用界面 | 数据模型、权限、导入导出和运行时 | 当前差距 |
| --- | --- | --- | --- | --- |
| 决策大屏 | [Grafana](https://github.com/grafana/grafana)、ThingsBoard、Kepler.gl；多源态势、值班视图、告警/事件、处置建议、人工批准、播放与交接 | 地图、风险矩阵、真实指标卡、趋势、事件时间线、资源状态、处置漏斗 | `dashboard_definitions, panels, data_bindings, decision_cards, approvals, snapshots`；按岗位/事件字段裁剪；JSON/PNG/PDF；查询网关和缓存 | 旧版只有百度链接；当前无路由，属 P0 绿地范围 |
| 稳定性系数测算 | [PySlope](https://github.com/JesseBonanno/PySlope)（MIT，Bishop 方法参考）及 QGIS/GDAL；边坡几何、分层材料、水位、荷载、滑面搜索、多方法对照、参数敏感性、概率分析、专家复核 | 剖面与材料层、候选/临界滑面、FoS 分布、敏感性 tornado、参数相关、失效概率 | `slope_models, strata, materials, water_levels, loads, analysis_cases, slip_surfaces, validation_cases, approvals`；DXF/CSV/JSON；隔离数值 Worker；算法和规范版本审计 | 旧版只有百度链接；生产结论需验证案例和岩土专家签字 |
| 综合预警研判 | 并入“灾害监测预警平台”；ThingsBoard/NiFi/Temporal；多源规则/模型、滞回去抖、告警合并、证据汇聚、人工研判、升级/关闭和演练 | 告警队列、关联事件图、因子贡献、空间态势、规则命中、处置时间线 | 复用 `rules, observations, alerts, evidence, decisions, notifications`；CAP/JSON/CSV；流处理和通知运行时 | 旧版只有百度链接；当前单值阈值远不足以覆盖 |
| 微震裂隙可视化 | ObsPy、[PyVista](https://github.com/pyvista/pyvista)（MIT）、CesiumJS；微震目录、定位不确定性、聚类、震源机制/矩张量、裂隙面拟合、时间演化和人工解释 | 三维震源球、裂隙面、巷道/地层、时间—能量、b 值、聚类、定位误差椭球、事件详情 | `microseismic_events, locations, mechanisms, clusters, fracture_interpretations, geology_assets, revisions`；QuakeML/CSV/DXF/3D Tiles；ObsPy/PyVista Worker 和 WebGL 查看器 | 旧版只有百度链接；当前无路由，属 P0 绿地范围 |
| 点云瘦身与瓦片轻量化 | [PDAL](https://github.com/PDAL/PDAL)、[3D Tiles](https://github.com/CesiumGS/3d-tiles) 和 CesiumJS；LAS/LAZ QA、CRS、分类、裁剪、去噪、采样、octree/LOD、切片、压缩、metadata 和结果验证 | 三维点云、分类图例、LOD 切换、密度/高程直方图、空间误差热力图、处理流水线和瓦片统计 | `point_cloud_assets, schemas, processing_recipes, jobs, tilesets, tile_nodes, quality_reports`；LAS/LAZ/E57/PLY/3D Tiles；PDAL/tiler 独立 Worker、对象存储/CDN | 旧版只有百度链接；当前无路由，属 P0 绿地范围 |
| 位移时间序列预测 | [sktime](https://github.com/sktime/sktime)；传感器/测点、质量控制、缺测/异常、趋势季节性、变化点、基线与模型、滚动回测、预测区间、漂移和预警联动 | 多测点时序、预测区间、残差、回测窗口、误差对比、变化点、漂移和特征贡献 | `displacement_series, sensors, quality_events, feature_sets, forecast_models, backtests, forecasts, intervals, drift_events`；CSV/Parquet/API；隔离训练/推理 Worker 和模型注册表 | 旧版只有百度链接；当前无路由，属 P0 绿地范围 |

上述能力在领域需求、规范依据、验证数据和责任人没有签字前，React 总览只能显示“规划中”，不得显示为已迁移或可用。

## 5. 教学工作台

### 5.1 Python 实验室

- **参考仓库**：[JupyterLite](https://github.com/jupyterlite/jupyterlite)（BSD-3-Clause，浏览器内实验）；JupyterLab/JupyterHub（BSD-3-Clause，服务器课程环境）；Monaco（MIT）。
- **完整功能**：文件树、编辑器/Notebook、kernel 生命周期、stdin/stdout/stderr、富输出、包/数据集、保存点、实验模板、教师只读材料、运行历史、资源配额和一键重置。
- **图表/界面**：Jupyter 式文件树/标签页/单元格/输出；变量和运行状态；资源用量只显示真实数据。
- **数据模型**：`lab_templates, lab_sessions, files, notebooks, checkpoints, kernel_sessions, executions, outputs, environments, package_policies`。
- **权限与审计**：教师发布模板；学生隔离会话；助教按课程查看；代码执行、包变更、下载和分享审计。
- **导入导出/运行时**：`.py/.ipynb/CSV`；浏览器 JupyterLite 或每用户容器/JupyterHub；生产代码执行绝不使用同机 subprocess。
- **当前差距（P0）**：文本框调用 AST 黑名单和同机 subprocess，可绕过且无资源/网络/文件系统隔离；无文件、Notebook、kernel 或环境管理。

### 5.2 120 题日常练习

- **参考仓库**：[H5P PHP Library](https://github.com/h5p/h5p-php-library)（GPL-3.0，独立集成/交互参考）；Moodle Quiz（GPL-3.0+，独立服务/工作流参考）。题库内容沿用旧仓库的 120 题，但需内容审核、版本化和题目唯一标识。
- **完整功能**：四题型；分类/难度/搜索/收藏；练习即时反馈；错题；计时随机试卷；交卷统一评分；尝试历史；题目版本；题库导入；教师统计和题目质量分析。
- **图表/界面**：题目导航、计时/进度、知识点掌握热力图、答题正确率/耗时分布、题目区分度、错题趋势。
- **数据模型**：`question_banks, question_versions, options, accepted_answers, tags, exams, exam_rules, attempts, responses, scores, favorites, mastery, item_statistics`。
- **权限与审计**：教师编题/审核/发布分离；学生只见允许答案；考试期间隐藏答案且服务端判分；题目变更和成绩修订审计。
- **导入导出/运行时**：QTI/JSON/CSV；成绩 CSV/XLSX/PDF；可选 xAPI/LTI。
- **当前差距（P0）**：React 只让用户手填“标准答案/我的答案”，没有旧版 120 题、练习/考试 UI、错题、收藏、题库管理或服务端防作弊。

### 5.3 在线项目开发

- **参考仓库**：[Plane](https://github.com/makeplane/plane)（AGPL，独立部署/API/信息架构）；Temporal/Dagster 用于自动任务，不复制 Plane 源码进闭源前端。
- **完整功能**：多项目、成员、角色、任务、状态、优先级、标签、依赖、评论、附件、周期/里程碑、看板/列表/时间线、活动、通知、归档和项目交换。
- **图表/界面**：Kanban、密集列表、时间线/Gantt、里程碑、燃尽、累计流、成员负载和活动流。
- **数据模型**：`projects, memberships, issues, statuses, labels, dependencies, comments, attachments, cycles, milestones, activities, notifications`。
- **权限与审计**：项目负责人、教师、学生成员、访客；字段级修改规则；成员/状态/截止日期/归档均审计。
- **导入导出/运行时**：CSV/JSON/ZIP、日历订阅、Webhook；可选 Plane 独立实例适配。
- **当前差距（P0）**：只汇总几条任务 JSON；无多项目、成员、看板、评论、附件、通知、里程碑或活动。

### 5.4 数据清洗工作台

- **参考仓库**：[OpenRefine](https://github.com/OpenRefine/OpenRefine)（BSD-3-Clause，可独立部署或基于其公开工作流独立实现）。
- **完整功能**：CSV/TSV/TXT/JSON/XML/XLS/XLSX 导入预览；类型推断；缺失/唯一/重复/异常；文本/数值/时间 facet；过滤/分组/排序；单元格编辑；列/行操作；安全表达式；完整 undo/redo/分支；操作脚本回放；reconciliation；大数据作业。
- **图表/界面**：高密度虚拟表格、facet 侧栏、频次条形/数值直方图、质量画像、操作历史、变更 diff 和错误行队列。
- **数据模型**：`data_projects, source_assets, import_configs, schemas, table_snapshots, operations, history_cursors, facets, reconciliation_jobs, exports`；大型表使用 Parquet/分析引擎而非 JSON blob。
- **权限与审计**：源文件只读；每个操作不可变；导出关联历史游标；协作者的分支/合并和下载审计。
- **导入导出/运行时**：上述格式；CSV/TSV/XLSX/JSON/HTML/Parquet/ZIP；OpenRefine 或 DuckDB/Arrow Worker。
- **当前差距（P0）**：只支持文本 CSV 与 4 个简单操作；无文件、facet、编辑、undo/redo、脚本分支、Excel/XML、虚拟表格或大数据引擎。

### 5.5 AI 辅助解释与报告

- **参考仓库**：[WebLLM](https://github.com/mlc-ai/web-llm)（Apache-2.0，本地 WebGPU）；RAGFlow/AnythingLLM（材料和检索工作流）；PDF.js/Mammoth/SheetJS 等解析器逐项保留许可。
- **完整功能**：多格式材料、URL 抓取审批、hash/片段/页码定位、材料选择、权限感知检索、带引用问答、8 类报告结构、流式生成/中断、模型/提示/温度记录、引用/数字/覆盖/占位符核验、版本和完整交付包。
- **图表/界面**：材料库、片段详情、对话、报告大纲/编辑器、流式状态、引用覆盖、未证实数字、来源索引、版本 diff、模型资源/成本。
- **数据模型**：`report_projects, materials, fragments, retrieval_indexes, conversations, prompts, generations, report_sections, citations, verification_findings, versions, deliveries`。
- **权限与审计**：材料 ACL 必须贯穿检索/生成；模型调用同意、发送片段清单、供应商/区域、用量和人工批准审计；密钥只进 Secret Manager。
- **导入导出/运行时**：PDF/DOCX/PPTX/XLSX/HTML/XML/代码；MD/HTML/DOCX/PDF/TXT/JSON/ZIP；WebLLM Worker 或企业模型网关。
- **当前差距（P0）**：基于段落拼模板；无文件解析、真实检索、模型、流式、材料 ACL、版本 diff、DOCX/PDF 或模型治理。

### 5.6 Python English

- **参考仓库**：[2EZ-exam](https://github.com/dvrone/2EZ-exam)（README 标 MIT，但旧审计发现固定 commit 缺根 LICENSE，因此仅研究流程）；H5P/Moodle 的内容和测验模型。
- **完整功能**：旧版 8 主题 64 词、Learn/Flashcard/Quiz/Pronunciation/Typing、32 题考试、即时反馈、计时/导航、8 篇参考、XP/等级/连续学习、真实排行榜、发音和语音识别、内容导入和教师审核。
- **图表/界面**：学习面板、课程卡、闪卡、单题测验、打字/发音反馈、掌握度热力图、连续学习日历、考试历史和真实排行榜。
- **数据模型**：`courses, vocabulary_versions, examples, references, exams, questions, learning_sessions, responses, mastery, xp_events, streaks, leaderboard_snapshots, imports`。
- **权限与审计**：教师审核内容；学生拥有进度；排行榜须同意且可匿名；XP 事件服务端生成并可追溯。
- **导入导出/运行时**：JSON 词汇、2EZ 风格文本题、语音合成/识别适配；学习/考试记录导出。
- **当前差距（P0）**：三词 JSON 评分和简单掌握率；64 词、五模式、32 题、参考、XP、streak、排行榜和语音均未迁移。

### 5.7 AI 测试与提交

- **参考仓库**：[Judge0 Core](https://github.com/judge0/judge0)（GPL-3.0，必须独立服务）和 [Judge0 IDE](https://github.com/judge0/ide)（MIT，交互参考）；Monaco Editor（MIT）。
- **完整功能**：语言/状态/配置发现；15 个领域任务和自定义任务 schema；Monaco；自定义输入；公开/隐藏批量测试；异步 token 轮询；资源限制；标准 verdict；stdout/stderr/编译/时间/内存；加权得分；诊断；提交历史；教师任务版本。
- **图表/界面**：任务 rail、编辑器、stdin/stdout/result panes、test case 表、verdict 分布、时间/内存图、提交趋势和差异诊断。
- **数据模型**：`assessment_tasks, task_versions, languages, test_cases, hidden_case_secrets, submissions, case_results, verdicts, diagnostics, quotas`。
- **权限与审计**：隐藏测试只在可信服务端；教师发布题目；学生无法读 expected output；重判、成绩变更和代码读取审计。
- **导入导出/运行时**：Judge0 REST/batch；独立编译器 Worker、网络隔离、配额、队列；任务 JSON 和历史导出。
- **当前差距（P0）**：只在同机运行 Python；JavaScript/Go 只做文本审查；隐藏测试由客户端提交，无法保密；无真实 Judge0、语言发现、队列或安全隔离。

### 5.8 项目提交

- **参考仓库**：[Uppy](https://github.com/transloadit/uppy)（MIT，上传 UI）；tus/tusd（可恢复上传）；ClamAV；对象存储 SDK。
- **完整功能**：目录/拖放/断点续传；模板；扩展名/MIME/大小/数量；恶意文件扫描；路径规范化；SHA-256；README/入口/依赖检查；服务端 ZIP；不可变提交；重新提交版本；教师内部评审、退回和归档。
- **图表/界面**：文件树、上传队列/进度、校验状态、扫描状态、manifest、版本时间线、审核清单。
- **数据模型**：`submission_projects, upload_sessions, objects, manifests, validation_rules, validation_results, malware_scans, submissions, submission_versions, reviews, retention_policies`。
- **权限与审计**：学生只管理自己的草稿；正式提交不可覆盖；教师评审；扫描失败隔离；上传/下载/提交/退回审计。
- **导入导出/运行时**：tus/S3 multipart、异步扫描、ZIP Worker、短时签名下载。
- **当前差距（P0）**：在请求 JSON 中传文件正文并同步 base64 ZIP；无真实上传、大小总限、扫描、对象存储、断点续传、不可变提交或审核。

## 6. 协作与管理功能

### 6.1 讨论区

- **参考仓库**：[Discourse](https://github.com/discourse/discourse)（GPL-2.0，独立服务/API/交互参考）和 Moodle Forum（GPL）。
- **完整功能**：课程/研究频道、线程回复、提及、未读、订阅、搜索、过滤、优先级、置顶、解决、编辑历史、附件、通知、举报、管理员审核和保留策略。
- **图表/界面**：密集线程列表、阅读详情、参与者/活动时间线、审核队列；不需要装饰性统计。
- **数据模型**：`channels, discussions, posts, post_revisions, mentions, reads, subscriptions, attachments, moderation_actions, reports`。
- **权限与审计**：频道成员、作者编辑窗口、教师/管理员审核；删除采用墓碑；审核和敏感读取审计。
- **当前差距（P0）**：只有 JSON 记录、回复和解决；缺未读/提及/置顶/编辑历史/通知/附件/审核/分页/搜索索引。

### 6.2 作业与评分

- **参考仓库**：[Moodle](https://github.com/moodle/moodle)（GPL-3.0，独立服务/API/工作流参考）；H5P/LTI/QTI 规范。
- **完整功能**：课程/班级、作业草稿/发布/关闭、资源、要求、截止/时区/宽限、个人/小组提交、草稿/正式/重交、附件版本、迟交、量规、匿名评分、双评、退修、成绩发布、通知和成绩导出。
- **图表/界面**：作业列表/详情、提交队列、rubric 表、批改面板、成绩分布、迟交状态、版本时间线和反馈。
- **数据模型**：`courses, classes, enrollments, assignments, assignment_versions, resources, rubrics, criteria, submissions, submission_versions, files, grades, grade_events, feedback, extension_grants`。
- **权限与审计**：教师/助教权限范围、学生仅本人、匿名评分映射隔离；发布后变更、延期、下载、评分和改分审计。
- **当前差距（P0）**：一个共享 JSON 表；附件以 data URL 入库；无课程/选课、对象存储、时区/宽限、小组、匿名/双评、正式成绩发布和完整变更历史。

### 6.3 组织、用户和权益管理

- **参考仓库**：Keycloak（OIDC/SAML/MFA/用户联合）；OpenFGA（资源关系授权）；可选 SCIM 实现需单独选型。
- **完整功能**：组织/部门/项目空间、成员邀请/禁用、角色/权限模板、课程选课、服务账号、API token、外部身份绑定、权益/配额、审计查询、会话吊销、数据导出/删除和安全事件。
- **图表/界面**：成员和角色表、权限解释器、访问审查、活跃会话、安全事件、配额和审计搜索。不得显示虚构 KPI。
- **数据模型**：`tenants, users, identities, groups, memberships, role_bindings, relationships, service_accounts, api_tokens, entitlements, quotas, sessions, audit_events, access_reviews`。
- **当前差距（P0）**：两个硬编码账号、明文默认密码、内存会话、无租户/用户生命周期/MFA/SSO/授权模型/访问审查。

## 7. 当前横向差距分级

### P0：不解决就禁止生产数据进入

- 硬编码演示身份、内存会话、Cookie/CSRF/登录防爆破体系不完整。
- SQLite 运行时自动建表且把领域状态存成 JSON；无正式迁移、租户表、对象存储和字段化领域模型。
- Python `/tools/{slug}/run` 可被直接访问，全部 CPU/网络任务同步执行。
- Python 代码运行器只有 AST 黑名单和同机 subprocess；不存在安全沙箱。
- 无耐久任务队列、幂等、取消、资源配额、死信和失败恢复。
- 文件通过 JSON/data URL/base64 传输；无 MIME 探测、病毒扫描、总大小限制、对象存储和保留策略。
- 无不可变审计、统一 OpenAPI/错误码、结构化日志、指标、追踪、告警、SLO、备份恢复演练。
- 绝大多数工作台是共享动态表单，缺少领域专用界面、真实图表和大数据交互。

### P1：试点上线前必须完成

- 每个工作台字段化 schema、状态机、审批、版本、导入导出和领域基准。
- 外部运行时适配器、连接健康、超时/熔断/速率限制、凭据管理和数据出境记录。
- 搜索、分页、过滤、批处理、通知、并发冲突处理、无障碍和中英文。
- 权限矩阵、契约/E2E/负载/安全/迁移测试和 CI 发布门禁。

### P2：规模化运营前完成

- 多区域/容灾、容量自动扩展、冷热分层、成本归集、管理员运营工具、合规报表和年度访问复核。
- 科学算法黄金数据集、跨实现复现、漂移监测和模型卡/数据卡持续治理。

## 8. 重构实施顺序与完成定义

1. **平台地基**：OIDC、租户、OpenFGA/RBAC、PostgreSQL migrations、对象存储、审计、Temporal、OpenTelemetry、统一 API 契约。
2. **文件和计算底座**：分片上传/扫描/派生、Worker sandbox、任务状态/进度/取消、算法注册表和产物血缘。
3. **第一批高风险工作台**：Python 实验/AI 评测、项目提交、知识系统、作业；先消除代码执行和文件处理风险。
4. **第二批科研计算**：遥感、地震、背景噪声、研究雷达、论文和专利；用黄金数据集验证科学正确性。
5. **第三批工程接入**：NiFi、监测告警、UAV、多源融合、应急；必须连接真实沙箱环境做故障演练。
6. **其余教学与协作**：完整题库、Python English、项目空间、数据清洗、报告、讨论和管理台。
7. **企业验收**：功能矩阵 100% 有自动或人工验收证据；P0/P1 为零；权限负面测试、恢复演练、负载/渗透、SBOM/许可证、安全和运维文档通过。

单个工作台只有同时满足以下条件才允许标记“完成”：真实输入可导入；核心算法或外部服务真实执行；领域专用界面和图表可用；字段化数据和租户权限正确；每个关键动作可审计；版本/审批/导出完整；故障可恢复；基准、权限、契约和端到端测试通过；运维和许可证材料齐备。
