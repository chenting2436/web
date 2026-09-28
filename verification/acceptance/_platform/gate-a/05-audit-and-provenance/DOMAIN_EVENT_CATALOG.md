# Gate A 领域事件目录

状态：首版事件基线。事件只携带标识、版本和必要状态，不携带正文、密钥、隐藏用例或大对象。所有事件使用 UUID event_id、UTC occurred_at、tenant_id、actor 摘要、request_id、aggregate_id、aggregate_version、schema_version 和 trace_id。

| 事件 | 生产者 | 触发条件 | 主要消费者 | 敏感载荷规则 |
|---|---|---|---|---|
| identity.user_linked.v1 | identity | 首次 OIDC 身份绑定同事务完成 | audit、profile | 仅 provider/subject 摘要，不含 token |
| identity.session_revoked.v1 | identity | 单会话或全设备撤销 | session cache、audit | 不含 cookie/refresh token |
| authorization.relationship_changed.v1 | membership | 成员/角色/项目关系改变 | OpenFGA relay、reconciler | 仅 tuple 标识和版本 |
| entitlement.changed.v1 | entitlements | 授予、过期、撤销或策略发布 | catalog cache、notification | 不含支付信息 |
| discussion.message_created.v1 | discussions | 消息与审计同事务提交 | notification、search | 只含 message_id 和 mention IDs |
| discussion.status_changed.v1 | discussions | resolved/reopened/moderated | notification、audit | 不携带正文 |
| assignment.published.v1 | assignments | draft 新版本正式发布 | notification、calendar | 资源说明由授权读取 |
| submission.submitted.v1 | submissions | 不可变提交版本建立 | teacher queue、preflight | 附件只含 artifact_id |
| grade.published.v1 | grading | 成绩发布或修正 | notification、analytics | 不含反馈正文和隐藏用例 |
| file.upload_completed.v1 | files | 分片完成并校验哈希 | malware scan | 仅 file_id、size、mime candidate、hash |
| file.scan_completed.v1 | scanner | 扫描终态写入 | file service、audit | 不含恶意样本内容 |
| import.validated.v1 | import service | 格式/schema/安全预检完成 | UI notification、commit orchestrator | 错误只含稳定码与位置 |
| import.committed.v1 | import service | 事务提交并生成对账单 | audit、migration report | 仅计数、manifest_id、hash |
| export.ready.v1 | export service | 产物写入对象存储并封存 | notification | 不含签名 URL |
| project.version_created.v1 | projects | 不可变快照完成 | search、audit | 只含 version/artifact references |
| job.queued.v1 | Go control plane | 业务命令与 outbox 同事务 | Temporal starter | 参数以受控 job_input_ref 提供 |
| job.started.v1 | worker orchestration | 有效 lease/fence 获得 | telemetry、UI stream | 不含 worker credential |
| job.progressed.v1 | worker orchestration | 节流后的进度 checkpoint | UI stream、telemetry | 只含百分比、阶段和稳定状态码 |
| job.succeeded.v1 | worker orchestration | 终态与产物引用原子提交 | domain projector、notification | 仅 result/artifact hash 与算法版本 |
| job.failed.v1 | worker orchestration | 稳定失败终态提交 | notification、DLQ policy | 诊断正文进受权产物，事件只含错误码 |
| job.cancelled.v1 | worker orchestration | 取消 fence 生效 | domain projector、audit | 不含用户输入 |
| knowledge.document_indexed.v1 | knowledge worker | 索引版本封存 | search alias switch | 仅 document/index version/hash |
| radar.alert_raised.v1 | radar | 监测规则匹配且去重成功 | notification、transfer queue | 摘要最小化，正文授权后读取 |
| workflow.version_published.v1 | automation | 审批后的版本发布 | Temporal registry、audit | Secret 仅 secret_ref |
| workflow.approval_requested.v1 | automation | 人工门节点到达 | notification | 不含输入正文 |
| dataflow.deployment_changed.v1 | NiFi adapter | 真实部署状态回读 | UI、audit | 必须含 environment 和 upstream revision |
| science.result_quality_checked.v1 | science worker | 自动 QC 指标完成 | reviewer queue | 指标/单位可带，原始数据用 artifact_id |
| science.result_approved.v1 | reviewer | 领域专家人工批准 | publication/export | 含批准者、方法/结果版本和理由引用 |
| disclosure.review_changed.v1 | patent domain | 内审/法务审查状态变化 | notification、audit | 评论正文由授权读取 |
| audit.checkpoint_signed.v1 | audit service | 增量 checkpoint 封存 | WORM archive、SIEM | 只含 scope/range/root/signature reference |

## 投递与演进规则

- 事件和业务行必须由同一 PostgreSQL 事务写入；禁止先发消息后写数据库。
- relay 至少一次投递；消费者以 consumer + event_id 去重，副作用使用供应商支持的幂等键。
- 同一 aggregate 依 aggregate_version 拒绝倒序覆盖；跨 aggregate 不承诺全局顺序。
- schema 只做向后兼容增加；破坏性变更发布新事件名版本，并保留双读/回放窗口。
- 事件保存数据分类和 retention_class；删除业务正文不破坏必要审计，但事件不得成为正文副本。
- DLQ 必须告警、可重放、可审计；重放不生成新的业务事实，只补投原 event_id。

