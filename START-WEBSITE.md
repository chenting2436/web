# SkyViewLab 本地启动文档

本文档用于从 GitHub 干净克隆并启动当前 React + Go + Python 分离式网站。
本地开发模式仅用于功能联调，不应直接作为公网生产部署方式。

## 1. 环境要求

Windows 10/11 工作站需要安装：

- Git
- PowerShell 7（命令名为 `pwsh`）
- Node.js 22.13.0 或更高版本
- Go 1.27 或更高版本
- Python 3.13

检查版本：

```powershell
git --version
pwsh --version
node --version
npm --version
go version
python --version
```

## 2. 克隆代码

```powershell
git clone git@github.com:chenting2436/web.git
Set-Location .\web
```

如果使用仓库 Deploy Key，请确保本机 SSH 配置选择了对应私钥。

## 3. 配置本地登录账号

复制本地开发模板：

```powershell
Copy-Item .\local-development.env.example .\.env.backend
notepad .\.env.backend
```

至少填写：

```text
SKYVIEW_LOCAL_DEMO_ACCOUNT=你的管理员账号
SKYVIEW_LOCAL_DEMO_PASSWORD=你的本地管理员密码
```

如需学生账号，同时填写 `SKYVIEW_LOCAL_STUDENT_ACCOUNT` 与
`SKYVIEW_LOCAL_STUDENT_PASSWORD`；否则两项都保持为空。`.env.backend` 已被
Git 忽略，禁止将真实密码提交到仓库。

## 4. 一键启动完整网站

```powershell
pwsh -File .\verification\start-local-website.ps1
```

首次启动会自动完成：

1. 根据 `package-lock.json` 执行 `npm ci`；
2. 创建 `backend_python/.venv` 并安装 Python 运行依赖；
3. 从当前源码构建 Go API 与 Worker，不依赖仓库外的旧 EXE；
4. 启动 Python Compute Plane、Go API、Go Worker 和 React；
5. 执行健康、能力目录、会话边界和未授权访问验收。

启动完成后访问：

- 网站：<http://localhost:4182/>
- Go API 就绪接口：<http://127.0.0.1:8080/api/v1/ready>
- Python 就绪接口：<http://127.0.0.1:8000/ready>

也可以在启动成功后自动打开浏览器：

```powershell
pwsh -File .\verification\start-local-website.ps1 -OpenBrowser
```

## 5. 停止网站

```powershell
pwsh -File .\verification\stop-local-website.ps1
```

停止脚本只会结束属于当前代码目录的 React、Go、Python 和 Worker 进程；
如果端口被其他程序占用，它会拒绝误杀并报告冲突。

## 6. 手动验收

网站运行后执行：

```powershell
pwsh -File .\verification\verify-local.ps1
```

完整测试：

```powershell
# React
Set-Location .\web_react
npm run typecheck
npm test
npm run build

# Go
Set-Location ..\backend_go
go test ./...
go vet ./...

# Python
Set-Location ..\backend_python
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

## 7. 常见问题

### 端口被占用

本地固定使用 4182、8080、8000。启动脚本只会重启当前 SkyViewLab
目录中的进程；若端口属于其他项目，请先自行关闭冲突程序。

### 修改依赖后没有生效

React 启动脚本会比较 `package-lock.json` 的 SHA-256，变化后自动重新执行
`npm ci`。Python 每次启动都会根据 `requirements.txt` 校验并安装运行依赖；
Go 服务每次从当前源码重新构建。

### 边坡数值分析找不到基准数据

默认基准已随 Python 服务保存在
`backend_python/app/assets/flac3d/slope_zones_fos_results.csv`，干净克隆不再
依赖开发者电脑上的旧资料目录。如需替换基准，可设置
`FLAC3D_BENCHMARK_DIRECTORY` 指向受控数据目录。

### 生产部署

本地脚本使用 SQLite、开发登录与本机 Worker。正式部署必须按
[BACKEND.md](BACKEND.md) 完成 PostgreSQL、OIDC、OpenFGA、密钥管理、TLS、
任务运行时、监控、备份恢复及安全验收。
