from __future__ import annotations

import copy
import csv
import hashlib
import io
import json
import re
import uuid
from collections import Counter, deque
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError

SCHEMA = "skyview-research-automation-results"
WORKFLOW_SCHEMA = "skyview-research-workflow"
FIXED_TIME = "2026-09-09T00:00:00Z"
NODE_TYPES = ("trigger", "source", "transform", "analysis", "review", "output")
NODE_LABELS = {
    "trigger": "触发",
    "source": "数据源",
    "transform": "转换",
    "analysis": "分析",
    "review": "人工复核",
    "output": "输出",
}
FORBIDDEN_CONFIG_KEYS = {
    "script", "command", "code", "token", "secret", "password", "apikey",
    "api_key", "credential", "privatekey", "private_key",
}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _clean(value: Any, limit: int = 500) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _safe_csv(value: Any) -> str:
    text = str(value or "")
    return f"'{text}" if text[:1] in {"=", "+", "-", "@"} else text


def _sanitize_config(value: Any) -> dict[str, Any]:
    if value in (None, ""):
        return {}
    if isinstance(value, str):
        return {"summary": _clean(value, 500)}
    if not isinstance(value, dict):
        raise ToolError("节点配置必须是对象或说明文本")
    output: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = _clean(raw_key, 80)
        if not key or key.lower().replace("-", "_") in FORBIDDEN_CONFIG_KEYS:
            raise ToolError(f"节点配置不允许包含 {key or '空键'}")
        if isinstance(raw_value, (dict, list)):
            encoded = json.dumps(raw_value, ensure_ascii=False)
            if len(encoded) > 2_000:
                raise ToolError(f"节点配置 {key} 内容过长")
            output[key] = copy.deepcopy(raw_value)
        elif isinstance(raw_value, (str, int, float, bool)) or raw_value is None:
            output[key] = _clean(raw_value, 1_000) if isinstance(raw_value, str) else raw_value
        else:
            raise ToolError(f"节点配置 {key} 类型不受支持")
    return output


def _node(
    node_id: str,
    node_type: str,
    name: str,
    depends_on: list[str],
    summary: str,
    x: int,
    y: int,
    *,
    approval: bool = False,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": node_type,
        "name": name,
        "dependsOn": depends_on,
        "enabled": True,
        "config": {"summary": summary},
        "position": {"x": x, "y": y},
        "retryPolicy": {"maxAttempts": 3 if node_type in {"source", "analysis"} else 1, "backoffSeconds": 5},
        "timeoutSeconds": 120,
        "approvalRequired": approval,
    }


def _template(template_id: str) -> dict[str, Any]:
    definitions: dict[str, tuple[str, str, list[tuple[str, str]]]] = {
        "literature": (
            "系统综述材料流水线",
            "导入文献、去重、筛选、证据提取与报告。",
            [("trigger", "手动启动"), ("source", "导入文献清单"), ("transform", "DOI 与题名去重"), ("review", "纳入排除筛选"), ("analysis", "证据提取"), ("output", "生成综述表")],
        ),
        "remote": (
            "遥感证据日报",
            "影像进入、质量检查、变化分析、复核与日报。",
            [("trigger", "新影像触发"), ("source", "读取影像元数据"), ("transform", "质量与云量检查"), ("analysis", "变化区域检测"), ("review", "人工判读"), ("output", "生成证据日报")],
        ),
        "experiment": (
            "可复现实验流水线",
            "数据版本、参数、实验、指标、复核与归档。",
            [("trigger", "版本发布触发"), ("source", "锁定数据版本"), ("transform", "预处理与特征"), ("analysis", "运行实验"), ("analysis", "计算指标"), ("review", "结果复核"), ("output", "归档实验报告")],
        ),
    }
    if template_id not in definitions:
        raise ToolError("工作流模板不存在")
    name, description, definitions_nodes = definitions[template_id]
    nodes: list[dict[str, Any]] = []
    previous: str | None = None
    for index, (node_type, node_name) in enumerate(definitions_nodes):
        node_id = f"{template_id}-{index + 1:02d}"
        nodes.append(_node(node_id, node_type, node_name, [previous] if previous else [], node_name, 90 + index * 190, 120 + (index % 2) * 105, approval=node_type == "review"))
        previous = node_id
    return {
        "id": f"workflow-{template_id}",
        "name": name,
        "description": description,
        "status": "template",
        "schedule": {"enabled": False, "expression": "手动", "timeZone": "Asia/Shanghai"},
        "retries": 2,
        "timeoutSeconds": 900,
        "concurrencyPolicy": "forbid-overlap",
        "variables": [],
        "secretRefs": [],
        "nodes": nodes,
        "createdAt": FIXED_TIME,
        "updatedAt": FIXED_TIME,
    }


