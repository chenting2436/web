# Gate A 权限与租户隔离矩阵

状态：首版验收基线。角色只提供默认能力，最终决定必须同时检查 tenant、资源关系、状态、权益和字段规则。React 隐藏按钮不算授权。

## 角色

| 角色 | 默认范围 |
|---|---|
| anonymous | 仅公开首页、公开团队资料和 OIDC 入口 |
| student | 本人资料、本人课程、本人草稿/提交/进度和被邀请项目 |
| teacher | 被授权课程、课程学生、作业、评分和课程讨论 |
| project_member | 被邀请项目内按 viewer/editor/operator/reviewer 关系行动 |
| admin | 本组织成员、角色、权益、内容审核和配置；不能自动跨组织 |
| super_admin | 平台级配置与紧急运维；所有数据访问仍需理由、二次验证与审计 |
| service_worker | 仅领取被授权的 job/action；无浏览器会话能力 |
| audit_reader | 只读授权范围审计；不能修改业务或审计链 |

## 核心动作

符号：A=允许；S=仅本人/自己创建；C=仅授权课程；P=仅被授权项目；D=需独立高风险授权；—=拒绝。

| 动作 | anonymous | student | teacher | project_member | admin | super_admin | worker |
|---|---:|---:|---:|---:|---:|---:|---:|
| 读取公开页面 | A | A | A | A | A | A | — |
| 读取/修改本人资料 | — | S | S | S | S | S | — |
| 查看课程成员 | — | C | C | — | A | D | — |
| 管理成员/角色 | — | — | C | — | A | D | — |
| 管理功能策略/权益 | — | — | — | — | A | D | — |
| 创建/回复讨论 | — | C/P | C/P | P | A | D | — |
| 审核、删除、恢复讨论 | — | — | C | — | A | D | — |
| 创建/发布作业 | — | — | C | — | A | D | — |
| 保存/提交本人作业 | — | S | — | — | — | — | — |
| 评分/发布成绩 | — | — | C | — | D | D | — |
| 创建上传会话 | — | S | C | P | A | D | — |
| 下载文件 | — | S/C/P | C/P | P | A | D | — |
| 敏感数据批量导出 | — | — | D | D | D | D | — |
| 运行普通受控任务 | — | S/C/P | C/P | P | A | D | A |
| 管理隐藏判题用例 | — | — | D | — | D | D | — |
| 发布科学/法律成果 | — | — | D | D | D | D | — |
| 运行/部署自动化与 NiFi | — | — | — | D | D | D | A |
| 使用远程 AI 外发数据 | — | D | D | D | D | D | A |
| 读取审计 | — | — | C/P | P | A | D | — |
| 修改/删除审计 | — | — | — | — | — | — | — |

## 20 个工作台的资源关系

| 追踪 | 最低读取关系 | 修改关系 | 高风险独立权限 |
|---|---|---|---|
| T01 Python 编译器 | workspace.viewer | workspace.editor/owner | workspace.run_server、workspace.share、snapshot.restore |
| T02 日常做题 | course.student/teacher | attempt.owner 或 course.teacher | question.publish、answer_key.read |
| T03 在线项目 | project.viewer | project.member/maintainer | member.manage、project.archive、project.export |
| T04 数据处理 | project.viewer | project.editor | sensitive.export、operation.commit |
| T05 AI 报告 | project.viewer | project.editor/reviewer | ai.remote_send、report.finalize、sensitive.export |
| T06 Python 英文授课 | profile.owner 或 course.teacher | profile.owner/course.teacher | catalog.publish、score.adjust |
| T07 AI 测试与提交 | course.student/teacher | submission.owner 或 task.manager | judge.run、hidden_case.manage、grade.publish |
| T08 项目提交 | submission.owner/reviewer | owner 在 draft；reviewer 审核 | version.finalize、grade.publish |
| R01 论文写作 | project.viewer | project.editor/reviewer | report.finalize、ai.remote_send、export.final |
| R02 灾害遥感 | project.viewer | project.editor/operator | job.run、validation.approve、result.publish |
| R03 地震与物理 | project.viewer | project.editor/operator | job.run、pick.approve、result.publish |
| R04 专利转化 | project.viewer | project.editor/reviewer | legal.approve、external.verify、sensitive.export |
| R05 Skill 进化 | skill.viewer | skill.editor/operator | secret_ref.use、release.approve、release.publish/rollback |
| R06 知识系统 | kb.viewer | kb.editor | document.export、index.publish、acl.manage |
| R07 科研雷达 | collection.viewer | collection.editor/operator | monitor.manage、transfer.execute、bulk.export |
| R08 矿山安全雷达 | mine_collection.viewer | mine_collection.editor/operator | monitor.manage、transfer.execute、bulk.export |
| R09 研究自动化 | workflow.viewer | workflow.editor/operator | secret_ref.use、run.approve、version.publish |
| E01 数据网关 | dataflow.view | dataflow.modify/operate | view_data、view_provenance、manage_policy、deploy |
| E02 面波背景噪声 | project.viewer | project.editor/operator | job.run、quality.approve、result.publish |
| E03 专利交底书 | disclosure.viewer | disclosure.editor/reviewer | ai.remote_send、legal.approve、version.finalize |

## 服务端执行顺序

1. 校验会话、MFA/二次验证要求和账号状态。
2. 从会话绑定的权威身份得到 tenant；忽略客户端自行声明的 tenant。
3. 读取资源并验证父级 tenant、organization/course/workspace/project 链。
4. 调用 OpenFGA/等价关系检查；故障时 fail-closed。
5. 校验业务状态、资源 version/ETag、权益有效期和字段级规则。
6. 在同一事务设置 PostgreSQL 本地身份上下文，依赖 RLS 形成第二道防线。
7. 写业务数据、审计和 outbox；响应前做最小字段投影。

## 强制负向测试

每个资源族必须自动生成并执行以下拒绝用例：

- 未登录、过期/撤销会话、停用账号。
- 同 tenant 无关系、跨 organization/course/workspace/project、跨 tenant。
- 枚举 UUID、篡改父级 ID、批量接口混入一条越权资源。
- viewer 尝试写入、student 修改成绩、teacher 读取非授权课程、admin 跨组织。
- 过期/撤销权益、客户端伪造 feature flag、直接访问隐藏路由。
- stale ETag、重用幂等键但请求体不同、重放一次性授权。
- worker 领取错误 slug/action/job，过期 fence 完成任务，浏览器使用 worker 凭据。
- R07 与 R08 相同关键词/外部记录 ID 下的交叉读取和 transfer。
- 隐藏判题用例、secret_ref、对象存储 key、供应商密钥出现在普通响应或日志。

每个允许路径至少一项正向测试，每个拒绝路径至少一项负向测试。Gate B 必须在真实 OpenFGA 与 PostgreSQL RLS 上对账，纯 mock 不计通过。

