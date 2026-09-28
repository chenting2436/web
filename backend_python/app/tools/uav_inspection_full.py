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


SCHEMA = "skyview-uav-inspection-results"
MAX_MANIFEST_ROWS = 10_000


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _audit(project: dict[str, Any], action: str, actor: str, target: str, detail: str) -> None:
    project.setdefault("audit", []).insert(0, {
        "id": f"audit-{uuid.uuid4().hex[:10]}", "time": _now(), "action": action,
        "actor": _clean(actor, 80) or "当前巡检员", "target": _clean(target, 120), "detail": _clean(detail, 500),
    })
    project["audit"] = project["audit"][:300]
    project["updatedAt"] = _now()
    project["version"] = int(project.get("version", 1)) + 1


def _route_metrics(plan: dict[str, Any]) -> dict[str, Any]:
    points = plan.get("waypoints", [])
    route_length = sum(math.hypot(float(right["x"]) - float(left["x"]), float(right["y"]) - float(left["y"])) for left, right in zip(points, points[1:]))
    polygon = plan.get("coveragePolygon", [])
    area = 0.0
    if len(polygon) >= 3:
        area = abs(sum(float(point["x"]) * float(polygon[(index + 1) % len(polygon)]["y"]) - float(polygon[(index + 1) % len(polygon)]["x"]) * float(point["y"]) for index, point in enumerate(polygon))) / 2
    altitude = max(10, float(plan.get("altitudeM", 80)))
    focal = max(1, float(plan.get("camera", {}).get("focalLengthMm", 24)))
    pixel = max(.001, float(plan.get("camera", {}).get("pixelSizeUm", 2.4)))
    gsd_cm = altitude * pixel / focal / 10
    flight_minutes = route_length / max(1, float(plan.get("speedMps", 6))) / 60 + len(points) * .08
    battery = min(100, flight_minutes / max(1, float(plan.get("batteryMinutes", 28))) * 100)
    no_fly_hits = []
    for zone in plan.get("noFlyZones", []):
        for point in points:
            if math.hypot(float(point["x"]) - float(zone["x"]), float(point["y"]) - float(zone["y"])) <= float(zone["radius"]):
                no_fly_hits.append({"zoneId": zone["id"], "waypointId": point["id"]})
    checks = [
        {"label": "航高在任务许可范围内", "passed": 30 <= altitude <= 120},
        {"label": "航向重叠率不低于 75%", "passed": float(plan.get("frontOverlap", 0)) >= 75},
        {"label": "旁向重叠率不低于 65%", "passed": float(plan.get("sideOverlap", 0)) >= 65},
        {"label": "航线未进入禁飞缓冲区", "passed": not no_fly_hits},
        {"label": "预计单架次电量充足", "passed": battery <= 82},
        {"label": "起降点和返航点已登记", "passed": bool(plan.get("homePoint")) and len(points) >= 2},
    ]
    return {"routeLengthM": round(route_length, 1), "coverageAreaM2": round(area, 1), "gsdCm": round(gsd_cm, 2), "estimatedMinutes": round(flight_minutes, 1), "batteryUsePercent": round(battery, 1), "noFlyHits": no_fly_hits, "checks": checks, "passed": all(item["passed"] for item in checks)}


def _priority(detection: dict[str, Any]) -> float:
    severity = min(5, max(1, float(detection.get("severity", 1))))
    confidence = min(1, max(0, float(detection.get("confidence", .5))))
    exposure = min(5, max(1, float(detection.get("exposure", 1))))
    repeat = min(3, max(0, float(detection.get("repeatCount", 0))))
    return round(severity * 12 + confidence * 25 + exposure * 3 + repeat * 4, 2)