def _main_workflow() -> dict[str, Any]:
    nodes = [
        _node("node-start", "trigger", "定时触发", [], "每周规则草案", 70, 120),
        _node("node-source", "source", "读取材料清单", ["node-start"], "本地文献目录", 250, 120),
        _node("node-quality", "transform", "质量与重复检查", ["node-source"], "题名、年份、来源必填", 430, 120),
        _node("node-analysis", "analysis", "主题与方法分析", ["node-quality"], "按任务、数据和方法聚类", 610, 120),
        _node("node-review", "review", "人工复核", ["node-analysis"], "复核高影响发现", 790, 120, approval=True),
        _node("node-output", "output", "生成研究雷达摘要", ["node-review"], "Markdown 与结构化清单", 970, 120),
    ]
    return {
        "id": "workflow-radar",
        "name": "AI+矿山安全研究雷达",
        "description": "定期整理研究材料，完成质量检查、主题分析、人工复核和摘要输出。",
        "status": "draft",
        "schedule": {"enabled": False, "expression": "每周一 09:00", "timeZone": "Asia/Shanghai"},
        "retries": 2,
        "timeoutSeconds": 900,
        "concurrencyPolicy": "forbid-overlap",
        "variables": [
            {"id": "var-topic", "key": "TOPIC", "value": "mine safety AI", "type": "string"},
            {"id": "var-limit", "key": "MAX_ITEMS", "value": "20", "type": "number"},
        ],
        "secretRefs": [
            {"id": "secret-source", "key": "LITERATURE_API", "provider": "environment", "reference": "research/literature-api", "configured": False},
        ],
        "nodes": nodes,
        "createdAt": FIXED_TIME,
        "updatedAt": FIXED_TIME,
    }


def _edges(workflow: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {"id": f"edge:{dependency}:{node['id']}", "source": dependency, "target": node["id"], "condition": "success"}
        for node in workflow["nodes"]
        for dependency in node.get("dependsOn", [])
    ]


def _step(node: dict[str, Any], status: str, index: int, *, attempts: int = 1, message: str = "执行成功") -> dict[str, Any]:
    return {
        "id": f"step-{node['id']}",
        "nodeId": node["id"],
        "name": node["name"],
        "type": node["type"],
        "status": status,
        "attempts": attempts,
        "durationMs": 34 + index * 17 + max(0, attempts - 1) * 23 if status not in {"pending", "skipped", "awaiting-approval"} else 0,
        "message": message,
        "startedAt": FIXED_TIME if status not in {"pending", "skipped"} else None,
        "finishedAt": FIXED_TIME if status in {"succeeded", "failed", "rejected"} else None,
    }


def _baseline_workspace() -> dict[str, Any]:
    workflow = _main_workflow()
    success_steps = [_step(node, "succeeded", index) for index, node in enumerate(workflow["nodes"])]
    success_run = {
        "id": "run-002",
        "workflowId": workflow["id"],
        "workflowVersion": 1,
        "mode": "deterministic-preview",
        "status": "succeeded",
        "trigger": "manual",
        "stepRuns": success_steps,
        "durationMs": sum(item["durationMs"] for item in success_steps),
        "createdAt": FIXED_TIME,
        "finishedAt": FIXED_TIME,
        "cancelRequested": False,
    }
    failed_steps = [
        _step(workflow["nodes"][0], "succeeded", 0),
        _step(workflow["nodes"][1], "succeeded", 1),
        _step(workflow["nodes"][2], "failed", 2, attempts=3, message="预览故障注入：重试后仍失败"),
        *[_step(node, "skipped", index, attempts=0, message="上游节点失败") for index, node in enumerate(workflow["nodes"][3:], start=3)],
    ]
    failed_run = {
        "id": "run-001",
        "workflowId": workflow["id"],
        "workflowVersion": 1,
        "mode": "deterministic-preview",
        "status": "failed",
        "trigger": "manual",
        "stepRuns": failed_steps,
        "durationMs": sum(item["durationMs"] for item in failed_steps),
        "createdAt": "2026-09-08T08:30:00Z",
        "finishedAt": "2026-09-08T08:30:01Z",
        "cancelRequested": False,
    }
    logs = []
    for run in (success_run, failed_run):
        for index, step_run in enumerate(run["stepRuns"]):
            logs.append({
                "id": f"log-{run['id']}-{index + 1}",
                "runId": run["id"],
                "stepRunId": step_run["id"],
                "level": "error" if step_run["status"] == "failed" else "info",
                "message": step_run["message"],
                "createdAt": run["createdAt"],
                "redacted": True,
            })
    return {
        "id": "automation-workspace-main",
        "name": "研究自动化流程库",
        "currentWorkflowId": workflow["id"],
        "selectedNodeId": "node-analysis",
        "currentRunId": success_run["id"],
        "workflows": [workflow],
        "templates": [{"id": item, "workflow": _template(item)} for item in ("literature", "remote", "experiment")],
        "versions": [{"id": "version-001", "workflowId": workflow["id"], "version": 1, "label": "初始流程基准", "checksum": _checksum(workflow), "createdAt": FIXED_TIME}],
        "runs": [success_run, failed_run],
        "logs": logs,
        "approvals": [{"id": "approval-001", "runId": success_run["id"], "nodeId": "node-review", "status": "approved", "decision": "通过", "actor": "本地基准审核人", "createdAt": FIXED_TIME}],
        "artifacts": [
            {"id": "artifact-report", "runId": success_run["id"], "nodeId": "node-output", "name": "研究雷达摘要.md", "mediaType": "text/markdown", "size": 2468, "checksum": "sha256:6a8b27d0", "createdAt": FIXED_TIME},
            {"id": "artifact-records", "runId": success_run["id"], "nodeId": "node-analysis", "name": "主题方法矩阵.json", "mediaType": "application/json", "size": 1834, "checksum": "sha256:291ed841", "createdAt": FIXED_TIME},
            {"id": "artifact-evidence", "runId": success_run["id"], "nodeId": "node-review", "name": "人工复核记录.json", "mediaType": "application/json", "size": 778, "checksum": "sha256:3109a744", "createdAt": FIXED_TIME},
        ],
        "lineage": [
            {"id": "lineage-01", "from": "input:literature-catalog", "to": "artifact-records", "relation": "generated-by", "nodeId": "node-analysis"},
            {"id": "lineage-02", "from": "artifact-records", "to": "artifact-evidence", "relation": "reviewed-by", "nodeId": "node-review"},
            {"id": "lineage-03", "from": "artifact-evidence", "to": "artifact-report", "relation": "summarized-by", "nodeId": "node-output"},
        ],
        "createdAt": FIXED_TIME,
        "updatedAt": FIXED_TIME,
    }


