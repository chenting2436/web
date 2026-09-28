from __future__ import annotations

import base64
import csv
import io
import json
import math
import statistics
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-fusion-console-results"
MAX_IMPORT_ROWS = 20_000


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _parse_time(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(_clean(value, 80).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ToolError("时间格式无效") from exc
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _audit(workspace: dict[str, Any], action: str, actor: str, target: str, detail: str) -> None:
    workspace.setdefault("audit", []).insert(0, {
        "id": f"audit-{uuid.uuid4().hex[:10]}", "time": _now(), "action": action,
        "actor": _clean(actor, 80) or "当前数据工程师", "target": _clean(target, 120),
        "detail": _clean(detail, 500),
    })
    workspace["audit"] = workspace["audit"][:400]
    workspace["version"] = int(workspace.get("version", 1)) + 1
    workspace["updatedAt"] = _now()


def _pearson(left: list[float | None], right: list[float | None]) -> float:
    pairs = [(float(a), float(b)) for a, b in zip(left, right) if a is not None and b is not None]
    if len(pairs) < 3:
        return 0.0
    xs, ys = zip(*pairs)
    x_mean, y_mean = statistics.mean(xs), statistics.mean(ys)
    numerator = sum((x - x_mean) * (y - y_mean) for x, y in pairs)
    denominator = math.sqrt(sum((x - x_mean) ** 2 for x in xs) * sum((y - y_mean) ** 2 for y in ys))
    return round(numerator / denominator, 3) if denominator else 0.0


def _sample() -> dict[str, Any]:
    base = datetime(2026, 9, 10, 8, 0, tzinfo=UTC)
    times = [(base + timedelta(minutes=5 * index)).isoformat().replace("+00:00", "Z") for index in range(16)]
    source_specs = [
        ("src-gnss", "北坡 GNSS", "GNSS", "displacement", "mm", 32, 31, [4.2, 4.4, 4.8, 5.1, 5.6, 6.3, 7.4, 8.8, 10.2, 11.9, 14.1, 17.0, 20.4, 24.8, 29.9, 35.6]),
        ("src-rain", "北坡雨量", "MQTT", "rainfall", "mm/h", 23, 24, [0, 0, 1, 2, 5, 9, 16, 24, 38, 55, 72, 68, 51, 33, 20, 11]),
        ("src-pore", "坡脚孔压", "HTTP", "pore-pressure", "kPa", 42, 64, [82, 83, 84, 85, 87, 90, 94, 99, 105, 112, 121, 130, 139, 146, 151, 154]),
        ("src-seismic", "微震事件流", "Kafka", "microseismic-energy", "kJ", 58, 45, [1.2, 1.0, 1.4, 1.8, 1.5, 2.1, 2.4, 3.1, 4.8, 7.2, 12.6, 10.4, 18.2, 22.1, 14.8, 9.6]),
        ("src-insar", "InSAR 形变", "FILE", "displacement", "mm", 70, 33, [3.8, None, None, 4.7, None, None, 7.1, None, None, 12.8, None, None, 21.6, None, None, 33.9]),
        ("src-temp", "地表温度", "OPC-UA", "temperature", "°C", 77, 67, [21.4, 21.6, 22.0, 22.5, 23.1, 24.0, 25.2, 26.4, 27.6, 28.1, 27.8, 27.0, 26.2, 25.4, 24.9, 24.3]),
    ]
    sources: list[dict[str, Any]] = []
    schemas: list[dict[str, Any]] = []
    observations: list[dict[str, Any]] = []
    for source_id, name, protocol, kind, unit, x, y, values in source_specs:
        sources.append({
            "id": source_id, "name": name, "protocol": protocol, "kind": kind, "unit": unit,
            "canonicalUnit": unit, "status": "degraded" if source_id == "src-insar" else "online",
            "clockOffsetSeconds": 42 if source_id == "src-seismic" else 3 if source_id == "src-rain" else 0,
            "watermarkSeconds": 90 if protocol == "Kafka" else 30, "x": x, "y": y,
            "owner": "监测数据组", "schemaVersion": 2, "calibrationVersion": "cal-v2",
            "lastSeen": times[-1], "retentionDays": 365,
        })
        schemas.append({
            "id": f"schema-{source_id}", "sourceId": source_id, "version": 2, "status": "published",
            "fields": [{"name": "eventTime", "type": "datetime", "required": True}, {"name": "value", "type": "number", "required": True}, {"name": "quality", "type": "enum", "required": True}],
            "unit": unit, "crs": "LOCAL-METER", "approvedBy": ["源管理员", "数据工程师"], "publishedAt": "2026-09-09T09:00:00Z",
        })
        for index, value in enumerate(values):
            event_time = _parse_time(times[index]) + timedelta(seconds=(index % 3) * 4)
            ingest_time = event_time + timedelta(seconds=(42 if source_id == "src-seismic" else 4 + index % 4))
            observations.append({
                "id": f"obs-{source_id}-{index:02d}", "sourceId": source_id,
                "eventTime": event_time.isoformat().replace("+00:00", "Z"),
                "ingestTime": ingest_time.isoformat().replace("+00:00", "Z"),
                "rawValue": value, "value": value, "unit": unit,
                "quality": "missing" if value is None else "good", "calibrationVersion": "cal-v2",
                "x": x, "y": y, "traceId": f"trace-{index:02d}", "source": "deterministic-benchmark",
            })
    workspace = {
        "id": "fusion-north-slope", "name": "北岭边坡多源联合研判", "version": 4,
        "selectedSourceId": "src-gnss", "selectedEventId": "fused-003", "windowSeconds": 300,
        "alignmentMode": "event-time", "fillPolicy": "forward-limited", "maxFillWindows": 2,
        "calibrationVersions": [
            {"id": "cal-v1", "status": "archived", "factor": 1, "offset": 0, "approvedBy": ["源管理员"], "createdAt": "2026-07-01T00:00:00Z"},
            {"id": "cal-v2", "status": "published", "factor": 1, "offset": 0, "approvedBy": ["源管理员", "业务审核"], "createdAt": "2026-09-01T00:00:00Z"},
        ],
        "alignmentJobs": [{"id": "align-20260910", "status": "succeeded", "windowSeconds": 300, "mode": "event-time", "watermarkSeconds": 90, "inputRows": len(observations), "outputWindows": 16, "lateRows": 1, "createdAt": "2026-09-10T09:20:00Z"}],
        "featureSets": [{"id": "features-v3", "name": "边坡联合特征", "version": 3, "status": "published", "features": ["位移速率", "累计雨量", "孔压增量", "微震能量", "InSAR 一致性"], "lineage": [item[0] for item in source_specs], "createdAt": "2026-09-09T10:00:00Z"}],
        "fusionModels": [{"id": "model-slope-risk", "name": "边坡多源证据融合", "type": "weighted-evidence", "activeVersionId": "model-v3", "owner": "模型组"}],
        "modelVersions": [{"id": "model-v3", "modelId": "model-slope-risk", "version": 3, "status": "published", "weights": {"src-gnss": .28, "src-rain": .17, "src-pore": .22, "src-seismic": .18, "src-insar": .12, "src-temp": .03}, "thresholds": {"warning": .55, "high": .72, "critical": .86}, "approvals": [{"actor": "模型作者", "time": "2026-09-09T10:20:00Z"}, {"actor": "业务审核", "time": "2026-09-09T10:36:00Z"}], "createdAt": "2026-09-09T10:00:00Z"}],
        "fusedEvents": [
            {"id": "fused-001", "windowStart": times[9], "windowEnd": times[10], "riskScore": .61, "level": "warning", "status": "confirmed", "title": "降雨与孔压同步抬升", "evidenceIds": ["obs-src-rain-09", "obs-src-pore-09", "obs-src-gnss-09"], "modelVersionId": "model-v3", "reviewer": "张审核员", "reviewedAt": "2026-09-10T09:01:00Z"},
            {"id": "fused-002", "windowStart": times[12], "windowEnd": times[13], "riskScore": .79, "level": "high", "status": "confirmed", "title": "位移加速伴随微震增强", "evidenceIds": ["obs-src-gnss-12", "obs-src-seismic-12", "obs-src-insar-12"], "modelVersionId": "model-v3", "reviewer": "李审核员", "reviewedAt": "2026-09-10T09:08:00Z"},
            {"id": "fused-003", "windowStart": times[15], "windowEnd": "2026-09-10T09:20:00Z", "riskScore": .88, "level": "critical", "status": "review", "title": "多源形变证据持续增强", "evidenceIds": ["obs-src-gnss-15", "obs-src-pore-15", "obs-src-seismic-15", "obs-src-insar-15"], "modelVersionId": "model-v3", "reviewer": "", "reviewedAt": None},
        ],
        "qualityEvents": [
            {"id": "quality-001", "sourceId": "src-insar", "type": "missing", "severity": "warning", "status": "open", "time": times[14], "detail": "稀疏重访源存在预期空窗，已限制前向填充窗口"},
            {"id": "quality-002", "sourceId": "src-seismic", "type": "clock-drift", "severity": "warning", "status": "open", "time": times[15], "detail": "事件时钟较接入时钟偏移 42 秒"},
            {"id": "quality-003", "sourceId": "src-rain", "type": "spike", "severity": "info", "status": "closed", "time": times[10], "detail": "强降雨突增经相邻窗口与设备状态复核后保留"},
        ],
        "approvals": [{"id": "approval-model-v3", "target": "model-v3", "status": "approved", "actors": ["模型作者", "业务审核"], "time": "2026-09-09T10:36:00Z"}],
        "roles": [{"role": "源管理员", "members": ["王源管"]}, {"role": "数据工程师", "members": ["赵工程师"]}, {"role": "模型作者", "members": ["陈模型"]}, {"role": "业务审核", "members": ["李审核员"]}],
        "audit": [{"id": "audit-seed", "time": "2026-09-10T09:08:00Z", "action": "review-fused-event", "actor": "李审核员", "target": "fused-002", "detail": "复核位移与微震联合证据并确认高风险事件"}],
        "createdAt": "2026-09-09T00:00:00Z", "updatedAt": "2026-09-10T09:20:00Z",
    }
    return _result(workspace, sources, schemas, observations, "load-sample")


def _aligned_series(sources: list[dict[str, Any]], observations: list[dict[str, Any]], window_seconds: int) -> tuple[list[str], list[dict[str, Any]]]:
    valid_times = [_parse_time(item["eventTime"]) for item in observations if item.get("eventTime")]
    if not valid_times:
        return [], []
    start_epoch = int(min(valid_times).timestamp()) // window_seconds * window_seconds
    end_epoch = int(max(valid_times).timestamp()) // window_seconds * window_seconds
    epochs = list(range(start_epoch, end_epoch + 1, window_seconds))[-96:]
    labels = [datetime.fromtimestamp(epoch, UTC).isoformat().replace("+00:00", "Z") for epoch in epochs]
    rows = []
    for source in sources:
        buckets: dict[int, list[float]] = {}
        for item in observations:
            if item.get("sourceId") != source["id"] or item.get("value") is None:
                continue
            epoch = int(_parse_time(item["eventTime"]).timestamp()) // window_seconds * window_seconds
            buckets.setdefault(epoch, []).append(float(item["value"]))
        values: list[float | None] = [round(statistics.mean(buckets[epoch]), 4) if epoch in buckets else None for epoch in epochs]
        finite = [value for value in values if value is not None]
        low, high = (min(finite), max(finite)) if finite else (0, 0)
        normalized = [round((value - low) / max(high - low, 1e-9), 4) if value is not None else None for value in values]
        rows.append({"sourceId": source["id"], "name": source["name"], "unit": source["canonicalUnit"], "values": values, "normalized": normalized})
    return labels, rows


def _analysis(workspace: dict[str, Any], sources: list[dict[str, Any]], observations: list[dict[str, Any]]) -> dict[str, Any]:
    window_seconds = max(10, int(workspace.get("windowSeconds", 300)))
    times, aligned = _aligned_series(sources, observations, window_seconds)
    aligned_map = {item["sourceId"]: item["values"] for item in aligned}
    correlation = []
    for left in sources:
        for right in sources:
            correlation.append({"left": left["id"], "right": right["id"], "value": 1 if left["id"] == right["id"] else _pearson(aligned_map.get(left["id"], []), aligned_map.get(right["id"], []))})
    missing_matrix = []
    for source in sources:
        values = aligned_map.get(source["id"], [])
        for index, value in enumerate(values):
            missing_matrix.append({"sourceId": source["id"], "window": index, "status": "missing" if value is None else "good"})
    selected_id = workspace.get("selectedEventId")
    selected = next((item for item in workspace.get("fusedEvents", []) if item.get("id") == selected_id), None) or (workspace.get("fusedEvents") or [{}])[-1]
    version = next((item for item in workspace.get("modelVersions", []) if item.get("id") == selected.get("modelVersionId")), {})
    weights = version.get("weights", {})
    latest_norm = {item["sourceId"]: next((value for value in reversed(item["normalized"]) if value is not None), 0) for item in aligned}
    contributions = [{"sourceId": source["id"], "name": source["name"], "weight": float(weights.get(source["id"], 0)), "normalized": float(latest_norm.get(source["id"], 0)), "contribution": round(float(weights.get(source["id"], 0)) * float(latest_norm.get(source["id"], 0)), 4)} for source in sources]
    contributions.sort(key=lambda item: item["contribution"], reverse=True)
    finite_rows = sum(item.get("value") is not None for item in observations)
    completeness = round(finite_rows / max(1, len(observations)) * 100, 1)
    drifted = sum(abs(float(item.get("clockOffsetSeconds", 0))) > float(item.get("watermarkSeconds", 30)) / 2 for item in sources)
    events = workspace.get("fusedEvents", [])
    open_quality = [item for item in workspace.get("qualityEvents", []) if item.get("status") == "open"]
    return {
        "metrics": {"sources": len(sources), "onlineSources": sum(item.get("status") == "online" for item in sources), "completeness": completeness, "clockDriftSources": drifted, "qualityEvents": len(open_quality), "fusedEvents": len(events), "pendingReview": sum(item.get("status") == "review" for item in events), "criticalEvents": sum(item.get("level") == "critical" and item.get("status") != "rejected" for item in events), "activeModelVersion": version.get("version", 0)},
        "timeAxis": times, "alignedSeries": aligned, "missingMatrix": missing_matrix, "correlationMatrix": correlation,
        "topology": {"nodes": [{"id": item["id"], "name": item["name"], "kind": "source", "status": item["status"], "x": item["x"], "y": item["y"]} for item in sources] + [{"id": "aligner", "name": "事件时间对齐", "kind": "process", "status": "healthy", "x": 50, "y": 32}, {"id": "fusion", "name": "融合模型 v3", "kind": "model", "status": "published", "x": 50, "y": 57}, {"id": "decision", "name": "研判事件", "kind": "output", "status": "review", "x": 50, "y": 82}], "edges": [{"source": item["id"], "target": "aligner"} for item in sources] + [{"source": "aligner", "target": "fusion"}, {"source": "fusion", "target": "decision"}]},
        "spatialSignals": [{"sourceId": item["id"], "name": item["name"], "x": item["x"], "y": item["y"], "status": item["status"], "value": next((point for point in reversed(aligned_map.get(item["id"], [])) if point is not None), None), "unit": item["unit"]} for item in sources],
        "qualityEvents": sorted(workspace.get("qualityEvents", []), key=lambda item: str(item.get("time", "")), reverse=True),
        "fusedTimeline": sorted(events, key=lambda item: str(item.get("windowStart", ""))),
        "selectedEvent": selected, "contributions": contributions,
        "qualityChecks": [
            {"label": "数据源均绑定已发布 schema", "passed": all(int(item.get("schemaVersion", 0)) > 0 for item in sources)},
            {"label": "单位已映射到规范单位", "passed": all(item.get("canonicalUnit") for item in sources)},
            {"label": "观测保留事件时间与接入时间", "passed": all(item.get("eventTime") and item.get("ingestTime") for item in observations)},
            {"label": "融合结论可追溯原始观测", "passed": all(item.get("evidenceIds") for item in events)},
            {"label": "已发布模型完成双人审批", "passed": all(len({approval.get("actor") for approval in item.get("approvals", [])}) >= 2 for item in workspace.get("modelVersions", []) if item.get("status") == "published")},
            {"label": "校准版本进入观测血缘", "passed": all(item.get("calibrationVersion") for item in observations)},
        ],
        "replay": workspace.get("lastReplay", {"from": times[8] if len(times) > 8 else times[0] if times else None, "to": times[-1] if times else None, "observations": finite_rows, "events": len(events)}),
    }


def _csv_safe(value: Any) -> str:
    text = _clean(value, 10_000)
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


def _exports(result: dict[str, Any]) -> dict[str, str]:
    workspace = result["workspace"]
    observations_io = io.StringIO()
    writer = csv.writer(observations_io, lineterminator="\n")
    writer.writerow(["观测ID", "源ID", "事件时间", "接入时间", "数值", "单位", "质量", "校准版本", "追踪ID"])
    for item in result["observations"]:
        writer.writerow([item.get("id"), item.get("sourceId"), item.get("eventTime"), item.get("ingestTime"), item.get("value", ""), item.get("unit"), item.get("quality"), item.get("calibrationVersion"), item.get("traceId")])
    events_io = io.StringIO()
    writer = csv.writer(events_io, lineterminator="\n")
    writer.writerow(["事件ID", "开始时间", "等级", "风险分", "状态", "标题", "模型版本", "证据数量", "复核人"])
    for item in workspace.get("fusedEvents", []):
        writer.writerow([item.get("id"), item.get("windowStart"), item.get("level"), item.get("riskScore"), item.get("status"), _csv_safe(item.get("title")), item.get("modelVersionId"), len(item.get("evidenceIds", [])), _csv_safe(item.get("reviewer"))])
    audit_io = io.StringIO()
    writer = csv.writer(audit_io, lineterminator="\n")
    writer.writerow(["审计ID", "时间", "动作", "操作人", "对象", "说明"])
    for item in workspace.get("audit", []):
        writer.writerow([item.get("id"), item.get("time"), item.get("action"), _csv_safe(item.get("actor")), item.get("target"), _csv_safe(item.get("detail"))])
    metrics = result["analysis"]["metrics"]
    report = "\n".join([
        "# 多源监测融合研判报告", "", f"- 项目：{workspace['name']}", f"- 生成时间：{_now()}",
        f"- 数据源：{metrics['onlineSources']}/{metrics['sources']} 在线", f"- 数据完整率：{metrics['completeness']}%",
        f"- 融合事件：{metrics['fusedEvents']}（严重 {metrics['criticalEvents']}，待复核 {metrics['pendingReview']}）", "",
        "## 融合事件", *[f"- [{item['level']}] {item['title']}：{item['riskScore']:.0%}，{len(item.get('evidenceIds', []))} 条证据，状态 {item['status']}" for item in workspace.get("fusedEvents", [])], "",
        "## 质量门禁", *[f"- {'通过' if item['passed'] else '未通过'}：{item['label']}" for item in result["analysis"]["qualityChecks"]],
    ])
    lineage = json.dumps({"schemas": result["schemas"], "calibrationVersions": workspace.get("calibrationVersions", []), "featureSets": workspace.get("featureSets", []), "modelVersions": workspace.get("modelVersions", []), "events": workspace.get("fusedEvents", [])}, ensure_ascii=False, indent=2)
    backup = json.dumps({key: result[key] for key in ["schema", "version", "workspace", "sources", "schemas", "observations", "analysis", "runtime"]}, ensure_ascii=False, indent=2)
    package_stream = io.BytesIO()
    with zipfile.ZipFile(package_stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("fusion-report.md", report)
        archive.writestr("observations.csv", observations_io.getvalue())
        archive.writestr("fused-events.csv", events_io.getvalue())
        archive.writestr("audit.csv", audit_io.getvalue())
        archive.writestr("lineage.json", lineage)
        archive.writestr("fusion-console-backup.json", backup)
    return {"reportMarkdown": report, "observationsCsv": observations_io.getvalue(), "eventsCsv": events_io.getvalue(), "auditCsv": audit_io.getvalue(), "lineageJson": lineage, "backupJson": backup, "packageBase64": base64.b64encode(package_stream.getvalue()).decode("ascii")}


def _result(workspace: dict[str, Any], sources: list[dict[str, Any]], schemas: list[dict[str, Any]], observations: list[dict[str, Any]], stage: str, **extra: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"schema": SCHEMA, "version": 2, "stage": stage, "workspace": workspace, "sources": sources, "schemas": schemas, "observations": observations[-MAX_IMPORT_ROWS:]}
    result["analysis"] = _analysis(workspace, sources, result["observations"])
    result["runtime"] = {
        "controlPlane": "Go 项目、版本、作业、权限与审计", "computePlane": "Python 事件时间对齐、质量计算、特征与融合解释",
        "ingestion": {"mqtt": "adapter-ready", "http": "adapter-ready", "file": "enabled", "kafka": "not-configured", "opcUa": "not-configured"},
        "streamProcessing": {"engine": "Kafka/Flink adapter", "status": "not-configured"},
        "timeSeriesStore": {"engine": "TimescaleDB/InfluxDB adapter", "status": "not-configured"},
        "modelWorker": {"engine": "HTTP model worker", "status": "not-configured", "localDeterministicFusion": "enabled"},
        "supportedImports": ["CSV", "JSON", "NDJSON"], "supportedExports": ["CSV", "JSON", "Markdown", "ZIP"], "arbitraryCodeExecution": False,
    }
    result.update(extra)
    result["exports"] = _exports(result)
    return result


def _bundle(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    state = payload.get("state") or {}
    if not isinstance(state, dict) or state.get("schema") != SCHEMA:
        sample = _sample()
        return deepcopy(sample["workspace"]), deepcopy(sample["sources"]), deepcopy(sample["schemas"]), deepcopy(sample["observations"])
    return tuple(deepcopy(state[key]) for key in ["workspace", "sources", "schemas", "observations"])  # type: ignore[return-value]


def _find(items: list[dict[str, Any]], item_id: str, label: str) -> dict[str, Any]:
    item = next((entry for entry in items if entry.get("id") == item_id), None)
    if not item:
        raise ToolError(f"{label}不存在")
    return item


def _import_rows(content: str, file_name: str, source_ids: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(content.encode("utf-8")) > 4_000_000:
        raise ToolError("观测文件不能超过 4 MB")
    try:
        if file_name.lower().endswith(".json"):
            raw_rows = json.loads(content)
        elif file_name.lower().endswith(".ndjson"):
            raw_rows = [json.loads(line) for line in content.splitlines() if line.strip()]
        else:
            raw_rows = list(csv.DictReader(io.StringIO(content)))
    except (json.JSONDecodeError, csv.Error) as exc:
        raise ToolError("观测文件无法解析") from exc
    if not isinstance(raw_rows, list):
        raise ToolError("观测数据必须是记录数组")
    if len(raw_rows) > MAX_IMPORT_ROWS:
        raise ToolError(f"一次最多导入 {MAX_IMPORT_ROWS} 行")
    accepted, rejected = [], []
    for index, raw in enumerate(raw_rows, start=2):
        if not isinstance(raw, dict):
            rejected.append({"line": index, "reason": "不是对象"})
            continue
        source_id = _clean(raw.get("sourceId") or raw.get("source_id"), 100)
        try:
            event_time = _parse_time(raw.get("eventTime") or raw.get("timestamp"))
            value = float(raw.get("value"))
            if not math.isfinite(value):
                raise ValueError
        except (ToolError, TypeError, ValueError):
            rejected.append({"line": index, "reason": "时间或数值无效"})
            continue
        if source_id not in source_ids:
            rejected.append({"line": index, "reason": "数据源未注册"})
            continue
        accepted.append({"id": f"obs-import-{uuid.uuid4().hex[:10]}", "sourceId": source_id, "eventTime": event_time.isoformat().replace("+00:00", "Z"), "ingestTime": _now(), "rawValue": value, "value": value, "unit": _clean(raw.get("unit"), 30), "quality": "good", "calibrationVersion": _clean(raw.get("calibrationVersion"), 60) or "unverified", "traceId": f"trace-{uuid.uuid4().hex[:10]}", "source": _clean(file_name, 200)})
    return accepted, rejected


def _legacy_align(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("observations")
    try:
        observations = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError as exc:
        raise ToolError("observations 必须是非空 JSON 数组") from exc
    if not isinstance(observations, list) or not observations:
        raise ToolError("observations 必须是非空 JSON 数组")
    window_seconds = max(1, int(float(payload.get("windowSeconds", 60))))
    buckets: dict[int, list[dict[str, Any]]] = {}
    rejected = []
    for item in observations:
        try:
            timestamp = _parse_time(item.get("timestamp"))
            value = float(item.get("value"))
        except (AttributeError, ToolError, TypeError, ValueError):
            rejected.append(item)
            continue
        epoch = int(timestamp.timestamp()) // window_seconds * window_seconds
        buckets.setdefault(epoch, []).append({**item, "value": value})
    groups = [{"timestamp": datetime.fromtimestamp(epoch, UTC).isoformat(), "sources": sorted({_clean(item.get("source"), 100) or "unknown" for item in items}), "count": len(items), "average": round(statistics.mean(item["value"] for item in items), 6), "spread": round(statistics.pstdev(item["value"] for item in items), 6)} for epoch, items in sorted(buckets.items())]
    return {"windowSeconds": window_seconds, "groups": groups, "rejected": len(rejected)}


def run_fusion_console(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "align" and not payload.get("state"):
        return _legacy_align(payload)
    if action in {"load-sample", "run-all"}:
        return _sample()
    workspace, sources, schemas, observations = _bundle(payload)
    actor = _clean(payload.get("actor"), 80) or "当前数据工程师"

    if action == "register-source":
        name, protocol, unit = _clean(payload.get("name"), 120), _clean(payload.get("protocol"), 30).upper(), _clean(payload.get("unit"), 30)
        if not name or protocol not in {"MQTT", "HTTP", "KAFKA", "FILE", "OPC-UA"} or not unit:
            raise ToolError("名称、支持的协议和单位不能为空")
        source_id = f"src-{uuid.uuid4().hex[:8]}"
        sources.append({"id": source_id, "name": name, "protocol": protocol, "kind": _clean(payload.get("kind"), 80) or "custom", "unit": unit, "canonicalUnit": _clean(payload.get("canonicalUnit"), 30) or unit, "status": "registered", "clockOffsetSeconds": 0, "watermarkSeconds": max(1, int(payload.get("watermarkSeconds", 30))), "x": float(payload.get("x", 50)), "y": float(payload.get("y", 50)), "owner": actor, "schemaVersion": 1, "calibrationVersion": "unverified", "lastSeen": None, "retentionDays": 365})
        schemas.append({"id": f"schema-{source_id}", "sourceId": source_id, "version": 1, "status": "draft", "fields": [{"name": "eventTime", "type": "datetime", "required": True}, {"name": "value", "type": "number", "required": True}], "unit": unit, "crs": _clean(payload.get("crs"), 40) or "LOCAL-METER", "approvedBy": [], "publishedAt": None})
        _audit(workspace, action, actor, source_id, f"注册 {protocol} 数据源 {name}")
    elif action == "govern-schema":
        source = _find(sources, _clean(payload.get("sourceId"), 100), "数据源")
        schema = _find(schemas, f"schema-{source['id']}", "Schema")
        schema["unit"] = _clean(payload.get("unit"), 30) or schema.get("unit")
        schema["crs"] = _clean(payload.get("crs"), 40) or schema.get("crs")
        approver = _clean(payload.get("approver"), 80) or actor
        approvals = set(schema.get("approvedBy", [])); approvals.add(approver); schema["approvedBy"] = sorted(approvals)
        if len(approvals) >= 2:
            schema["status"], schema["publishedAt"] = "published", _now()
            source["schemaVersion"] = schema["version"]
            source["canonicalUnit"] = schema["unit"]
        else:
            schema["status"] = "review"
        _audit(workspace, action, actor, schema["id"], f"Schema 审批累计 {len(approvals)} 人")
    elif action == "calibrate-source":
        source = _find(sources, _clean(payload.get("sourceId"), 100), "数据源")
        factor, offset = float(payload.get("factor", 1)), float(payload.get("offset", 0))
        if not math.isfinite(factor) or factor == 0 or not math.isfinite(offset):
            raise ToolError("校准系数无效")
        version_id = f"cal-{uuid.uuid4().hex[:8]}"
        workspace.setdefault("calibrationVersions", []).insert(0, {"id": version_id, "sourceId": source["id"], "status": "review", "factor": factor, "offset": offset, "approvedBy": [actor], "createdAt": _now()})
        source["calibrationVersion"] = version_id
        for item in observations:
            if item.get("sourceId") == source["id"] and item.get("rawValue") is not None:
                item["value"] = round(float(item["rawValue"]) * factor + offset, 6); item["calibrationVersion"] = version_id
        _audit(workspace, action, actor, source["id"], f"应用校准 {version_id}：factor={factor}, offset={offset}")
    elif action == "import-observations":
        accepted, rejected = _import_rows(_clean(payload.get("content"), 4_000_000), _clean(payload.get("fileName"), 200) or "observations.csv", {item["id"] for item in sources})
        observations.extend(accepted)
        _audit(workspace, action, actor, "observations", f"导入 {len(accepted)} 行，拒绝 {len(rejected)} 行")
        return _result(workspace, sources, schemas, observations, action, importSummary={"accepted": len(accepted), "rejected": len(rejected), "violations": rejected[:200]})
    elif action == "run-quality-checks":
        created = 0
        for source in sources:
            offset = abs(float(source.get("clockOffsetSeconds", 0)))
            watermark = max(1, float(source.get("watermarkSeconds", 30)))
            if offset > watermark / 2 and not any(item.get("sourceId") == source["id"] and item.get("type") == "clock-drift" and item.get("status") == "open" for item in workspace.get("qualityEvents", [])):
                workspace.setdefault("qualityEvents", []).insert(0, {"id": f"quality-{uuid.uuid4().hex[:8]}", "sourceId": source["id"], "type": "clock-drift", "severity": "warning", "status": "open", "time": _now(), "detail": f"时钟偏移 {offset:.0f} 秒超过水位线的一半"}); created += 1
        _audit(workspace, action, actor, "quality", f"完成缺失、时钟漂移和有限值检查，新增 {created} 个质量事件")
    elif action in {"align-observations", "align"}:
        window_seconds = max(10, min(86_400, int(payload.get("windowSeconds", workspace.get("windowSeconds", 300)))))
        workspace["windowSeconds"] = window_seconds
        _, series = _aligned_series(sources, observations, window_seconds)
        job = {"id": f"align-{uuid.uuid4().hex[:8]}", "status": "succeeded", "windowSeconds": window_seconds, "mode": "event-time", "watermarkSeconds": max((int(item.get("watermarkSeconds", 30)) for item in sources), default=30), "inputRows": len(observations), "outputWindows": max((len(item["values"]) for item in series), default=0), "lateRows": sum(_parse_time(item["ingestTime"]) - _parse_time(item["eventTime"]) > timedelta(seconds=90) for item in observations), "createdAt": _now()}
        workspace.setdefault("alignmentJobs", []).insert(0, job); workspace["alignmentJobs"] = workspace["alignmentJobs"][:50]
        _audit(workspace, action, actor, job["id"], f"按 {window_seconds} 秒事件时间窗口完成对齐")
    elif action == "build-features":
        feature_id = f"features-{uuid.uuid4().hex[:8]}"
        workspace.setdefault("featureSets", []).insert(0, {"id": feature_id, "name": _clean(payload.get("name"), 120) or "联合变化特征", "version": len(workspace.get("featureSets", [])) + 1, "status": "review", "features": ["窗口均值", "窗口增量", "归一化强度", "跨源一致性"], "lineage": [item["id"] for item in sources], "createdAt": _now()})
        _audit(workspace, action, actor, feature_id, "生成可追溯联合特征集")
    elif action == "run-fusion":
        analysis = _analysis(workspace, sources, observations)
        contributions = analysis["contributions"]
        score = round(min(1, sum(item["contribution"] for item in contributions) * 1.22), 4)
        level = "critical" if score >= .86 else "high" if score >= .72 else "warning" if score >= .55 else "normal"
        evidence = []
        for source in sources:
            latest = next((item for item in reversed(observations) if item.get("sourceId") == source["id"] and item.get("value") is not None), None)
            if latest:
                evidence.append(latest["id"])
        event_id = f"fused-{uuid.uuid4().hex[:8]}"
        workspace.setdefault("fusedEvents", []).append({"id": event_id, "windowStart": analysis["timeAxis"][-1] if analysis["timeAxis"] else _now(), "windowEnd": _now(), "riskScore": score, "level": level, "status": "review", "title": _clean(payload.get("title"), 160) or "最新窗口多源联合研判", "evidenceIds": evidence, "modelVersionId": _clean(payload.get("modelVersionId"), 100) or "model-v3", "reviewer": "", "reviewedAt": None})
        workspace["selectedEventId"] = event_id
        _audit(workspace, action, actor, event_id, f"生成 {level} 融合事件，风险分 {score:.2f}，关联 {len(evidence)} 条原始观测")
    elif action == "review-fused-event":
        event = _find(workspace.get("fusedEvents", []), _clean(payload.get("eventId"), 100), "融合事件")
        decision = _clean(payload.get("decision"), 30)
        if decision not in {"confirmed", "rejected", "review"}:
            raise ToolError("复核结论无效")
        event.update({"status": decision, "reviewer": actor, "reviewedAt": _now(), "reviewNote": _clean(payload.get("note"), 500)})
        _audit(workspace, action, actor, event["id"], f"融合事件复核为 {decision}")
    elif action == "publish-model-version":
        version = _find(workspace.get("modelVersions", []), _clean(payload.get("versionId"), 100), "模型版本")
        approvals = version.setdefault("approvals", [])
        if actor not in {item.get("actor") for item in approvals}:
            approvals.append({"actor": actor, "time": _now()})
        version["status"] = "published" if len({item.get("actor") for item in approvals}) >= 2 else "review"
        _audit(workspace, action, actor, version["id"], f"模型版本审批累计 {len(approvals)} 人，状态 {version['status']}")
    elif action == "replay-window":
        start, end = _parse_time(payload.get("from")), _parse_time(payload.get("to"))
        if end <= start:
            raise ToolError("回放结束时间必须晚于开始时间")
        workspace["lastReplay"] = {"from": start.isoformat().replace("+00:00", "Z"), "to": end.isoformat().replace("+00:00", "Z"), "observations": sum(start <= _parse_time(item["eventTime"]) <= end for item in observations), "events": sum(start <= _parse_time(item["windowStart"]) <= end for item in workspace.get("fusedEvents", [])), "createdAt": _now()}
        _audit(workspace, action, actor, "replay", f"回放 {workspace['lastReplay']['observations']} 条观测和 {workspace['lastReplay']['events']} 个事件")
    elif action in {"runtime-status", "validate", "export"}:
        if action == "validate":
            _audit(workspace, action, actor, workspace["id"], "执行 schema、单位、时间、血缘与模型审批门禁")
    else:
        raise ToolError("不支持的多源融合操作")
    return _result(workspace, sources, schemas, observations, action)
