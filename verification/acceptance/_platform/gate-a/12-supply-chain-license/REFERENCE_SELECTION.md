# 20 个工作台的主参考选择

冻结日期：2026-09-08。原则是每个模块只保留一个主要产品/流程参考和必要的直接运行依赖；参考项目不复制源码、品牌、截图或数据。版本事实来自对应官方 GitHub 仓库/Release；没有稳定 tag 或无法取得完整 commit 的条目保持 pending。

| 追踪 | 主参考或运行依赖 | 锁定点 | 用途 | 边界 | 状态 |
|---|---|---|---|---|---|
| T01 | JupyterLite / Pyodide | JupyterLite v0.7.5；Pyodide 0.28.3 | 文件、kernel、浏览器运行流程 | JupyterLite 只参考；Pyodide 是可选本地运行依赖 | LOCKED |
| T02 | H5P Question Set | library 1.21.13 | 逐题、反馈、进度 | 只参考交互；题库与引擎自研 | LOCKED |
| T03 | Plane | v1.4.0 | 项目、看板、活动 | AGPL 项目只参考信息架构 | LOCKED |
| T04 | OpenRefine | 3.10.1 | 导入、facet、操作历史、undo/redo | 只参考；解析/清洗能力自研并在 Python 隔离 | LOCKED |
| T05 | WebLLM | 0.2.84；commit 90f67096b68d3b77509c938f2221e4cef03b7d76 | WebGPU/Worker/流式本地模型 | 直接运行可选；模型权重另行许可 | LOCKED |
| T06 | 2EZ-exam | 333427c5080ddbebb8d70198df653173876fb0f9 | 学习模式、XP、考试 | 仅参考；该 commit 根 LICENSE 缺失，不复制源码 | LOCKED |
| T07 | Judge0 Core / IDE | aca5e2bbfa6bd27ccaf577ebddb9d04a37bd2773 / 4e0e7a4bfe3217e07f4a88967bc7d4837b8e38c0 | 隔离判题协议 / IDE 交互 | Core 独立服务；IDE 只参考；隐藏用例只在服务端 | LOCKED |
| T08 | Uppy | 5.2.4 | 上传列表、校验、进度 | 只参考；是否直接引入由 bundle/安全评审决定 | LOCKED |
| R01 | Academic Research Skills | a29f30f58123fba630dd59f2ead7f50da98c812d | 十阶段、人审 checkpoint | CC BY-NC，仅研究参考，商业部署不复制 | LOCKED |
| R02 | QGIS / geotiff.js | QGIS 4.2.0；geotiff.js 3.0.5 | GIS 信息架构 / 浏览器预览 | QGIS GPL 只参考；正式算法在 Python | LOCKED |
| R03 | ObsPy | stable tag/commit 待领域环境确认 | 波形、谱、trigger、pick 语义 | Python 计划依赖，必须与黄金 miniSEED 一起锁 | PENDING |
| R04 | Patent2Net P2N | 仓库已归档；完整 commit 待冻结 | 专利数据与分析流程 | 只参考；任何法律结论人工批准 | PENDING |
| R05 | Agent Skills specification | 完整 commit 待冻结 | SKILL.md、resources、progressive disclosure | 只参考开放规范；运行器自研并隔离 | PENDING |
| R06 | RAGFlow | v0.27.1 | 文档、chunk、检索、引用、评测 | 只参考；不嵌入其服务/代码 | LOCKED |
| R07 | Open Knowledge Maps Headstart | 完整 commit 待冻结 | 主题图、发现与证据浏览 | 只参考视觉/流程 | PENDING |
| R08 | R07 共用主参考 + 原版矿山 taxonomy | 与 R07 同锁 | 独立矿山模式 | 数据空间、权限、索引和告警必须与 R07 隔离 | PENDING |
| R09 | Temporal | 生产镜像 digest 待目标 registry | 耐久工作流、重试、审批、恢复 | 真实运行依赖；tag 不足以放行 | PENDING-DIGEST |
| E01 | Apache NiFi | 2.10.0 | Processor、queue、provenance、lineage | 独立服务；浏览器预览不得标为真实部署 | LOCKED-TAG |
| E02 | NoisePy | v0.9.93 | 环境噪声处理与相关流程 | Python 计划依赖；镜像/科学黄金集仍待锁 | LOCKED-TAG |
| E03 | Patent-assistant | 7123187a1e071b402c4e87ff6d2ce8d1aff825e4 | 十章节、图示、版本和导出 | MIT 有源适配，保留许可证与署名 | LOCKED |

## 官方来源

- https://github.com/jupyterlite/jupyterlite/releases
- https://github.com/h5p/h5p-question-set
- https://github.com/makeplane/plane/releases
- https://github.com/OpenRefine/OpenRefine/releases
- https://github.com/mlc-ai/web-llm
- https://github.com/dvrone/2EZ-exam
- https://github.com/judge0/judge0 与 https://github.com/judge0/ide
- https://github.com/transloadit/uppy/releases
- https://github.com/Imbad0202/academic-research-skills
- https://github.com/qgis/QGIS
- https://github.com/obspy/obspy
- https://github.com/Patent2net/P2N
- https://github.com/agentskills/agentskills
- https://github.com/infiniflow/ragflow/releases
- https://github.com/OpenKnowledgeMaps/Headstart
- https://github.com/temporalio/temporal
- https://github.com/apache/nifi/releases
- https://github.com/noisepy/NoisePy/releases
- https://github.com/Dyp130/Patent-assistant

## 未关闭原因

R03、R04、R05、R07/R08 缺完整 commit；R09 和所有生产基础设施缺目标 registry 的镜像 digest。即使标为 LOCKED 的参考项目也仍需 SBOM/SCA 与法务结论，因此 Gate A 的供应链总项继续保持未勾选。
