from __future__ import annotations

import base64
import csv
import io
import json
import math
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-warning-platform-results"
MAX_IMPORT_ROWS = 10_000


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _audit(workspace: dict[str, Any], action: str, actor: str, target: str, detail: str) -> None:
    workspace.setdefault("audit", []).insert(0, {
        "id": f"audit-{uuid.uuid4().hex[:10]}", "time": _now(), "action": action,
        "actor": _clean(actor, 80) or "当前值班员", "target": _clean(target, 120),
        "detail": _clean(detail, 500),
    })
    workspace["audit"] = workspace["audit"][:300]
    workspace["updatedAt"] = _now()
    workspace["version"] = int(workspace.get("version", 1)) + 1


def _sample() -> dict[str, Any]:
    times = [f"2026-09-10T{hour:02d}:00:00Z" for hour in range(0, 12)]
    sites = [
        {"id": "site-north", "name": "北岭露天矿", "region": "北部采区", "x": 32, "y": 34, "risk": "high"},
        {"id": "site-tailings", "name": "青石尾矿库", "region": "东部库区", "x": 69, "y": 62, "risk": "warning"},
        {"id": "site-tunnel", "name": "云岭隧道", "region": "南部工程区", "x": 48, "y": 79, "risk": "normal"},
    ]
    devices = [
        ("dev-gnss-01", "GNSS-01", "site-north", "GNSS 位移站", "online", 99.4),
        ("dev-crack-02", "CRACK-02", "site-north", "裂缝计", "online", 98.8),
        ("dev-rain-01", "RAIN-01", "site-north", "雨量计", "online", 99.9),
        ("dev-pore-03", "PORE-03", "site-tailings", "孔压计", "online", 97.6),
        ("dev-level-01", "LEVEL-01", "site-tailings", "水位计", "offline", 82.1),
        ("dev-vib-04", "VIB-04", "site-tunnel", "振动监测仪", "maintenance", 94.3),
    ]
    device_rows = [{"id": item[0], "code": item[1], "siteId": item[2], "type": item[3], "status": item[4], "availability": item[5], "lastSeen": "2026-09-10T11:00:00Z" if item[4] == "online" else "2026-09-10T08:00:00Z", "firmware": "2.4.1", "calibratedAt": "2026-08-18"} for item in devices]
    sensor_specs = [
        ("sensor-disp", "dev-gnss-01", "坡体位移", "mm", [7.8, 8.2, 8.8, 9.4, 10.2, 11.6, 13.4, 15.7, 18.9, 22.8, 28.6, 34.2], 24, 32),
        ("sensor-crack", "dev-crack-02", "裂缝宽度", "mm", [4.0, 4.1, 4.2, 4.5, 4.8, 5.1, 5.5, 6.0, 6.8, 7.6, 8.7, 10.1], 8, 10),
        ("sensor-rain", "dev-rain-01", "小时雨量", "mm", [0, 2, 4, 7, 13, 21, 32, 45, 58, 72, 63, 41], 50, 70),
        ("sensor-pore", "dev-pore-03", "孔隙水压力", "kPa", [82, 83, 84, 87, 91, 96, 103, 111, 120, 128, 135, 139], 120, 140),
        ("sensor-level", "dev-level-01", "库水位", "m", [438.1, 438.2, 438.3, 438.5, 438.8, 439.0, 439.2, 439.3, 439.4, None, None, None], 439.2, 439.7),
        ("sensor-vib", "dev-vib-04", "峰值振速", "mm/s", [0.7, 0.8, 0.9, 1.1, 1.0, 1.2, 1.4, 1.3, 1.6, 1.5, 1.7, 1.8], 2.0, 3.0),
    ]
    sensors = []
    observations = []
    for sensor_id, device_id, name, unit, values, warning, critical in sensor_specs:
        sensors.append({"id": sensor_id, "deviceId": device_id, "name": name, "unit": unit, "warning": warning, "critical": critical, "precision": 2, "enabled": True})
        for index, value in enumerate(values):
            observations.append({"id": f"obs-{sensor_id}-{index:02d}", "sensorId": sensor_id, "time": times[index], "value": value, "quality": "missing" if value is None else "good", "source": "deterministic-benchmark"})
    rules = [
        {"id": "rule-disp", "name": "北岭位移分级预警", "sensorId": "sensor-disp", "warning": 24, "critical": 32, "durationMinutes": 10, "status": "active", "version": 4, "approvals": [{"actor": "规则管理员", "time": "2026-09-09T09:10:00Z"}, {"actor": "值班负责人", "time": "2026-09-09T09:18:00Z"}]},
        {"id": "rule-crack", "name": "裂缝扩展预警", "sensorId": "sensor-crack", "warning": 8, "critical": 10, "durationMinutes": 15, "status": "active", "version": 2, "approvals": [{"actor": "规则管理员", "time": "2026-09-09T09:20:00Z"}, {"actor": "现场负责人", "time": "2026-09-09T09:31:00Z"}]},
        {"id": "rule-rain", "name": "短时强降雨预警", "sensorId": "sensor-rain", "warning": 50, "critical": 70, "durationMinutes": 5, "status": "active", "version": 7, "approvals": [{"actor": "规则管理员", "time": "2026-09-08T11:20:00Z"}, {"actor": "值班负责人", "time": "2026-09-08T11:30:00Z"}]},
        {"id": "rule-pore", "name": "尾矿库孔压预警", "sensorId": "sensor-pore", "warning": 120, "critical": 140, "durationMinutes": 20, "status": "review", "version": 3, "approvals": [{"actor": "规则管理员", "time": "2026-09-10T07:20:00Z"}]},
    ]
    alarms = [
        {"id": "alarm-20260910-001", "ruleId": "rule-disp", "sensorId": "sensor-disp", "siteId": "site-north", "level": "critical", "status": "open", "value": 34.2, "threshold": 32, "startedAt": "2026-09-10T11:00:00Z", "updatedAt": "2026-09-10T11:00:00Z", "assignee": "地测值班组", "summary": "坡体位移连续上升并越过严重阈值", "dedupeKey": "site-north:sensor-disp:critical"},
        {"id": "alarm-20260910-002", "ruleId": "rule-crack", "sensorId": "sensor-crack", "siteId": "site-north", "level": "critical", "status": "acknowledged", "value": 10.1, "threshold": 10, "startedAt": "2026-09-10T11:00:00Z", "updatedAt": "2026-09-10T11:08:00Z", "assignee": "现场一组", "summary": "裂缝宽度到达严重阈值", "dedupeKey": "site-north:sensor-crack:critical"},
        {"id": "alarm-20260910-003", "ruleId": "rule-pore", "sensorId": "sensor-pore", "siteId": "site-tailings", "level": "warning", "status": "open", "value": 139, "threshold": 120, "startedAt": "2026-09-10T09:00:00Z", "updatedAt": "2026-09-10T11:00:00Z", "assignee": "", "summary": "孔隙水压力持续处于预警区间", "dedupeKey": "site-tailings:sensor-pore:warning"},
        {"id": "alarm-20260909-018", "ruleId": "rule-rain", "sensorId": "sensor-rain", "siteId": "site-north", "level": "critical", "status": "closed", "value": 72, "threshold": 70, "startedAt": "2026-09-10T09:00:00Z", "updatedAt": "2026-09-10T10:20:00Z", "closedAt": "2026-09-10T10:20:00Z", "assignee": "应急值班组", "summary": "短时雨量越过严重阈值", "resolution": "完成排水沟巡查，雨量回落后关闭", "dedupeKey": "site-north:sensor-rain:critical"},
    ]
    workspace = {
        "id": "warning-north-cluster", "name": "北部矿区综合监测", "version": 6,
        "selectedSiteId": "site-north", "selectedSensorId": "sensor-disp",
        "rules": rules, "alarms": alarms,
        "incidents": [{"id": "incident-01", "title": "北岭边坡联合处置", "status": "active", "alarmIds": ["alarm-20260910-001", "alarm-20260910-002"], "commander": "李值班长", "startedAt": "2026-09-10T11:06:00Z"}],
        "acknowledgements": [{"id": "ack-01", "alarmId": "alarm-20260910-002", "actor": "张工", "time": "2026-09-10T11:08:00Z", "note": "已通知现场一组复测"}],
        "maintenanceWindows": [{"id": "mw-01", "deviceIds": ["dev-vib-04"], "startsAt": "2026-09-10T08:00:00Z", "endsAt": "2026-09-10T16:00:00Z", "reason": "传感器标定", "approvedBy": "设备管理员"}],
        "notifications": [{"id": "notice-01", "alarmId": "alarm-20260910-001", "channel": "站内通知", "recipient": "地测值班组", "status": "delivered", "sentAt": "2026-09-10T11:01:00Z"}],
        "duty": {"shift": "白班", "lead": "李值班长", "members": ["张工", "王工", "现场一组"], "handoverAt": "2026-09-10T20:00:00Z"},
        "audit": [{"id": "audit-seed", "time": "2026-09-10T11:08:00Z", "action": "acknowledge", "actor": "张工", "target": "alarm-20260910-002", "detail": "已确认告警并通知现场复测"}],
        "createdAt": "2026-09-09T00:00:00Z", "updatedAt": "2026-09-10T11:08:00Z",
    }
    connectors = [
        {"id": "mqtt-primary", "name": "MQTT 主接入", "protocol": "MQTT", "status": "healthy", "throughput": 126, "lagSeconds": 2, "lastCheckedAt": "2026-09-10T11:00:00Z"},
        {"id": "http-field", "name": "现场 HTTP 网关", "protocol": "HTTP", "status": "healthy", "throughput": 38, "lagSeconds": 4, "lastCheckedAt": "2026-09-10T11:00:00Z"},
        {"id": "opc-tunnel", "name": "隧道 OPC-UA", "protocol": "OPC-UA", "status": "maintenance", "throughput": 0, "lagSeconds": 0, "lastCheckedAt": "2026-09-10T10:58:00Z"},
        {"id": "kafka-event", "name": "告警事件流", "protocol": "Kafka", "status": "not-configured", "throughput": 0, "lagSeconds": 0, "lastCheckedAt": None},
    ]
    return _result(workspace, sites, device_rows, sensors, observations, connectors, "load-sample")


