# SkyViewLab React Frontend

这是 SkyViewLab 的独立 React 前端项目。项目中不包含后端路由、数据库或服务端业务逻辑。

## 本地运行

完整网站（React、Go API、Go Worker、Python）的干净克隆启动方式见根目录
[`START-WEBSITE.md`](../START-WEBSITE.md)。只调试前端时使用：

```bash
npm install
npm run dev
```

## 前后端分离约定

- 页面与组件：`app/`、`components/`
- 前端展示数据：`lib/`
- API 客户端：`services/api/`
- 前后端共享的数据形状：`types/api.ts`
- 静态资源：`public/`
- 后端地址：复制 `.env.example` 为 `.env.local`，设置 `NEXT_PUBLIC_API_BASE_URL`

生产默认设置 `NEXT_PUBLIC_OIDC_ENABLED=true`、`NEXT_PUBLIC_ENABLE_DEV_LOGIN=false`。组织身份源成功回调 Go 后，Go 只允许跳转到固定的 React `/auth/complete` 页面；该页面会通过 `/auth/me` 再确认 HttpOnly 会话，成功后才进入个人中心。前端不会解析身份令牌，也不会从查询参数接受下一跳地址。本地联调请让网页与 API 使用同一站点主机名（例如都使用 `localhost`），以符合会话 Cookie 的 SameSite 边界。

所有远程数据请求都必须经过 `services/api/`。请勿在页面组件中拼接后端地址，也不要在本项目内创建数据库连接或后端业务路由。

配套后端位于相邻的独立项目：

- [`../backend_go`](../backend_go)：前端主 API 与登录会话
- [`../backend_python`](../backend_python)：算法与数据分析服务

完整启动说明见 [`../BACKEND.md`](../BACKEND.md)。

当前 26 个工作台按照冻结的迁移清单和服务端能力目录进行管理。列表和工作台详情会从 Go 的 `/api/v1/tools/catalog` 校验当前能力状态；控制面不可用、能力缺失或状态无效时，前端按安全默认值关闭执行。服务端状态只能进一步收紧本地安全门禁，不能单方面重新开放被冻结的高风险入口。

可执行原型只通过 `services/api/tools.ts` 向 Go 创建服务端作业，浏览器不能直连 Python，也不能自行上报运行终态。项目、版本、作业和运行记录由后端管理。

现有通用三栏式工作区仅用于流程评审，将按生产蓝图逐项替换成独立 route/component/schema/tests 和领域图表。信息架构参考 JupyterLab、OpenRefine、Plane 与 Judge0 IDE 的公开工作流，但不复制其商标或上游界面源码。详细边界见 `OPEN_SOURCE_NOTICES.md`、根目录 `PRODUCTION_REBUILD_BLUEPRINT.md` 和 `PRODUCTION_REBUILD_PROGRESS.md`。

## 构建

```bash
npm run build
```