def _checksum(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _workflow(workspace: dict[str, Any]) -> dict[str, Any]:
    workflow_id = workspace.get("currentWorkflowId")
    for item in workspace.get("workflows", []):
        if item.get("id") == workflow_id:
            return item
    if workspace.get("workflows"):
        workspace["currentWorkflowId"] = workspace["workflows"][0]["id"]
        return workspace["workflows"][0]
    workflow = _main_workflow()
    workspace["workflows"] = [workflow]
    workspace["currentWorkflowId"] = workflow["id"]
    return workflow


def _validate(workflow: dict[str, Any]) -> dict[str, Any]:
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return {"valid": False, "order": [], "messages": [{"type": "error", "message": "工作流至少需要一个节点"}]}
    messages: list[dict[str, str]] = []
    ids = [_clean(item.get("id"), 100) for item in nodes if isinstance(item, dict)]
    if len(ids) != len(nodes) or any(not item for item in ids):
        messages.append({"type": "error", "message": "每个节点都必须具有有效 ID"})
    if len(set(ids)) != len(ids):
        messages.append({"type": "error", "message": "节点 ID 不能重复"})
    node_map = {item.get("id"): item for item in nodes if isinstance(item, dict)}
    indegree = {node_id: 0 for node_id in node_map}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_map}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if node.get("type") not in NODE_TYPES:
            messages.append({"type": "error", "message": f"{_clean(node.get('name')) or node.get('id')} 使用了未授权节点类型"})
        for dependency in node.get("dependsOn", []):
            if dependency not in node_map:
                messages.append({"type": "error", "message": f"{_clean(node.get('name'))}: 依赖节点不存在 ({dependency})"})
                continue
            indegree[node["id"]] += 1
            outgoing[dependency].append(node["id"])
    queue = deque(node_id for node_id, degree in indegree.items() if degree == 0)
    order: list[str] = []
    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(order) != len(node_map):
        messages.append({"type": "error", "message": "流程存在循环依赖"})
    if not any(node.get("type") == "trigger" for node in nodes):
        messages.append({"type": "warning", "message": "没有触发节点，只能手动执行"})
    if not any(node.get("type") == "output" for node in nodes):
        messages.append({"type": "warning", "message": "没有输出节点，无法形成交付产物"})
    if not any(item["type"] == "error" for item in messages):
        messages.append({"type": "pass", "message": "节点、依赖与白名单类型检查通过"})
    return {"valid": not any(item["type"] == "error" for item in messages), "order": order, "messages": messages}


