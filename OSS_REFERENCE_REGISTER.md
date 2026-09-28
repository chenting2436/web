# SkyViewLab 开源参考与集成登记册

更新日期：2026-09-07  
用途：为生产重构固定“借鉴什么、怎么用、哪些不能复制”。最终集成前必须锁定 commit/tag，由法务和安全团队复核许可证、NOTICE、CVE、镜像来源和数据条款。

## 使用分类

- **选用**：计划作为生产组件、SDK 或协议接入。
- **独立服务**：通过受控 API 部署，SkyViewLab 不复制其源码到闭源模块；需履行对应网络分发/修改义务。
- **工作流参考**：只学习公开功能和信息架构，React/Go/Python 独立实现，不复制代码、文案、提示词、资产或品牌。
- **排除**：不作为生产底座。

## 平台底座

| 项目 | 决策 | 用途 | 边界/许可证关注 |
| --- | --- | --- | --- |
| [Keycloak](https://github.com/keycloak/keycloak) | 选用/独立服务 | OIDC/SAML、MFA、身份联合、会话和管理 | Apache-2.0；生产加固、主题和升级策略单独验收 |
| [OpenFGA](https://github.com/openfga/openfga) | 选用/独立服务 | tenant/workspace/project/artifact 细粒度授权 | Apache-2.0；授权模型版本和一致性策略需测试 |
| [Temporal](https://github.com/temporalio/temporal) | 选用/独立服务 | 耐久工作流、重试、恢复、计时器和人工等待 | 固定版本复核许可证；Go/Python Worker 分离部署 |
| [OpenTelemetry Go](https://github.com/open-telemetry/opentelemetry-go) | 选用 | Go/Python/队列/数据库端到端 trace、metric、log 关联 | Apache-2.0；遥测数据需脱敏和保留治理 |
| [pgvector](https://github.com/pgvector/pgvector) | 选用 | PostgreSQL 内可选向量检索 | PostgreSQL License；规模阈值后再评估专用向量库 |
| [Uppy](https://github.com/transloadit/uppy) | 选用 | React 分片、断点续传和上传队列 | MIT；后端仍须自建 ACL、扫描、配额和对象生命周期 |

## 科研工作台

| 工作台 | 首选项目 | 决策 | 计划使用范围 | 许可证/风险结论 |
| --- | --- | --- | --- | --- |
| 论文发布 | [Manubot](https://github.com/manubot/manubot) | 选用/独立构建 Worker | 标识符引用、CSL/Pandoc、版本化 HTML/PDF 发布 | BSD-2-Clause-Patent；保留 NOTICE，TeX/Pandoc/模板另审 |
| 论文写作 | [Academic Research Skills](https://github.com/Imbad0202/academic-research-skills) | 工作流参考 | 十阶段、人审关卡、证据与诚信治理 | CC BY-NC 4.0；商业生产不可直接复制内容或实现 |
| 论文/文献 | [Zotero](https://github.com/zotero/zotero) | 独立服务/API/工作流参考 | 文献元数据、集合、BibTeX/RIS/CSL 交换 | AGPL；优先官方 API/交换格式，不内嵌源码 |
| 遥感 | [SamGeo](https://github.com/opengeos/segment-geospatial) | 可选 Python Worker | GeoTIFF/COG 分割、GeoJSON/vector 产物 | MIT；模型权重和数据集许可证另审 |
| 遥感/GIS | [QGIS](https://github.com/qgis/QGIS) | 独立服务/工作流参考 | 空间 QA、制图、处理模型和结果复核 | GPL-2.0+；不复制界面或代码进闭源 React |
| 摄影测量 | [OpenDroneMap](https://github.com/OpenDroneMap/ODM) | 独立服务 | 正射、DSM、点云、模型产物 | AGPL；经 API 集成，修改和部署义务由法务确认 |
| 地震 | [ObsPy](https://github.com/obspy/obspy) | 选用 Python Worker | miniSEED/SAC/StationXML/QuakeML、信号处理、FDSN | LGPL-3.0；动态依赖、NOTICE 和修改边界留档 |
| 地震前端 | [Seisplotjs](https://github.com/crotwell/seisplotjs) | 可选选用 | 波形、时间窗和 miniSEED 浏览器可视化 | MIT；固定版本并审计 OregonDSP 等传递依赖 |
| 地震 ML | [SeisBench](https://github.com/seisbench/seisbench) | 可选独立服务 | 学习式震相拾取、模型和评测基准 | GPL-3.0；模型权重、训练数据和模型卡分别审核 |
| 专利数据 | [python-epo-ops-client](https://github.com/ip-tools/python-epo-ops-client) | 可选 SDK | EPO OPS 适配 | Apache-2.0；仍需 OPS 账户、限流和数据使用条款 |
| 专利分析 | [Patent2Net v3](https://github.com/Patent2net/P2N-v3) | 工作流参考/可选独立工具 | 同族、景观、网络和检索流程 | CeCILL-B；法务确认兼容边界后才可集成 |
| Skill | [Agent Skills specification](https://github.com/agentskills/agentskills) | 规范参考 | SKILL.md 结构、渐进披露和互操作 | 代码 Apache-2.0、文档 CC BY 4.0；规范版本必须固定 |
| Skill 评测 | [Promptfoo](https://github.com/promptfoo/promptfoo) | 可选独立服务/CLI | 数据集、断言、回归和红队 | MIT；自定义脚本/provider 不视为沙箱，禁止在 API 进程执行 |
| Skill 追踪 | [Langfuse](https://github.com/langfuse/langfuse) | 可选独立服务 | trace、dataset、experiment、eval 和 prompt 版本 | 核心 MIT、`ee/` 非开源；不能把企业能力冒充 OSS |
| 研究自动化 | [Dagster](https://github.com/dagster-io/dagster)、[Prefect](https://github.com/PrefectHQ/prefect) | 工作流参考/可选适配 | 资产血缘、运行可视化、任务模式 | Apache-2.0；平台耐久编排仍统一使用 Temporal |
| 知识系统 | [RAGFlow](https://github.com/infiniflow/ragflow) | 可选独立服务 | 解析、检索、引用问答和评测流程 | Apache-2.0；模型、OCR、解析器各自许可证另审 |
| 知识系统 | [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | 工作流参考/可选独立服务 | 工作区、材料、模型适配交互 | 仓库 MIT，但自托管/商业条款和附加组件需逐项确认 |
| 研究地图 | [Open Knowledge Maps](https://github.com/OpenKnowledgeMaps) | 工作流参考 | 主题聚类、证据地图和文献探索 | 固定子仓库后逐一复核许可证，不复制品牌/UI |
| 背景噪声 | [NoisePy](https://github.com/noisepy/NoisePy) | 选用 Python Worker | 预处理、互相关、叠加、监测和频散流程 | MIT；科学结果需与基准数据独立验证 |
| 背景噪声 | [MSNoise](https://github.com/ROBelgium/MSNoise)、[SeisLib](https://github.com/fmagrini/seislib) | 参考/交叉验证 | dv/v、层析和科学交叉复现 | MSNoise 为 EUPL-1.1，优先独立服务；SeisLib 固定版本后复核 |
| 科学动画 | [ManimGL](https://github.com/3b1b/manim) | 工作流参考/可选隔离渲染 Worker | 程序化场景、交互预览、相机、三维和 Python 交付脚本 | MIT；当前 React/Python 为 clean-room 独立实现，不复制界面、品牌、示例资产或源码；正式接入需固定版本并单独审查 FFmpeg/OpenGL/LaTeX 依赖 |

## 工程工作台

| 工作台 | 首选项目 | 决策 | 计划使用范围 | 许可证/风险结论 |
| --- | --- | --- | --- | --- |
| 数据网关 | [Apache NiFi](https://github.com/apache/nifi) | 选用/独立服务 | 流程、队列、背压、连接器、provenance/lineage/replay | Apache-2.0；不重复自研执行引擎，SkyViewLab 管理引用和权限 |
| 监测预警 | [ThingsBoard](https://github.com/thingsboard/thingsboard) | 独立服务/工作流参考 | 设备、遥测、规则链、告警和 dashboard 模式 | Community 代码 Apache-2.0；Professional/Cloud 功能另行采购和审查 |
| UAV | [WebODM](https://github.com/WebODM/WebODM) | 独立服务 | 任务、影像、ODM 作业和成果访问 | AGPL；API 集成且保留独立品牌/部署边界 |
| 多源地图 | [Kepler.gl](https://github.com/keplergl/kepler.gl) | 可选 UI 组件/参考 | 大规模时空数据探索 | 固定版本复核许可证；业务地图仍需权限裁剪 |
| 应急 | [Ushahidi Platform](https://github.com/ushahidi/platform) | 独立服务/工作流参考 | 信息收集、核验、地理定位和发布流程 | AGPL-3.0；不复制源码进闭源服务 |
| 应急 | [Sahana Eden](https://github.com/sahana/eden) | 工作流参考 | 事件、资源、队伍、避难点和行动管理 | 固定版本后复核许可证；从领域需求重新建模 |
| 决策大屏 | [Grafana](https://github.com/grafana/grafana) | 独立服务/工作流参考 | 可观测 dashboard、告警和时间范围交互 | AGPL edition 边界需复核；业务审批仍由 SkyViewLab 负责 |
| 边坡稳定 | [PySlope](https://github.com/JesseBonanno/PySlope) | 算法参考/可选 Worker | Bishop 切片法、材料、水位、荷载、滑面搜索和图形 | MIT；方法范围有限，必须用规范案例和其他实现交叉验证 |
| 微震三维 | [PyVista](https://github.com/pyvista/pyvista) | 选用 Python 可视化 Worker | 点、面、体和网格的三维科学可视化 | MIT；浏览器交付使用标准化 3D 产物，不暴露 Worker |
| 点云处理 | [PDAL](https://github.com/PDAL/PDAL) | 选用/独立 Worker | LAS/LAZ 读取、过滤、转换和 pipeline | 固定版本复核许可证；大文件必须流式/分块并限制资源 |
| 点云交换 | [Cesium 3D Tiles](https://github.com/CesiumGS/3d-tiles) | 规范参考 | 海量点云/三维地理内容的层级流式交换 | 开放规范；生成器、viewer 和托管服务各自许可证另审 |
| 位移预测 | [sktime](https://github.com/sktime/sktime) | 选用 Python Worker | 预测、回测、变化点、异常检测和统一模型接口 | BSD-3-Clause；软依赖和模型许可证逐个锁定 |

## 教学、协作与交付

| 工作台 | 首选项目 | 决策 | 计划使用范围 | 许可证/风险结论 |
| --- | --- | --- | --- | --- |
| Python 实验 | [JupyterLite](https://github.com/jupyterlite/jupyterlite) | 选用/嵌入或独立前端 | 浏览器 kernel、Notebook、文件和富输出 | BSD-3-Clause；与服务端沙箱是两种部署模式 |
| Python 实验 | [JupyterLab](https://github.com/jupyterlab/jupyterlab) | 信息架构与交互参考 | Notebook、文件、编辑器、终端、富输出和可组合工作区 | BSD-3-Clause；当前 React 外壳为独立实现，不复制其界面源码或品牌 |
| Python 实验 | [Monaco Editor](https://github.com/microsoft/monaco-editor) | 选用（前端组件） | Python 编辑、语法高亮、折叠、快捷键和多文件模型 | MIT；固定 0.56.0，Worker 独立打包，DOMPurify 覆盖到已修复版本 |
| Python 实验 | [xterm.js](https://github.com/xtermjs/xterm.js) | 选用（前端组件） | 终端渲染、CJK/IME、可访问输入和自适应尺寸 | MIT；固定 5.5.0，当前命令由浏览器工作区解释器白名单处理 |
| Python 实验 | [Pyodide](https://github.com/pyodide/pyodide) | 选用（轻量模式） | CPython/WASM、micropip 和浏览器文件系统 | MPL-2.0；浏览器 Web API 环境不是对抗性安全沙箱 |
| Python 实验 | [Jupyter Server](https://github.com/jupyter-server/jupyter_server) + [JupyterHub](https://github.com/jupyterhub/jupyterhub) + [KubeSpawner](https://github.com/jupyterhub/kubespawner) | 生产远程内核适配目标 | 多用户会话、Kernel REST/WebSocket、逐用户 Pod、卷与资源配额 | BSD-3-Clause；作为独立运行时接入，安全边界必须由 Spawner、Kubernetes、卷、镜像、配额和网络策略共同验收 |
| 日常练习 | [PrairieLearn](https://github.com/PrairieLearn/PrairieLearn) | 工作流与能力参考 | 参数化变体、自动判分、形成性练习与总结性考试分离、元数据驱动组卷 | AGPL-3.0；当前 React/Python 为 clean-room 独立实现，不复制题目、界面或服务端代码 |
| 日常练习 | [Oppia](https://github.com/oppia/oppia) | 自适应学习参考 | 学习路径、逐步反馈、按掌握度调整后续内容 | Apache-2.0；只借鉴产品机制，题库与推荐模型独立实现 |
| 日常练习 | [Open edX](https://github.com/openedx/openedx-platform) | 平台与内容编排参考 | CMS/LMS 分离、内容库、开放回答、学习记录与扩展式评测 | AGPL-3.0；不嵌入平台源码，后续如集成必须保持独立服务边界 |
| 日常练习 | [H5P Question Set](https://github.com/h5p/h5p-question-set) | 交互与信息架构参考 | 多题组合、题目导航、进度与反馈 | MIT；当前 React 练习台为 clean-room 独立实现，不复制 H5P UI 或内容 |
| 练习/作业 | [Moodle](https://github.com/moodle/moodle) | 独立服务/API/工作流参考 | 题库版本、随机题槽、作业、量规、成绩和课程权限 | GPL-3.0；不复制服务端代码进闭源 Go |
| 练习交换 | [1EdTech QTI](https://www.1edtech.org/standards/qti) | 标准参考/后续适配目标 | 题目、试卷、反馈、结果与内容包交换 | 开放行业标准；当前兼容纵切先保留卡片版 JSON，正式 QTI 往返需另做 conformance 验收 |
| 作业/提交 | [Submitty](https://github.com/Submitty/Submitty) | 独立服务/工作流参考 | 个人/团队提交、迟交、量规、人工/自动评分和成绩汇总 | BSD-3-Clause；执行学生代码仍必须强隔离 |
| 项目空间 | [Plane](https://github.com/makeplane/plane) | 独立服务/API/工作流参考 | 项目、任务、周期、看板、列表、时间线 | AGPL-3.0；API 接入或独立实现，禁止直接混入闭源前端 |
| 项目空间 | [OpenProject](https://github.com/opf/openproject) | 备选独立服务/参考 | WBS、board、timeline、角色和活动 | GPL-3.0；仅作独立服务或 clean-room 参考 |
| 数据清洗 | [OpenRefine](https://github.com/OpenRefine/OpenRefine) | 独立服务/工作流参考 | 导入、facet、操作历史、reconciliation 和导出 | BSD-3-Clause；可评估适配其服务或用 Arrow/DuckDB 独立实现 |
| 数据清洗 UI | [Perspective](https://github.com/finos/perspective) | 可选 React/WASM 组件 | 流式高密表、pivot、聚合和可视分析 | Apache-2.0；不能替代服务端治理、历史和权限 |
| AI 报告 | [WebLLM](https://github.com/mlc-ai/web-llm) | 可选选用 | WebGPU 本地模型、stream、worker 和 OpenAI-compatible API | Apache-2.0；模型权重、浏览器能力和 SRI 单独验收 |
| 报告发布 | [Quarto CLI](https://github.com/quarto-dev/quarto-cli) | 选用/独立构建 Worker | 引用、交叉引用、代码输出和 HTML/PDF/文档发布 | MIT；Pandoc、TeX、Jupyter、模板和用户代码分别隔离/审计 |
| AI 评测 | [Judge0 Core](https://github.com/judge0/judge0) | 选用/独立服务 | 多语言异步编译运行、verdict 和资源限制 | GPL-3.0；必须独立隔离部署，且采用已修复 [GHSA-q7vg-26pg-v5hr](https://github.com/judge0/judge0/security/advisories/GHSA-q7vg-26pg-v5hr) 的版本 |
| AI 评测 UI | [Judge0 IDE](https://github.com/judge0/ide) | 工作流参考 | 编辑器、输入输出和判题交互 | MIT；React 仍按 SkyViewLab 设计系统独立实现 |
| 项目提交 | [tusd](https://github.com/tus/tusd) | 选用/独立服务 | 可恢复分块上传 | 固定版本复核许可证；对象 ACL 和扫描由平台保证 |
| 讨论 | [Discourse](https://github.com/discourse/discourse) | 独立服务/API/工作流参考 | 线程、通知、审核、搜索和保留 | GPL-2.0；按独立服务边界使用 |
| 内部讨论 | [Zulip](https://github.com/zulip/zulip) | 备选独立服务/事件模型参考 | topic/thread、mention、unread、角色和搜索 | Apache-2.0；完整服务较重，集成时通过 API |

## 明确排除或限制

| 项目 | 结论 | 原因 |
| --- | --- | --- |
| [Flowise](https://github.com/FlowiseAI/Flowise) | 排除为生产底座 | 官方仓库已于 2026-08-13 归档；只保留历史产品研究价值 |
| [Dify](https://github.com/langgenius/dify) | 不作默认底座 | 使用带附加条件的 Dify Open Source License；如未来单独采用须先完成法务和架构评审 |
| [2EZ-exam](https://github.com/dvrone/2EZ-exam) | 仅工作流参考 | README 声称 MIT，但旧审计固定 commit 未发现根 LICENSE；课程内容也必须独立审核版权 |
| Academic Research Skills | 仅工作流参考 | CC BY-NC 限制与企业商业交付冲突，禁止直接复制内容、提示词和实现 |

## 集成验收规则

任何条目从“参考”进入“选用”前，必须同时提交：固定 commit/tag、许可证原文和 NOTICE、依赖树/SBOM、已知漏洞、数据流向、出境/遥测说明、权限模型、Secret 处理、升级/回滚、SLO、容量测试、故障降级和替换方案。缺一项不得进入生产制品。
