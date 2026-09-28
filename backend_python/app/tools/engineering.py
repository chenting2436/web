from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from app.tools.common import (
    ToolError,
    clamp,
    mean,
    number,
    parse_json,
    parse_numbers,
    require_text,
    standard_deviation,
)


def _parse_csv(source: str) -> tuple[list[str], list[dict[str, str]]]:
    sample = source[:4_096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(source), dialect=dialect)
    if not reader.fieldnames:
        raise ToolError("未识别到 CSV 表头")
    rows = [{str(key): str(value or "").strip() for key, value in row.items() if key is not None} for row in reader]
    if not rows:
        raise ToolError("CSV 没有数据行")
    if len(rows) > 20_000:
        raise ToolError("一次最多处理 20000 行")
    return [str(name).strip() for name in reader.fieldnames], rows


def _infer_type(values: list[str]) -> str:
    non_empty = [value for value in values if value != ""]
    if not non_empty:
        return "empty"
    numeric = 0
    boolean = 0
    for value in non_empty:
        try:
            float(value)
            numeric += 1
        except ValueError:
            pass
        if value.lower() in {"true", "false", "yes", "no", "0", "1"}:
            boolean += 1
    if numeric == len(non_empty):
        return "number"
    if boolean == len(non_empty):
        return "boolean"
    return "string"


