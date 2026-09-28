from __future__ import annotations

import ast
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import PurePosixPath
from typing import Any

from app.config import settings
from app.tools.common import ToolError, mean, number, parse_json, require_text, tokenize


BLOCKED_MODULES = {
    "ctypes", "http", "multiprocessing", "os", "pathlib", "shutil", "socket",
    "subprocess", "sys", "urllib", "winreg",
}
BLOCKED_CALLS = {"breakpoint", "compile", "eval", "exec", "globals", "help", "locals", "open", "vars", "__import__"}


def _validate_python_source(source: str) -> None:
    if len(source) > 20_000:
        raise ToolError("代码最多 20000 个字符")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise ToolError(f"语法错误：第 {exc.lineno} 行 {exc.msg}") from exc
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name.split(".")[0] for alias in node.names] if isinstance(node, ast.Import) else [str(node.module or "").split(".")[0]]
            if any(name in BLOCKED_MODULES for name in names):
                raise ToolError("本地练习运行器禁止系统、网络和进程模块")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in BLOCKED_CALLS:
            raise ToolError(f"本地练习运行器禁止调用 {node.func.id}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ToolError("本地练习运行器禁止访问双下划线属性")
        if isinstance(node, ast.Name) and node.id in {"__builtins__", "__loader__", "__spec__"}:
            raise ToolError("本地练习运行器禁止访问解释器内部对象")


def _run_python(source: str, stdin: str) -> dict[str, Any]:
    if not settings.unsafe_local_code_execution_enabled:
        raise ToolError(
            "同机代码执行默认关闭；生产环境必须接入隔离沙箱运行时",
            code="UNSAFE_LOCAL_RUNTIME_DISABLED",
            status_code=503,
        )
    _validate_python_source(source)
    if len(stdin) > 20_000:
        raise ToolError("标准输入最多 20000 个字符")
    started = time.perf_counter()
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with tempfile.TemporaryDirectory(prefix="skyviewlab-python-") as directory:
        environment = {"PYTHONIOENCODING": "utf-8", "PYTHONHASHSEED": "0"}
        try:
            completed = subprocess.run(
                [sys.executable, "-I", "-S", "-c", source],
                input=stdin,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=4,
                cwd=directory,
                env=environment,
                creationflags=creation_flags,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ToolError("运行超过 4 秒，已停止") from exc
    return {
        "exitCode": completed.returncode,
        "stdout": completed.stdout[:50_000],
        "stderr": completed.stderr[:50_000],
        "durationMs": round((time.perf_counter() - started) * 1_000, 2),
        "runtime": f"Python {sys.version_info.major}.{sys.version_info.minor}",
        "executionMode": "unsafe-development-prototype",
        "prototype": True,
        "productionSandbox": False,
        "warning": "该结果来自显式启用的同机开发运行器，不是容器沙箱，不得用于生产判定。",
    }


def python_lab(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "run":
        raise ToolError("不支持的 Python 操作")
    return _run_python(require_text(payload, "code", max_length=20_000), str(payload.get("stdin", "")))


def daily_practice(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "grade":
        raise ToolError("不支持的练习操作")
    expected = [line.strip() for line in require_text(payload, "expected").splitlines() if line.strip()]
    answers = [line.strip() for line in str(payload.get("answers", "")).splitlines()]
    details = []
    for index, correct_answer in enumerate(expected):
        answer = answers[index] if index < len(answers) else ""
        correct = answer.casefold() == correct_answer.casefold()
        details.append({"question": index + 1, "answer": answer, "expected": correct_answer, "correct": correct})
    correct_count = sum(item["correct"] for item in details)
    percent = round(correct_count / len(expected) * 100)
    return {"correct": correct_count, "total": len(expected), "percent": percent, "passed": percent >= 70, "details": details}


def project_workspace(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    tasks = parse_json(payload.get("tasks"), fallback=[])
    if not isinstance(tasks, list):
        raise ToolError("tasks 必须是 JSON 数组")
    normalized = []
    for index, item in enumerate(tasks):
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            continue
        normalized.append({
            "id": str(item.get("id", f"task-{index + 1}")),
            "title": str(item.get("title", "未命名任务")),
            "status": str(item.get("status", "todo")),
            "owner": str(item.get("owner", "")),
            "dueAt": item.get("dueAt"),
        })
    if action == "validate":
        duplicates = [task_id for task_id, count in Counter(task["id"] for task in normalized).items() if count > 1]
        return {"valid": not duplicates, "duplicates": duplicates, "tasks": len(normalized)}
    if action != "summary":
        raise ToolError("不支持的项目操作")
    by_status = Counter(task["status"] for task in normalized)
    completed = by_status.get("done", 0) + by_status.get("completed", 0)
    return {
        "total": len(normalized),
        "completed": completed,
        "progress": round(completed / max(1, len(normalized)) * 100),
        "byStatus": dict(by_status),
        "unassigned": sum(not task["owner"] for task in normalized),
        "tasks": normalized,
    }


def _parse_table(source: str) -> tuple[list[str], list[dict[str, str]]]:
    try:
        dialect = csv.Sniffer().sniff(source[:4_096], delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(source), dialect=dialect)
    if not reader.fieldnames:
        raise ToolError("未识别到表头")
    rows = [{str(key): str(value or "") for key, value in row.items() if key is not None} for row in reader]
    return [str(field) for field in reader.fieldnames], rows


def data_lab(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "clean":
        raise ToolError("不支持的数据清洗操作")
    source = require_text(payload, "csv")
    fields, rows = _parse_table(source)
    operations = parse_json(payload.get("operations"), fallback=["trim", "remove-empty", "deduplicate"])
    if not isinstance(operations, list):
        raise ToolError("operations 必须是 JSON 数组")
    allowed = {"trim", "collapse-whitespace", "remove-empty", "deduplicate"}
    unknown = [str(operation) for operation in operations if str(operation) not in allowed]
    if unknown:
        raise ToolError(f"不支持的操作：{', '.join(unknown)}")
    audit = []
    current = rows
    if "trim" in operations or "collapse-whitespace" in operations:
        changed = 0
        cleaned = []
        for row in current:
            output = {}
            for key, value in row.items():
                new_value = value.strip()
                if "collapse-whitespace" in operations:
                    new_value = re.sub(r"\s+", " ", new_value)
                changed += new_value != value
                output[key] = new_value
            cleaned.append(output)
        current = cleaned
        audit.append({"operation": "normalize-text", "affected": changed})
    if "remove-empty" in operations:
        before = len(current)
        current = [row for row in current if any(value != "" for value in row.values())]
        audit.append({"operation": "remove-empty", "affected": before - len(current)})
    if "deduplicate" in operations:
        seen = set()
        deduplicated = []
        for row in current:
            key = tuple(row.get(field, "") for field in fields)
            if key not in seen:
                seen.add(key)
                deduplicated.append(row)
        audit.append({"operation": "deduplicate", "affected": len(current) - len(deduplicated)})
        current = deduplicated
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows(current)
    return {"inputRows": len(rows), "outputRows": len(current), "fields": fields, "audit": audit, "csv": output.getvalue()}


def _material_chunks(material: str) -> list[str]:
    return [chunk.strip() for chunk in re.split(r"\n\s*\n|(?<=[。！？.!?])\s+", material) if chunk.strip()]


def ai_report(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    material = require_text(payload, "material")
    title = str(payload.get("title", "材料分析报告")).strip() or "材料分析报告"
    chunks = _material_chunks(material)
    if action == "draft":
        query_terms = set(tokenize(str(payload.get("focus", title))))
        ranked = sorted(
            enumerate(chunks),
            key=lambda item: sum(tokenize(item[1]).count(term) for term in query_terms),
            reverse=True,
        )[:8]
        evidence = [{"label": f"S1.{index + 1}", "text": chunk} for index, chunk in ranked]
        body = "\n\n".join(f"- {item['text']} [{item['label']}]" for item in evidence)
        report = f"# {title}\n\n## 依据材料\n\n{body}\n\n## 局限\n\n本报告只依据当前提交材料，需要人工核对原文与数据。"
        return {"report": report, "evidence": evidence, "mode": "extractive-server"}
    if action != "audit":
        raise ToolError("不支持的报告操作")
    report = require_text(payload, "report")
    labels = set(re.findall(r"\[(S\d+\.\d+)\]", report))
    valid = {f"S1.{index + 1}" for index in range(len(chunks))}
    invalid = sorted(labels - valid)
    issues = []
    if not labels:
        issues.append({"level": "high", "message": "报告没有材料引用"})
    if invalid:
        issues.append({"level": "high", "message": f"存在 {len(invalid)} 个无效引用"})
    if not re.search(r"局限|不确定|limitation|uncertain", report, re.IGNORECASE):
        issues.append({"level": "medium", "message": "没有说明局限或不确定性"})
    return {"passed": not any(item["level"] == "high" for item in issues), "citations": len(labels), "invalid": invalid, "issues": issues}


def python_english(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "grade":
        raise ToolError("不支持的 Python English 操作")
    questions = parse_json(payload.get("questions"), fallback=[])
    answers = parse_json(payload.get("answers"), fallback=[])
    if not isinstance(questions, list) or not isinstance(answers, list) or not questions:
        raise ToolError("questions 和 answers 必须是 JSON 数组")
    details = []
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            continue
        expected = str(question.get("answer", "")).casefold().strip()
        answer = str(answers[index] if index < len(answers) else "").casefold().strip()
        details.append({"question": question.get("term", index + 1), "correct": answer == expected, "expected": question.get("answer", "")})
    correct = sum(item["correct"] for item in details)
    percent = round(correct / max(1, len(details)) * 100)
    return {"correct": correct, "total": len(details), "percent": percent, "passed": percent >= 70, "details": details}


def _source_review(source: str, language: str) -> dict[str, Any]:
    lines = source.splitlines()
    findings = []
    if len([line for line in lines if line.strip()]) < 3:
        findings.append({"level": "warning", "message": "实现过短，请检查输入和边界条件"})
    if any(len(line) > 120 for line in lines):
        findings.append({"level": "info", "message": "存在超过 120 字符的代码行"})
    if re.search(r"\b(TODO|FIXME|pass)\b", source, re.IGNORECASE):
        findings.append({"level": "warning", "message": "代码包含未完成标记"})
    if "python" in language.lower() and re.search(r"except\s*:", source):
        findings.append({"level": "warning", "message": "裸 except 会掩盖错误类型"})
    if not findings:
        findings.append({"level": "success", "message": "未发现明显的基础问题"})
    return {"lines": len(lines), "characters": len(source), "findings": findings}


def ai_assessment(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    source = require_text(payload, "code", max_length=20_000)
    language = str(payload.get("language", "Python"))
    if action == "review":
        return _source_review(source, language)
    if action == "run" and language.casefold() == "python":
        return _run_python(source, str(payload.get("stdin", "")))
    raise ToolError("当前本地运行器只执行 Python；其他语言请接入 Judge0")


def project_submission(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "manifest":
        raise ToolError("不支持的项目提交操作")
    files = parse_json(payload.get("files"), fallback=[])
    if not isinstance(files, list) or not files:
        raise ToolError("files 必须是非空 JSON 数组")
    manifest = []
    issues = []
    total = 0
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            continue
        path = str(item.get("path", "")).replace("\\", "/").strip()
        content = str(item.get("content", ""))
        pure_path = PurePosixPath(path)
        if not path or path.startswith("/") or ".." in pure_path.parts:
            issues.append({"level": "error", "message": f"第 {index + 1} 个文件路径不安全"})
            continue
        encoded = content.encode("utf-8")
        total += len(encoded)
        manifest.append({"path": path, "size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest()})
    if not any(item["path"].lower().startswith("readme") for item in manifest):
        issues.append({"level": "warning", "message": "项目缺少 README"})
    return {"valid": not any(item["level"] == "error" for item in issues), "files": len(manifest), "totalBytes": total, "manifest": manifest, "issues": issues}
