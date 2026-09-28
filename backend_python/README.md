# SkyViewLab Python 计算服务

该目录是 Python 计算面的安全边界实现。账号、项目、任务和审计由 Go 控制面管理；Python 只负责确定性计算、题库校验和外部运行时编排，不保存浏览器会话。

## 运行前配置

`.env.example` 只是配置清单，应用不会自动读取它。启动前必须由当前 shell、编排平台或 Secret Manager 显式注入变量；生产式启动至少设置：

- `SERVICE_HMAC_SECRET`：Go 控制面与 Python 计算面共享的随机密钥，至少 32 个 UTF-8 字节。
- `TRUSTED_SERVICE_ID`：允许调用工具执行接口的服务身份，默认 `go-control-plane`。
- `APP_ENV=production`：默认值；生产模式下所有开发绕过开关都会拒绝就绪。

默认请求上限为 1 MiB、JSON 深度 16、单数组 5000 项、单字符串 200000 字符，可通过 `.env.example` 中对应变量收紧。大型文件和结果后续必须走对象存储，不能提高 JSON 上限来替代。

## 存活与就绪

- `GET /live`：只证明进程能够响应。
- `GET /ready`：检查服务身份密钥和安全开关等必需配置；配置不完整时返回 503。
- `GET /health`：暂时保留的兼容别名，已经标记弃用。

## Go → Python 服务签名

`POST /tools/{slug}/run` 和 `POST /analysis/text` 默认只接受带以下请求头的 Go 控制面请求：

- `X-Skyview-Service`
- `X-Skyview-Timestamp`（Unix 秒）
- `X-Skyview-Nonce`
- `X-Skyview-Actor`
- `X-Skyview-Tenant`
- `X-Skyview-Job`
- `X-Skyview-Signature`

签名值是小写十六进制 HMAC-SHA256。待签名内容以换行连接：

```text
skyview-hmac-v1
HTTP_METHOD
URL_PATH
timestamp
nonce
service
actor
tenant
job
sha256(raw_request_body)
```

服务拒绝超出时间窗口的请求，并在单进程内对 nonce 做一次性占用。这只是第一道防重放屏障；多副本部署需要由 Go/任务系统提供持久化幂等和重放防护。

所有错误都使用稳定 envelope：

```json
{
  "error": {"code": "SERVICE_AUTH_INVALID", "message": "服务签名无效"},
  "message": "服务签名无效",
  "requestId": "..."
}
```

顶层 `message` 只为当前 React 客户端临时兼容，下一主版本移除。

## AI 测试与提交的隔离执行器

新版 AI 测试与提交不会在普通 Python 服务进程中运行学习者代码。题库、草稿、静态检查、提交留痕、评分编排和结果脱敏通过 Go 任务边界调用 Python；真正执行由独立的 Judge0 兼容沙箱承担。可选配置如下：

```text
JUDGE0_API_URL=https://judge.internal.example.com
JUDGE0_AUTH_HEADER=X-Auth-Token
JUDGE0_AUTH_TOKEN=<由 Secret Manager 注入>
```

生产地址必须使用 HTTPS；只有 `localhost` 或 `127.0.0.1` 的开发执行器可以使用 HTTP。认证令牌不得写进 React 项目、项目状态或导出文件。未配置执行器时，工作台仍可完成题库管理、草稿保存、静态检查、基准结果审阅、提交留痕与交付导出，新提交会保持“等待执行节点”，不会伪造运行结果。

## FLAC3D 边坡稳定分析运行时

`flac3d-slope-stability` 默认载入项目提供的 3000 单元基准结果，支持参数校验、独立坡快速筛查、塑性/位移/应力剖面、结果 CSV 导入和完整运行包导出。新的三维强度折减计算必须连接已授权的 FLAC3D 控制台：

```text
FLAC3D_BENCHMARK_DIRECTORY=D:\data\flac3d-slope-benchmark
FLAC3D_CONSOLE_PATH=D:\Itasca\FLAC3D700\exe64\flac3d700_console.exe
FLAC3D_RUN_ROOT=D:\skyviewlab-runs\flac3d
FLAC3D_EXECUTION_TIMEOUT_SECONDS=420
ALLOW_FLAC3D_EXECUTION=true
```

可执行程序路径由服务端固定配置，浏览器只能提交经过上下限约束的数值参数，不能提交脚本、命令或文件路径。Python 在独立任务目录生成参数化模型并以无 shell 方式调用求解器；Go 控制面继续负责项目、权限、任务状态和审计。未配置求解器或许可证时，高保真执行保持关闭，但已核验基准、模型检查、结果导入与交付包仍可用。

## 兼容的不安全开发运行器

旧兼容接口的 Python 同机 subprocess 默认关闭。只有同时设置：

```text
APP_ENV=development
ALLOW_UNSAFE_LOCAL_CODE_EXECUTION=true
```

才会启用。响应会明确包含 `prototype: true`、`productionSandbox: false` 和风险提示，不能把它描述为沙箱或用于正式评分。

无签名开发调用也只有在 `APP_ENV=development` 且 `ALLOW_UNSIGNED_DEV_REQUESTS=true` 时才会启用；两个开关默认均为 `false`，并且在生产环境设置为 `true` 会使 `/ready` 返回 503。

## 本地验证

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

将变量注入当前进程环境后，再使用本地启动命令：

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

API 文档位于 `/docs`。`GET /tools/catalog` 会把当前能力标记为 `prototype`，不会宣称生产可用。