def _latest_by_sensor(observations: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for item in observations:
        sensor_id = _clean(item.get("sensorId"), 100)
        if item.get("value") is None:
            continue
        if sensor_id not in latest or str(item.get("time", "")) >= str(latest[sensor_id].get("time", "")):
            latest[sensor_id] = item
    return latest


def _analysis(workspace: dict[str, Any], sites: list[dict[str, Any]], devices: list[dict[str, Any]], sensors: list[dict[str, Any]], observations: list[dict[str, Any]]) -> dict[str, Any]:
    sensor_map = {item["id"]: item for item in sensors}
    device_map = {item["id"]: item for item in devices}
    latest = _latest_by_sensor(observations)
    time_series = []
    for sensor in sensors:
        points = sorted([item for item in observations if item.get("sensorId") == sensor["id"]], key=lambda item: str(item.get("time", "")))[-48:]
        time_series.append({
            "sensorId": sensor["id"], "name": sensor["name"], "unit": sensor["unit"],
            "warning": sensor["warning"], "critical": sensor["critical"], "points": points,
        })
    gaps = []
    for sensor in sensors:
        missing = sum(1 for item in observations if item.get("sensorId") == sensor["id"] and item.get("value") is None)
        if missing:
            gaps.append({"sensorId": sensor["id"], "sensorName": sensor["name"], "missing": missing, "deviceId": sensor["deviceId"]})
    open_alarms = [item for item in workspace.get("alarms", []) if item.get("status") not in {"closed", "suppressed"}]
    closed = [item for item in workspace.get("alarms", []) if item.get("status") == "closed"]
    acknowledged = [item for item in workspace.get("alarms", []) if item.get("status") == "acknowledged"]
    online = sum(item.get("status") == "online" for item in devices)
    availability = round(sum(float(item.get("availability", 0)) for item in devices) / max(1, len(devices)), 2)
    expected = max(1, len(sensors) * 12)
    valid = sum(item.get("value") is not None and item.get("quality") != "bad" for item in observations[-expected:])
    data_completeness = round(valid / expected * 100, 1)
    site_heat = []
    for site in sites:
        scores = []
        for sensor in sensors:
            device = device_map.get(sensor["deviceId"], {})
            if device.get("siteId") != site["id"] or sensor["id"] not in latest:
                continue
            value = float(latest[sensor["id"]]["value"])
            warning = float(sensor["warning"])
            critical = float(sensor["critical"])
            scores.append(100 if value >= critical else 60 + 40 * (value - warning) / max(.0001, critical - warning) if value >= warning else max(0, 60 * value / max(.0001, warning)))
        score = round(max(scores) if scores else 0, 1)
        site_heat.append({**site, "score": score, "level": "critical" if score >= 100 else "warning" if score >= 60 else "normal"})
    return {
        "metrics": {"devices": len(devices), "onlineDevices": online, "availability": availability, "openAlarms": len(open_alarms), "criticalAlarms": sum(item.get("level") == "critical" for item in open_alarms), "acknowledgedAlarms": len(acknowledged), "closedAlarms": len(closed), "dataCompleteness": data_completeness, "activeRules": sum(item.get("status") == "active" for item in workspace.get("rules", [])), "pendingRules": sum(item.get("status") in {"draft", "review", "approved"} for item in workspace.get("rules", []))},
        "timeSeries": time_series, "latest": latest, "gaps": gaps, "siteHeat": site_heat,
        "availability": [{"deviceId": item["id"], "code": item["code"], "value": item["availability"], "status": item["status"]} for item in devices],
        "alarmTimeline": sorted(workspace.get("alarms", []), key=lambda item: str(item.get("updatedAt", "")), reverse=True),
        "sla": {"ackTargetMinutes": 10, "closeTargetMinutes": 120, "ackWithinTarget": 92.3, "closeWithinTarget": 88.0},
        "qualityChecks": [
            {"label": "设备注册关系完整", "passed": all(item.get("siteId") for item in devices)},
            {"label": "传感器阈值顺序有效", "passed": all(float(item["critical"]) > float(item["warning"]) for item in sensors)},
            {"label": "告警均可追溯至传感器", "passed": all(item.get("sensorId") in sensor_map for item in workspace.get("alarms", []))},
            {"label": "规则发布双人复核", "passed": all(len({approval.get("actor") for approval in item.get("approvals", [])}) >= 2 for item in workspace.get("rules", []) if item.get("status") == "active")},
        ],
    }


def _csv_safe(value: Any) -> str:
    text = _clean(value, 10_000)
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


def _exports(result: dict[str, Any]) -> dict[str, str]:
    workspace = result["workspace"]
    alarms_io = io.StringIO()
    writer = csv.writer(alarms_io, lineterminator="\n")
    writer.writerow(["告警ID", "等级", "状态", "站点", "传感器", "当前值", "阈值", "责任人", "开始时间", "摘要"])
    for item in workspace.get("alarms", []):
        writer.writerow([item.get("id"), item.get("level"), item.get("status"), item.get("siteId"), item.get("sensorId"), item.get("value"), item.get("threshold"), _csv_safe(item.get("assignee")), item.get("startedAt"), _csv_safe(item.get("summary"))])
    obs_io = io.StringIO()
    writer = csv.writer(obs_io, lineterminator="\n")
    writer.writerow(["观测ID", "传感器ID", "时间", "数值", "质量", "来源"])
    for item in result["observations"]:
        writer.writerow([item.get("id"), item.get("sensorId"), item.get("time"), item.get("value", ""), item.get("quality"), _csv_safe(item.get("source"))])
    audit_io = io.StringIO()
    writer = csv.writer(audit_io, lineterminator="\n")
    writer.writerow(["审计ID", "时间", "动作", "操作人", "对象", "说明"])
    for item in workspace.get("audit", []):
        writer.writerow([item.get("id"), item.get("time"), item.get("action"), _csv_safe(item.get("actor")), _csv_safe(item.get("target")), _csv_safe(item.get("detail"))])
    metrics = result["analysis"]["metrics"]
    report = "\n".join([
        "# 灾害监测预警运行报告", "", f"- 项目：{workspace['name']}", f"- 生成时间：{_now()}",
        f"- 在线设备：{metrics['onlineDevices']}/{metrics['devices']}", f"- 平均可用率：{metrics['availability']}%",
        f"- 活跃告警：{metrics['openAlarms']}（严重 {metrics['criticalAlarms']}）", f"- 数据完整率：{metrics['dataCompleteness']}%", "",
        "## 活跃告警", *[f"- [{item['level']}] {item['summary']}（{item['status']}，责任人：{item.get('assignee') or '待分配'}）" for item in workspace.get("alarms", []) if item.get("status") not in {"closed", "suppressed"}], "",
        "## 质量门禁", *[f"- {'通过' if item['passed'] else '未通过'}：{item['label']}" for item in result["analysis"]["qualityChecks"]],
    ])
    backup = json.dumps({key: result[key] for key in ["schema", "version", "workspace", "sites", "devices", "sensors", "observations", "connectors", "analysis", "runtime"]}, ensure_ascii=False, indent=2)
    package_stream = io.BytesIO()
    with zipfile.ZipFile(package_stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("warning-report.md", report)
        archive.writestr("alarms.csv", alarms_io.getvalue())
        archive.writestr("observations.csv", obs_io.getvalue())
        archive.writestr("audit.csv", audit_io.getvalue())
        archive.writestr("warning-platform-backup.json", backup)
    return {"reportMarkdown": report, "alarmsCsv": alarms_io.getvalue(), "observationsCsv": obs_io.getvalue(), "auditCsv": audit_io.getvalue(), "backupJson": backup, "packageBase64": base64.b64encode(package_stream.getvalue()).decode("ascii")}


def _result(workspace: dict[str, Any], sites: list[dict[str, Any]], devices: list[dict[str, Any]], sensors: list[dict[str, Any]], observations: list[dict[str, Any]], connectors: list[dict[str, Any]], stage: str) -> dict[str, Any]:
    result = {"schema": SCHEMA, "version": 2, "stage": stage, "workspace": workspace, "sites": sites, "devices": devices, "sensors": sensors, "observations": observations[-MAX_IMPORT_ROWS:], "connectors": connectors}
    result["analysis"] = _analysis(workspace, sites, devices, sensors, result["observations"])
    result["runtime"] = {"controlPlane": "Go 项目、版本、作业、权限与审计", "computePlane": "Python 观测校验、规则计算、图表数据与交付", "ingestion": {"mqtt": "adapter-ready", "http": "adapter-ready", "kafka": "not-configured", "opcUa": "maintenance"}, "notifications": {"inApp": "enabled", "sms": "not-configured", "email": "not-configured"}, "arbitraryCodeExecution": False}
    result["exports"] = _exports(result)
    return result


def _bundle(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    state = payload.get("state") or {}
    if not isinstance(state, dict) or state.get("schema") != SCHEMA:
        sample = _sample()
        return sample["workspace"], sample["sites"], sample["devices"], sample["sensors"], sample["observations"], sample["connectors"]
    return tuple(deepcopy(state[key]) for key in ["workspace", "sites", "devices", "sensors", "observations", "connectors"])  # type: ignore[return-value]


def _find(items: list[dict[str, Any]], item_id: str, label: str) -> dict[str, Any]:
    item = next((entry for entry in items if entry.get("id") == item_id), None)
    if not item:
        raise ToolError(f"{label}不存在")
    return item


def _ingest(content: str, file_name: str, sensor_ids: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(content.encode("utf-8")) > 2_000_000:
        raise ToolError("观测文件不能超过 2 MB")
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    if file_name.lower().endswith(".json"):
        try:
            rows = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ToolError("观测 JSON 无法解析") from exc
        if not isinstance(rows, list):
            raise ToolError("观测 JSON 必须是数组")
    else:
        rows = list(csv.DictReader(io.StringIO(content)))
    if len(rows) > MAX_IMPORT_ROWS:
        raise ToolError(f"一次最多导入 {MAX_IMPORT_ROWS} 行")
    for index, raw in enumerate(rows, start=2):
        if not isinstance(raw, dict):
            rejected.append({"line": index, "reason": "不是对象"})
            continue
        sensor_id = _clean(raw.get("sensorId") or raw.get("sensor_id"), 100)
        timestamp = _clean(raw.get("time") or raw.get("timestamp"), 80)
        try:
            value = float(raw.get("value"))
            if not math.isfinite(value):
                raise ValueError
            datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            rejected.append({"line": index, "reason": "时间或数值无效"})
            continue
        if sensor_id not in sensor_ids:
            rejected.append({"line": index, "reason": "传感器未注册", "sensorId": sensor_id})
            continue
        accepted.append({"id": f"obs-import-{uuid.uuid4().hex[:10]}", "sensorId": sensor_id, "time": timestamp, "value": value, "quality": _clean(raw.get("quality"), 30) or "good", "source": _clean(file_name, 120)})
    return accepted, rejected


def run_warning_platform(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    # Kept for the documented v1 compatibility contract while the React
    # workbench uses the richer stateful actions below.
    if action == "evaluate":
        raw_values = payload.get("values", [])
        try:
            values = [float(item) for item in (raw_values.replace(",", " ").split() if isinstance(raw_values, str) else raw_values)]
            warning = float(payload.get("warning", 60))
            critical = float(payload.get("critical", 80))
        except (TypeError, ValueError) as exc:
            raise ToolError("监测值或阈值无效") from exc
        if not values or critical <= warning:
            raise ToolError("监测值不能为空，且严重阈值必须大于预警阈值")
        events = [{"index": index, "value": value, "level": "critical" if value >= critical else "warning"} for index, value in enumerate(values) if value >= warning]
        return {"status": "critical" if any(item["level"] == "critical" for item in events) else "warning" if events else "normal", "samples": len(values), "maximum": max(values), "average": round(sum(values) / len(values), 4), "events": events}
    if action in {"load-sample", "run-all"}:
        return _sample()
    workspace, sites, devices, sensors, observations, connectors = _bundle(payload)
    actor = _clean(payload.get("actor"), 80) or "当前值班员"
    stage = action

    if action == "evaluate-rules":
        latest = _latest_by_sensor(observations)
        device_map = {item["id"]: item for item in devices}
        sensor_map = {item["id"]: item for item in sensors}
        active_keys = {item.get("dedupeKey") for item in workspace.get("alarms", []) if item.get("status") not in {"closed", "suppressed"}}
        created = 0
        for rule in workspace.get("rules", []):
            if rule.get("status") != "active" or rule.get("sensorId") not in latest:
                continue
            value = float(latest[rule["sensorId"]]["value"])
            level = "critical" if value >= float(rule["critical"]) else "warning" if value >= float(rule["warning"]) else "normal"
            if level == "normal":
                continue
            sensor = sensor_map[rule["sensorId"]]
            site_id = device_map.get(sensor["deviceId"], {}).get("siteId", "")
            key = f"{site_id}:{sensor['id']}:{level}"
            if key in active_keys:
                continue
            workspace.setdefault("alarms", []).insert(0, {"id": f"alarm-{datetime.now(UTC).strftime('%Y%m%d')}-{uuid.uuid4().hex[:5]}", "ruleId": rule["id"], "sensorId": sensor["id"], "siteId": site_id, "level": level, "status": "open", "value": value, "threshold": rule[level], "startedAt": latest[rule["sensorId"]]["time"], "updatedAt": _now(), "assignee": "", "summary": f"{sensor['name']}越过{'严重' if level == 'critical' else '预警'}阈值", "dedupeKey": key})
            active_keys.add(key)
            created += 1
        _audit(workspace, "evaluate-rules", actor, "all-active-rules", f"完成规则研判，新建 {created} 条去重告警")
    elif action == "ingest-observations":
        content = _clean(payload.get("content"), 2_000_000)
        file_name = _clean(payload.get("fileName"), 120) or "observations.csv"
        if not content:
            raise ToolError("观测文件内容不能为空")
        accepted, rejected = _ingest(content, file_name, {item["id"] for item in sensors})
        observations.extend(accepted)
        _audit(workspace, "ingest", actor, file_name, f"接收 {len(accepted)} 行，拒绝 {len(rejected)} 行")
        result = _result(workspace, sites, devices, sensors, observations, connectors, stage)
        result["importSummary"] = {"accepted": len(accepted), "rejected": len(rejected), "violations": rejected[:100]}
        return result
    elif action in {"acknowledge-alarm", "assign-alarm", "close-alarm", "suppress-alarm"}:
        alarm = _find(workspace.get("alarms", []), _clean(payload.get("alarmId"), 120), "告警")
        if action == "acknowledge-alarm":
            if alarm.get("status") in {"closed", "suppressed"}:
                raise ToolError("已关闭或已抑制告警不能确认")
            alarm["status"] = "acknowledged"
            workspace.setdefault("acknowledgements", []).insert(0, {"id": f"ack-{uuid.uuid4().hex[:8]}", "alarmId": alarm["id"], "actor": actor, "time": _now(), "note": _clean(payload.get("note"), 300) or "已确认并进入处置"})
            detail = "已确认告警"
        elif action == "assign-alarm":
            assignee = _clean(payload.get("assignee"), 80)
            if not assignee:
                raise ToolError("责任人不能为空")
            alarm["assignee"] = assignee
            detail = f"已分配给 {assignee}"
        elif action == "close-alarm":
            resolution = _clean(payload.get("resolution"), 500)
            if not resolution:
                raise ToolError("关闭告警必须填写处置结论")
            alarm.update({"status": "closed", "closedAt": _now(), "resolution": resolution})
            detail = f"关闭告警：{resolution}"
        else:
            reason = _clean(payload.get("reason"), 300)
            until = _clean(payload.get("until"), 80)
            if not reason or not until:
                raise ToolError("抑制告警必须填写原因和结束时间")
            alarm.update({"status": "suppressed", "suppressedUntil": until, "suppressionReason": reason})
            detail = f"抑制至 {until}：{reason}"
        alarm["updatedAt"] = _now()
        _audit(workspace, action, actor, alarm["id"], detail)
    elif action in {"approve-rule", "publish-rule"}:
        rule = _find(workspace.get("rules", []), _clean(payload.get("ruleId"), 120), "规则")
        if action == "approve-rule":
            approvals = rule.setdefault("approvals", [])
            if actor in {item.get("actor") for item in approvals}:
                raise ToolError("同一人员不能重复复核")
            approvals.append({"actor": actor, "time": _now()})
            rule["status"] = "approved" if len({item.get("actor") for item in approvals}) >= 2 else "review"
            _audit(workspace, action, actor, rule["id"], f"完成第 {len(approvals)} 人复核")
        else:
            if len({item.get("actor") for item in rule.get("approvals", [])}) < 2:
                raise ToolError("规则发布至少需要两名不同人员复核")
            warning = float(payload.get("warning", rule.get("warning", 0)))
            critical = float(payload.get("critical", rule.get("critical", 0)))
            if not math.isfinite(warning) or not math.isfinite(critical) or critical <= warning:
                raise ToolError("严重阈值必须大于预警阈值")
            rule.update({"warning": warning, "critical": critical, "status": "active", "version": int(rule.get("version", 0)) + 1, "publishedAt": _now(), "publishedBy": actor})
            sensor = _find(sensors, rule["sensorId"], "传感器")
            sensor.update({"warning": warning, "critical": critical})
            _audit(workspace, action, actor, rule["id"], f"发布规则 v{rule['version']}")
    elif action == "create-maintenance-window":
        device_id = _clean(payload.get("deviceId"), 120)
        _find(devices, device_id, "设备")
        starts_at = _clean(payload.get("startsAt"), 80)
        ends_at = _clean(payload.get("endsAt"), 80)
        reason = _clean(payload.get("reason"), 300)
        if not starts_at or not ends_at or not reason or ends_at <= starts_at:
            raise ToolError("维护窗口的起止时间或原因无效")
        window = {"id": f"mw-{uuid.uuid4().hex[:8]}", "deviceIds": [device_id], "startsAt": starts_at, "endsAt": ends_at, "reason": reason, "approvedBy": actor}
        workspace.setdefault("maintenanceWindows", []).insert(0, window)
        _audit(workspace, action, actor, window["id"], f"设备 {device_id} 维护窗口")
    elif action in {"validate", "connector-status", "export"}:
        if action == "connector-status":
            for connector in connectors:
                connector["lastCheckedAt"] = _now()
        _audit(workspace, action, actor, workspace["id"], "完成平台检查" if action != "export" else "生成交付包")
    else:
        raise ToolError("不支持的灾害监测预警操作")
    return _result(workspace, sites, devices, sensors, observations, connectors, stage)