def _sample() -> dict[str, Any]:
    plan = {
        "id": "plan-bridge-a", "name": "北岭运输桥季度巡检", "status": "approved", "crs": "LOCAL-METER",
        "altitudeM": 72, "speedMps": 6, "frontOverlap": 82, "sideOverlap": 72, "batteryMinutes": 28,
        "camera": {"model": "P1-35mm", "focalLengthMm": 35, "pixelSizeUm": 4.4, "imageWidth": 8192, "imageHeight": 5460},
        "homePoint": {"x": 8, "y": 84},
        "coveragePolygon": [{"x": 16, "y": 18}, {"x": 88, "y": 18}, {"x": 91, "y": 76}, {"x": 14, "y": 79}],
        "waypoints": [
            {"id": "wp-01", "x": 10, "y": 84, "altitudeM": 72, "action": "起飞"},
            {"id": "wp-02", "x": 18, "y": 24, "altitudeM": 72, "action": "开始拍摄"},
            {"id": "wp-03", "x": 86, "y": 24, "altitudeM": 72, "action": "航带转向"},
            {"id": "wp-04", "x": 86, "y": 40, "altitudeM": 72, "action": "航带转向"},
            {"id": "wp-05", "x": 18, "y": 40, "altitudeM": 72, "action": "航带转向"},
            {"id": "wp-06", "x": 18, "y": 57, "altitudeM": 72, "action": "航带转向"},
            {"id": "wp-07", "x": 86, "y": 57, "altitudeM": 72, "action": "航带转向"},
            {"id": "wp-08", "x": 86, "y": 73, "altitudeM": 72, "action": "结束拍摄"},
            {"id": "wp-09", "x": 10, "y": 84, "altitudeM": 72, "action": "返航"},
        ],
        "noFlyZones": [{"id": "nfz-substation", "name": "变电站安全区", "x": 62, "y": 9, "radius": 7}],
        "approvedBy": "项目负责人", "approvedAt": "2026-09-09T08:30:00Z",
    }
    missions = [
        {"id": "mission-20260910", "name": "2026 年第三季度巡检", "planId": plan["id"], "status": "review", "pilot": "王飞手", "aircraft": "M350 RTK", "startedAt": "2026-09-10T08:16:00Z", "endedAt": "2026-09-10T08:37:00Z", "weather": "多云 / 3级风", "imageCount": 186, "coveragePercent": 98.4, "qualityScore": 94.6, "source": "deterministic-benchmark"},
        {"id": "mission-20260612", "name": "2026 年第二季度巡检", "planId": plan["id"], "status": "closed", "pilot": "赵飞手", "aircraft": "M350 RTK", "startedAt": "2026-06-12T07:55:00Z", "endedAt": "2026-06-12T08:18:00Z", "weather": "晴 / 2级风", "imageCount": 174, "coveragePercent": 97.8, "qualityScore": 95.2, "source": "historical-benchmark"},
    ]
    image_assets = []
    for index in range(1, 13):
        image_assets.append({
            "id": f"img-{index:03d}", "missionId": "mission-20260910", "fileName": f"DJI_20260910_{index:04d}.JPG",
            "capturedAt": f"2026-09-10T08:{16 + index:02d}:00Z", "gps": {"x": 18 + (index % 6) * 13.5, "y": 24 + (index // 6) * 33},
            "altitudeM": 72 + (index % 3) * .2, "yaw": (index * 17) % 360, "pitch": -90, "roll": round((index % 4 - 2) * .3, 1),
            "width": 8192, "height": 5460, "checksum": f"sha256:sample-{index:03d}", "quality": "accepted" if index != 9 else "blur-review",
            "storageStatus": "manifest-only", "thumbnail": "/assets/images/function-cards/drone-bridge-inspection.jpg",
        })
    detections = [
        ("det-001", "img-003", "裂缝", 5, .96, 5, 3, "confirmed", [28, 34, 22, 9]),
        ("det-002", "img-004", "剥落", 4, .91, 4, 2, "confirmed", [61, 22, 16, 18]),
        ("det-003", "img-006", "锈蚀", 4, .88, 4, 2, "review", [45, 46, 18, 16]),
        ("det-004", "img-007", "渗水", 3, .84, 3, 1, "confirmed", [19, 55, 28, 20]),
        ("det-005", "img-009", "裂缝", 3, .73, 4, 1, "review", [70, 52, 13, 10]),
        ("det-006", "img-010", "异物", 2, .82, 2, 0, "rejected", [35, 18, 10, 12]),
        ("det-007", "img-011", "锈蚀", 2, .79, 3, 1, "review", [55, 63, 17, 11]),
        ("det-008", "img-012", "裂缝", 4, .89, 5, 2, "confirmed", [32, 39, 25, 8]),
    ]
    detection_rows = []
    for item in detections:
        row = {"id": item[0], "missionId": "mission-20260910", "imageId": item[1], "type": item[2], "severity": item[3], "confidence": item[4], "exposure": item[5], "repeatCount": item[6], "status": item[7], "geometry": {"type": "bbox", "values": item[8]}, "model": {"name": "defect-baseline", "version": "1.4.2", "threshold": .65}, "createdAt": "2026-09-10T09:10:00Z"}
        row["priorityScore"] = _priority(row)
        detection_rows.append(row)
    project = {
        "id": "uav-bridge-inspection", "name": "北岭运输桥无人机巡检", "version": 5, "selectedMissionId": "mission-20260910", "selectedDetectionId": "det-001",
        "flightPlans": [plan], "missions": missions,
        "odmJobs": [{"id": "odm-20260910", "missionId": "mission-20260910", "status": "sample-result", "engine": "NodeODM adapter", "images": 186, "progress": 100, "startedAt": "2026-09-10T08:44:00Z", "finishedAt": "2026-09-10T09:04:00Z", "parameters": {"orthophotoResolution": 2.0, "dsm": True, "pcQuality": "medium"}}],
        "orthomosaics": [{"id": "ortho-20260910", "missionId": "mission-20260910", "status": "available", "resolutionCm": 1.86, "coverageM2": 4380, "crs": "LOCAL-METER", "source": "deterministic-benchmark", "cogStatus": "sample-metadata"}],
        "pointClouds": [{"id": "cloud-20260910", "missionId": "mission-20260910", "status": "available", "points": 18_420_000, "density": 1420, "format": "LAZ", "source": "deterministic-benchmark"}],
        "detections": detection_rows,
        "annotations": [{"id": "ann-001", "detectionId": "det-001", "geometry": {"type": "bbox", "values": [27, 33, 24, 11]}, "label": "主梁裂缝", "author": "陈审核员", "createdAt": "2026-09-10T09:22:00Z", "overridesModel": True}],
        "inspections": [{"id": "inspect-001", "detectionId": "det-001", "reviewer": "陈审核员", "decision": "confirmed", "note": "裂缝连续可见，建议安排近距复核。", "reviewedAt": "2026-09-10T09:22:00Z"}],
        "workOrders": [
            {"id": "wo-001", "title": "主梁裂缝近距复核", "detectionIds": ["det-001", "det-008"], "priority": "urgent", "status": "assigned", "assignee": "桥梁检测一组", "dueAt": "2026-09-11T12:00:00Z", "createdAt": "2026-09-10T09:25:00Z", "resolution": ""},
            {"id": "wo-002", "title": "支座剥落范围测量", "detectionIds": ["det-002"], "priority": "high", "status": "in-progress", "assignee": "结构检测组", "dueAt": "2026-09-12T18:00:00Z", "createdAt": "2026-09-10T09:28:00Z", "resolution": ""},
            {"id": "wo-003", "title": "排水孔渗水复查", "detectionIds": ["det-004"], "priority": "medium", "status": "closed", "assignee": "养护二组", "dueAt": "2026-09-13T18:00:00Z", "createdAt": "2026-09-10T09:30:00Z", "closedAt": "2026-09-10T10:42:00Z", "resolution": "排水孔通畅，记录雨后复查计划"},
        ],
        "historicalSummary": [{"missionId": "mission-20260612", "date": "2026-06-12", "total": 5, "critical": 1, "confirmed": 3, "types": {"裂缝": 2, "剥落": 1, "锈蚀": 1, "渗水": 1}}, {"missionId": "mission-20260910", "date": "2026-09-10", "total": 8, "critical": 1, "confirmed": 4, "types": {"裂缝": 3, "剥落": 1, "锈蚀": 2, "渗水": 1, "异物": 1}}],
        "roles": [{"role": "飞手", "members": ["王飞手"]}, {"role": "数据处理", "members": ["赵处理员"]}, {"role": "算法审核", "members": ["陈审核员"]}, {"role": "现场复核", "members": ["桥梁检测一组"]}, {"role": "项目负责人", "members": ["李负责人"]}],
        "audit": [{"id": "audit-seed", "time": "2026-09-10T09:25:00Z", "action": "create-work-order", "actor": "陈审核员", "target": "wo-001", "detail": "确认主梁裂缝并生成近距复核工单"}],
        "createdAt": "2026-09-09T00:00:00Z", "updatedAt": "2026-09-10T09:30:00Z",
    }
    runtime = {"objectStorage": {"status": "not-configured", "provider": "S3/R2 adapter"}, "photogrammetry": {"status": "not-configured", "engine": "NodeODM/WebODM adapter"}, "gpuInference": {"status": "not-configured", "engine": "HTTP inference adapter"}, "tileService": {"status": "sample-metadata", "engine": "COG/XYZ adapter"}, "supportedImports": ["JPEG", "DNG", "CSV", "JSON", "GeoJSON", "KML"], "supportedExports": ["GeoJSON", "CSV", "KML", "Markdown", "JSON", "ZIP"], "arbitraryCodeExecution": False}
    return _result(project, image_assets, runtime, "load-sample")


def _analysis(project: dict[str, Any], image_assets: list[dict[str, Any]]) -> dict[str, Any]:
    mission_id = project.get("selectedMissionId") or project.get("missions", [{}])[0].get("id")
    mission = next((item for item in project.get("missions", []) if item.get("id") == mission_id), {})
    plan = next((item for item in project.get("flightPlans", []) if item.get("id") == mission.get("planId")), project.get("flightPlans", [{}])[0])
    route = _route_metrics(plan)
    detections = [item for item in project.get("detections", []) if item.get("missionId") == mission_id]
    for detection in detections:
        detection["priorityScore"] = _priority(detection)
    detections.sort(key=lambda item: float(item.get("priorityScore", 0)), reverse=True)
    type_counts: dict[str, int] = {}
    severity_counts = {str(index): 0 for index in range(1, 6)}
    for item in detections:
        type_counts[item["type"]] = type_counts.get(item["type"], 0) + 1
        severity_counts[str(int(item.get("severity", 1)))] += 1
    work_orders = project.get("workOrders", [])
    assets = [item for item in image_assets if item.get("missionId") == mission_id]
    accepted = sum(item.get("quality") == "accepted" for item in assets)
    history = project.get("historicalSummary", [])
    return {
        "route": route,
        "metrics": {"missions": len(project.get("missions", [])), "images": int(mission.get("imageCount", len(assets))), "manifestImages": len(assets), "coveragePercent": float(mission.get("coveragePercent", 0)), "qualityScore": float(mission.get("qualityScore", 0)), "detections": len(detections), "confirmed": sum(item.get("status") == "confirmed" for item in detections), "pendingReview": sum(item.get("status") == "review" for item in detections), "openWorkOrders": sum(item.get("status") != "closed" for item in work_orders)},
        "detections": detections, "typeCounts": [{"name": name, "count": count} for name, count in sorted(type_counts.items(), key=lambda item: item[1], reverse=True)], "severityCounts": [{"severity": int(level), "count": count} for level, count in severity_counts.items()],
        "imageQuality": {"accepted": accepted, "review": len(assets) - accepted, "rate": round(accepted / len(assets) * 100, 1) if assets else 0},
        "coverageGrid": [{"x": x, "y": y, "value": round(82 + ((x * 11 + y * 7) % 18), 1)} for y in range(6) for x in range(9)],
        "comparison": {"missions": history, "delta": (history[-1]["total"] - history[-2]["total"]) if len(history) >= 2 else 0, "newTypes": [name for name in (history[-1].get("types", {}) if history else {}) if not history[-2].get("types", {}).get(name)] if len(history) >= 2 else []},
        "qualityChecks": [*route["checks"], {"label": "影像清单具备时间与位置", "passed": all(item.get("capturedAt") and item.get("gps") for item in assets)}, {"label": "缺陷记录保留模型版本", "passed": all(item.get("model", {}).get("version") for item in detections)}, {"label": "人工覆盖保留作者与原始检测", "passed": all(item.get("author") and item.get("detectionId") for item in project.get("annotations", []))}],
    }


def _csv_safe(value: Any) -> str:
    text = _clean(value, 10_000)
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


def _geojson(project: dict[str, Any], image_assets: list[dict[str, Any]]) -> str:
    plan = project.get("flightPlans", [{}])[0]
    features = [
        {
            "type": "Feature",
            "properties": {"id": plan.get("id"), "name": plan.get("name")},
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [point["x"], point["y"]]
                    for point in plan.get("waypoints", [])
                ],
            },
        }
    ]
    image_map = {item["id"]: item for item in image_assets}
    for item in project.get("detections", []):
        image = image_map.get(item.get("imageId"), {})
        gps = image.get("gps", {})
        features.append({"type": "Feature", "properties": {key: item.get(key) for key in ["id", "type", "severity", "confidence", "status", "priorityScore"]}, "geometry": {"type": "Point", "coordinates": [gps.get("x", 0), gps.get("y", 0)]}})
    return json.dumps({"type": "FeatureCollection", "name": project.get("name"), "features": features}, ensure_ascii=False, indent=2)