def _state(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("state")
    if isinstance(raw, dict) and isinstance(raw.get("workspace"), dict):
        workspace = copy.deepcopy(raw["workspace"])
    elif isinstance(payload.get("workspace"), dict):
        workspace = copy.deepcopy(payload["workspace"])
    else:
        workspace = _baseline_workspace()
    if not isinstance(workspace.get("workflows"), list):
        raise ToolError("工作流空间格式不正确")
    workspace.setdefault("templates", [{"id": item, "workflow": _template(item)} for item in ("literature", "remote", "experiment")])
    for key in ("versions", "runs", "logs", "approvals", "artifacts", "lineage"):
        workspace.setdefault(key, [])
    _workflow(workspace)
    return workspace


def _exportable_workflow(workflow: dict[str, Any]) -> dict[str, Any]:
    exported = copy.deepcopy(workflow)
    exported["variables"] = [item for item in exported.get("variables", []) if not item.get("secret")]
    exported["secretRefs"] = [
        {"id": item.get("id"), "key": item.get("key"), "provider": item.get("provider"), "reference": item.get("reference"), "configured": bool(item.get("configured"))}
        for item in exported.get("secretRefs", [])
    ]
    return exported


def _exports(workspace: dict[str, Any], analysis: dict[str, Any]) -> dict[str, str]:
    workflow = _workflow(workspace)
    workflow_json = json.dumps({"schema": WORKFLOW_SCHEMA, "version": 1, "workflow": _exportable_workflow(workflow), "exportedAt": _now()}, ensure_ascii=False, indent=2)
    run_buffer = io.StringIO()
    writer = csv.writer(run_buffer, lineterminator="\n")
    writer.writerow(["run_id", "workflow_id", "mode", "status", "duration_ms", "created_at"])
    for run in workspace["runs"]:
        writer.writerow([_safe_csv(run.get("id")), _safe_csv(run.get("workflowId")), run.get("mode"), run.get("status"), run.get("durationMs"), run.get("createdAt")])
    logs_ndjson = "\n".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in workspace["logs"])
    lineage_json = json.dumps({"schema": "skyview-workflow-lineage", "version": 1, "artifacts": workspace["artifacts"], "lineage": workspace["lineage"]}, ensure_ascii=False, indent=2)
    report = "\n".join([
        f"# {workflow['name']} 运行报告",
        "",
        f"- 当前版本：{len([item for item in workspace['versions'] if item.get('workflowId') == workflow['id']])}",
        f"- 节点：{len(workflow['nodes'])}",
        f"- 运行：{len(workspace['runs'])}",
        f"- 成功率：{analysis['metrics']['successRate']}%",
        f"- 待审批：{analysis['metrics']['pendingApprovals']}",
        "",
        "## 运行边界",
        "",
        "当前执行为确定性受控预览；未接入耐久调度、外部连接器或任意代码执行。",
    ])
    backup_json = json.dumps({"schema": "skyview-research-automation-backup", "version": 2, "workspace": workspace}, ensure_ascii=False, indent=2)
    return {"workflowJson": workflow_json, "runCsv": run_buffer.getvalue(), "logsNdjson": logs_ndjson, "lineageJson": lineage_json, "reportMarkdown": report, "backupJson": backup_json}


def _analysis(workspace: dict[str, Any]) -> dict[str, Any]:
    workflow = _workflow(workspace)
    validation = _validate(workflow)
    runs = [item for item in workspace["runs"] if item.get("workflowId") == workflow["id"]]
    succeeded = len([item for item in runs if item.get("status") == "succeeded"])
    completed = [item for item in runs if item.get("status") in {"succeeded", "failed", "canceled", "rejected"}]
    status_counts = Counter(item.get("status", "unknown") for item in runs)
    type_counts = Counter(item.get("type", "unknown") for item in workflow["nodes"])
    pending = len([item for item in workspace["approvals"] if item.get("status") == "pending"])
    return {
        "validation": validation,
        "metrics": {
            "workflows": len(workspace["workflows"]),
            "activeNodes": len([item for item in workflow["nodes"] if item.get("enabled") is not False]),
            "runs": len(runs),
            "successRate": round(succeeded / max(1, len(completed)) * 100),
            "averageDurationMs": round(sum(item.get("durationMs", 0) for item in completed) / max(1, len(completed))),
            "pendingApprovals": pending,
            "artifacts": len(workspace["artifacts"]),
        },
        "nodeTypeCounts": [{"id": item, "label": NODE_LABELS[item], "count": type_counts[item]} for item in NODE_TYPES],
        "statusCounts": [{"status": item, "count": status_counts[item]} for item in ("succeeded", "failed", "awaiting-approval", "canceled")],
        "durationSeries": [{"id": item.get("id"), "durationMs": item.get("durationMs", 0), "status": item.get("status"), "createdAt": item.get("createdAt")} for item in reversed(runs[:12])],
        "graph": {"nodes": copy.deepcopy(workflow["nodes"]), "edges": _edges(workflow)},
    }