def data_gateway(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "process":
        raise ToolError("不支持的数据网关操作")
    source = require_text(payload, "csv")
    fields, rows = _parse_csv(source)
    mappings = parse_json(payload.get("mappings"), fallback={})
    required_fields = parse_json(payload.get("requiredFields"), fallback=[])
    if not isinstance(mappings, dict) or not isinstance(required_fields, list):
        raise ToolError("字段映射必须是对象，必填字段必须是数组")

    mapped_rows = []
    rejected = []
    for index, row in enumerate(rows, start=2):
        mapped = {str(mappings.get(key, key)): value for key, value in row.items()}
        missing = [str(field) for field in required_fields if not str(mapped.get(str(field), "")).strip()]
        if missing:
            rejected.append({"line": index, "missing": missing})
        else:
            mapped_rows.append(mapped)

    output_fields = sorted({key for row in mapped_rows for key in row})
    schema = [
        {
            "name": field,
            "type": _infer_type([row.get(field, "") for row in mapped_rows]),
            "completeness": round(sum(bool(row.get(field, "")) for row in mapped_rows) / max(1, len(mapped_rows)), 4),
        }
        for field in output_fields
    ]
    return {
        "received": len(rows),
        "published": len(mapped_rows),
        "rejected": len(rejected),
        "qualityScore": round(len(mapped_rows) / len(rows), 4),
        "inputFields": fields,
        "schema": schema,
        "violations": rejected[:200],
        "output": mapped_rows[:500],
    }


def ambient_noise(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "correlate":
        raise ToolError("不支持的背景噪声操作")
    left = parse_numbers(payload.get("left"), key="left", minimum=8)
    right = parse_numbers(payload.get("right"), key="right", minimum=8)
    if len(left) != len(right):
        raise ToolError("两条波形长度必须一致")
    max_lag = int(clamp(number(payload, "maxLag", min(100, len(left) // 3)), 1, len(left) - 2))
    left_mean = mean(left)
    right_mean = mean(right)
    centered_left = [value - left_mean for value in left]
    centered_right = [value - right_mean for value in right]
    values = []
    for lag in range(-max_lag, max_lag + 1):
        pairs = [
            (centered_left[index], centered_right[index + lag])
            for index in range(len(left))
            if 0 <= index + lag < len(right)
        ]
        numerator = sum(a * b for a, b in pairs)
        denominator = math.sqrt(sum(a * a for a, _ in pairs) * sum(b * b for _, b in pairs))
        values.append({"lag": lag, "correlation": numerator / denominator if denominator else 0})
    peak = max(values, key=lambda item: (abs(item["correlation"]), -abs(item["lag"])))
    return {
        "samples": len(left),
        "peakLag": peak["lag"],
        "peakCorrelation": round(peak["correlation"], 6),
        "correlation": [{"lag": item["lag"], "value": round(item["correlation"], 6)} for item in values],
    }


def warning_platform(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "evaluate":
        raise ToolError("不支持的预警操作")
    values = parse_numbers(payload.get("values"), minimum=1)
    warning = number(payload, "warning", 60)
    critical = number(payload, "critical", 80)
    if critical <= warning:
        raise ToolError("严重阈值必须大于预警阈值")
    events = []
    for index, value in enumerate(values):
        level = "critical" if value >= critical else "warning" if value >= warning else "normal"
        if level != "normal":
            events.append({"index": index, "value": value, "level": level})
    critical_count = sum(event["level"] == "critical" for event in events)
    return {
        "status": "critical" if critical_count else "warning" if events else "normal",
        "samples": len(values),
        "maximum": max(values),
        "average": round(mean(values), 4),
        "events": events[:500],
    }


def uav_inspection(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "prioritize":
        raise ToolError("不支持的巡检操作")
    anomalies = parse_json(payload.get("anomalies"), fallback=[])
    if not isinstance(anomalies, list):
        raise ToolError("anomalies 必须是 JSON 数组")
    rows = []
    for index, anomaly in enumerate(anomalies):
        if not isinstance(anomaly, dict):
            continue
        severity = clamp(float(anomaly.get("severity", 1)), 1, 5)
        confidence = clamp(float(anomaly.get("confidence", 0.5)), 0, 1)
        exposure = clamp(float(anomaly.get("exposure", 1)), 1, 5)
        score = severity * 12 + confidence * 25 + exposure * 3
        rows.append({**anomaly, "id": anomaly.get("id", f"anomaly-{index + 1}"), "priorityScore": round(score, 2)})
    rows.sort(key=lambda item: item["priorityScore"], reverse=True)
    return {"total": len(rows), "reviewFirst": rows[:10], "all": rows}


def fusion_console(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "align":
        raise ToolError("不支持的融合操作")
    observations = parse_json(payload.get("observations"), fallback=[])
    if not isinstance(observations, list) or not observations:
        raise ToolError("observations 必须是非空 JSON 数组")
    window_seconds = max(1, int(number(payload, "windowSeconds", 60)))
    buckets: dict[int, list[dict[str, Any]]] = defaultdict(list)
    rejected = []
    for item in observations:
        if not isinstance(item, dict):
            continue
        raw_time = item.get("timestamp")
        try:
            timestamp = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=UTC)
            value = float(item.get("value"))
        except (TypeError, ValueError):
            rejected.append(item)
            continue
        bucket = int(timestamp.timestamp()) // window_seconds * window_seconds
        buckets[bucket].append({**item, "value": value})
    aligned = []
    for epoch, items in sorted(buckets.items()):
        aligned.append({
            "timestamp": datetime.fromtimestamp(epoch, UTC).isoformat(),
            "sources": sorted({str(item.get("source", "unknown")) for item in items}),
            "count": len(items),
            "average": round(mean([item["value"] for item in items]), 6),
            "spread": round(standard_deviation([item["value"] for item in items]), 6),
        })
    return {"windowSeconds": window_seconds, "groups": aligned, "rejected": len(rejected)}


def emergency_console(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "plan":
        raise ToolError("不支持的应急操作")
    incident = require_text(payload, "incident", max_length=2_000)
    severity = str(payload.get("severity", "medium")).lower()
    if severity not in {"low", "medium", "high", "critical"}:
        raise ToolError("severity 必须是 low、medium、high 或 critical")
    tasks = parse_json(payload.get("tasks"), fallback=[])
    if not isinstance(tasks, list):
        raise ToolError("tasks 必须是 JSON 数组")
    normalized = []
    for index, task in enumerate(tasks):
        if isinstance(task, str):
            task = {"title": task}
        if not isinstance(task, dict):
            continue
        normalized.append({
            "id": task.get("id", f"task-{index + 1}"),
            "title": str(task.get("title", "未命名任务")),
            "owner": str(task.get("owner", "待分配")),
            "status": str(task.get("status", "todo")),
            "priority": task.get("priority", severity),
        })
    return {
        "incident": incident,
        "severity": severity,
        "status": "active",
        "tasks": normalized,
        "unassigned": sum(task["owner"] == "待分配" for task in normalized),
        "createdAt": datetime.now(UTC).isoformat(),
    }