def _exports(result: dict[str, Any]) -> dict[str, str]:
    project = result["project"]
    detections_io = io.StringIO(); writer = csv.writer(detections_io, lineterminator="\n")
    writer.writerow(["缺陷ID", "任务ID", "影像ID", "类型", "严重度", "置信度", "暴露度", "重复次数", "状态", "优先级", "模型版本"])
    for item in project.get("detections", []):
        writer.writerow([item.get("id"), item.get("missionId"), item.get("imageId"), _csv_safe(item.get("type")), item.get("severity"), item.get("confidence"), item.get("exposure"), item.get("repeatCount"), item.get("status"), item.get("priorityScore"), item.get("model", {}).get("version")])
    orders_io = io.StringIO(); writer = csv.writer(orders_io, lineterminator="\n")
    writer.writerow(["工单ID", "标题", "优先级", "状态", "责任人", "截止时间", "关联缺陷", "处置结论"])
    for item in project.get("workOrders", []):
        writer.writerow([item.get("id"), _csv_safe(item.get("title")), item.get("priority"), item.get("status"), _csv_safe(item.get("assignee")), item.get("dueAt"), ";".join(item.get("detectionIds", [])), _csv_safe(item.get("resolution"))])
    metrics = result["analysis"]["metrics"]
    report = "\n".join(["# 无人机巡检报告", "", f"- 项目：{project['name']}", f"- 生成时间：{_now()}", f"- 本次任务：{project['selectedMissionId']}", f"- 覆盖率：{metrics['coveragePercent']}%", f"- 影像：{metrics['images']} 张", f"- 缺陷：{metrics['detections']}（已确认 {metrics['confirmed']}，待复核 {metrics['pendingReview']}）", "", "## 优先缺陷", *[f"- P{item['severity']} {item['type']}：{item['id']}，优先分 {item['priorityScore']}，状态 {item['status']}" for item in result["analysis"]["detections"]], "", "## 质量门禁", *[f"- {'通过' if item['passed'] else '未通过'}：{item['label']}" for item in result["analysis"]["qualityChecks"]]])
    backup = json.dumps({key: result[key] for key in ["schema", "version", "project", "imageAssets", "analysis", "runtime"]}, ensure_ascii=False, indent=2)
    geojson = _geojson(project, result["imageAssets"])
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("inspection-report.md", report)
        archive.writestr("detections.csv", detections_io.getvalue())
        archive.writestr("work-orders.csv", orders_io.getvalue())
        archive.writestr("route-and-defects.geojson", geojson)
        archive.writestr("uav-inspection-backup.json", backup)
    return {"reportMarkdown": report, "detectionsCsv": detections_io.getvalue(), "workOrdersCsv": orders_io.getvalue(), "geoJson": geojson, "backupJson": backup, "packageBase64": base64.b64encode(package.getvalue()).decode("ascii")}


