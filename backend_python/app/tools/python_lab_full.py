from __future__ import annotations

import ast
import copy
import csv
import hashlib
import io
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-python-lab-results"
WORKSPACE_SCHEMA = "skyview-python-lab-workspace"
FIXED_TIME = "2026-09-09T00:00:00Z"
MAX_FILES = 120
MAX_FOLDERS = 60
MAX_FILE_CHARS = 100_000
MAX_WORKSPACE_BYTES = 900_000
MAX_RUNS = 100
MAX_NOTEBOOK_CELLS = 80
MAX_CELL_CHARS = 40_000
MAX_CELL_OUTPUT_BYTES = 600_000

DEFAULT_FILES = {
    "main.py": '''from utils.math_tools import square_sum
import os
import sys

print("Hello, Python Lab!")
print("环境变量 COURSE =", os.environ.get("COURSE"))
print("命令行参数 =", sys.argv[1:])
try:
    print("标准输入第一行 =", input())
except EOFError:
    print("标准输入第一行 = <empty>")

numbers = [1, 2, 3, 4, 5]
print("平方和 =", square_sum(numbers))

with open("data/data.txt", "r", encoding="utf-8") as file:
    print("data/data.txt 第一行 =", file.readline().strip())
''',
    "utils/math_tools.py": '''def square_sum(values):
    return sum(x * x for x in values)
''',
    "data/data.txt": "10,20,30\n40,50,60\n",
    "requirements.txt": "# 每行一个包名，运行前会在浏览器运行时安装\n# numpy\n",
    "README.md": '''# Python Lab

课程实验工作区支持多文件、浏览器 Python、运行参数和受限终端。

常用命令：

```bash
COURSE=PythonLab python main.py --mode practice
python main.py < data/data.txt
echo "42\\nhello" | python main.py
python -m unittest test*.py
pip install numpy
```
''',
    ".vscode/settings.json": '''{
  "python.defaultInterpreterPath": "pyodide",
  "python.terminal.activateEnvironment": true,
  "editor.tabSize": 4
}
''',
}

TEMPLATES = [
    {
        "id": "data",
        "name": "数据统计",
        "description": "列表、聚合和条件筛选",
        "content": '''records = [
    {"site": "A", "risk": 0.42},
    {"site": "B", "risk": 0.81},
    {"site": "C", "risk": 0.63},
]
values = [item["risk"] for item in records]
print("样本数:", len(values))
print("平均风险:", round(sum(values) / len(values), 3))
print("高风险:", [item["site"] for item in records if item["risk"] >= 0.8])
''',
    },
    {
        "id": "algorithm",
        "name": "算法与函数",
        "description": "滑动平均与参数校验",
        "content": '''def moving_average(values, window):
    if window <= 0 or len(values) < window:
        return []
    return [sum(values[i:i + window]) / window for i in range(len(values) - window + 1)]

series = [2, 5, 4, 8, 9, 7]
print(moving_average(series, 3))
''',
    },
    {
        "id": "files",
        "name": "文件处理",
        "description": "Pathlib 文件读写",
        "content": '''from pathlib import Path

path = Path("data/report.txt")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("SkyViewLab\\nstatus=ready\\n", encoding="utf-8")
print(path.read_text(encoding="utf-8"))
''',
    },
    {
        "id": "visual",
        "name": "文本可视化",
        "description": "在终端输出条形图",
        "content": '''values = [3, 7, 5, 9, 6]
scale = max(values)
for index, value in enumerate(values, start=1):
    bar = "█" * round(value / scale * 24)
    print(f"{index:02d} | {bar:<24} {value}")
''',
    },
]

BASELINE_NOTEBOOK = {
    "id": "notebook-data-basics",
    "title": "数据统计入门",
    "updatedAt": FIXED_TIME,
    "cells": [
        {
            "id": "cell-intro",
            "type": "markdown",
            "source": "## 实验目标\n读取监测数据，完成均值计算与高风险站点筛选。",
            "executionCount": None,
            "status": "idle",
            "outputs": [],
        },
        {
            "id": "cell-load",
            "type": "code",
            "source": 'records = [\n    {"site": "A", "risk": 0.42},\n    {"site": "B", "risk": 0.81},\n    {"site": "C", "risk": 0.63},\n]\nrecords',
            "executionCount": None,
            "status": "idle",
            "outputs": [],
        },
        {
            "id": "cell-analyse",
            "type": "code",
            "source": 'values = [item["risk"] for item in records]\naverage = round(sum(values) / len(values), 3)\nhigh_risk = [item["site"] for item in records if item["risk"] >= 0.8]\nprint("平均风险:", average)\nprint("高风险站点:", high_risk)',
            "executionCount": None,
            "status": "idle",
            "outputs": [],
        },
    ],
}

