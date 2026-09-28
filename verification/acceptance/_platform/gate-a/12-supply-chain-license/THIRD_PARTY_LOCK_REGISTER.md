# Gate A 第三方版本、许可证与使用边界登记

状态：进行中。已把旧版实际运行依赖和已有明确 commit 的研究来源锁定；缺少上游 commit、容器 digest 或法务批准的条目保持阻塞，不得写成“已集成/已批准”。

## 可复现依赖入口

| 组件面 | 锁定文件 | SHA-256 | 当前结论 |
|---|---|---|---|
| React/npm | web_react/package-lock.json | C7074CE0C8CBB2D2F831CCA9D423800FFA2DC5FE75B86BABDCBA937E7354941C | npm tarball/version/integrity 已锁；已生成 lockfile CycloneDX，尚缺签名、镜像 SBOM 和 SCA 报告 |
| Go modules | backend_go/go.mod + go.sum | D18CA6BF285AFF258AAD07F3E9DC5340AFED42953CDC67480463125717700A78 / A877FBF319FF1A61365B08E34B62BF34AF38606226A0FEF1D1C81AF7FDCAC3E7 | 版本与 checksum 已锁；已生成 go.mod 组件 CycloneDX，尚缺签名、构建/镜像 SBOM 和 SCA 报告 |
| Python | backend_python/requirements.txt | 3987E02F925DD3BC326224D27353A1E6BC9512A222BAF07AB04881639CD90E73 | FastAPI 0.141.1、Uvicorn 0.52.4 已精确锁；已生成直接 requirements CycloneDX，仍缺 hash lock、已解析传递依赖和完整科学依赖 |
| 基础设施 | infra/compose.foundation.yml | 53D0087991C9EF9C4208C87A9771B9E8B58E950FC14BF1384266735346B649E0 | 文件已锁但镜像 digest 故意为空；生产启动前必须批准并填入 |
| 旧版 notices | OPEN_SOURCE_NOTICES.md | D4C97ABD3828006F66A24196EBEFBF6FDFED259EB089F8375C2C65A4B316DDB1 | 绑定旧提交；完整跟踪文件哈希见 tracked-files.sha256 |

## 原卡片版直接运行依赖

| 依赖 | 锁定版本/commit | 许可证记录 | 使用边界 | 状态 |
|---|---|---|---|---|
| Three.js | r160 / 0.160.0 | MIT | 首页 WebGL；React lock 实际解析为 0.160.0 | 已锁，待 SCA |
| Skulpt | 1.2.0 | MIT | 旧浏览器 Python；新架构仅兼容评估 | 已锁，替换/保留待 T01 评审 |
| Pyodide | 0.28.3 CDN 路径 | MPL-2.0 等多组件条款待核 | T01 明确的浏览器本地运行模式 | 版本已锁，供应/离线/NOTICE 待审 |
| Papa Parse | 5.5.4 | MIT | CSV/TSV 浏览器解析 | 已锁，生产不可信大文件转服务端隔离 |
| SheetJS CE | 0.20.3 | Apache-2.0 记录 | XLS/XLSX 旧版解析/导出 | 已锁，来源与分发方式待法务复核 |
| JSZip | 3.10.1 | MIT 或 GPL-3.0-or-later | ZIP/DOCX/PPTX 处理 | 已锁；生产按 MIT 许可文本复核，解析转隔离环境 |
| PDF.js | 6.2.108 | Apache-2.0 | PDF 文本抽取 | 已锁，解析转隔离环境 |
| Mammoth | 1.12.0 | BSD-2-Clause | DOCX raw-text 抽取 | 已锁，外链/资源禁用并隔离 |
| MiniSearch | 7.2.0 | MIT | R06 本地前缀/模糊检索 | 已锁；正式检索方案另评审 |
| geotiff.js | 3.0.5 | MIT | R02 浏览器 GeoTIFF 预览 | 已锁；正式科学计算转 Python |
| Seisplotjs | 3.2.7 | MIT | R03 miniSEED 浏览器解析/预览 | 已锁，连同传递依赖复核 |
| Luxon | 3.7.2 | MIT | Seisplotjs 传递依赖 | 已锁 |
| OregonDSP | 1.3.1 | LGPL-3.0 | Seisplotjs 的 Steim 解压传递代码 | 已锁；动态/打包边界与 NOTICE 待法务 |
| Monaco Editor | 0.44.0 | MIT | T07 源码编辑器 | 已锁；React 迁移版本升级需重新做视觉/快捷键基线 |
| WebLLM | npm 0.2.84；研究 commit 90f67096b68d3b77509c938f2221e4cef03b7d76 | Apache-2.0 | T05 可选本地 WebGPU；模型权重单独许可 | 已锁；生产默认不远程加载未批准模型 |
| Patent-assistant | 7123187a1e071b402c4e87ff6d2ce8d1aff825e4 | MIT | E03 有源代码适配/署名边界 | 已锁；保留 LICENSE/NOTICE |