def _result(project: dict[str, Any], image_assets: list[dict[str, Any]], runtime: dict[str, Any], stage: str) -> dict[str, Any]:
    result = {"schema": SCHEMA, "version": 2, "stage": stage, "project": project, "imageAssets": image_assets[-MAX_MANIFEST_ROWS:], "runtime": runtime}
    result["analysis"] = _analysis(project, result["imageAssets"])
    result["exports"] = _exports(result)
    return result


def _bundle(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    state = payload.get("state") or {}
    if not isinstance(state, dict) or state.get("schema") != SCHEMA:
        sample = _sample()
        return sample["project"], sample["imageAssets"], sample["runtime"]
    return deepcopy(state["project"]), deepcopy(state["imageAssets"]), deepcopy(state["runtime"])


def _find(items: list[dict[str, Any]], item_id: str, label: str) -> dict[str, Any]:
    item = next((entry for entry in items if entry.get("id") == item_id), None)
    if not item:
        raise ToolError(f"{label}不存在")
    return item


def _import_manifest(content: str, file_name: str, mission_ids: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if len(content.encode("utf-8")) > 2_000_000:
        raise ToolError("影像清单不能超过 2 MB")
    if file_name.lower().endswith(".json"):
        try:
            rows = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ToolError("影像清单 JSON 无法解析") from exc
        if not isinstance(rows, list):
            raise ToolError("影像清单 JSON 必须是数组")
    else:
        rows = list(csv.DictReader(io.StringIO(content)))
    if len(rows) > MAX_MANIFEST_ROWS:
        raise ToolError(f"一次最多导入 {MAX_MANIFEST_ROWS} 行")
    accepted, rejected = [], []
    for index, raw in enumerate(rows, start=2):
        if not isinstance(raw, dict):
            rejected.append({"line": index, "reason": "不是对象"}); continue
        mission_id = _clean(raw.get("missionId") or raw.get("mission_id"), 120)
        file_value = _clean(raw.get("fileName") or raw.get("file_name"), 180)
        captured = _clean(raw.get("capturedAt") or raw.get("captured_at"), 80)
        try:
            x, y, altitude = float(raw.get("x")), float(raw.get("y")), float(raw.get("altitudeM") or raw.get("altitude_m"))
            if not all(math.isfinite(value) for value in [x, y, altitude]): raise ValueError
            datetime.fromisoformat(captured.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            rejected.append({"line": index, "reason": "位置、高度或时间无效"}); continue
        if mission_id not in mission_ids or not file_value:
            rejected.append({"line": index, "reason": "任务未登记或文件名为空"}); continue
        accepted.append({"id": f"img-import-{uuid.uuid4().hex[:10]}", "missionId": mission_id, "fileName": file_value, "capturedAt": captured, "gps": {"x": x, "y": y}, "altitudeM": altitude, "yaw": float(raw.get("yaw") or 0), "pitch": float(raw.get("pitch") or -90), "roll": float(raw.get("roll") or 0), "width": int(float(raw.get("width") or 0)), "height": int(float(raw.get("height") or 0)), "checksum": _clean(raw.get("checksum"), 180), "quality": _clean(raw.get("quality"), 50) or "pending", "storageStatus": "manifest-only", "thumbnail": "/assets/images/function-cards/drone-bridge-inspection.jpg"})
    return accepted, rejected


def run_uav_inspection(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    # Preserve the v1 scoring contract for callers that have not moved to the
    # stateful inspection workbench yet.
    if action == "prioritize":
        anomalies = payload.get("anomalies", [])
        if isinstance(anomalies, str):
            try: anomalies = json.loads(anomalies)
            except json.JSONDecodeError as exc: raise ToolError("anomalies 必须是 JSON 数组") from exc
        if not isinstance(anomalies, list): raise ToolError("anomalies 必须是 JSON 数组")
        rows = []
        for index, raw in enumerate(anomalies):
            if not isinstance(raw, dict): continue
            row = {**raw, "id": raw.get("id", f"anomaly-{index + 1}")}; row["priorityScore"] = _priority(row); rows.append(row)
        rows.sort(key=lambda item: item["priorityScore"], reverse=True)
        return {"total": len(rows), "reviewFirst": rows[:10], "all": rows}
    if action in {"load-sample", "run-all"}:
        return _sample()
    project, image_assets, runtime = _bundle(payload)
    actor = _clean(payload.get("actor"), 80) or "当前巡检员"

    if action == "update-flight-plan":
        plan = _find(project.get("flightPlans", []), _clean(payload.get("planId"), 120), "航线")
        for key, lower, upper in [("altitudeM", 10, 200), ("frontOverlap", 0, 95), ("sideOverlap", 0, 95), ("speedMps", 1, 20)]:
            if key in payload:
                try: value = float(payload[key])
                except (TypeError, ValueError) as exc: raise ToolError(f"{key} 必须是数值") from exc
                plan[key] = min(upper, max(lower, value))
        if isinstance(payload.get("waypoints"), list):
            plan["waypoints"] = deepcopy(payload["waypoints"][:200])
        plan["status"] = "draft"
        _audit(project, action, actor, plan["id"], "更新航高、速度、重叠率或航点")
    elif action == "validate-flight-plan":
        plan = _find(project.get("flightPlans", []), _clean(payload.get("planId"), 120) or project["flightPlans"][0]["id"], "航线")
        metrics = _route_metrics(plan)
        plan["status"] = "validated" if metrics["passed"] else "blocked"
        _audit(project, action, actor, plan["id"], f"航线门禁 {'通过' if metrics['passed'] else '未通过'}")
    elif action == "import-image-manifest":
        content = _clean(payload.get("content"), 2_000_000); file_name = _clean(payload.get("fileName"), 180) or "image-manifest.csv"
        if not content: raise ToolError("影像清单不能为空")
        accepted, rejected = _import_manifest(content, file_name, {item["id"] for item in project.get("missions", [])})
        image_assets.extend(accepted); _audit(project, action, actor, file_name, f"接收 {len(accepted)} 行，拒绝 {len(rejected)} 行")
        result = _result(project, image_assets, runtime, action); result["importSummary"] = {"accepted": len(accepted), "rejected": len(rejected), "violations": rejected[:100]}; return result
    elif action == "prepare-photogrammetry":
        mission_id = _clean(payload.get("missionId"), 120) or project.get("selectedMissionId")
        _find(project.get("missions", []), mission_id, "巡检任务")
        job = {"id": f"odm-{uuid.uuid4().hex[:8]}", "missionId": mission_id, "status": "prepared", "engine": "NodeODM adapter", "images": len([item for item in image_assets if item.get("missionId") == mission_id]), "progress": 0, "startedAt": None, "finishedAt": None, "parameters": {"orthophotoResolution": float(payload.get("orthophotoResolution", 2.0)), "dsm": bool(payload.get("dsm", True)), "pcQuality": _clean(payload.get("pcQuality"), 30) or "medium"}}
        project.setdefault("odmJobs", []).insert(0, job); _audit(project, action, actor, job["id"], "生成摄影测量任务清单；等待外部 NodeODM 连接")
    elif action == "run-defect-analysis":
        mission_id = _clean(payload.get("missionId"), 120) or project.get("selectedMissionId")
        detections = [item for item in project.get("detections", []) if item.get("missionId") == mission_id]
        for item in detections: item["priorityScore"] = _priority(item)
        _audit(project, action, actor, mission_id, f"使用固定模型版本复算 {len(detections)} 条候选缺陷的优先级")
    elif action in {"review-detection", "update-annotation"}:
        detection = _find(project.get("detections", []), _clean(payload.get("detectionId"), 120), "缺陷")
        if action == "review-detection":
            decision = _clean(payload.get("decision"), 30)
            if decision not in {"confirmed", "rejected", "review"}: raise ToolError("复核结论无效")
            detection["status"] = decision
            inspection = {"id": f"inspect-{uuid.uuid4().hex[:8]}", "detectionId": detection["id"], "reviewer": actor, "decision": decision, "note": _clean(payload.get("note"), 500), "reviewedAt": _now()}
            project.setdefault("inspections", []).insert(0, inspection); detail = f"人工复核为 {decision}"
        else:
            geometry = payload.get("geometry")
            if not isinstance(geometry, dict) or geometry.get("type") not in {"bbox", "polygon"}: raise ToolError("标注几何必须是 bbox 或 polygon")
            annotation = {"id": f"ann-{uuid.uuid4().hex[:8]}", "detectionId": detection["id"], "geometry": deepcopy(geometry), "label": _clean(payload.get("label"), 120) or detection["type"], "author": actor, "createdAt": _now(), "overridesModel": True}
            project.setdefault("annotations", []).insert(0, annotation); detail = "保存人工覆盖标注并保留模型原始框"
        _audit(project, action, actor, detection["id"], detail)
    elif action == "create-work-order":
        detection_ids = payload.get("detectionIds") or [_clean(payload.get("detectionId"), 120)]
        if not isinstance(detection_ids, list) or not detection_ids: raise ToolError("至少选择一个缺陷")
        for item_id in detection_ids: _find(project.get("detections", []), _clean(item_id, 120), "缺陷")
        title = _clean(payload.get("title"), 180); assignee = _clean(payload.get("assignee"), 100)
        if not title or not assignee: raise ToolError("工单标题和责任人不能为空")
        order = {"id": f"wo-{uuid.uuid4().hex[:8]}", "title": title, "detectionIds": detection_ids, "priority": _clean(payload.get("priority"), 30) or "high", "status": "assigned", "assignee": assignee, "dueAt": _clean(payload.get("dueAt"), 80), "createdAt": _now(), "resolution": ""}
        project.setdefault("workOrders", []).insert(0, order); _audit(project, action, actor, order["id"], f"创建工单并分配给 {assignee}")
    elif action == "update-work-order":
        order = _find(project.get("workOrders", []), _clean(payload.get("workOrderId"), 120), "工单")
        status = _clean(payload.get("status"), 30)
        if status not in {"assigned", "in-progress", "blocked", "closed"}: raise ToolError("工单状态无效")
        order["status"] = status
        if payload.get("assignee"): order["assignee"] = _clean(payload.get("assignee"), 100)
        if status == "closed":
            resolution = _clean(payload.get("resolution"), 500)
            if not resolution: raise ToolError("关闭工单必须填写处置结论")
            order["resolution"] = resolution; order["closedAt"] = _now()
        _audit(project, action, actor, order["id"], f"工单更新为 {status}")
    elif action in {"compare-missions", "runtime-status", "validate", "export"}:
        _audit(project, action, actor, project["id"], {"compare-missions": "复算历次巡检差异", "runtime-status": "检查外部运行时配置", "validate": "执行航线、影像、模型与证据门禁", "export": "生成巡检交付包"}[action])
    else:
        raise ToolError("不支持的无人机巡检操作")
    return _result(project, image_assets, runtime, action)