BASELINE_COURSE = {
    "title": "Python 数据处理实验",
    "section": "第 03 节 · 列表、字典与统计",
    "objectives": ["读取结构化记录", "计算汇总指标", "筛选风险对象"],
    "steps": [
        {"id": "prepare", "title": "认识数据", "detail": "运行第一个代码单元，检查 records 的结构。"},
        {"id": "analyse", "title": "完成分析", "detail": "计算平均值并筛选风险值不低于 0.8 的站点。"},
        {"id": "deliver", "title": "保存结果", "detail": "保存工作区并创建快照，形成可复核记录。"},
    ],
    "checks": [
        {"id": "records", "label": "已生成 3 条记录", "passed": False},
        {"id": "average", "label": "平均风险为 0.62", "passed": False},
        {"id": "high-risk", "label": "识别站点 B", "passed": False},
    ],
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _checksum(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _clean(value: Any, limit: int) -> str:
    return str(value or "").replace("\x00", "")[:limit]


def _normalize_path(value: Any) -> str:
    raw = _clean(value, 300).replace("\\", "/").strip().lstrip("/")
    parts: list[str] = []
    for part in raw.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        if any(ord(char) < 32 for char in part):
            raise ToolError("文件路径包含无效字符")
        parts.append(part)
    normalized = "/".join(parts)
    if len(normalized) > 180:
        raise ToolError("文件路径过长")
    return normalized


def _requirements(files: dict[str, str]) -> list[str]:
    packages: list[str] = []
    for line in files.get("requirements.txt", "").splitlines():
        requirement = line.split("#", 1)[0].strip()
        if not requirement:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:==|>=|<=|~=|>|<)\s*[A-Za-z0-9_.+-]+)?", requirement):
            raise ToolError(f"requirements.txt 包含不受支持的依赖表达式：{requirement}")
        packages.append(requirement)
    return list(dict.fromkeys(packages))[:30]


def _validate_files(files_value: Any) -> dict[str, str]:
    if not isinstance(files_value, dict) or not files_value:
        raise ToolError("工作区至少需要一个文件")
    if len(files_value) > MAX_FILES:
        raise ToolError(f"工作区最多支持 {MAX_FILES} 个文件")
    files: dict[str, str] = {}
    total_bytes = 0
    for raw_path, raw_content in files_value.items():
        path = _normalize_path(raw_path)
        if not path:
            raise ToolError("文件路径不能为空")
        if path in files:
            raise ToolError("工作区存在规范化后重复的文件路径")
        content = str(raw_content or "")
        if len(content) > MAX_FILE_CHARS:
            raise ToolError(f"单个文件最多 {MAX_FILE_CHARS} 个字符")
        total_bytes += len(content.encode("utf-8"))
        files[path] = content
    if total_bytes > MAX_WORKSPACE_BYTES:
        raise ToolError(f"工作区最多 {MAX_WORKSPACE_BYTES} 字节")
    _requirements(files)
    return files


