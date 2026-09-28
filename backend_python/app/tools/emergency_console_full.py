from __future__ import annotations

import base64
import csv
import io
import json
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from html import escape
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-emergency-console-results"
MAX_IMPORT_BYTES = 4_000_000
MAX_IMPORT_ROWS = 10_000


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _find(rows: list[dict[str, Any]], identifier: str, label: str) -> dict[str, Any]:
    item = next((row for row in rows if row.get("id") == identifier), None)
    if item is None:
        raise ToolError(f"{label}不存在")
    return item


def _audit(console: dict[str, Any], action: str, actor: str, target: str, detail: str) -> None:
    console.setdefault("audit", []).insert(0, {
        "id": f"audit-{uuid.uuid4().hex[:10]}", "time": _now(), "action": action,
        "actor": _clean(actor, 80) or "当前值班员", "target": _clean(target, 120),
        "detail": _clean(detail, 500),
    })
    console["audit"] = console["audit"][:500]
    console["version"] = int(console.get("version", 1)) + 1
    console["updatedAt"] = _now()


def _sample_console() -> dict[str, Any]:
    return {
        "id": "incident-console-north-slope", "name": "北岭矿区边坡应急协同", "version": 7,
        "selectedReportId": "report-003", "selectedTaskId": "task-004", "selectedDecisionId": "decision-003",
        "incident": {
            "id": "incident-20260910-001", "code": "INC-20260910-001", "title": "北侧边坡多源异常事件",
            "category": "地质灾害", "level": "red", "status": "active", "commander": "李指挥",
            "location": "北岭矿区北侧边坡", "startedAt": "2026-09-10T07:48:00Z",
            "summary": "连续降雨后 GNSS 位移、孔压与微震指标同步升高，已划定警戒区并组织现场复核。",
            "objectives": ["确保人员撤离危险区", "核实边坡变形范围", "保持矿区应急通道畅通"],
            "sensitiveFields": ["人员联系方式", "精确集合点坐标"],
        },
        "reports": [
            {"id": "report-001", "source": "GNSS 监测", "type": "sensor", "title": "位移速率持续升高", "content": "北坡 G12 点位移速率达到 6.8 mm/h。", "time": "2026-09-10T07:48:00Z", "status": "verified", "confidence": .98, "x": 63, "y": 31, "evidenceIds": ["ev-gnss-12"], "reviewer": "张审核"},
            {"id": "report-002", "source": "无人机巡检", "type": "uav", "title": "坡肩发现新增裂缝", "content": "正射影像显示约 18 m 连续裂缝，宽度 4–12 cm。", "time": "2026-09-10T08:06:00Z", "status": "verified", "confidence": .92, "x": 58, "y": 26, "evidenceIds": ["ev-uav-44", "ev-uav-45"], "reviewer": "陈审核"},
            {"id": "report-003", "source": "现场二组", "type": "field", "title": "排水沟局部堵塞", "content": "坡脚西段排水沟存在淤堵，积水深约 12 cm。", "time": "2026-09-10T08:22:00Z", "status": "review", "confidence": .81, "x": 46, "y": 68, "evidenceIds": ["ev-photo-208"], "reviewer": ""},
            {"id": "report-004", "source": "雨量站 R3", "type": "sensor", "title": "1 小时雨量超过阈值", "content": "过去一小时累计降雨 72 mm。", "time": "2026-09-10T08:31:00Z", "status": "verified", "confidence": .99, "x": 75, "y": 48, "evidenceIds": ["ev-rain-r3"], "reviewer": "系统规则+王值守"},
            {"id": "report-005", "source": "公众热线", "type": "public", "title": "北侧道路落石线索", "content": "来电称北侧便道有小块落石，尚未完成位置核验。", "time": "2026-09-10T08:43:00Z", "status": "unverified", "confidence": .42, "x": 31, "y": 54, "evidenceIds": ["ev-call-019"], "reviewer": ""},
        ],
        "verifications": [
            {"id": "verify-001", "reportId": "report-001", "decision": "verified", "reviewer": "张审核", "time": "2026-09-10T07:55:00Z", "note": "与孔压和历史基线交叉核验一致"},
            {"id": "verify-002", "reportId": "report-002", "decision": "verified", "reviewer": "陈审核", "time": "2026-09-10T08:13:00Z", "note": "影像定位和地面控制点通过"},
        ],
        "mapLayers": [
            {"id": "layer-base", "name": "矿区基础图", "type": "local-vector", "visible": True, "status": "sample-metadata"},
            {"id": "layer-hazard", "name": "危险区", "type": "GeoJSON", "visible": True, "status": "available"},
            {"id": "layer-route", "name": "疏散路线", "type": "GeoJSON", "visible": True, "status": "available"},
        ],
        "mapZones": [
            {"id": "zone-red", "name": "核心警戒区", "level": "red", "points": [[48, 22], [72, 22], [80, 50], [66, 72], [40, 61]]},
            {"id": "zone-amber", "name": "外围管控区", "level": "amber", "points": [[33, 13], [83, 14], [92, 62], [73, 84], [25, 70]]},
        ],
        "resources": [
            {"id": "res-001", "name": "四驱指挥车", "type": "车辆", "quantity": 2, "available": 1, "status": "deployed", "assignedTaskId": "task-001", "x": 23, "y": 78},
            {"id": "res-002", "name": "无人机 M350", "type": "航空器", "quantity": 2, "available": 1, "status": "deployed", "assignedTaskId": "task-003", "x": 38, "y": 76},
            {"id": "res-003", "name": "挖掘机", "type": "工程机械", "quantity": 3, "available": 2, "status": "standby", "assignedTaskId": "", "x": 17, "y": 63},
            {"id": "res-004", "name": "医疗急救包", "type": "医疗", "quantity": 12, "available": 9, "status": "available", "assignedTaskId": "", "x": 15, "y": 85},
            {"id": "res-005", "name": "便携照明组", "type": "保障", "quantity": 8, "available": 4, "status": "available", "assignedTaskId": "task-006", "x": 28, "y": 82},
        ],
        "teams": [
            {"id": "team-command", "name": "现场指挥组", "leader": "李指挥", "members": 5, "status": "operating", "capabilities": ["指挥", "决策"], "x": 21, "y": 80},
            {"id": "team-field-a", "name": "现场一组", "leader": "赵队长", "members": 8, "status": "deployed", "capabilities": ["警戒", "疏散"], "x": 38, "y": 58},
            {"id": "team-field-b", "name": "现场二组", "leader": "钱队长", "members": 6, "status": "deployed", "capabilities": ["排水", "工程处置"], "x": 46, "y": 68},
            {"id": "team-info", "name": "信息核验组", "leader": "张审核", "members": 4, "status": "operating", "capabilities": ["核验", "态势图"], "x": 25, "y": 82},
        ],
        "shelters": [
            {"id": "shelter-001", "name": "南侧临时安置点", "capacity": 180, "occupancy": 74, "status": "open", "x": 12, "y": 89},
            {"id": "shelter-002", "name": "综合楼集合点", "capacity": 120, "occupancy": 42, "status": "open", "x": 20, "y": 90},
        ],
        "tasks": [
            {"id": "task-001", "title": "封控北侧便道入口", "owner": "现场一组", "status": "done", "priority": "critical", "startAt": "2026-09-10T07:58:00Z", "dueAt": "2026-09-10T08:15:00Z", "progress": 100, "dependencyIds": [], "sop": ["设置硬隔离", "登记进出人员", "每 15 分钟回报"], "evidenceIds": ["report-001"]},
            {"id": "task-002", "title": "撤离核心警戒区人员", "owner": "现场一组", "status": "done", "priority": "critical", "startAt": "2026-09-10T08:00:00Z", "dueAt": "2026-09-10T08:30:00Z", "progress": 100, "dependencyIds": ["task-001"], "sop": ["清点名单", "引导至安置点", "双人复核"], "evidenceIds": ["report-001"]},
            {"id": "task-003", "title": "无人机复飞裂缝区域", "owner": "无人机组", "status": "doing", "priority": "high", "startAt": "2026-09-10T08:28:00Z", "dueAt": "2026-09-10T09:20:00Z", "progress": 65, "dependencyIds": ["task-001"], "sop": ["检查空域", "定高航测", "上传影像清单"], "evidenceIds": ["report-002"]},
            {"id": "task-004", "title": "疏通坡脚排水沟", "owner": "现场二组", "status": "doing", "priority": "high", "startAt": "2026-09-10T08:35:00Z", "dueAt": "2026-09-10T10:00:00Z", "progress": 40, "dependencyIds": ["task-001"], "sop": ["上游截流", "机械清淤", "复测排水能力"], "evidenceIds": ["report-003"]},
            {"id": "task-005", "title": "复核公众落石线索", "owner": "信息核验组", "status": "todo", "priority": "medium", "startAt": "2026-09-10T08:50:00Z", "dueAt": "2026-09-10T09:30:00Z", "progress": 0, "dependencyIds": [], "sop": ["回拨确认", "定位道路", "现场交叉核验"], "evidenceIds": ["report-005"]},
            {"id": "task-006", "title": "部署夜间照明与备用电源", "owner": "保障组", "status": "todo", "priority": "medium", "startAt": "2026-09-10T09:00:00Z", "dueAt": "2026-09-10T17:00:00Z", "progress": 0, "dependencyIds": [], "sop": ["测试设备", "布设安全线路", "登记领用"], "evidenceIds": []},
            {"id": "task-007", "title": "发布第 2 号态势通报", "owner": "信息核验组", "status": "blocked", "priority": "high", "startAt": "2026-09-10T09:10:00Z", "dueAt": "2026-09-10T09:40:00Z", "progress": 20, "dependencyIds": ["task-003", "task-004"], "sop": ["汇总证据", "双人审批", "限定分发范围"], "evidenceIds": ["report-001", "report-002", "report-004"]},
            {"id": "task-008", "title": "准备下一班次交接", "owner": "现场指挥组", "status": "todo", "priority": "medium", "startAt": "2026-09-10T15:30:00Z", "dueAt": "2026-09-10T16:00:00Z", "progress": 0, "dependencyIds": ["task-007"], "sop": ["核对未结任务", "记录关键风险", "双方签收"], "evidenceIds": []},
        ],
        "dependencies": [
            {"source": "task-001", "target": "task-002"}, {"source": "task-001", "target": "task-003"},
            {"source": "task-001", "target": "task-004"}, {"source": "task-003", "target": "task-007"},
            {"source": "task-004", "target": "task-007"}, {"source": "task-007", "target": "task-008"},
        ],
        "decisions": [
            {"id": "decision-001", "title": "启动红色响应", "option": "立即启动", "status": "approved", "decider": "李指挥", "approvers": ["李指挥", "王值班长"], "time": "2026-09-10T07:56:00Z", "reason": "多源指标超过红色阈值并呈持续加速", "evidenceIds": ["report-001", "report-004"], "impact": "封控、撤离、提高监测频率"},
            {"id": "decision-002", "title": "扩大核心警戒区", "option": "向西扩展 120 m", "status": "approved", "decider": "李指挥", "approvers": ["李指挥", "安全总监"], "time": "2026-09-10T08:18:00Z", "reason": "新增坡肩裂缝与形变方向一致", "evidenceIds": ["report-001", "report-002"], "impact": "增加 2 个封控点"},
            {"id": "decision-003", "title": "是否启用工程卸载", "option": "等待排水与复飞结果", "status": "pending", "decider": "待审批", "approvers": [], "time": "2026-09-10T08:46:00Z", "reason": "需要确认地下水响应与裂缝延伸范围", "evidenceIds": ["report-002", "report-003"], "impact": "影响后续机械资源调度"},
        ],
        "communications": [
            {"id": "comm-001", "channel": "in-app", "audience": "全体应急成员", "subject": "启动红色响应", "status": "delivered", "time": "2026-09-10T07:57:00Z", "sender": "现场指挥组"},
            {"id": "comm-002", "channel": "radio", "audience": "现场一组", "subject": "封控与撤离指令", "status": "acknowledged", "time": "2026-09-10T08:00:00Z", "sender": "李指挥"},
            {"id": "comm-003", "channel": "in-app", "audience": "信息核验组", "subject": "核验无人机裂缝影像", "status": "delivered", "time": "2026-09-10T08:08:00Z", "sender": "王值班长"},
            {"id": "comm-004", "channel": "sms", "audience": "外部协作单位", "subject": "待接入短信网关后发送", "status": "prepared", "time": "2026-09-10T08:20:00Z", "sender": "联络员"},
            {"id": "comm-005", "channel": "email", "audience": "监管只读组", "subject": "第 1 号态势通报待分发", "status": "prepared", "time": "2026-09-10T08:35:00Z", "sender": "信息核验组"},
            {"id": "comm-006", "channel": "radio", "audience": "现场二组", "subject": "确认排水沟处置进度", "status": "acknowledged", "time": "2026-09-10T08:42:00Z", "sender": "王值班长"},
        ],
        "shifts": [
            {"id": "shift-day", "name": "白班", "leader": "王值班长", "startAt": "2026-09-10T08:00:00Z", "endAt": "2026-09-10T16:00:00Z", "status": "active", "handoverNote": "重点跟踪裂缝复飞、排水效果与工程卸载决策。", "acceptedBy": ""},
            {"id": "shift-night", "name": "夜班", "leader": "周值班长", "startAt": "2026-09-10T16:00:00Z", "endAt": "2026-09-11T00:00:00Z", "status": "scheduled", "handoverNote": "", "acceptedBy": ""},
        ],
        "situationReports": [
            {"id": "sitrep-001", "version": 1, "title": "北侧边坡事件第 1 号态势通报", "status": "published", "time": "2026-09-10T08:35:00Z", "author": "信息核验组", "approvers": ["王值班长", "李指挥"], "evidenceIds": ["report-001", "report-002", "report-004"], "summary": "完成封控和人员撤离，现场处置持续进行。"},
        ],
        "afterActionReviews": [],
        "roles": [
            {"role": "指挥员", "permissions": ["incident:*", "decision:approve", "communication:send"]},
            {"role": "值班员", "permissions": ["task:*", "sitrep:create", "handover:create"]},
            {"role": "现场队伍", "permissions": ["task:update", "report:create"]},
            {"role": "信息审核", "permissions": ["report:verify", "sitrep:review"]},
            {"role": "外部协作", "permissions": ["assigned-task:read", "assigned-task:update"]},
            {"role": "监管只读", "permissions": ["approved-record:read"]},
        ],
        "audit": [{"id": "audit-seed", "time": "2026-09-10T08:35:00Z", "action": "publish-situation-report", "actor": "信息核验组", "target": "sitrep-001", "detail": "双人批准后发布第 1 号态势通报"}],
        "createdAt": "2026-09-10T07:48:00Z", "updatedAt": "2026-09-10T08:50:00Z",
    }


