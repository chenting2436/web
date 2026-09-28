# 遗留工作台状态一次性导入

`data/workbench-state.json` 是旧版单机状态文件，键格式为 `<legacyUserKey>|<slug>`。新版服务不会自动读取它，也不会把 `guest`、邮箱或昵称猜测为真实用户。唯一受支持的迁移入口是独立命令 `cmd/import-workbench-state`。

该命令默认只做 dry-run。只有显式增加 `--apply` 才会写入 `workbench_states`；每条新写入都与 `workbench.state.legacy_import` 审计事件及链头推进处于同一个数据库事务。任一映射、冲突或审计写入失败会回滚整批导入。

## 迁移前提

1. 停止仍可能改写旧 JSON 文件的进程，并为旧文件、目标数据库和最终映射清单各保留一份只读备份。
2. 目标数据库必须已经完成当前 schema migration。导入命令不会创建或升级 schema，也禁止 `DATABASE_MIGRATE=true`。
3. 清单中的 tenant、workspace、目标 user 和操作人 user 必须已经存在且处于 active 状态；两位用户都必须拥有该 workspace 的 active membership。
4. `actorUserId` 必须是目标 workspace 的 active admin。它代表批准并执行迁移的人，不能用待迁移用户冒充操作人（除非该用户本人确实是管理员并承担该职责）。一个清单内所有映射必须使用同一个 tenant、workspace 和 `actorUserId`；跨作用域迁移必须拆成独立清单，逐批 dry-run、审批和 apply。
5. 生产 PostgreSQL 使用长期 runtime 账号和 `sslmode=verify-full`，不可使用 migration owner 凭据。启动前仍会执行既有的 runtime 最小权限门禁。

## 映射清单

先计算冻结后源文件的 SHA-256。PowerShell 示例：

```powershell
(Get-FileHash -Algorithm SHA256 .\data\workbench-state.json).Hash.ToLowerInvariant()
```

创建一个不提交到源码仓库的严格 JSON 清单：

```json
{
  "version": 1,
  "sourceSha256": "<上一步得到的 64 位小写十六进制摘要>",
  "mappings": [
    {
      "legacyUserKey": "guest",
      "tenantId": "tenant-existing",
      "workspaceId": "workspace-existing",
      "userId": "target-user-existing",
      "actorUserId": "admin-user-existing",
      "acknowledgeAnonymousSource": true
    }
  ]
}
```

每个源 `legacyUserKey` 必须恰好有一条映射，清单不能包含未使用的映射。不同源记录也不能落到同一个 tenant/workspace/user/slug。`guest` 仍可在管理员确认数据归属后显式迁移，但必须写出 `acknowledgeAnonymousSource: true`；缺少这一确认会直接拒绝，系统绝不会自动把匿名数据导给当前登录用户。

整批导入只使用上述管理员的普通 user RLS 上下文；不启用 system 身份，也不绕过 tenant policy。管理员只能在清单绑定的同一 tenant/workspace 内读取映射所需的身份记录并写入目标工作台状态。

清单与源文件均拒绝未知字段、重复 JSON key、尾随 JSON、非法或未知 slug、非对象 state 以及规范化后超过 1 MiB 的 state。清单内的 `sourceSha256` 把审批结果绑定到源文件的精确字节，源文件发生任何改动都必须重新审核和生成清单。

## 执行

数据库连接只从环境变量读取，避免把凭据写入命令历史。SQLite 仅限显式开发模式，并且 `DATABASE_FILE` 必须指向已经存在的持久数据库文件：

```powershell
$env:DEV_MODE = 'true'
$env:DATABASE_ADAPTER = 'sqlite-development'
$env:DATABASE_FILE = '.\data\skyviewlab.db'
$env:DATABASE_MIGRATE = 'false'

go run .\cmd\import-workbench-state `
  --legacy-file .\data\workbench-state.json `
  --mapping-file .\data\workbench-state.import-map.json
```

生产 PostgreSQL 保持 `DEV_MODE=false`、`DATABASE_ADAPTER=postgresql`、`DATABASE_FILE` 为空，并由 Secret Manager 注入带 `sslmode=verify-full` 的 `DATABASE_URL`。

先审阅 dry-run JSON 报告：

- `would-import`：目标不存在，apply 时将新建 revision 1；
- `already-present`：目标状态与规范化后的源状态完全一致，是安全的幂等跳过；
- `conflict`：目标已存在不同状态，整批拒绝，不提供覆盖开关。

审阅通过后，仅增加 `--apply` 重跑同一命令：

```powershell
go run .\cmd\import-workbench-state `
  --legacy-file .\data\workbench-state.json `
  --mapping-file .\data\workbench-state.import-map.json `
  --apply
```

保存 apply 报告并核对审计链。再次使用同一源文件和清单执行会全部显示 `already-present`，不会增加 revision，也不会重复追加审计事件。若目标状态已被用户修改，命令会 fail-closed；不存在“最后写入者覆盖”模式。

确认迁移和备份可恢复后，可将旧 JSON、清单及执行报告转入受控归档。不要删除原件，直到恢复演练和业务负责人签字完成。
