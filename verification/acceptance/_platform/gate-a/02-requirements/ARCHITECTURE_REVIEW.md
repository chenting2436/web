# Gate A 首版架构自审

评审日期：2026-09-08。结论：设计材料具备进入正式多人评审的完整结构，但由于业务参数、真实基础设施、科学数据、许可证和责任人未确认，Gate A 仍是 CONDITIONAL / NO-GO。

| 审查面 | 证据 | 自审结论 | 进入下一 Gate 前动作 |
|---|---|---|---|
| 功能事实 | 旧提交、32 入口、20 工作台、9 占位、109 测试 | 通过冻结 | 产品负责人核对截图/交互并签字 |
| 前后端边界 | target-openapi.yaml、TARGET_DOMAIN_MODEL.md | React → Go → Worker/外部边界明确 | 每个纵向切片替换通用设计 schema |
| 数据 | ER/聚合、状态机、RLS 规则 | 首版通过 | 真实 PG 迁移、约束、索引和回滚 |
| 权限 | PERMISSION_MATRIX.md | 角色 + 关系 + 状态 + 权益模型明确 | OpenFGA/RLS 正负矩阵与撤权 E2E |
| 安全 | THREAT_MODEL.md、format fixtures | 16 类主要威胁已登记 | 隔离、扫描、SSRF、秘密扫描与恢复演练 |
| 审计/任务 | DOMAIN_EVENT_CATALOG.md、现有审计/outbox 骨架 | 事务事件和最小载荷规则明确 | relay、checkpoint、WORM、Temporal |
| 科学质量 | GOLDEN_DATASET_REGISTER.md | 明确区分合成兼容与真实验证 | 取得真实数据、许可、公差和专家签字 |
| 供应链 | THIRD_PARTY_LOCK_REGISTER.md | 已知直接依赖/6 个 commit 已锁 | 补上游 commit、镜像 digest、SBOM/SCA/法务 |
| 视觉/可用性 | 32 截图、DOM/字段清单 | 捕获完成但审批未完成 | 重拍加载态，录角色交互和多视口 |

正式评审至少需要产品、后端、数据/算法、安全、运维和法务代表。任何单方“通过”都不能覆盖其责任域的未决项。