def _validate_notebook_output(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ToolError("Notebook 输出格式无效")
    kind = _clean(raw.get("kind"), 20)
    if kind not in {"text", "value", "table", "image"}:
        raise ToolError("Notebook 输出类型不受支持")
    output: dict[str, Any] = {"kind": kind}
    if kind in {"text", "value"}:
        output["text"] = _clean(raw.get("text"), 12_000)
    elif kind == "table":
        columns = raw.get("columns", [])
        rows = raw.get("rows", [])
        if not isinstance(columns, list) or not isinstance(rows, list):
            raise ToolError("Notebook 表格输出格式无效")
        output["columns"] = [_clean(item, 120) for item in columns[:20]]
        output["rows"] = [
            [_clean(value, 500) for value in row[:20]]
            for row in rows[:100]
            if isinstance(row, list)
        ]
    else:
        data_url = _clean(raw.get("dataUrl"), MAX_CELL_OUTPUT_BYTES)
        if data_url and not re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+", data_url):
            raise ToolError("Notebook 图像输出必须是受支持的数据 URL")
        output["dataUrl"] = data_url
    if len(json.dumps(output, ensure_ascii=False).encode("utf-8")) > MAX_CELL_OUTPUT_BYTES:
        raise ToolError("Notebook 单元输出超过容量限制")
    return output


def _validate_notebooks(raw: Any) -> list[dict[str, Any]]:
    source = raw if isinstance(raw, list) and raw else [BASELINE_NOTEBOOK]
    notebooks: list[dict[str, Any]] = []
    for raw_notebook in source[:12]:
        if not isinstance(raw_notebook, dict):
            raise ToolError("Notebook 格式无效")
        raw_cells = raw_notebook.get("cells", [])
        if not isinstance(raw_cells, list) or not raw_cells:
            raise ToolError("Notebook 至少需要一个单元")
        if len(raw_cells) > MAX_NOTEBOOK_CELLS:
            raise ToolError(f"Notebook 最多支持 {MAX_NOTEBOOK_CELLS} 个单元")
        cells: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw_cell in raw_cells:
            if not isinstance(raw_cell, dict):
                raise ToolError("Notebook 单元格式无效")
            cell_id = _clean(raw_cell.get("id"), 100) or _uid("cell")
            if cell_id in seen:
                raise ToolError("Notebook 存在重复单元标识")
            seen.add(cell_id)
            cell_type = _clean(raw_cell.get("type"), 20)
            if cell_type not in {"markdown", "code"}:
                raise ToolError("Notebook 单元类型无效")
            source_text = _clean(raw_cell.get("source"), MAX_CELL_CHARS)
            status = _clean(raw_cell.get("status"), 20)
            if status not in {"idle", "running", "succeeded", "failed"}:
                status = "idle"
            execution_count = raw_cell.get("executionCount")
            if execution_count is not None:
                execution_count = max(0, min(100_000, int(execution_count)))
            outputs = raw_cell.get("outputs", [])
            if not isinstance(outputs, list):
                raise ToolError("Notebook 单元输出格式无效")
            cells.append({
                "id": cell_id,
                "type": cell_type,
                "source": source_text,
                "executionCount": execution_count,
                "status": status,
                "outputs": [_validate_notebook_output(item) for item in outputs[:12]],
            })
        notebooks.append({
            "id": _clean(raw_notebook.get("id"), 100) or _uid("notebook"),
            "title": _clean(raw_notebook.get("title"), 160) or "Python Notebook",
            "cells": cells,
            "updatedAt": _clean(raw_notebook.get("updatedAt"), 60) or _now(),
        })
    return notebooks


def _normalize_course(raw: Any) -> dict[str, Any]:
    course = copy.deepcopy(BASELINE_COURSE)
    if not isinstance(raw, dict):
        return course
    checks_by_id = {
        _clean(item.get("id"), 80): bool(item.get("passed"))
        for item in raw.get("checks", [])
        if isinstance(item, dict)
    } if isinstance(raw.get("checks"), list) else {}
    for check in course["checks"]:
        check["passed"] = checks_by_id.get(check["id"], check["passed"])
    return course


def _folders_for(files: dict[str, str], supplied: Any = None) -> list[str]:
    folders = {_normalize_path(item) for item in supplied or [] if _normalize_path(item)} if isinstance(supplied, list) else set()
    for path in files:
        parent = PurePosixPath(path).parent
        while str(parent) not in {"", "."}:
            folders.add(str(parent))
            parent = parent.parent
    if len(folders) > MAX_FOLDERS:
        raise ToolError(f"工作区最多支持 {MAX_FOLDERS} 个文件夹")
    return sorted(folders)


def _snapshot_payload(workspace: dict[str, Any]) -> dict[str, Any]:
    return {
        "files": copy.deepcopy(workspace["files"]),
        "folders": list(workspace["folders"]),
        "openFiles": list(workspace["openFiles"]),
        "activePath": workspace["activePath"],
        "expandedFolders": list(workspace["expandedFolders"]),
        "runConfig": copy.deepcopy(workspace["runConfig"]),
        "layout": copy.deepcopy(workspace["layout"]),
        "notebooks": copy.deepcopy(workspace["notebooks"]),
        "activeNotebookId": workspace["activeNotebookId"],
        "course": copy.deepcopy(workspace["course"]),
    }


def _baseline_workspace() -> dict[str, Any]:
    files = copy.deepcopy(DEFAULT_FILES)
    workspace: dict[str, Any] = {
        "id": "python-workspace-main",
        "title": "Python 课程实验",
        "revision": 1,
        "files": files,
        "folders": [".vscode", "data", "utils"],
        "openFiles": ["main.py", "utils/math_tools.py"],
        "activePath": "main.py",
        "expandedFolders": [".vscode", "data", "utils"],
        "fileRevisions": {
            path: {"revision": 1, "checksum": _checksum(content), "updatedAt": FIXED_TIME}
            for path, content in files.items()
        },
        "runConfig": {
            "entryPath": "main.py",
            "stdin": "42\n",
            "argv": ["--mode", "practice"],
            "env": {"COURSE": "PythonLab"},
        },
        "installedPackages": ["micropip"],
        "layout": {"sidebarWidth": 252, "terminalHeight": 228, "rightPanelWidth": 276},
        "notebooks": [copy.deepcopy(BASELINE_NOTEBOOK)],
        "activeNotebookId": BASELINE_NOTEBOOK["id"],
        "course": copy.deepcopy(BASELINE_COURSE),
        "snapshots": [],
        "runs": [
            {
                "id": "run-browser-001",
                "entryPath": "main.py",
                "command": "COURSE=PythonLab python main.py --mode practice",
                "status": "succeeded",
                "exitCode": 0,
                "durationMs": 84.2,
                "stdoutPreview": "Hello, Python Lab!\n环境变量 COURSE = PythonLab\n平方和 = 55",
                "stderrPreview": "",
                "runtime": "Pyodide 0.28.3",
                "evidenceSource": "browser-local",
                "verified": False,
                "createdAt": FIXED_TIME,
            }
        ],
        "quotas": {
            "maxFiles": MAX_FILES,
            "maxFolders": MAX_FOLDERS,
            "maxFileChars": MAX_FILE_CHARS,
            "maxWorkspaceBytes": MAX_WORKSPACE_BYTES,
            "maxRuns": MAX_RUNS,
        },
        "updatedAt": FIXED_TIME,
    }
    initial = _snapshot_payload(workspace)
    workspace["snapshots"] = [{
        "id": "snapshot-initial",
        "label": "初始课程基准",
        "checksum": _checksum(initial),
        "createdAt": FIXED_TIME,
        "immutable": True,
        "payload": initial,
    }]
    return workspace


def _normalize_workspace(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ToolError("工作区数据格式无效")
    files = _validate_files(raw.get("files"))
    folders = _folders_for(files, raw.get("folders"))
    first = next(iter(files))
    active = _normalize_path(raw.get("activePath"))
    if active not in files:
        active = first
    open_files = []
    for item in raw.get("openFiles", []):
        path = _normalize_path(item)
        if path in files and path not in open_files:
            open_files.append(path)
    if active not in open_files:
        open_files.insert(0, active)
    expanded = []
    for item in raw.get("expandedFolders", []):
        path = _normalize_path(item)
        if path in folders and path not in expanded:
            expanded.append(path)
    notebooks = _validate_notebooks(raw.get("notebooks"))
    active_notebook_id = _clean(raw.get("activeNotebookId"), 100)
    if active_notebook_id not in {item["id"] for item in notebooks}:
        active_notebook_id = notebooks[0]["id"]
    baseline = _baseline_workspace()
    baseline.update({
        "id": _clean(raw.get("id"), 100) or _uid("python-workspace"),
        "title": _clean(raw.get("title"), 120) or "导入的 Python 工作区",
        "revision": max(1, int(raw.get("revision", 1) or 1)),
        "files": files,
        "folders": folders,
        "openFiles": open_files[:20],
        "activePath": active,
        "expandedFolders": expanded,
        "fileRevisions": {
            path: {"revision": 1, "checksum": _checksum(content), "updatedAt": _now()}
            for path, content in files.items()
        },
        "notebooks": notebooks,
        "activeNotebookId": active_notebook_id,
        "course": _normalize_course(raw.get("course")),
        "runs": list(raw.get("runs", []))[:MAX_RUNS] if isinstance(raw.get("runs"), list) else [],
        "snapshots": [],
        "updatedAt": _now(),
    })
    config = raw.get("runConfig")
    if isinstance(config, dict):
        baseline["runConfig"] = {
            "entryPath": _normalize_path(config.get("entryPath")) if _normalize_path(config.get("entryPath")) in files else active,
            "stdin": _clean(config.get("stdin"), 20_000),
            "argv": [_clean(item, 200) for item in config.get("argv", [])][:40] if isinstance(config.get("argv"), list) else [],
            "env": {
                _clean(key, 80): _clean(value, 500)
                for key, value in (config.get("env") or {}).items()
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key))
            } if isinstance(config.get("env"), dict) else {},
        }
    if isinstance(raw.get("layout"), dict):
        baseline["layout"] = {
            "sidebarWidth": min(520, max(200, int(raw["layout"].get("sidebarWidth", 252)))),
            "terminalHeight": min(520, max(150, int(raw["layout"].get("terminalHeight", 228)))),
            "rightPanelWidth": min(460, max(220, int(raw["layout"].get("rightPanelWidth", 276)))),
        }
    packages = []
    if isinstance(raw.get("installedPackages"), list):
        for item in raw["installedPackages"]:
            package = _clean(item, 120).strip()
            if re.fullmatch(r"[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?(?:==[A-Za-z0-9_.+-]+)?", package):
                packages.append(package)
    baseline["installedPackages"] = sorted(set(["micropip", *packages]))[:50]
    safe_snapshots = []
    for item in raw.get("snapshots", [])[:20] if isinstance(raw.get("snapshots"), list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("payload"), dict):
            continue
        candidate = item["payload"]
        try:
            snapshot_files = _validate_files(candidate.get("files"))
            snapshot_folders = _folders_for(snapshot_files, candidate.get("folders"))
        except ToolError:
            continue
        snapshot_active = _normalize_path(candidate.get("activePath"))
        if snapshot_active not in snapshot_files:
            snapshot_active = next(iter(snapshot_files))
        snapshot_open = [_normalize_path(path) for path in candidate.get("openFiles", [])] if isinstance(candidate.get("openFiles"), list) else []
        snapshot_open = list(dict.fromkeys(path for path in snapshot_open if path in snapshot_files))[:20] or [snapshot_active]
        snapshot_expanded = [_normalize_path(path) for path in candidate.get("expandedFolders", [])] if isinstance(candidate.get("expandedFolders"), list) else []
        snapshot_notebooks = _validate_notebooks(candidate.get("notebooks"))
        snapshot_active_notebook = _clean(candidate.get("activeNotebookId"), 100)
        if snapshot_active_notebook not in {item["id"] for item in snapshot_notebooks}:
            snapshot_active_notebook = snapshot_notebooks[0]["id"]
        snapshot_payload = {
            "files": snapshot_files,
            "folders": snapshot_folders,
            "openFiles": snapshot_open,
            "activePath": snapshot_active,
            "expandedFolders": list(dict.fromkeys(path for path in snapshot_expanded if path in snapshot_folders)),
            "runConfig": copy.deepcopy(candidate.get("runConfig")) if isinstance(candidate.get("runConfig"), dict) else copy.deepcopy(baseline["runConfig"]),
            "layout": copy.deepcopy(candidate.get("layout")) if isinstance(candidate.get("layout"), dict) else copy.deepcopy(baseline["layout"]),
            "notebooks": snapshot_notebooks,
            "activeNotebookId": snapshot_active_notebook,
            "course": _normalize_course(candidate.get("course")),
        }
        safe_snapshots.append({
            "id": _clean(item.get("id"), 100) or _uid("snapshot"),
            "label": _clean(item.get("label"), 120) or "工作区快照",
            "checksum": _checksum(snapshot_payload),
            "createdAt": _clean(item.get("createdAt"), 60) or _now(),
            "immutable": True,
            "payload": snapshot_payload,
        })
    baseline["snapshots"] = safe_snapshots
    return baseline


