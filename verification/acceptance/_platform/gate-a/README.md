# Gate A 基线冻结证据

状态：进行中。此目录只保存可复现的基线与验收证据，不代表 Gate A 已全部完成。

## 已冻结

- 原卡片版提交必须为 `8a754dcdb8ab97c7a90ca588693a17b21ee1f41b`，且工作区必须干净。
- 32 个 HTML 入口，其中 31 个正式功能入口、1 个兼容跳转。
- 20 个真实工作台：教学 8、科研 9、工程 3。
- 9 张工程占位卡，与真实工作台分开统计。
- 旧浏览器数据根、导出 schema 源码位置、全部跟踪文件 SHA-256。
- 旧版 `node --test` 的完整 TAP 输出与 109/109 结果。
- 总清单、生产蓝图和两份用户提供文档的 SHA-256。
- 32 个入口的 1440×1000 Edge 截图、截图 SHA-256 清单，以及静态 DOM/字段/动作 token 清单。
- 首版目标 OpenAPI、领域/ER 模型、权限矩阵、威胁模型和领域事件目录。
- 15 个初始文本/安全格式样例与 8 组旧版兼容黄金期望。
- React/npm、Go modules 和 Python 直接 requirements 的 CycloneDX 源码依赖清单。
- `verification/verify-gate-a.ps1` 实时重跑旧版 109 项测试并校验以上 Gate A 交付物。

## 生成文件

- `00-manifest/baseline-manifest.json`：基线总索引与证据哈希。
- `01-legacy-baseline/tracked-files.sha256`：旧仓库全部跟踪文件哈希。
- `01-legacy-baseline/routes.json`：旧入口到 React 正式路由的映射。
- `01-legacy-baseline/engineering-placeholders.json`：9 张仅占位工程卡。
- `01-legacy-baseline/storage-roots.json`：需要验证/迁移/丢弃的浏览器数据根。
- `01-legacy-baseline/schema-occurrences.json`：导入导出 schema 的源码出现位置。
- `01-legacy-baseline/page-assets.json`：32 个旧页面引用的样式、脚本和外部资源。
- `01-legacy-baseline/test-files.json`：旧版 27 个测试文件。
- `01-legacy-baseline/approved-checklist-v1.md`：用户确认时的清单不可变快照。
- `01-legacy-baseline/FUNCTION_TRACEABILITY.md`：旧页面/源码/存储/测试到 React、Go、Python/外部运行时的逐项追踪矩阵。
- `01-legacy-baseline/legacy-tests.tap`：旧版完整测试记录。
- `01-legacy-baseline/legacy-test-summary.json`：旧版测试摘要。
- `12-supply-chain-license/source-documents.json`：清单、蓝图、需求与开源映射的文件哈希。
- `03-api-and-data/target-openapi.yaml`：设计态目标契约；不替代已实现 API 契约。
- `03-api-and-data/TARGET_DOMAIN_MODEL.md`：ER、聚合、状态机和约束基线。
- `03-api-and-data/FIELD_GROUP_TRACEABILITY.md`：字段组到 React、Go、Python/外部运行时和测试族的追踪。
- `02-requirements/DECISION_STATUS.md`、`ARCHITECTURE_REVIEW.md`：暂定设计默认值、未决业务决策和评审状态。
- `04-permissions/PERMISSION_MATRIX.md`：角色、资源关系和负向测试矩阵。
- `05-audit-and-provenance/DOMAIN_EVENT_CATALOG.md`：领域事件、最小载荷与幂等规则。
- `09-tests/FORMAT_FIXTURE_REGISTER.md` 与 `fixtures/`：格式边界和首批测试样例。
- `10-visual-a11y/visual-manifest.json`、`legacy-dom-fields.json`：视觉和字段基线索引。
- `11-security-recovery/THREAT_MODEL.md`：信任边界与 STRIDE 风险登记。
- `12-supply-chain-license/THIRD_PARTY_LOCK_REGISTER.md`：直接依赖、参考仓库和待决法务项。
- `12-supply-chain-license/REFERENCE_SELECTION.md`：20 个工作台的主参考/主运行时收敛结果。
- `12-supply-chain-license/*.cdx.json`：当前源码锁文件可解析范围内的 CycloneDX 清单。

这些生成文件由 `verification/freeze-card-baseline.ps1` 创建。脚本会在提交不一致、旧仓库有未提交修改、入口数量变化或 109 项旧测试失败时拒绝冻结；已有基线默认不可覆盖。`verification/verify-card-baseline.ps1` 用于日常只读验证。

## Gate A 仍待完成

- 32 个截图已生成，但 T04/T05 等初始化/加载状态需重拍；主要交互录像、角色态和移动/平板视觉基线仍缺。
- 文本/安全样例已起步；Office、ZIP、GeoTIFF、miniSEED 等二进制及领域格式尚未达到“每类三样例”。
- 页面级全链追踪已完成；逐字段 request/response、数据库列、迁移与测试映射随各纵向切片补齐。
- 已锁旧版直接依赖与 6 个明确上游 commit，并生成源码依赖 SBOM；其余参考 commit、生产镜像 digest、完整传递依赖/镜像 SBOM、SCA 和法务状态未锁。
- OpenAPI、ER/聚合、权限、威胁和事件首版已输出并通过结构校验；仍需架构/安全/领域负责人评审签字。
- 真实科学黄金数据、算法公差、数据许可和领域签字人尚未取得。