## 已锁定的参考仓库

这些条目用于流程或界面研究；除明确列在“直接运行依赖”的项目外，不复制源码、图片、品牌或构建产物。

| 参考 | 锁定 commit | 许可证/边界 | 状态 |
|---|---|---|---|
| 2EZ-exam | 333427c5080ddbebb8d70198df653173876fb0f9 | README 称 MIT，但该 commit 无根 LICENSE；只参考公开流程 | 已锁，禁止复制源码 |
| Judge0 Core | aca5e2bbfa6bd27ccaf577ebddb9d04a37bd2773 | GPL-3.0；只作独立隔离服务 | 已锁，部署法务待审 |
| Judge0 IDE | 4e0e7a4bfe3217e07f4a88967bc7d4837b8e38c0 | MIT；只参考交互 | 已锁 |
| Academic Research Skills | a29f30f58123fba630dd59f2ead7f50da98c812d | CC BY-NC 4.0/source-available；仅研究参考，商业环境不复制 | 已锁，商业法务硬门禁 |
| Patent-assistant | 7123187a1e071b402c4e87ff6d2ce8d1aff825e4 | MIT；E03 适配 | 已锁 |
| WebLLM | 90f67096b68d3b77509c938f2221e4cef03b7d76 | Apache-2.0；运行包另锁 0.2.84 | 已锁 |

## 尚未锁定的参考与外部服务

下列只冻结了官方仓库/文档 URL 或产品选择，尚无经审查的 commit/tag/digest，因此 Gate A 供应链项仍不可勾选：

- JupyterLab/JupyterLite、H5P、OpenRefine、Uppy、QGIS、GDAL、Earth Engine 文档、SNAP、OpenDroneMap、ResQ-Sentinel。
- ObsPy、SciPy、FDSN miniSEED、SeisBench、NoisePy、MSNoise、SeisLib。
- Patent2Net、PatentsView、python-epo-ops-client、Agent Skills、skill-up、Promptfoo、Langfuse、NVIDIA Skills、Refly、Dify、Flowise。
- RAGFlow、AnythingLLM、Khoj、Open WebUI、Mem0、Zotero、Open Knowledge Maps、Dagster、Prefect、Plane。
- Crossref、OpenAlex、Semantic Scholar 的 API 条款、配额、缓存和署名版本。
- PostgreSQL、Keycloak、OpenFGA、Temporal、MinIO、OpenTelemetry Collector 和 NiFi 的生产镜像 digest。

20 个工作台的收敛后主参考见 REFERENCE_SELECTION.md；它用稳定 tag/已知 commit 关闭了 JupyterLite、H5P Question Set、Plane、OpenRefine、Uppy、QGIS、RAGFlow、NiFi 和 NoisePy 等泛候选中的主要版本缺口，同时明确保留 R03、R04、R05、R07/R08 和生产镜像 digest 的阻塞状态。

源码依赖清单位于 `sbom/`：React/npm SBOM 来自项目 lockfile；Go SBOM来自 `go.mod` 精确模块；Python SBOM来自直接 `requirements.txt`。它们用于 Gate A 源码冻结与差异检测，不等同于生产制品、容器镜像或运行环境的完整传递依赖清单。

## 强制处置

1. 参考仓库必须记录“参考”或“运行”，禁止把研究过的仓库写成已集成。
2. 生产容器只允许 registry/repository@sha256:digest；tag 不构成锁定。
3. 每次依赖升级必须更新 SBOM、SCA、许可证差异、兼容/视觉/科学回归和回滚记录。
4. GPL/AGPL/LGPL/CC BY-NC 与模型权重、数据集许可证必须由法务对真实部署方式给出书面结论。
5. Critical/High 漏洞、缺失来源/许可、不可验证签名或不可重现构建均保持 NO-GO。