def _analysis(console: dict[str, Any]) -> dict[str, Any]:
    tasks = console.get("tasks", [])
    reports = console.get("reports", [])
    resources = console.get("resources", [])
    decisions = console.get("decisions", [])
    status_counts = {status: sum(item.get("status") == status for item in tasks) for status in ["todo", "doing", "blocked", "done"]}
    total_quantity = sum(int(item.get("quantity", 0)) for item in resources)
    available_quantity = sum(int(item.get("available", 0)) for item in resources)
    incident = console.get("incident", {})
    timeline: list[dict[str, Any]] = []
    for item in reports:
        timeline.append({"id": item["id"], "time": item["time"], "kind": "report", "title": item["title"], "status": item["status"]})
    for item in decisions:
        timeline.append({"id": item["id"], "time": item["time"], "kind": "decision", "title": item["title"], "status": item["status"]})
    for item in console.get("communications", []):
        timeline.append({"id": item["id"], "time": item["time"], "kind": "communication", "title": item["subject"], "status": item["status"]})
    timeline.sort(key=lambda row: str(row.get("time", "")), reverse=True)
    checks = [
        {"label": "活动事件已指定指挥员", "passed": bool(incident.get("commander"))},
        {"label": "高优先级任务均有责任人", "passed": all(item.get("owner") for item in tasks if item.get("priority") in {"critical", "high"})},
        {"label": "已批准决策均关联证据", "passed": all(item.get("evidenceIds") for item in decisions if item.get("status") == "approved")},
        {"label": "态势通报保留批准人", "passed": all(len(item.get("approvers", [])) >= 2 for item in console.get("situationReports", []) if item.get("status") == "published")},
        {"label": "外部通信未伪装为已发送", "passed": all(item.get("status") != "delivered" for item in console.get("communications", []) if item.get("channel") in {"sms", "email"})},
        {"label": "敏感字段已声明字段级授权", "passed": bool(incident.get("sensitiveFields"))},
    ]
    risk_matrix = [
        {"name": "边坡失稳", "likelihood": 4, "impact": 5, "score": 20, "control": "封控、撤离、连续监测"},
        {"name": "道路落石", "likelihood": 3, "impact": 3, "score": 9, "control": "巡查与交通管制"},
        {"name": "排水失效", "likelihood": 4, "impact": 4, "score": 16, "control": "截流、清淤、复测"},
        {"name": "通信中断", "likelihood": 2, "impact": 4, "score": 8, "control": "无线电与人工传令备份"},
    ]
    return {
        "metrics": {
            "verifiedReports": sum(item.get("status") == "verified" for item in reports), "totalReports": len(reports),
            "openTasks": status_counts["todo"] + status_counts["doing"] + status_counts["blocked"], "blockedTasks": status_counts["blocked"],
            "resourceAvailability": round(available_quantity / max(1, total_quantity) * 100, 1),
            "deployedTeams": sum(item.get("status") == "deployed" for item in console.get("teams", [])),
            "pendingDecisions": sum(item.get("status") == "pending" for item in decisions),
            "shelterOccupancy": sum(int(item.get("occupancy", 0)) for item in console.get("shelters", [])),
        },
        "taskStatusCounts": status_counts, "timeline": timeline[:80], "riskMatrix": risk_matrix,
        "dependencyGraph": {"nodes": [{"id": item["id"], "title": item["title"], "status": item["status"], "priority": item["priority"]} for item in tasks], "edges": deepcopy(console.get("dependencies", []))},
        "mapItems": {
            "reports": [{"id": item["id"], "x": item["x"], "y": item["y"], "status": item["status"], "title": item["title"]} for item in reports],
            "teams": [{"id": item["id"], "x": item["x"], "y": item["y"], "status": item["status"], "name": item["name"]} for item in console.get("teams", [])],
            "resources": [{"id": item["id"], "x": item["x"], "y": item["y"], "status": item["status"], "name": item["name"]} for item in resources],
            "shelters": [{"id": item["id"], "x": item["x"], "y": item["y"], "status": item["status"], "name": item["name"]} for item in console.get("shelters", [])],
        },
        "qualityChecks": checks,
    }