def _workspace_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state")
    if isinstance(state, dict) and isinstance(state.get("workspace"), dict):
        return _normalize_workspace(state["workspace"])
    if isinstance(payload.get("workspace"), dict):
        return _normalize_workspace(payload["workspace"])
    return _baseline_workspace()


def _analysis(workspace: dict[str, Any]) -> dict[str, Any]:
    syntax: list[dict[str, Any]] = []
    imports: set[str] = set()
    python_files = [path for path in workspace["files"] if path.endswith(".py")]
    for path in python_files:
        content = workspace["files"][path]
        try:
            tree = ast.parse(content, filename=path)
            status, message, line = "valid", "语法检查通过", None
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imports.update(alias.name.split(".")[0] for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imports.add(node.module.split(".")[0])
        except SyntaxError as exc:
            status, message, line = "error", exc.msg, exc.lineno
        syntax.append({"path": path, "status": status, "message": message, "line": line})
    total_bytes = sum(len(content.encode("utf-8")) for content in workspace["files"].values())
    return {
        "metrics": {
            "files": len(workspace["files"]),
            "folders": len(workspace["folders"]),
            "pythonFiles": len(python_files),
            "openFiles": len(workspace["openFiles"]),
            "totalBytes": total_bytes,
            "runs": len(workspace["runs"]),
            "snapshots": len(workspace["snapshots"]),
        },
        "syntax": syntax,
        "valid": all(item["status"] == "valid" for item in syntax),
        "imports": sorted(imports),
        "requirements": _requirements(workspace["files"]),
        "tree": [
            {"path": folder, "type": "folder"} for folder in workspace["folders"]
        ] + [
            {"path": path, "type": "file", "bytes": len(content.encode("utf-8")), "checksum": _checksum(content)}
            for path, content in sorted(workspace["files"].items())
        ],
    }


def _exports(workspace: dict[str, Any], analysis: dict[str, Any]) -> dict[str, str]:
    compatible = {
        "schema": WORKSPACE_SCHEMA,
        "version": 3,
        "files": workspace["files"],
        "folders": workspace["folders"],
        "openFiles": workspace["openFiles"],
        "activePath": workspace["activePath"],
        "expandedFolders": workspace["expandedFolders"],
        "runConfig": workspace["runConfig"],
        "layout": workspace["layout"],
        "notebooks": workspace["notebooks"],
        "activeNotebookId": workspace["activeNotebookId"],
        "course": workspace["course"],
    }
    manifest_buffer = io.StringIO()
    writer = csv.writer(manifest_buffer, lineterminator="\n")
    writer.writerow(["path", "type", "bytes", "checksum"])
    for item in analysis["tree"]:
        writer.writerow([item["path"], item["type"], item.get("bytes", 0), item.get("checksum", "")])
    runs_buffer = io.StringIO()
    writer = csv.writer(runs_buffer, lineterminator="\n")
    writer.writerow(["run_id", "entry_path", "status", "exit_code", "duration_ms", "runtime", "created_at", "verified"])
    for run in workspace["runs"]:
        writer.writerow([run.get("id"), run.get("entryPath"), run.get("status"), run.get("exitCode"), run.get("durationMs"), run.get("runtime"), run.get("createdAt"), run.get("verified", False)])
    report = (
        f"# {workspace['title']}\n\n"
        f"- 文件：{analysis['metrics']['files']}\n"
        f"- Python 文件：{analysis['metrics']['pythonFiles']}\n"
        f"- 工作区字节：{analysis['metrics']['totalBytes']}\n"
        f"- 语法检查：{'通过' if analysis['valid'] else '存在错误'}\n"
        f"- 浏览器运行记录：{analysis['metrics']['runs']}\n\n"
        "运行记录来自浏览器本地 Pyodide，不作为服务端验证结果。\n"
    )
    backup = {
        "schema": "skyview-python-lab-backup",
        "version": 1,
        "workspace": workspace,
        "analysis": analysis,
    }
    active_notebook = next(
        (item for item in workspace["notebooks"] if item["id"] == workspace["activeNotebookId"]),
        workspace["notebooks"][0],
    )
    notebook_cells = []
    for cell in active_notebook["cells"]:
        ipynb_cell: dict[str, Any] = {
            "cell_type": cell["type"],
            "metadata": {},
            "source": cell["source"].splitlines(keepends=True),
        }
        if cell["type"] == "code":
            outputs = []
            for item in cell["outputs"]:
                if item["kind"] == "text":
                    outputs.append({"output_type": "stream", "name": "stdout", "text": str(item.get("text", "")).splitlines(keepends=True)})
                elif item["kind"] == "value":
                    outputs.append({"output_type": "execute_result", "execution_count": cell["executionCount"], "metadata": {}, "data": {"text/plain": item.get("text", "")}})
                elif item["kind"] == "table":
                    outputs.append({"output_type": "display_data", "metadata": {}, "data": {"application/vnd.skyview.table+json": {"columns": item.get("columns", []), "rows": item.get("rows", [])}}})
                elif item["kind"] == "image" and item.get("dataUrl"):
                    encoded = str(item["dataUrl"]).split(",", 1)[-1]
                    outputs.append({"output_type": "display_data", "metadata": {}, "data": {"image/png": encoded}})
            ipynb_cell.update({"execution_count": cell["executionCount"], "outputs": outputs})
        notebook_cells.append(ipynb_cell)
    notebook_ipynb = {
        "cells": notebook_cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3 (Pyodide)", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.13"},
            "skyviewlab": {"workspaceId": workspace["id"], "notebookId": active_notebook["id"]},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    return {
        "workspaceJson": json.dumps(compatible, ensure_ascii=False, indent=2),
        "manifestCsv": manifest_buffer.getvalue(),
        "runHistoryCsv": runs_buffer.getvalue(),
        "analysisMarkdown": report,
        "backupJson": json.dumps(backup, ensure_ascii=False, indent=2),
        "notebookIpynb": json.dumps(notebook_ipynb, ensure_ascii=False, indent=2),
    }


def _result(workspace: dict[str, Any], stage: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    analysis = _analysis(workspace)
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "version": 4,
        "stage": stage,
        "workspace": workspace,
        "templates": TEMPLATES,
        "analysis": analysis,
        "runtime": {
            "browserRuntime": "Pyodide 0.28.3",
            "browserExecutionEnabled": True,
            "workerTerminationStopsExecution": True,
            "serverCodeExecutionEnabled": False,
            "serverArbitraryCodeExecution": False,
            "packageInstallMode": "browser-micropip",
            "persistentPythonFileSystem": False,
            "browserRunEvidenceVerified": False,
            "editor": "Monaco Editor 0.56.0",
            "terminal": "xterm.js 5.5.0",
            "productionKernelAdapter": "JupyterHub/Jupyter Server",
            "productionIsolation": "KubeSpawner single-user pods",
        },
        "exports": _exports(workspace, analysis),
    }
    if extra:
        result.update(extra)
    return result


def _touch(workspace: dict[str, Any]) -> None:
    workspace["revision"] = int(workspace.get("revision", 0)) + 1
    workspace["updatedAt"] = _now()


def run_python_lab(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "run":
        # Backward-compatible development-only route. Production remains fail-closed.
        from app.tools.teaching import python_lab as legacy_python_lab
        return legacy_python_lab(action, payload)
    if action in {"load-sample", "run-all"}:
        return _result(_baseline_workspace(), action)

    workspace = _workspace_from_payload(payload)
    if action in {"validate-workspace", "export"}:
        return _result(workspace, action)
    if action == "save-file":
        path = _normalize_path(payload.get("path"))
        if path not in workspace["files"]:
            raise ToolError("要保存的文件不存在")
        content = _clean(payload.get("content"), MAX_FILE_CHARS)
        workspace["files"][path] = content
        current = workspace["fileRevisions"].get(path, {"revision": 0})
        workspace["fileRevisions"][path] = {"revision": int(current.get("revision", 0)) + 1, "checksum": _checksum(content), "updatedAt": _now()}
        workspace["folders"] = _folders_for(workspace["files"], workspace["folders"])
        _validate_files(workspace["files"])
        _touch(workspace)
        return _result(workspace, action)
    if action == "create-file":
        path = _normalize_path(payload.get("path"))
        if not path:
            raise ToolError("文件路径不能为空")
        if path in workspace["files"]:
            raise ToolError("文件已经存在")
        workspace["files"][path] = _clean(payload.get("content"), MAX_FILE_CHARS)
        workspace["folders"] = _folders_for(workspace["files"], workspace["folders"])
        _validate_files(workspace["files"])
        workspace["openFiles"] = [path, *workspace["openFiles"]][:20]
        workspace["activePath"] = path
        workspace["fileRevisions"][path] = {"revision": 1, "checksum": _checksum(workspace["files"][path]), "updatedAt": _now()}
        _touch(workspace)
        return _result(workspace, action)
    if action == "create-folder":
        path = _normalize_path(payload.get("path"))
        if not path:
            raise ToolError("文件夹路径不能为空")
        folders = set(workspace["folders"])
        parent = PurePosixPath(path)
        while str(parent) not in {"", "."}:
            folders.add(str(parent))
            parent = parent.parent
        if len(folders) > MAX_FOLDERS:
            raise ToolError(f"工作区最多支持 {MAX_FOLDERS} 个文件夹")
        workspace["folders"] = sorted(folders)
        workspace["expandedFolders"] = sorted(set(workspace["expandedFolders"] + [path]))
        _touch(workspace)
        return _result(workspace, action)
    if action == "rename-path":
        old_path = _normalize_path(payload.get("oldPath"))
        new_path = _normalize_path(payload.get("newPath"))
        if not old_path or not new_path or old_path == new_path:
            raise ToolError("重命名路径无效")
        is_file = old_path in workspace["files"]
        prefix = old_path + "/"
        if not is_file and old_path not in workspace["folders"]:
            raise ToolError("要重命名的路径不存在")
        replacements: dict[str, str] = {}
        for path in workspace["files"]:
            if path == old_path:
                replacements[path] = new_path
            elif path.startswith(prefix):
                replacements[path] = new_path + "/" + path[len(prefix):]
        if any(target in workspace["files"] and target not in replacements for target in replacements.values()):
            raise ToolError("目标路径已存在")
        for source, target in replacements.items():
            workspace["files"][target] = workspace["files"].pop(source)
            if source in workspace["fileRevisions"]:
                workspace["fileRevisions"][target] = workspace["fileRevisions"].pop(source)
        workspace["folders"] = sorted({new_path if item == old_path else new_path + "/" + item[len(prefix):] if item.startswith(prefix) else item for item in workspace["folders"]})
        workspace["folders"] = _folders_for(workspace["files"], workspace["folders"])
        workspace["openFiles"] = [replacements.get(item, item) for item in workspace["openFiles"]]
        workspace["activePath"] = replacements.get(workspace["activePath"], workspace["activePath"])
        workspace["expandedFolders"] = [new_path if item == old_path else new_path + "/" + item[len(prefix):] if item.startswith(prefix) else item for item in workspace["expandedFolders"]]
        _touch(workspace)
        return _result(workspace, action)
    if action == "delete-path":
        path = _normalize_path(payload.get("path"))
        if not path:
            raise ToolError("删除路径不能为空")
        prefix = path + "/"
        removed = [item for item in workspace["files"] if item == path or item.startswith(prefix)]
        if not removed and path not in workspace["folders"]:
            raise ToolError("要删除的路径不存在")
        if len(removed) == len(workspace["files"]):
            raise ToolError("工作区至少需要保留一个文件")
        for item in removed:
            workspace["files"].pop(item, None)
            workspace["fileRevisions"].pop(item, None)
        workspace["folders"] = [item for item in workspace["folders"] if item != path and not item.startswith(prefix)]
        workspace["openFiles"] = [item for item in workspace["openFiles"] if item in workspace["files"]]
        if not workspace["openFiles"]:
            workspace["openFiles"] = [next(iter(workspace["files"]))]
        if workspace["activePath"] not in workspace["files"]:
            workspace["activePath"] = workspace["openFiles"][0]
        _touch(workspace)
        return _result(workspace, action)
    if action == "apply-template":
        template_id = _clean(payload.get("templateId"), 50)
        template = next((item for item in TEMPLATES if item["id"] == template_id), None)
        if not template:
            raise ToolError("示例模板不存在")
        path = workspace["activePath"]
        workspace["files"][path] = template["content"]
        workspace["fileRevisions"][path] = {"revision": int(workspace["fileRevisions"].get(path, {}).get("revision", 0)) + 1, "checksum": _checksum(template["content"]), "updatedAt": _now()}
        _touch(workspace)
        return _result(workspace, action, {"appliedTemplate": template_id})
    if action == "save-notebook":
        notebooks = _validate_notebooks([payload.get("notebook")])
        notebook = notebooks[0]
        existing_ids = {item["id"] for item in workspace["notebooks"]}
        if notebook["id"] not in existing_ids and len(workspace["notebooks"]) >= 12:
            raise ToolError("Notebook 数量已达到上限")
        workspace["notebooks"] = [
            notebook if item["id"] == notebook["id"] else item
            for item in workspace["notebooks"]
        ]
        if notebook["id"] not in existing_ids:
            workspace["notebooks"].append(notebook)
        workspace["activeNotebookId"] = notebook["id"]
        _touch(workspace)
        return _result(workspace, action, {"savedNotebookId": notebook["id"]})
    if action == "record-cell-run":
        notebook_id = _clean(payload.get("notebookId"), 100)
        cell_id = _clean(payload.get("cellId"), 100)
        notebook = next((item for item in workspace["notebooks"] if item["id"] == notebook_id), None)
        if not notebook:
            raise ToolError("Notebook 不存在")
        cell = next((item for item in notebook["cells"] if item["id"] == cell_id), None)
        if not cell or cell["type"] != "code":
            raise ToolError("要记录的代码单元不存在")
        status = _clean(payload.get("status"), 20)
        if status not in {"succeeded", "failed", "stopped"}:
            raise ToolError("代码单元运行状态无效")
        raw_outputs = payload.get("outputs", [])
        if not isinstance(raw_outputs, list):
            raise ToolError("代码单元输出格式无效")
        outputs = [_validate_notebook_output(item) for item in raw_outputs[:12]]
        cell["status"] = "succeeded" if status == "succeeded" else "failed"
        cell["executionCount"] = max(1, min(100_000, int(payload.get("executionCount", 1) or 1)))
        cell["outputs"] = outputs
        notebook["updatedAt"] = _now()
        variables = payload.get("variables", [])
        safe_variables = []
        if isinstance(variables, list):
            for item in variables[:40]:
                if isinstance(item, dict):
                    safe_variables.append({
                        "name": _clean(item.get("name"), 100),
                        "type": _clean(item.get("type"), 100),
                        "value": _clean(item.get("value"), 500),
                    })
        evidence = "\n".join([
            _clean(payload.get("stdout"), 12_000),
            _clean(payload.get("stderr"), 12_000),
            json.dumps(safe_variables, ensure_ascii=False),
        ])
        for check in workspace["course"]["checks"]:
            if check["id"] == "records" and ("records" in evidence and all(token in evidence for token in ["A", "B", "C"])):
                check["passed"] = True
            elif check["id"] == "average" and "0.62" in evidence:
                check["passed"] = True
            elif check["id"] == "high-risk" and ("high_risk" in evidence or "高风险" in evidence) and "B" in evidence:
                check["passed"] = True
        run = {
            "id": _uid("run-browser-cell"),
            "entryPath": f"notebook:{notebook_id}#{cell_id}",
            "command": f"运行代码单元 {cell_id}",
            "status": status,
            "exitCode": int(payload.get("exitCode", 0)),
            "durationMs": max(0, min(600_000, float(payload.get("durationMs", 0)))),
            "stdoutPreview": _clean(payload.get("stdout"), 12_000),
            "stderrPreview": _clean(payload.get("stderr"), 12_000),
            "runtime": "Pyodide 0.28.3 notebook kernel",
            "evidenceSource": "browser-local",
            "verified": False,
            "createdAt": _now(),
        }
        workspace["runs"] = [run, *workspace["runs"]][:MAX_RUNS]
        _touch(workspace)
        return _result(workspace, action, {"recordedRun": run, "savedNotebookId": notebook_id})
    if action == "update-run-config":
        entry = _normalize_path(payload.get("entryPath"))
        if entry not in workspace["files"] or not entry.endswith(".py"):
            raise ToolError("入口必须是工作区内的 Python 文件")
        argv = payload.get("argv", [])
        env = payload.get("env", {})
        if not isinstance(argv, list) or not isinstance(env, dict):
            raise ToolError("运行参数格式无效")
        normalized_env: dict[str, str] = {}
        for key, value in env.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)):
                raise ToolError("环境变量名称无效")
            normalized_env[str(key)] = _clean(value, 500)
        workspace["runConfig"] = {
            "entryPath": entry,
            "stdin": _clean(payload.get("stdin"), 20_000),
            "argv": [_clean(item, 200) for item in argv][:40],
            "env": normalized_env,
        }
        _touch(workspace)
        return _result(workspace, action)
    if action == "install-package":
        package = _clean(payload.get("package"), 120).strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_,.-]+\])?(?:==[A-Za-z0-9_.+-]+)?", package):
            raise ToolError("包名称格式无效")
        workspace["installedPackages"] = sorted(set(workspace["installedPackages"] + [package]))[:50]
        _touch(workspace)
        return _result(workspace, action)
    if action == "record-run":
        status = _clean(payload.get("status"), 30)
        if status not in {"succeeded", "failed", "stopped"}:
            raise ToolError("运行状态无效")
        run = {
            "id": _uid("run-browser"),
            "entryPath": _normalize_path(payload.get("entryPath")) or workspace["activePath"],
            "command": _clean(payload.get("command"), 500),
            "status": status,
            "exitCode": int(payload.get("exitCode", 0)),
            "durationMs": max(0, min(600_000, float(payload.get("durationMs", 0)))),
            "stdoutPreview": _clean(payload.get("stdout"), 12_000),
            "stderrPreview": _clean(payload.get("stderr"), 12_000),
            "runtime": _clean(payload.get("runtime"), 100) or "Pyodide 0.28.3",
            "evidenceSource": "browser-local",
            "verified": False,
            "createdAt": _now(),
        }
        workspace["runs"] = [run, *workspace["runs"]][:MAX_RUNS]
        _touch(workspace)
        return _result(workspace, action, {"recordedRun": run})
    if action == "create-snapshot":
        data = _snapshot_payload(workspace)
        snapshot = {
            "id": _uid("snapshot"),
            "label": _clean(payload.get("label"), 120) or f"工作区快照 {len(workspace['snapshots']) + 1}",
            "checksum": _checksum(data),
            "createdAt": _now(),
            "immutable": True,
            "payload": data,
        }
        workspace["snapshots"] = [snapshot, *workspace["snapshots"]][:20]
        _touch(workspace)
        return _result(workspace, action, {"createdSnapshot": snapshot})
    if action == "restore-snapshot":
        snapshot_id = _clean(payload.get("snapshotId"), 100)
        snapshot = next((item for item in workspace["snapshots"] if item.get("id") == snapshot_id), None)
        if not snapshot or not isinstance(snapshot.get("payload"), dict):
            raise ToolError("快照不存在或不可恢复")
        preserved_snapshots = workspace["snapshots"]
        preserved_runs = workspace["runs"]
        restored = _normalize_workspace(snapshot["payload"])
        restored.update({"id": workspace["id"], "title": workspace["title"], "snapshots": preserved_snapshots, "runs": preserved_runs})
        _touch(restored)
        return _result(restored, action, {"restoredSnapshotId": snapshot_id})
    if action == "import-workspace":
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ToolError("导入文件为空")
        if len(content.encode("utf-8")) > MAX_WORKSPACE_BYTES:
            raise ToolError("导入文件超过工作区上限")
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ToolError(f"工作区 JSON 格式错误：{exc.msg}") from exc
        if isinstance(parsed, dict) and parsed.get("schema") == "skyview-python-lab-backup":
            parsed = parsed.get("workspace")
        imported = _normalize_workspace(parsed)
        imported["id"] = _uid("python-workspace")
        imported["title"] = _clean(payload.get("title"), 120) or "导入的 Python 工作区"
        imported["runs"] = []
        imported["snapshots"] = []
        imported["revision"] = 1
        imported["updatedAt"] = _now()
        return _result(imported, action, {"importSummary": {"files": len(imported["files"]), "executionStarted": False, "runHistoryImported": False}})
    raise ToolError("不支持的 Python 实验室操作")