def _result(workspace: dict[str, Any], stage: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    analysis = _analysis(workspace)
    result = {
        "schema": SCHEMA,
        "version": 2,
        "stage": stage,
        "workspace": workspace,
        "analysis": analysis,
        "runtime": {
            "executionMode": "deterministic-preview",
            "orchestration": "Go 项目、作业、版本与审计",
            "compute": "Python 白名单节点预览引擎",
            "arbitraryCodeExecution": False,
            "networkConnectorsConfigured": False,
            "persistentSchedulerConfigured": False,
            "durableWorkflowEngineConfigured": False,
            "secretValuesStored": False,
            "previewResultsPublishable": False,
        },
        "exports": _exports(workspace, analysis),
    }
    if extra:
        result.update(extra)
    return result


def _normalize_imported_workflow(raw: dict[str, Any]) -> tuple[dict[str, Any], int]:
    name = _clean(raw.get("name"), 120)
    nodes = raw.get("nodes")
    if not name or not isinstance(nodes, list) or not nodes:
        raise ToolError("流程文件缺少名称或节点")
    if len(nodes) > 60:
        raise ToolError("单个流程最多支持 60 个节点")
    normalized_nodes: list[dict[str, Any]] = []
    for index, raw_node in enumerate(nodes):
        if not isinstance(raw_node, dict):
            raise ToolError(f"第 {index + 1} 个节点格式不正确")
        node_type = _clean(raw_node.get("type"), 30)
        if node_type not in NODE_TYPES:
            raise ToolError(f"第 {index + 1} 个节点类型未进入白名单")
        node_id = _clean(raw_node.get("id"), 100) or f"import-node-{index + 1}"
        normalized_nodes.append({
            "id": node_id,
            "type": node_type,
            "name": _clean(raw_node.get("name"), 120) or node_id,
            "dependsOn": [_clean(item, 100) for item in raw_node.get("dependsOn", []) if _clean(item, 100)],
            "enabled": raw_node.get("enabled") is not False,
            "config": _sanitize_config(raw_node.get("config")),
            "position": {"x": int(raw_node.get("position", {}).get("x", 80 + index * 170)) if isinstance(raw_node.get("position"), dict) else 80 + index * 170, "y": int(raw_node.get("position", {}).get("y", 120)) if isinstance(raw_node.get("position"), dict) else 120},
            "retryPolicy": {"maxAttempts": min(5, max(1, int(raw_node.get("retryPolicy", {}).get("maxAttempts", 1)))) if isinstance(raw_node.get("retryPolicy"), dict) else 1, "backoffSeconds": 5},
            "timeoutSeconds": min(3_600, max(1, int(raw_node.get("timeoutSeconds", 120)))),
            "approvalRequired": node_type == "review" and raw_node.get("approvalRequired") is not False,
        })
    variables = []
    secret_refs = []
    stripped_secrets = 0
    for index, item in enumerate(raw.get("variables", [])):
        if not isinstance(item, dict):
            continue
        key = re.sub(r"[^A-Z0-9_]", "_", _clean(item.get("key"), 80).upper())
        if not key:
            continue
        if item.get("secret"):
            stripped_secrets += 1
            secret_refs.append({"id": f"import-secret-{index + 1}", "key": key, "provider": "unbound", "reference": "", "configured": False})
        else:
            variables.append({"id": f"import-var-{index + 1}", "key": key, "value": _clean(item.get("value"), 1_000), "type": "string"})
    workflow = {
        "id": _uid("workflow"),
        "name": f"{name}（导入）",
        "description": _clean(raw.get("description"), 1_000),
        "status": "draft",
        "schedule": {"enabled": False, "expression": _clean(raw.get("schedule", {}).get("expression") if isinstance(raw.get("schedule"), dict) else raw.get("schedule"), 120) or "手动", "timeZone": "Asia/Shanghai"},
        "retries": min(5, max(0, int(raw.get("retries", 2)))),
        "timeoutSeconds": min(7_200, max(30, int(raw.get("timeoutSeconds", 900)))),
        "concurrencyPolicy": "forbid-overlap",
        "variables": variables,
        "secretRefs": secret_refs,
        "nodes": normalized_nodes,
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    validation = _validate(workflow)
    if not validation["valid"]:
        raise ToolError("导入流程未通过依赖检查：" + "；".join(item["message"] for item in validation["messages"] if item["type"] == "error"))
    return workflow, stripped_secrets


def _run_preview(workspace: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    workflow = _workflow(workspace)
    validation = _validate(workflow)
    if not validation["valid"]:
        raise ToolError("工作流未通过依赖检查")
    node_map = {item["id"]: item for item in workflow["nodes"]}
    step_runs: list[dict[str, Any]] = []
    failed: set[str] = set()
    waiting = False
    for index, node_id in enumerate(validation["order"]):
        node = node_map[node_id]
        if node.get("enabled") is False:
            step_runs.append(_step(node, "skipped", index, attempts=0, message="节点已停用"))
            continue
        if waiting or any(item in failed for item in node.get("dependsOn", [])):
            step_runs.append(_step(node, "pending" if waiting else "skipped", index, attempts=0, message="等待人工审批" if waiting else "上游节点失败"))
            continue
        if node.get("type") == "review" and node.get("approvalRequired"):
            step_runs.append(_step(node, "awaiting-approval", index, attempts=0, message="等待授权审核人处理"))
            waiting = True
            continue
        should_fail = bool(node.get("config", {}).get("simulateFailure"))
        if should_fail:
            attempts = min(5, max(1, int(node.get("retryPolicy", {}).get("maxAttempts", workflow.get("retries", 1) + 1))))
            step_runs.append(_step(node, "failed", index, attempts=attempts, message=f"预览故障注入：{attempts} 次尝试后失败"))
            failed.add(node_id)
        else:
            step_runs.append(_step(node, "succeeded", index))
    status = "failed" if failed else "awaiting-approval" if waiting else "succeeded"
    run = {
        "id": _uid("run"),
        "workflowId": workflow["id"],
        "workflowVersion": len([item for item in workspace["versions"] if item.get("workflowId") == workflow["id"]]),
        "mode": "deterministic-preview",
        "status": status,
        "trigger": "manual",
        "stepRuns": step_runs,
        "durationMs": sum(item["durationMs"] for item in step_runs),
        "createdAt": _now(),
        "finishedAt": _now() if status in {"succeeded", "failed"} else None,
        "cancelRequested": False,
    }
    workspace["runs"].insert(0, run)
    workspace["runs"] = workspace["runs"][:50]
    workspace["currentRunId"] = run["id"]
    for item in step_runs:
        workspace["logs"].insert(0, {"id": _uid("log"), "runId": run["id"], "stepRunId": item["id"], "level": "error" if item["status"] == "failed" else "info", "message": item["message"], "createdAt": _now(), "redacted": True})
    if waiting:
        step_run = next(item for item in step_runs if item["status"] == "awaiting-approval")
        workspace["approvals"].insert(0, {"id": _uid("approval"), "runId": run["id"], "nodeId": step_run["nodeId"], "status": "pending", "decision": "", "actor": "", "createdAt": _now()})
    workspace["updatedAt"] = _now()
    return workspace, run


def _legacy_nodes(payload: dict[str, Any]) -> list[dict[str, Any]] | None:
    nodes = payload.get("nodes")
    if isinstance(nodes, str):
        try:
            nodes = json.loads(nodes)
        except json.JSONDecodeError as exc:
            raise ToolError(f"JSON 格式错误：{exc.msg}") from exc
    return nodes if isinstance(nodes, list) and nodes else None


def _legacy_workflow(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    normalized = []
    for index, item in enumerate(nodes):
        if not isinstance(item, dict) or not _clean(item.get("id"), 100):
            raise ToolError(f"第 {index + 1} 个节点缺少 id")
        normalized.append({
            "id": _clean(item["id"], 100),
            "name": _clean(item.get("name"), 120) or _clean(item["id"], 100),
            "type": item.get("type") if item.get("type") in NODE_TYPES else "analysis",
            "dependsOn": [_clean(value, 100) for value in item.get("dependsOn", [])],
            "enabled": item.get("enabled") is not False,
            "config": _sanitize_config(item.get("config")),
            "approvalRequired": False,
        })
    return {"id": "legacy", "name": "兼容流程", "nodes": normalized}


def run_research_automation(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    legacy_nodes = _legacy_nodes(payload)
    if action in {"validate", "run"} and legacy_nodes and not payload.get("state") and not payload.get("workspace"):
        workflow = _legacy_workflow(legacy_nodes)
        validation = _validate(workflow)
        if not validation["valid"]:
            raise ToolError("；".join(item["message"] for item in validation["messages"] if item["type"] == "error"))
        if action == "validate":
            return {"valid": True, "order": validation["order"], "nodes": len(legacy_nodes)}
        trace = []
        failed = False
        node_map = {item["id"]: item for item in workflow["nodes"]}
        for node_id in validation["order"]:
            node = node_map[node_id]
            status = "skipped" if not node["enabled"] else "failed" if node["config"].get("simulateFailure") or "fail" in str(node["config"].get("summary", "")).lower() else "completed"
            trace.append({"id": node_id, "name": node["name"], "status": status})
            if status == "failed":
                failed = True
                break
        return {"status": "failed" if failed else "success", "trace": trace, "finishedAt": _now()}

    workspace = _state(payload)
    workflow = _workflow(workspace)
    if action in {"load-sample", "run-all"}:
        return _result(_baseline_workspace(), action)
    if action in {"validate", "validate-workflow"}:
        return _result(workspace, action)
    if action == "update-workflow":
        for key in ("name", "description"):
            if key in payload:
                workflow[key] = _clean(payload[key], 1_000 if key == "description" else 120)
        if "retries" in payload:
            workflow["retries"] = min(5, max(0, int(payload["retries"])))
        if "timeoutSeconds" in payload:
            workflow["timeoutSeconds"] = min(7_200, max(30, int(payload["timeoutSeconds"])))
        if "concurrencyPolicy" in payload:
            policy = _clean(payload["concurrencyPolicy"], 40)
            if policy not in {"forbid-overlap", "queue-one", "cancel-previous"}:
                raise ToolError("并发策略不受支持")
            workflow["concurrencyPolicy"] = policy
        if "schedule" in payload:
            schedule = payload["schedule"]
            if not isinstance(schedule, dict):
                raise ToolError("计划配置格式不正确")
            workflow["schedule"] = {"enabled": False, "expression": _clean(schedule.get("expression"), 120) or "手动", "timeZone": _clean(schedule.get("timeZone"), 80) or "Asia/Shanghai"}
        workflow["updatedAt"] = _now()
        workspace["updatedAt"] = _now()
        return _result(workspace, action)
    if action == "apply-template":
        template = _template(_clean(payload.get("templateId"), 30))
        template["id"] = _uid("workflow")
        template["name"] += "（副本）"
        template["status"] = "draft"
        workspace["workflows"].append(template)
        workspace["currentWorkflowId"] = template["id"]
        workspace["selectedNodeId"] = template["nodes"][0]["id"]
        return _result(workspace, action)
    if action == "select-workflow":
        workflow_id = _clean(payload.get("workflowId"), 100)
        if not any(item.get("id") == workflow_id for item in workspace["workflows"]):
            raise ToolError("工作流不存在")
        workspace["currentWorkflowId"] = workflow_id
        workspace["selectedNodeId"] = _workflow(workspace)["nodes"][0]["id"]
        return _result(workspace, action)
    if action == "add-node":
        if len(workflow["nodes"]) >= 60:
            raise ToolError("单个工作流最多支持 60 个节点")
        node_type = _clean(payload.get("type"), 30)
        if node_type not in NODE_TYPES:
            raise ToolError("节点类型未进入白名单")
        dependencies = [_clean(item, 100) for item in payload.get("dependsOn", [])]
        node = _node(_uid("node"), node_type, _clean(payload.get("name"), 120) or f"新{NODE_LABELS[node_type]}节点", dependencies, _clean(payload.get("summary"), 500), 90 + len(workflow["nodes"]) * 155, 120, approval=node_type == "review")
        workflow["nodes"].append(node)
        workspace["selectedNodeId"] = node["id"]
        validation = _validate(workflow)
        if not validation["valid"]:
            raise ToolError("新增节点造成无效依赖")
        return _result(workspace, action)
    if action == "update-node":
        node_id = _clean(payload.get("nodeId"), 100)
        node = next((item for item in workflow["nodes"] if item.get("id") == node_id), None)
        if not node:
            raise ToolError("节点不存在")
        if "name" in payload:
            node["name"] = _clean(payload["name"], 120) or node["name"]
        if "enabled" in payload:
            node["enabled"] = bool(payload["enabled"])
        if "dependsOn" in payload:
            node["dependsOn"] = [_clean(item, 100) for item in payload["dependsOn"] if _clean(item, 100) and _clean(item, 100) != node_id]
        if "config" in payload:
            node["config"] = _sanitize_config(payload["config"])
        if "approvalRequired" in payload:
            node["approvalRequired"] = node["type"] == "review" and bool(payload["approvalRequired"])
        if "maxAttempts" in payload:
            node["retryPolicy"]["maxAttempts"] = min(5, max(1, int(payload["maxAttempts"])))
        validation = _validate(workflow)
        if not validation["valid"]:
            raise ToolError("节点修改造成无效依赖")
        workspace["selectedNodeId"] = node_id
        return _result(workspace, action)
    if action == "delete-node":
        node_id = _clean(payload.get("nodeId"), 100)
        if len(workflow["nodes"]) <= 1:
            raise ToolError("工作流至少保留一个节点")
        workflow["nodes"] = [item for item in workflow["nodes"] if item.get("id") != node_id]
        for item in workflow["nodes"]:
            item["dependsOn"] = [dependency for dependency in item.get("dependsOn", []) if dependency != node_id]
        workspace["selectedNodeId"] = workflow["nodes"][0]["id"]
        return _result(workspace, action)
    if action == "add-variable":
        key = re.sub(r"[^A-Z0-9_]", "_", _clean(payload.get("key"), 80).upper())
        if not key:
            raise ToolError("变量名不能为空")
        if any(item.get("key") == key for item in workflow["variables"] + workflow["secretRefs"]):
            raise ToolError("变量或密钥引用名称重复")
        if payload.get("secret"):
            if payload.get("value") not in (None, ""):
                raise ToolError("敏感值不能进入工作流，请只填写密钥引用")
            workflow["secretRefs"].append({"id": _uid("secret"), "key": key, "provider": _clean(payload.get("provider"), 80) or "environment", "reference": _clean(payload.get("reference"), 200), "configured": False})
        else:
            workflow["variables"].append({"id": _uid("variable"), "key": key, "value": _clean(payload.get("value"), 1_000), "type": "string"})
        return _result(workspace, action)
    if action == "delete-variable":
        item_id = _clean(payload.get("itemId"), 100)
        workflow["variables"] = [item for item in workflow["variables"] if item.get("id") != item_id]
        workflow["secretRefs"] = [item for item in workflow["secretRefs"] if item.get("id") != item_id]
        return _result(workspace, action)
    if action in {"run", "run-preview"}:
        workspace, run = _run_preview(workspace)
        return _result(workspace, action, {"run": run})
    if action == "approve":
        run_id = _clean(payload.get("runId"), 100)
        decision = _clean(payload.get("decision"), 30)
        if decision not in {"approved", "rejected"}:
            raise ToolError("审批结论必须是 approved 或 rejected")
        run = next((item for item in workspace["runs"] if item.get("id") == run_id), None)
        approval = next((item for item in workspace["approvals"] if item.get("runId") == run_id and item.get("status") == "pending"), None)
        if not run or not approval:
            raise ToolError("待审批运行不存在")
        approval.update({"status": decision, "decision": _clean(payload.get("note"), 500) or ("通过" if decision == "approved" else "退回"), "actor": "当前授权用户", "decidedAt": _now()})
        waiting_index = next(index for index, item in enumerate(run["stepRuns"]) if item["status"] == "awaiting-approval")
        run["stepRuns"][waiting_index].update({"status": "succeeded" if decision == "approved" else "rejected", "attempts": 1, "durationMs": 12, "message": "人工审批通过" if decision == "approved" else "人工审批退回", "finishedAt": _now()})
        if decision == "approved":
            for index, item in enumerate(run["stepRuns"][waiting_index + 1 :], start=waiting_index + 1):
                item.update(_step(next(node for node in workflow["nodes"] if node["id"] == item["nodeId"]), "succeeded", index))
            run["status"] = "succeeded"
            output_node = next((item for item in workflow["nodes"] if item["type"] == "output"), workflow["nodes"][-1])
            artifact = {"id": _uid("artifact"), "runId": run_id, "nodeId": output_node["id"], "name": f"{workflow['name']}-预览报告.md", "mediaType": "text/markdown", "size": 1024 + len(workflow["nodes"]) * 96, "checksum": _checksum({"run": run_id, "workflow": workflow["id"]}), "createdAt": _now()}
            workspace["artifacts"].insert(0, artifact)
            workspace["lineage"].insert(0, {"id": _uid("lineage"), "from": f"run:{run_id}", "to": artifact["id"], "relation": "generated-by", "nodeId": output_node["id"]})
        else:
            for item in run["stepRuns"][waiting_index + 1 :]:
                item.update({"status": "skipped", "message": "审批未通过"})
            run["status"] = "rejected"
        run["durationMs"] = sum(item.get("durationMs", 0) for item in run["stepRuns"])
        run["finishedAt"] = _now()
        return _result(workspace, action, {"run": run})
    if action == "retry-step":
        run_id = _clean(payload.get("runId"), 100)
        node_id = _clean(payload.get("nodeId"), 100)
        run = next((item for item in workspace["runs"] if item.get("id") == run_id), None)
        if not run:
            raise ToolError("运行不存在")
        step_run = next((item for item in run["stepRuns"] if item.get("nodeId") == node_id and item.get("status") == "failed"), None)
        if not step_run:
            raise ToolError("没有可重试的失败步骤")
        step_run.update({"status": "succeeded", "attempts": step_run.get("attempts", 1) + 1, "durationMs": step_run.get("durationMs", 0) + 37, "message": "人工重试成功", "finishedAt": _now()})
        run["status"] = "failed"
        workspace["logs"].insert(0, {"id": _uid("log"), "runId": run_id, "stepRunId": step_run["id"], "level": "info", "message": "人工重试成功；下游需重新执行", "createdAt": _now(), "redacted": True})
        return _result(workspace, action, {"run": run})
    if action == "cancel-run":
        run_id = _clean(payload.get("runId"), 100)
        run = next((item for item in workspace["runs"] if item.get("id") == run_id), None)
        if not run or run.get("status") not in {"queued", "running", "awaiting-approval"}:
            raise ToolError("当前运行不能取消")
        run["status"] = "canceled"
        run["cancelRequested"] = True
        run["finishedAt"] = _now()
        for item in run["stepRuns"]:
            if item["status"] in {"pending", "awaiting-approval"}:
                item.update({"status": "skipped", "message": "运行已取消"})
        return _result(workspace, action, {"run": run})
    if action == "publish":
        validation = _validate(workflow)
        if not validation["valid"]:
            raise ToolError("无效工作流不能发布版本")
        version_number = 1 + max([int(item.get("version", 0)) for item in workspace["versions"] if item.get("workflowId") == workflow["id"]] or [0])
        version = {"id": _uid("version"), "workflowId": workflow["id"], "version": version_number, "label": _clean(payload.get("label"), 120) or f"版本 {version_number}", "checksum": _checksum(_exportable_workflow(workflow)), "createdAt": _now(), "immutable": True}
        workspace["versions"].insert(0, version)
        workflow["status"] = "published"
        return _result(workspace, action, {"publishedVersion": version})
    if action == "import-workflow":
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ToolError("导入文件为空")
        if len(content.encode("utf-8")) > 900_000:
            raise ToolError("导入文件不能超过 900 KB")
        try:
            imported_payload = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ToolError(f"流程 JSON 格式错误：{exc.msg}") from exc
        if imported_payload.get("schema") != WORKFLOW_SCHEMA or int(imported_payload.get("version", 0)) != 1 or not isinstance(imported_payload.get("workflow"), dict):
            raise ToolError("仅支持 skyview-research-workflow v1")
        imported, stripped_secrets = _normalize_imported_workflow(imported_payload["workflow"])
        workspace["workflows"].append(imported)
        workspace["currentWorkflowId"] = imported["id"]
        workspace["selectedNodeId"] = imported["nodes"][0]["id"]
        return _result(workspace, action, {"importSummary": {"nodes": len(imported["nodes"]), "historyDiscarded": True, "secretValuesStripped": stripped_secrets, "executionStarted": False}})
    if action == "export":
        return _result(workspace, action)
    raise ToolError("不支持的研究自动化操作")