def _runtime() -> dict[str, Any]:
    return {
        "controlPlane": {"status": "enabled", "engine": "Go jobs / projects / versions / audit"},
        "analysis": {"status": "enabled", "engine": "Python deterministic incident analysis"},
        "mapService": {"status": "sample-metadata", "engine": "MapLibre/OpenLayers adapter"},
        "weather": {"status": "not-configured", "engine": "weather adapter"},
        "organizationDirectory": {"status": "not-configured", "engine": "organization directory adapter"},
        "communications": {"inApp": "enabled", "radio": "record-only", "sms": "not-configured", "email": "not-configured"},
        "supportedImports": ["CAP", "GeoJSON", "KML", "CSV", "JSON"],
        "supportedExports": ["CAP", "GeoJSON", "KML", "CSV", "Markdown", "JSON", "ZIP"],
        "arbitraryCodeExecution": False,
    }


def _csv_text(headers: list[str], rows: list[list[Any]]) -> str:
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue()


def _exports(console: dict[str, Any], analysis: dict[str, Any], runtime: dict[str, Any]) -> dict[str, str]:
    incident = console["incident"]
    tasks_csv = _csv_text(["任务ID", "标题", "责任人", "状态", "优先级", "进度", "截止时间", "依赖"], [[item.get("id"), item.get("title"), item.get("owner"), item.get("status"), item.get("priority"), item.get("progress"), item.get("dueAt"), "|".join(item.get("dependencyIds", []))] for item in console.get("tasks", [])])
    resources_csv = _csv_text(["资源ID", "名称", "类型", "总量", "可用", "状态", "关联任务"], [[item.get("id"), item.get("name"), item.get("type"), item.get("quantity"), item.get("available"), item.get("status"), item.get("assignedTaskId")] for item in console.get("resources", [])])
    audit_csv = _csv_text(["审计ID", "时间", "动作", "操作人", "对象", "说明"], [[item.get("id"), item.get("time"), item.get("action"), item.get("actor"), item.get("target"), item.get("detail")] for item in console.get("audit", [])])
    report = "\n".join([
        "# 应急态势报告", "", f"- 事件：{incident['title']}", f"- 编号：{incident['code']}", f"- 等级：{incident['level']}",
        f"- 状态：{incident['status']}", f"- 指挥员：{incident['commander']}", f"- 生成时间：{_now()}", "", "## 当前态势", incident["summary"], "",
        "## 任务", *[f"- [{item['status']}] {item['title']} · {item['owner']} · {item['progress']}%" for item in console.get("tasks", [])], "",
        "## 决策记录", *[f"- {item['title']}：{item['option']}（{item['status']}，证据 {len(item.get('evidenceIds', []))} 条）" for item in console.get("decisions", [])], "",
        "## 交付门禁", *[f"- {'通过' if item['passed'] else '未通过'}：{item['label']}" for item in analysis["qualityChecks"]],
    ])
    features = []
    for item in console.get("reports", []):
        features.append({"type": "Feature", "properties": {"id": item["id"], "kind": "report", "title": item["title"], "status": item["status"]}, "geometry": {"type": "Point", "coordinates": [item["x"], item["y"]]}})
    for item in console.get("teams", []):
        features.append({"type": "Feature", "properties": {"id": item["id"], "kind": "team", "name": item["name"], "status": item["status"]}, "geometry": {"type": "Point", "coordinates": [item["x"], item["y"]]}})
    for zone in console.get("mapZones", []):
        ring = zone["points"] + [zone["points"][0]]
        features.append({"type": "Feature", "properties": {"id": zone["id"], "kind": "zone", "name": zone["name"], "level": zone["level"]}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
    geojson = json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2)
    cap_xml = "".join([
        '<?xml version="1.0" encoding="UTF-8"?>', '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">',
        f"<identifier>{escape(incident['code'])}</identifier><sender>SkyViewLab</sender><sent>{escape(_now())}</sent>",
        f"<status>{'Actual' if incident['status'] == 'active' else 'Exercise'}</status><msgType>Alert</msgType><scope>Restricted</scope>",
        f"<info><category>Geo</category><event>{escape(incident['title'])}</event><urgency>Immediate</urgency><severity>Extreme</severity><certainty>Likely</certainty><headline>{escape(incident['summary'])}</headline></info></alert>",
    ])
    backup = json.dumps({"schema": SCHEMA, "version": 2, "console": console, "analysis": analysis, "runtime": runtime}, ensure_ascii=False, indent=2)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("situation-report.md", report)
        archive.writestr("tasks.csv", tasks_csv)
        archive.writestr("resources.csv", resources_csv)
        archive.writestr("audit.csv", audit_csv)
        archive.writestr("situation.geojson", geojson)
        archive.writestr("alert.cap.xml", cap_xml)
        archive.writestr("emergency-console.json", backup)
    return {"reportMarkdown": report, "tasksCsv": tasks_csv, "resourcesCsv": resources_csv, "auditCsv": audit_csv, "geoJson": geojson, "capXml": cap_xml, "backupJson": backup, "packageBase64": base64.b64encode(package.getvalue()).decode("ascii")}


def _result(console: dict[str, Any], stage: str) -> dict[str, Any]:
    analysis = _analysis(console)
    runtime = _runtime()
    return {"schema": SCHEMA, "version": 2, "stage": stage, "console": console, "analysis": analysis, "runtime": runtime, "exports": _exports(console, analysis, runtime)}


def _bundle(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state")
    if not isinstance(state, dict) or state.get("schema") != SCHEMA or not isinstance(state.get("console"), dict):
        raise ToolError("应急工作台状态无效，请重新载入基准")
    return deepcopy(state["console"])


def _import_reports(content: str, file_name: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(content.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise ToolError("导入文件不能超过 4 MB")
    rows: list[dict[str, Any]]
    if file_name.lower().endswith(".json"):
        loaded = json.loads(content)
        rows = loaded if isinstance(loaded, list) else loaded.get("reports", []) if isinstance(loaded, dict) else []
    else:
        rows = list(csv.DictReader(io.StringIO(content)))
    accepted, rejected = [], []
    for index, raw in enumerate(rows[:MAX_IMPORT_ROWS], 2):
        if not isinstance(raw, dict):
            rejected.append({"line": index, "reason": "记录必须为对象"}); continue
        title, source = _clean(raw.get("title"), 180), _clean(raw.get("source"), 120)
        try:
            x, y = float(raw.get("x", 50)), float(raw.get("y", 50))
        except (TypeError, ValueError):
            rejected.append({"line": index, "reason": "坐标必须为数值"}); continue
        if not title or not source or not (0 <= x <= 100 and 0 <= y <= 100):
            rejected.append({"line": index, "reason": "来源、标题或 0–100 坐标无效"}); continue
        accepted.append({"id": f"report-{uuid.uuid4().hex[:8]}", "source": source, "type": _clean(raw.get("type"), 30) or "field", "title": title, "content": _clean(raw.get("content"), 2000), "time": _clean(raw.get("time"), 80) or _now(), "status": "unverified", "confidence": max(0, min(1, float(raw.get("confidence", .5)))), "x": x, "y": y, "evidenceIds": [], "reviewer": ""})
    return accepted, rejected


def run_emergency_console(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "plan":
        incident = _clean(payload.get("incident"), 2000)
        if not incident: raise ToolError("incident 不能为空")
        severity = _clean(payload.get("severity"), 30).lower() or "medium"
        if severity not in {"low", "medium", "high", "critical"}: raise ToolError("severity 无效")
        tasks = payload.get("tasks", [])
        if isinstance(tasks, str):
            try: tasks = json.loads(tasks)
            except json.JSONDecodeError as exc: raise ToolError("tasks 必须是 JSON 数组") from exc
        if not isinstance(tasks, list): raise ToolError("tasks 必须是 JSON 数组")
        normalized = [{"id": _clean(item.get("id"), 80) or f"task-{index + 1}", "title": _clean(item.get("title"), 180) or "未命名任务", "owner": _clean(item.get("owner"), 100) or "待分配", "status": _clean(item.get("status"), 30) or "todo", "priority": _clean(item.get("priority"), 30) or severity} if isinstance(item, dict) else {"id": f"task-{index + 1}", "title": _clean(item, 180) or "未命名任务", "owner": "待分配", "status": "todo", "priority": severity} for index, item in enumerate(tasks)]
        return {"incident": incident, "severity": severity, "status": "active", "tasks": normalized, "unassigned": sum(item["owner"] == "待分配" for item in normalized), "createdAt": _now()}
    if action in {"load-sample", "run-all"}:
        return _result(_sample_console(), action)
    console = _bundle(payload)
    actor = _clean(payload.get("actor"), 80) or "当前值班员"
    if action in {"create-incident", "update-incident"}:
        incident = console["incident"]
        for key in ["title", "category", "level", "status", "commander", "location", "summary"]:
            if key in payload: incident[key] = _clean(payload.get(key), 2000 if key == "summary" else 180)
        if action == "create-incident": incident["id"] = f"incident-{uuid.uuid4().hex[:8]}"; incident["code"] = _clean(payload.get("code"), 80) or incident["id"].upper(); incident["startedAt"] = _now()
        _audit(console, action, actor, incident["id"], "更新事件基础信息与指挥目标")
    elif action == "import-reports":
        content, file_name = _clean(payload.get("content"), 5_000_000), _clean(payload.get("fileName"), 180) or "reports.csv"
        if not content: raise ToolError("线索文件不能为空")
        accepted, rejected = _import_reports(content, file_name)
        console.setdefault("reports", []).extend(accepted)
        _audit(console, action, actor, file_name, f"接收 {len(accepted)} 条，拒绝 {len(rejected)} 条")
        result = _result(console, action); result["importSummary"] = {"accepted": len(accepted), "rejected": len(rejected), "violations": rejected[:100]}; return result
    elif action == "verify-report":
        report = _find(console["reports"], _clean(payload.get("reportId"), 120), "线索")
        decision = _clean(payload.get("decision"), 30)
        if decision not in {"verified", "rejected", "review"}: raise ToolError("核验结论无效")
        report["status"], report["reviewer"] = decision, actor
        record = {"id": f"verify-{uuid.uuid4().hex[:8]}", "reportId": report["id"], "decision": decision, "reviewer": actor, "time": _now(), "note": _clean(payload.get("note"), 500)}
        console.setdefault("verifications", []).insert(0, record); _audit(console, action, actor, report["id"], f"线索核验为 {decision}")
    elif action == "create-task":
        title, owner = _clean(payload.get("title"), 180), _clean(payload.get("owner"), 100)
        if not title or not owner: raise ToolError("任务标题和责任人不能为空")
        dependencies = payload.get("dependencyIds", [])
        if not isinstance(dependencies, list): raise ToolError("任务依赖必须为数组")
        for identifier in dependencies: _find(console["tasks"], _clean(identifier, 120), "依赖任务")
        task = {"id": f"task-{uuid.uuid4().hex[:8]}", "title": title, "owner": owner, "status": "todo", "priority": _clean(payload.get("priority"), 30) or "medium", "startAt": _now(), "dueAt": _clean(payload.get("dueAt"), 80), "progress": 0, "dependencyIds": dependencies, "sop": payload.get("sop", []) if isinstance(payload.get("sop"), list) else [], "evidenceIds": payload.get("evidenceIds", []) if isinstance(payload.get("evidenceIds"), list) else []}
        console["tasks"].append(task)
        console.setdefault("dependencies", []).extend({"source": item, "target": task["id"]} for item in dependencies)
        console["selectedTaskId"] = task["id"]; _audit(console, action, actor, task["id"], f"创建任务并分配给 {owner}")
    elif action == "update-task":
        task = _find(console["tasks"], _clean(payload.get("taskId"), 120), "任务")
        status = _clean(payload.get("status"), 30) or task["status"]
        if status not in {"todo", "doing", "blocked", "done"}: raise ToolError("任务状态无效")
        task["status"] = status
        if "owner" in payload: task["owner"] = _clean(payload.get("owner"), 100)
        if "progress" in payload: task["progress"] = max(0, min(100, int(payload["progress"])))
        if status == "done": task["progress"] = 100
        _audit(console, action, actor, task["id"], f"任务更新为 {status} / {task['progress']}%")
    elif action == "assign-resource":
        resource = _find(console["resources"], _clean(payload.get("resourceId"), 120), "资源")
        task = _find(console["tasks"], _clean(payload.get("taskId"), 120), "任务")
        quantity = max(1, int(payload.get("quantity", 1)))
        if int(resource.get("available", 0)) < quantity: raise ToolError("可用资源不足")
        resource["available"] -= quantity; resource["assignedTaskId"] = task["id"]; resource["status"] = "deployed"
        _audit(console, action, actor, resource["id"], f"向 {task['title']} 分配 {quantity} 个单位")
    elif action == "record-decision":
        title, option, reason = _clean(payload.get("title"), 180), _clean(payload.get("option"), 300), _clean(payload.get("reason"), 1000)
        evidence_ids = payload.get("evidenceIds", [])
        if not title or not option or not reason or not isinstance(evidence_ids, list) or not evidence_ids: raise ToolError("决策标题、方案、理由和证据不能为空")
        for identifier in evidence_ids: _find(console["reports"], _clean(identifier, 120), "决策证据")
        decision = {"id": f"decision-{uuid.uuid4().hex[:8]}", "title": title, "option": option, "status": "approved" if bool(payload.get("approve")) else "pending", "decider": actor, "approvers": [actor] if bool(payload.get("approve")) else [], "time": _now(), "reason": reason, "evidenceIds": evidence_ids, "impact": _clean(payload.get("impact"), 500)}
        console["decisions"].append(decision); console["selectedDecisionId"] = decision["id"]; _audit(console, action, actor, decision["id"], f"记录决策并关联 {len(evidence_ids)} 条证据")
    elif action == "send-communication":
        channel = _clean(payload.get("channel"), 30) or "in-app"
        if channel not in {"in-app", "radio", "sms", "email"}: raise ToolError("通信渠道无效")
        subject, audience = _clean(payload.get("subject"), 240), _clean(payload.get("audience"), 160)
        if not subject or not audience: raise ToolError("通信主题和接收对象不能为空")
        status = "delivered" if channel == "in-app" else "recorded" if channel == "radio" else "prepared"
        record = {"id": f"comm-{uuid.uuid4().hex[:8]}", "channel": channel, "audience": audience, "subject": subject, "status": status, "time": _now(), "sender": actor}
        console["communications"].insert(0, record); _audit(console, action, actor, record["id"], f"{channel} 通信记录状态 {status}")
    elif action == "handover-shift":
        current = _find(console["shifts"], _clean(payload.get("shiftId"), 120) or "shift-day", "班次")
        next_shift = _find(console["shifts"], _clean(payload.get("nextShiftId"), 120) or "shift-night", "接班班次")
        note, accepted_by = _clean(payload.get("note"), 1500), _clean(payload.get("acceptedBy"), 100)
        if not note or not accepted_by: raise ToolError("交接说明和接班人不能为空")
        current["status"] = "handed-over"; current["handoverNote"] = note; current["acceptedBy"] = accepted_by
        next_shift["status"] = "active"; next_shift["handoverNote"] = note; next_shift["acceptedBy"] = accepted_by
        _audit(console, action, actor, current["id"], f"交接给 {accepted_by} 并由双方记录")
    elif action == "publish-situation-report":
        summary = _clean(payload.get("summary"), 2000)
        approvers = payload.get("approvers", [])
        if not summary or not isinstance(approvers, list) or len(set(map(str, approvers))) < 2: raise ToolError("发布态势通报需要正文和两名不同批准人")
        report = {"id": f"sitrep-{uuid.uuid4().hex[:8]}", "version": len(console.get("situationReports", [])) + 1, "title": f"{console['incident']['title']}第 {len(console.get('situationReports', [])) + 1} 号态势通报", "status": "published", "time": _now(), "author": actor, "approvers": list(dict.fromkeys(map(_clean, approvers))), "evidenceIds": payload.get("evidenceIds", []) if isinstance(payload.get("evidenceIds"), list) else [], "summary": summary}
        console.setdefault("situationReports", []).insert(0, report); _audit(console, action, actor, report["id"], "双人批准后发布态势通报")
    elif action == "close-incident":
        open_tasks = [item for item in console["tasks"] if item.get("status") != "done"]
        if open_tasks and not bool(payload.get("force")): raise ToolError("仍有未完成任务，不能关闭事件")
        console["incident"]["status"] = "closed"; console["incident"]["closedAt"] = _now(); console["incident"]["closureReason"] = _clean(payload.get("reason"), 1000)
        _audit(console, action, actor, console["incident"]["id"], f"关闭事件，未结任务 {len(open_tasks)} 项")
    elif action == "after-action-review":
        review = {"id": f"aar-{uuid.uuid4().hex[:8]}", "time": _now(), "facilitator": actor, "summary": _clean(payload.get("summary"), 2000), "worked": payload.get("worked", []) if isinstance(payload.get("worked"), list) else [], "improvements": payload.get("improvements", []) if isinstance(payload.get("improvements"), list) else [], "actions": payload.get("actions", []) if isinstance(payload.get("actions"), list) else []}
        if not review["summary"]: raise ToolError("复盘摘要不能为空")
        console.setdefault("afterActionReviews", []).insert(0, review); _audit(console, action, actor, review["id"], "保存事后复盘与改进项")
    elif action in {"runtime-status", "validate", "export"}:
        _audit(console, action, actor, console["id"], {"runtime-status": "检查地图、天气、组织目录与通信适配器", "validate": "执行权限、证据、任务与发布门禁", "export": "生成 CAP、GeoJSON、表格、报告和完整交付包"}[action])
    else:
        raise ToolError("不支持的应急研判操作")
    return _result(console, action)
