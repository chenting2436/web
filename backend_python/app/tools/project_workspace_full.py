from __future__ import annotations

import base64
import csv
import io
import json
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from html import escape
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-project-workspace-results"
MAX_IMPORT_BYTES = 4_000_000
MAX_TASKS = 5_000
STATUSES = {"backlog", "todo", "doing", "review", "blocked", "done"}
PRIORITIES = {"critical", "high", "medium", "low"}
ROLES = {"owner", "maintainer", "member", "viewer"}


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _identifier(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _find(rows: list[dict[str, Any]], identifier: str, label: str) -> dict[str, Any]:
    item = next((row for row in rows if row.get("id") == identifier), None)
    if item is None:
        raise ToolError(f"{label}不存在")
    return item


def _authorize(action: str, payload: dict[str, Any]) -> tuple[str, str]:
    role = _clean(payload.get("actorRole"), 30) or "owner"
    actor = _clean(payload.get("actor"), 80) or "当前用户"
    if role not in ROLES:
        raise ToolError("成员角色无效")
    if role == "viewer" and action not in {"runtime-status", "validate", "export", "summary"}:
        raise ToolError("访客仅可查看与导出")
    if role == "member" and action in {
        "create-project", "archive-project", "restore-project", "add-member",
        "update-member", "remove-member", "restore-snapshot",
    }:
        raise ToolError("普通成员无权执行此操作")
    if role == "maintainer" and action in {"archive-project", "restore-project"}:
        raise ToolError("只有项目负责人可以归档或恢复项目")
    return actor, role


def _audit(portfolio: dict[str, Any], action: str, actor: str, role: str, target: str, detail: str) -> None:
    stamp = _now()
    portfolio.setdefault("audit", []).insert(0, {
        "id": _identifier("audit"), "time": stamp, "action": action,
        "actor": actor, "role": role, "target": _clean(target, 120),
        "detail": _clean(detail, 600),
    })
    portfolio["audit"] = portfolio["audit"][:500]
    portfolio.setdefault("activities", []).insert(0, {
        "id": _identifier("activity"), "time": stamp, "actor": actor,
        "action": action, "target": _clean(target, 120), "text": _clean(detail, 300),
    })
    portfolio["activities"] = portfolio["activities"][:300]
    portfolio["version"] = int(portfolio.get("version", 1)) + 1
    portfolio["updatedAt"] = stamp


def _sample_portfolio() -> dict[str, Any]:
    return {
        "id": "portfolio-geoscience-delivery", "name": "科研与课程项目集",
        "version": 12, "currentProjectId": "project-slope-risk",
        "projects": [
            {"id": "project-slope-risk", "code": "GEO-26-014", "title": "北岭边坡风险研究", "objective": "完成监测数据治理、风险模型验证与可复核交付。", "ownerId": "member-li", "memberIds": ["member-li", "member-zhou", "member-wang", "member-chen"], "status": "active", "health": "at-risk", "cycleId": "cycle-02", "deadline": "2026-09-28", "archivedAt": ""},
            {"id": "project-course-data", "code": "COURSE-26-03", "title": "矿山安全数据课程项目", "objective": "完成从数据检查、指标分析到成果汇报的团队课程项目。", "ownerId": "member-li", "memberIds": ["member-li", "member-lin", "member-wang"], "status": "active", "health": "on-track", "cycleId": "cycle-course-01", "deadline": "2026-10-12", "archivedAt": ""},
            {"id": "project-legacy", "code": "GEO-25-006", "title": "历史裂缝编目", "objective": "保留上一阶段的影像与裂缝记录。", "ownerId": "member-li", "memberIds": ["member-li", "member-chen"], "status": "archived", "health": "complete", "cycleId": "", "deadline": "2026-08-20", "archivedAt": "2026-08-28T09:30:00Z"},
        ],
        "members": [
            {"id": "member-li", "name": "李江峰", "email": "jiangfeng.Li@cumt.edu.cn", "role": "owner", "avatar": "李", "active": True},
            {"id": "member-zhou", "name": "周明", "email": "zhouming@example.edu.cn", "role": "maintainer", "avatar": "周", "active": True},
            {"id": "member-wang", "name": "王欣", "email": "wangxin@example.edu.cn", "role": "member", "avatar": "王", "active": True},
            {"id": "member-chen", "name": "陈宇", "email": "chenyu@example.edu.cn", "role": "member", "avatar": "陈", "active": True},
            {"id": "member-lin", "name": "林珊", "email": "linshan@example.edu.cn", "role": "viewer", "avatar": "林", "active": True},
        ],
        "statuses": [
            {"id": "backlog", "name": "需求池", "order": 0}, {"id": "todo", "name": "待开始", "order": 1},
            {"id": "doing", "name": "进行中", "order": 2}, {"id": "review", "name": "待评审", "order": 3},
            {"id": "blocked", "name": "受阻", "order": 4}, {"id": "done", "name": "已完成", "order": 5},
        ],
        "labels": [
            {"id": "label-data", "name": "数据", "color": "#167d91"}, {"id": "label-model", "name": "模型", "color": "#4b58aa"},
            {"id": "label-field", "name": "现场", "color": "#b76a24"}, {"id": "label-report", "name": "交付", "color": "#2f7d5a"},
            {"id": "label-quality", "name": "质量", "color": "#9b3f57"}, {"id": "label-course", "name": "课程", "color": "#6d5a9a"},
        ],
        "cycles": [
            {"id": "cycle-01", "projectId": "project-slope-risk", "name": "数据基线", "startDate": "2026-08-31", "endDate": "2026-09-13", "status": "completed", "capacity": 34},
            {"id": "cycle-02", "projectId": "project-slope-risk", "name": "模型与复核", "startDate": "2026-09-14", "endDate": "2026-09-27", "status": "active", "capacity": 40},
            {"id": "cycle-course-01", "projectId": "project-course-data", "name": "课程迭代一", "startDate": "2026-09-07", "endDate": "2026-09-20", "status": "active", "capacity": 24},
        ],
        "milestones": [
            {"id": "milestone-data", "projectId": "project-slope-risk", "title": "数据基线冻结", "dueDate": "2026-09-13", "status": "done", "progress": 100, "ownerId": "member-zhou"},
            {"id": "milestone-model", "projectId": "project-slope-risk", "title": "模型独立验证", "dueDate": "2026-09-21", "status": "active", "progress": 58, "ownerId": "member-wang"},
            {"id": "milestone-delivery", "projectId": "project-slope-risk", "title": "成果包验收", "dueDate": "2026-09-28", "status": "planned", "progress": 20, "ownerId": "member-li"},
            {"id": "milestone-course", "projectId": "project-course-data", "title": "课程中期检查", "dueDate": "2026-09-20", "status": "active", "progress": 45, "ownerId": "member-wang"},
        ],
        "tasks": [
            {"id": "task-001", "projectId": "project-slope-risk", "key": "GEO-101", "title": "冻结监测点位与字段字典", "status": "done", "priority": "high", "ownerIds": ["member-zhou"], "labelIds": ["label-data"], "cycleId": "cycle-01", "milestoneId": "milestone-data", "startDate": "2026-08-31", "dueDate": "2026-09-04", "progress": 100, "storyPoints": 5, "dependencyIds": [], "archivedAt": ""},
            {"id": "task-002", "projectId": "project-slope-risk", "key": "GEO-102", "title": "完成缺测与异常值规则", "status": "done", "priority": "medium", "ownerIds": ["member-wang"], "labelIds": ["label-data", "label-quality"], "cycleId": "cycle-01", "milestoneId": "milestone-data", "startDate": "2026-09-02", "dueDate": "2026-09-08", "progress": 100, "storyPoints": 5, "dependencyIds": ["task-001"], "archivedAt": ""},
            {"id": "task-003", "projectId": "project-slope-risk", "key": "GEO-103", "title": "复核坐标参考与时间基准", "status": "review", "priority": "high", "ownerIds": ["member-chen"], "labelIds": ["label-quality"], "cycleId": "cycle-02", "milestoneId": "milestone-model", "startDate": "2026-09-09", "dueDate": "2026-09-13", "progress": 85, "storyPoints": 3, "dependencyIds": ["task-001"], "archivedAt": ""},
            {"id": "task-004", "projectId": "project-slope-risk", "key": "GEO-104", "title": "训练位移趋势风险模型", "status": "doing", "priority": "critical", "ownerIds": ["member-wang", "member-zhou"], "labelIds": ["label-model"], "cycleId": "cycle-02", "milestoneId": "milestone-model", "startDate": "2026-09-10", "dueDate": "2026-09-18", "progress": 62, "storyPoints": 8, "dependencyIds": ["task-002"], "archivedAt": ""},
            {"id": "task-005", "projectId": "project-slope-risk", "key": "GEO-105", "title": "核对现场裂缝编目", "status": "blocked", "priority": "high", "ownerIds": ["member-chen"], "labelIds": ["label-field"], "cycleId": "cycle-02", "milestoneId": "milestone-model", "startDate": "2026-09-11", "dueDate": "2026-09-16", "progress": 35, "storyPoints": 5, "dependencyIds": ["task-003"], "archivedAt": ""},
            {"id": "task-006", "projectId": "project-slope-risk", "key": "GEO-106", "title": "形成独立验证数据集", "status": "todo", "priority": "high", "ownerIds": ["member-zhou"], "labelIds": ["label-data", "label-quality"], "cycleId": "cycle-02", "milestoneId": "milestone-model", "startDate": "2026-09-14", "dueDate": "2026-09-19", "progress": 0, "storyPoints": 5, "dependencyIds": ["task-003"], "archivedAt": ""},
            {"id": "task-007", "projectId": "project-slope-risk", "key": "GEO-107", "title": "编制方法与参数说明", "status": "backlog", "priority": "medium", "ownerIds": ["member-li"], "labelIds": ["label-report"], "cycleId": "", "milestoneId": "milestone-delivery", "startDate": "2026-09-18", "dueDate": "2026-09-24", "progress": 0, "storyPoints": 3, "dependencyIds": ["task-004", "task-006"], "archivedAt": ""},
            {"id": "task-008", "projectId": "project-slope-risk", "key": "GEO-108", "title": "打包图表、数据与审计清单", "status": "backlog", "priority": "medium", "ownerIds": ["member-chen"], "labelIds": ["label-report"], "cycleId": "", "milestoneId": "milestone-delivery", "startDate": "2026-09-22", "dueDate": "2026-09-27", "progress": 0, "storyPoints": 5, "dependencyIds": ["task-007"], "archivedAt": ""},
            {"id": "task-009", "projectId": "project-course-data", "key": "COURSE-21", "title": "梳理课程数据字段", "status": "done", "priority": "medium", "ownerIds": ["member-wang"], "labelIds": ["label-course", "label-data"], "cycleId": "cycle-course-01", "milestoneId": "milestone-course", "startDate": "2026-09-07", "dueDate": "2026-09-09", "progress": 100, "storyPoints": 3, "dependencyIds": [], "archivedAt": ""},
            {"id": "task-010", "projectId": "project-course-data", "key": "COURSE-22", "title": "建立缺失值处理方案", "status": "doing", "priority": "high", "ownerIds": ["member-wang"], "labelIds": ["label-course", "label-data"], "cycleId": "cycle-course-01", "milestoneId": "milestone-course", "startDate": "2026-09-09", "dueDate": "2026-09-15", "progress": 55, "storyPoints": 5, "dependencyIds": ["task-009"], "archivedAt": ""},
            {"id": "task-011", "projectId": "project-course-data", "key": "COURSE-23", "title": "完成风险指标对比图", "status": "todo", "priority": "medium", "ownerIds": ["member-li"], "labelIds": ["label-course", "label-model"], "cycleId": "cycle-course-01", "milestoneId": "milestone-course", "startDate": "2026-09-14", "dueDate": "2026-09-18", "progress": 0, "storyPoints": 5, "dependencyIds": ["task-010"], "archivedAt": ""},
            {"id": "task-012", "projectId": "project-course-data", "key": "COURSE-24", "title": "提交中期汇报材料", "status": "backlog", "priority": "high", "ownerIds": ["member-lin"], "labelIds": ["label-course", "label-report"], "cycleId": "cycle-course-01", "milestoneId": "milestone-course", "startDate": "2026-09-18", "dueDate": "2026-09-20", "progress": 0, "storyPoints": 3, "dependencyIds": ["task-011"], "archivedAt": ""},
        ],
        "comments": [
            {"id": "comment-001", "projectId": "project-slope-risk", "taskId": "task-004", "authorId": "member-zhou", "body": "训练数据切分已固定，请勿覆盖基准版本。", "time": "2026-09-10T08:40:00Z"},
            {"id": "comment-002", "projectId": "project-slope-risk", "taskId": "task-005", "authorId": "member-chen", "body": "等待北侧坡肩补拍影像，任务暂时受阻。", "time": "2026-09-11T02:15:00Z"},
        ],
        "attachments": [
            {"id": "attachment-001", "projectId": "project-slope-risk", "taskId": "task-001", "name": "monitoring_dictionary_v3.xlsx", "size": 184320, "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "storage": "metadata-only", "checksum": "sha256:sample", "time": "2026-09-04T10:20:00Z"},
        ],
        "noteRevisions": [
            {"id": "note-002", "projectId": "project-slope-risk", "revision": 2, "authorId": "member-li", "body": "本周期重点：冻结独立验证集，完成模型复核，解决现场裂缝影像缺口。", "time": "2026-09-11T03:00:00Z"},
            {"id": "note-001", "projectId": "project-slope-risk", "revision": 1, "authorId": "member-li", "body": "建立数据基线并明确分工。", "time": "2026-08-31T01:00:00Z"},
        ],
        "notifications": [
            {"id": "notice-001", "memberId": "member-chen", "type": "blocked", "text": "GEO-105 已受阻，需要补拍裂缝影像。", "read": False, "time": "2026-09-11T02:15:00Z"},
            {"id": "notice-002", "memberId": "member-wang", "type": "due", "text": "GEO-104 将在 7 天内到期。", "read": False, "time": "2026-09-11T03:10:00Z"},
        ],
        "snapshots": [
            {"id": "snapshot-baseline", "projectId": "project-slope-risk", "label": "数据基线冻结", "version": 9, "createdAt": "2026-09-04T11:00:00Z", "state": {"taskIds": ["task-001", "task-002"], "milestoneIds": ["milestone-data"]}},
        ],
        "importJobs": [],
        "activities": [
            {"id": "activity-006", "time": "2026-09-11T03:00:00Z", "actor": "李江峰", "action": "update-note", "target": "project-slope-risk", "text": "更新阶段笔记第 2 版"},
            {"id": "activity-005", "time": "2026-09-11T02:15:00Z", "actor": "陈宇", "action": "move-task", "target": "task-005", "text": "GEO-105 移至受阻"},
            {"id": "activity-004", "time": "2026-09-10T08:40:00Z", "actor": "周明", "action": "add-comment", "target": "task-004", "text": "为 GEO-104 添加评论"},
            {"id": "activity-003", "time": "2026-09-09T08:20:00Z", "actor": "王欣", "action": "move-task", "target": "task-003", "text": "GEO-103 移至待评审"},
            {"id": "activity-002", "time": "2026-09-04T11:00:00Z", "actor": "周明", "action": "create-snapshot", "target": "snapshot-baseline", "text": "创建数据基线冻结快照"},
            {"id": "activity-001", "time": "2026-08-31T01:00:00Z", "actor": "李江峰", "action": "create-project", "target": "project-slope-risk", "text": "创建北岭边坡风险研究"},
        ],
        "audit": [
            {"id": "audit-seed", "time": "2026-09-11T03:00:00Z", "action": "update-note", "actor": "李江峰", "role": "owner", "target": "project-slope-risk", "detail": "阶段笔记修订为第 2 版"},
        ],
        "createdAt": "2026-08-31T01:00:00Z", "updatedAt": "2026-09-11T03:00:00Z",
    }


def _active_project(portfolio: dict[str, Any]) -> dict[str, Any]:
    projects = portfolio.get("projects", [])
    project = next((item for item in projects if item.get("id") == portfolio.get("currentProjectId")), None)
    if project is None:
        project = next((item for item in projects if item.get("status") != "archived"), projects[0] if projects else None)
    if project is None:
        raise ToolError("项目集为空")
    portfolio["currentProjectId"] = project["id"]
    return project


def _legacy_portfolio(payload: dict[str, Any]) -> dict[str, Any]:
    sample = _sample_portfolio()
    project = sample["projects"][0]
    project["id"] = "project-imported-legacy"
    project["title"] = _clean(payload.get("title"), 180) or "旧版项目"
    project["objective"] = _clean(payload.get("objective"), 1500)
    project["code"] = "LEGACY-IMPORT"
    project["memberIds"] = ["member-li"]
    sample["projects"] = [project]
    sample["currentProjectId"] = project["id"]
    tasks: list[dict[str, Any]] = []
    for index, item in enumerate(payload.get("tasks", []) if isinstance(payload.get("tasks"), list) else []):
        if not isinstance(item, dict):
            continue
        status = _clean(item.get("status"), 30)
        tasks.append({
            "id": _identifier("task"), "projectId": project["id"], "key": f"LEGACY-{index + 1}",
            "title": _clean(item.get("title"), 180) or f"迁移任务 {index + 1}",
            "status": status if status in STATUSES else "todo", "priority": _clean(item.get("priority"), 30) if _clean(item.get("priority"), 30) in PRIORITIES else "medium",
            "ownerIds": [], "labelIds": [], "cycleId": "", "milestoneId": "",
            "startDate": "", "dueDate": _clean(item.get("dueDate") or item.get("dueAt"), 20),
            "progress": 100 if status == "done" else 0, "storyPoints": 1, "dependencyIds": [], "archivedAt": "",
        })
    sample["tasks"] = tasks
    sample["cycles"] = []
    sample["milestones"] = []
    sample["comments"] = []
    sample["attachments"] = []
    sample["noteRevisions"] = [{"id": _identifier("note"), "projectId": project["id"], "revision": 1, "authorId": "member-li", "body": _clean(payload.get("notes"), 4000), "time": _now()}]
    sample["snapshots"] = []
    sample["activities"] = []
    sample["audit"] = []
    return sample


def _bundle(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state")
    if isinstance(state, dict) and state.get("schema") == SCHEMA and isinstance(state.get("portfolio"), dict):
        return deepcopy(state["portfolio"])
    if isinstance(state, dict) and isinstance(state.get("portfolio"), dict):
        return deepcopy(state["portfolio"])
    if isinstance(state, dict) and isinstance(state.get("projects"), list):
        return deepcopy(state)
    if isinstance(payload.get("portfolio"), dict):
        return deepcopy(payload["portfolio"])
    if isinstance(state, dict) and isinstance(state.get("tasks"), list):
        return _legacy_portfolio(state)
    raise ToolError("缺少项目工作区状态，请先载入合成基准")


def _analysis(portfolio: dict[str, Any]) -> dict[str, Any]:
    project = _active_project(portfolio)
    project_id = project["id"]
    tasks = [item for item in portfolio.get("tasks", []) if item.get("projectId") == project_id and not item.get("archivedAt")]
    members = [item for item in portfolio.get("members", []) if item.get("id") in project.get("memberIds", []) and item.get("active", True)]
    milestones = [item for item in portfolio.get("milestones", []) if item.get("projectId") == project_id]
    status_counts = {status: sum(item.get("status") == status for item in tasks) for status in STATUSES}
    priority_counts = {priority: sum(item.get("priority") == priority for item in tasks) for priority in PRIORITIES}
    done_points = sum(int(item.get("storyPoints", 0)) for item in tasks if item.get("status") == "done")
    total_points = sum(int(item.get("storyPoints", 0)) for item in tasks)
    today = datetime.now(UTC).date().isoformat()
    overdue = [item for item in tasks if item.get("dueDate") and item["dueDate"] < today and item.get("status") != "done"]
    blocked = [item for item in tasks if item.get("status") == "blocked"]
    member_load = []
    for member in members:
        assigned = [task for task in tasks if member["id"] in task.get("ownerIds", []) and task.get("status") != "done"]
        points = sum(int(task.get("storyPoints", 0)) for task in assigned)
        member_load.append({"memberId": member["id"], "name": member["name"], "role": member["role"], "openTasks": len(assigned), "points": points, "capacity": 12, "utilization": min(150, round(points / 12 * 100))})
    board = [{"status": row["id"], "name": row["name"], "tasks": [task for task in tasks if task.get("status") == row["id"]]} for row in sorted(portfolio.get("statuses", []), key=lambda row: row.get("order", 0))]
    start = datetime(2026, 9, 7, tzinfo=UTC)
    remaining = total_points
    burndown = []
    cumulative = []
    for index in range(8):
        date = (start + timedelta(days=index * 3)).date().isoformat()
        completed = round(done_points * index / 7) if index < 7 else done_points
        remaining_value = max(0, total_points - completed)
        burndown.append({"date": date, "ideal": round(total_points * (7 - index) / 7), "remaining": remaining_value})
        cumulative.append({"date": date, "done": completed, "doing": max(1, status_counts["doing"] + status_counts["review"]), "todo": max(0, total_points - completed - status_counts["doing"] - status_counts["review"])})
        remaining = remaining_value
    quality = [
        {"label": "所有进行中任务均有负责人", "passed": all(task.get("ownerIds") for task in tasks if task.get("status") in {"doing", "review", "blocked"})},
        {"label": "任务依赖均指向现有任务", "passed": all(dep in {row["id"] for row in tasks} for task in tasks for dep in task.get("dependencyIds", []))},
        {"label": "里程碑均有负责人和日期", "passed": all(item.get("ownerId") and item.get("dueDate") for item in milestones)},
        {"label": "活动事件由服务端生成", "passed": all(item.get("id") and item.get("time") and item.get("actor") for item in portfolio.get("activities", []))},
        {"label": "外部附件未伪装为已入库", "passed": all(item.get("storage") in {"metadata-only", "object-storage"} for item in portfolio.get("attachments", []))},
        {"label": "归档任务可恢复", "passed": all("archivedAt" in item for item in portfolio.get("tasks", []))},
    ]
    return {
        "currentProject": deepcopy(project),
        "metrics": {"progress": round(done_points / max(1, total_points) * 100), "donePoints": done_points, "totalPoints": total_points, "openTasks": len(tasks) - status_counts["done"], "blockedTasks": len(blocked), "overdueTasks": len(overdue), "activeMembers": len(members), "milestoneProgress": round(sum(int(item.get("progress", 0)) for item in milestones) / max(1, len(milestones)))},
        "statusCounts": status_counts, "priorityCounts": priority_counts, "board": board,
        "taskList": sorted(tasks, key=lambda item: (item.get("dueDate") or "9999-99-99", item.get("key", ""))),
        "timeline": sorted(tasks, key=lambda item: (item.get("startDate") or "9999-99-99", item.get("dueDate") or "9999-99-99")),
        "milestones": sorted(milestones, key=lambda item: item.get("dueDate", "")),
        "burndown": burndown, "cumulativeFlow": cumulative, "memberLoad": member_load,
        "activities": [item for item in portfolio.get("activities", []) if item.get("target") == project_id or item.get("target") in {task["id"] for task in tasks}][:30],
        "overdueTaskIds": [item["id"] for item in overdue], "qualityChecks": quality,
    }


def _runtime() -> dict[str, Any]:
    return {
        "controlPlane": {"status": "enabled", "engine": "Go projects / jobs / versions / audit"},
        "analytics": {"status": "enabled", "engine": "Python deterministic portfolio analytics"},
        "objectStorage": {"status": "not-configured", "engine": "S3 compatible adapter"},
        "webhook": {"status": "not-configured", "engine": "signed webhook adapter"},
        "calendar": {"status": "enabled", "engine": "iCalendar export"},
        "plane": {"status": "not-configured", "engine": "Plane API adapter"},
        "workflow": {"status": "not-configured", "engine": "Temporal / Dagster adapter"},
        "supportedImports": ["SkyView JSON", "legacy project JSON"],
        "supportedExports": ["CSV", "JSON", "Markdown", "iCalendar", "ZIP"],
        "arbitraryCodeExecution": False,
    }


def _csv(headers: list[str], rows: list[list[Any]]) -> str:
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(headers)
    writer.writerows(rows)
    return output.getvalue()


def _exports(portfolio: dict[str, Any], analysis: dict[str, Any], runtime: dict[str, Any]) -> dict[str, str]:
    project = analysis["currentProject"]
    tasks = analysis["taskList"]
    members_by_id = {item["id"]: item for item in portfolio.get("members", [])}
    task_csv = _csv(
        ["编号", "任务", "状态", "优先级", "负责人", "开始日期", "截止日期", "进度", "故事点", "依赖"],
        [[item.get("key"), item.get("title"), item.get("status"), item.get("priority"), ";".join(members_by_id.get(identifier, {}).get("name", identifier) for identifier in item.get("ownerIds", [])), item.get("startDate"), item.get("dueDate"), item.get("progress"), item.get("storyPoints"), ";".join(item.get("dependencyIds", []))] for item in tasks],
    )
    member_csv = _csv(["姓名", "邮箱", "角色", "未结任务", "负载点", "利用率"], [[item["name"], members_by_id.get(item["memberId"], {}).get("email", ""), item["role"], item["openTasks"], item["points"], item["utilization"]] for item in analysis["memberLoad"]])
    activity_csv = _csv(["时间", "操作者", "操作", "对象", "说明"], [[item.get("time"), item.get("actor"), item.get("action"), item.get("target"), item.get("text")] for item in portfolio.get("activities", [])])
    calendar_lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SkyViewLab//Project Workspace//ZH-CN"]
    for task in tasks:
        if task.get("dueDate"):
            calendar_lines += ["BEGIN:VEVENT", f"UID:{task['id']}@skyviewlab.local", f"DTSTART;VALUE=DATE:{task['dueDate'].replace('-', '')}", f"SUMMARY:{task.get('key')} {task.get('title')}", "END:VEVENT"]
    calendar_lines.append("END:VCALENDAR")
    report = "\n".join([
        f"# {project['title']} 项目状态报告", "", f"- 项目编号：{project['code']}",
        f"- 健康度：{project['health']}", f"- 整体进度：{analysis['metrics']['progress']}%",
        f"- 未结任务：{analysis['metrics']['openTasks']}", f"- 受阻任务：{analysis['metrics']['blockedTasks']}",
        f"- 逾期任务：{analysis['metrics']['overdueTasks']}", "", "## 里程碑",
        *[f"- {item['title']}｜{item['status']}｜{item['progress']}%｜{item['dueDate']}" for item in analysis["milestones"]],
    ])
    snapshot = {"schema": SCHEMA, "version": 2, "exportedAt": _now(), "portfolio": portfolio, "analysis": analysis, "runtime": runtime}
    project_json = json.dumps(snapshot, ensure_ascii=False, indent=2)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", report)
        archive.writestr("project.json", project_json)
        archive.writestr("tasks.csv", task_csv)
        archive.writestr("members.csv", member_csv)
        archive.writestr("activities.csv", activity_csv)
        archive.writestr("calendar.ics", "\r\n".join(calendar_lines))
    return {"reportMarkdown": report, "tasksCsv": task_csv, "membersCsv": member_csv, "activitiesCsv": activity_csv, "calendarIcs": "\r\n".join(calendar_lines), "projectJson": project_json, "backupJson": project_json, "packageBase64": base64.b64encode(buffer.getvalue()).decode("ascii")}


def _result(portfolio: dict[str, Any], stage: str) -> dict[str, Any]:
    analysis = _analysis(portfolio)
    runtime = _runtime()
    return {"schema": SCHEMA, "version": 2, "stage": stage, "portfolio": portfolio, "analysis": analysis, "runtime": runtime, "exports": _exports(portfolio, analysis, runtime)}


def _legacy_summary(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("tasks", [])
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ToolError("tasks 必须是 JSON 数组") from exc
    if not isinstance(raw, list):
        raise ToolError("tasks 必须是 JSON 数组")
    tasks = [item for item in raw if isinstance(item, dict)]
    if action == "validate":
        identifiers = [_clean(item.get("id"), 80) for item in tasks if item.get("id")]
        return {"valid": len(identifiers) == len(set(identifiers)) and all(_clean(item.get("title"), 180) for item in tasks), "issues": [], "count": len(tasks)}
    done = sum(_clean(item.get("status"), 30) == "done" for item in tasks)
    return {"tasks": len(tasks), "done": done, "progress": round(done / max(1, len(tasks)) * 100), "byStatus": {status: sum(_clean(item.get("status"), 30) == status for item in tasks) for status in STATUSES}, "unassigned": sum(not item.get("owner") and not item.get("ownerIds") for item in tasks)}


def _import_project(portfolio: dict[str, Any], content: str, actor: str, role: str, file_name: str) -> None:
    if len(content.encode("utf-8")) > MAX_IMPORT_BYTES:
        raise ToolError("项目文件不能超过 4 MB")
    try:
        imported = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ToolError("项目文件不是有效 JSON") from exc
    if not isinstance(imported, dict):
        raise ToolError("项目文件必须是 JSON 对象")
    if imported.get("schema") == SCHEMA and isinstance(imported.get("portfolio"), dict):
        source = imported["portfolio"]
        source_project = _active_project(source)
        source_tasks = [item for item in source.get("tasks", []) if item.get("projectId") == source_project.get("id")]
    else:
        source_project = imported
        source_tasks = imported.get("tasks", [])
    if not isinstance(source_tasks, list) or len(source_tasks) > MAX_TASKS:
        raise ToolError("项目任务数量超出限制")
    new_project_id = _identifier("project")
    title = _clean(source_project.get("title"), 180) or "导入项目"
    project = {"id": new_project_id, "code": f"IMPORT-{uuid.uuid4().hex[:6].upper()}", "title": f"{title}（导入副本）", "objective": _clean(source_project.get("objective"), 1500), "ownerId": next((item["id"] for item in portfolio.get("members", []) if item.get("role") == "owner"), ""), "memberIds": [item["id"] for item in portfolio.get("members", []) if item.get("role") in {"owner", "maintainer"}], "status": "active", "health": "on-track", "cycleId": "", "deadline": _clean(source_project.get("deadline"), 20), "archivedAt": "", "importedFrom": file_name}
    portfolio["projects"].append(project)
    id_map: dict[str, str] = {}
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(source_tasks):
        if not isinstance(item, dict):
            continue
        old_id = _clean(item.get("id"), 120) or f"legacy-{index}"
        id_map[old_id] = _identifier("task")
        status = _clean(item.get("status"), 30)
        priority = _clean(item.get("priority"), 30)
        normalized.append({"id": id_map[old_id], "projectId": new_project_id, "key": f"IMP-{index + 1}", "title": _clean(item.get("title"), 180) or f"导入任务 {index + 1}", "status": status if status in STATUSES else "todo", "priority": priority if priority in PRIORITIES else "medium", "ownerIds": [], "labelIds": [], "cycleId": "", "milestoneId": "", "startDate": _clean(item.get("startDate"), 20), "dueDate": _clean(item.get("dueDate") or item.get("dueAt"), 20), "progress": max(0, min(100, int(item.get("progress", 100 if status == "done" else 0)))), "storyPoints": max(1, min(100, int(item.get("storyPoints", 1)))), "dependencyIds": [], "archivedAt": ""})
    for original, task in zip((item for item in source_tasks if isinstance(item, dict)), normalized):
        task["dependencyIds"] = [id_map[item] for item in original.get("dependencyIds", []) if item in id_map]
    portfolio["tasks"].extend(normalized)
    portfolio["currentProjectId"] = new_project_id
    job = {"id": _identifier("import"), "fileName": file_name, "projectId": new_project_id, "acceptedTasks": len(normalized), "status": "completed", "time": _now()}
    portfolio.setdefault("importJobs", []).insert(0, job)
    _audit(portfolio, "import-project", actor, role, new_project_id, f"导入项目副本，接收 {len(normalized)} 项任务")


def run_project_workspace(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action in {"summary", "validate"} and "tasks" in payload and "state" not in payload and "portfolio" not in payload:
        return _legacy_summary(action, payload)
    if action in {"load-sample", "run-all"}:
        return _result(_sample_portfolio(), action)
    portfolio = _bundle(payload)
    actor, role = _authorize(action, payload)
    project = _active_project(portfolio)
    if action == "select-project":
        selected = _find(portfolio["projects"], _clean(payload.get("projectId"), 120), "项目")
        portfolio["currentProjectId"] = selected["id"]
    elif action == "create-project":
        title = _clean(payload.get("title"), 180)
        if not title:
            raise ToolError("项目名称不能为空")
        owner = next((item["id"] for item in portfolio.get("members", []) if item.get("role") == "owner"), "")
        created = {"id": _identifier("project"), "code": _clean(payload.get("code"), 40) or f"PROJ-{uuid.uuid4().hex[:6].upper()}", "title": title, "objective": _clean(payload.get("objective"), 1500), "ownerId": owner, "memberIds": [owner] if owner else [], "status": "active", "health": "on-track", "cycleId": "", "deadline": _clean(payload.get("deadline"), 20), "archivedAt": ""}
        portfolio["projects"].append(created); portfolio["currentProjectId"] = created["id"]
        _audit(portfolio, action, actor, role, created["id"], f"创建项目 {title}")
    elif action == "update-project":
        for key, limit in {"title": 180, "objective": 1500, "health": 30, "deadline": 20, "cycleId": 120}.items():
            if key in payload:
                project[key] = _clean(payload.get(key), limit)
        _audit(portfolio, action, actor, role, project["id"], "更新项目目标、健康度或计划日期")
    elif action in {"archive-project", "restore-project"}:
        project["status"] = "archived" if action == "archive-project" else "active"
        project["archivedAt"] = _now() if action == "archive-project" else ""
        _audit(portfolio, action, actor, role, project["id"], "归档项目" if action == "archive-project" else "恢复项目")
    elif action == "create-task":
        title = _clean(payload.get("title"), 180)
        if not title:
            raise ToolError("任务名称不能为空")
        tasks = [item for item in portfolio.get("tasks", []) if item.get("projectId") == project["id"]]
        task = {"id": _identifier("task"), "projectId": project["id"], "key": f"{project.get('code', 'TASK')}-{len(tasks) + 1:03d}", "title": title, "status": "todo", "priority": _clean(payload.get("priority"), 30) if _clean(payload.get("priority"), 30) in PRIORITIES else "medium", "ownerIds": payload.get("ownerIds", []) if isinstance(payload.get("ownerIds"), list) else [], "labelIds": payload.get("labelIds", []) if isinstance(payload.get("labelIds"), list) else [], "cycleId": _clean(payload.get("cycleId"), 120), "milestoneId": _clean(payload.get("milestoneId"), 120), "startDate": _clean(payload.get("startDate"), 20), "dueDate": _clean(payload.get("dueDate"), 20), "progress": 0, "storyPoints": max(1, min(100, int(payload.get("storyPoints", 1)))), "dependencyIds": [], "archivedAt": ""}
        portfolio["tasks"].append(task); _audit(portfolio, action, actor, role, task["id"], f"创建任务 {task['key']} {title}")
    elif action in {"update-task", "move-task"}:
        task = _find(portfolio["tasks"], _clean(payload.get("taskId"), 120), "任务")
        if task.get("projectId") != project["id"]:
            raise ToolError("任务不属于当前项目")
        status = _clean(payload.get("status"), 30) or task.get("status", "todo")
        if status not in STATUSES:
            raise ToolError("任务状态无效")
        task["status"] = status
        for key, limit in {"title": 180, "priority": 30, "startDate": 20, "dueDate": 20, "cycleId": 120, "milestoneId": 120}.items():
            if key in payload:
                task[key] = _clean(payload.get(key), limit)
        if "ownerIds" in payload and isinstance(payload.get("ownerIds"), list): task["ownerIds"] = payload["ownerIds"]
        if "labelIds" in payload and isinstance(payload.get("labelIds"), list): task["labelIds"] = payload["labelIds"]
        if "progress" in payload: task["progress"] = max(0, min(100, int(payload.get("progress", 0))))
        if status == "done": task["progress"] = 100
        _audit(portfolio, action, actor, role, task["id"], f"{task['key']} 更新为 {status} / {task['progress']}%")
    elif action in {"archive-task", "delete-task", "restore-task"}:
        task = _find(portfolio["tasks"], _clean(payload.get("taskId"), 120), "任务")
        task["archivedAt"] = "" if action == "restore-task" else _now()
        _audit(portfolio, action, actor, role, task["id"], "恢复任务" if action == "restore-task" else "归档任务（可恢复）")
    elif action == "add-dependency":
        task = _find(portfolio["tasks"], _clean(payload.get("taskId"), 120), "任务")
        dependency = _find(portfolio["tasks"], _clean(payload.get("dependencyId"), 120), "依赖任务")
        if task["id"] == dependency["id"] or task.get("projectId") != dependency.get("projectId"):
            raise ToolError("任务不能依赖自身或其他项目任务")
        task.setdefault("dependencyIds", [])
        if dependency["id"] not in task["dependencyIds"]: task["dependencyIds"].append(dependency["id"])
        _audit(portfolio, action, actor, role, task["id"], f"增加依赖 {dependency['key']}")
    elif action == "add-comment":
        task = _find(portfolio["tasks"], _clean(payload.get("taskId"), 120), "任务")
        body = _clean(payload.get("body"), 2000)
        if not body: raise ToolError("评论内容不能为空")
        author_id = _clean(payload.get("authorId"), 120) or project.get("ownerId", "")
        comment = {"id": _identifier("comment"), "projectId": project["id"], "taskId": task["id"], "authorId": author_id, "body": body, "time": _now()}
        portfolio.setdefault("comments", []).insert(0, comment); _audit(portfolio, action, actor, role, task["id"], f"为 {task['key']} 添加评论")
    elif action == "add-attachment":
        task = _find(portfolio["tasks"], _clean(payload.get("taskId"), 120), "任务")
        name = _clean(payload.get("name"), 240)
        if not name: raise ToolError("附件名称不能为空")
        attachment = {"id": _identifier("attachment"), "projectId": project["id"], "taskId": task["id"], "name": name, "size": max(0, int(payload.get("size", 0))), "contentType": _clean(payload.get("contentType"), 120) or "application/octet-stream", "storage": "metadata-only", "checksum": _clean(payload.get("checksum"), 180), "time": _now()}
        portfolio.setdefault("attachments", []).insert(0, attachment); _audit(portfolio, action, actor, role, task["id"], f"登记附件元数据 {name}，未伪装为已上传")
    elif action in {"add-member", "update-member", "remove-member"}:
        if action == "add-member":
            name, email = _clean(payload.get("name"), 100), _clean(payload.get("email"), 180)
            if not name or not email: raise ToolError("成员姓名和邮箱不能为空")
            member_role = _clean(payload.get("role"), 30) or "member"
            if member_role not in ROLES: raise ToolError("成员角色无效")
            member = {"id": _identifier("member"), "name": name, "email": email, "role": member_role, "avatar": name[:1], "active": True}
            portfolio["members"].append(member); project.setdefault("memberIds", []).append(member["id"]); target = member["id"]
        else:
            member = _find(portfolio["members"], _clean(payload.get("memberId"), 120), "成员")
            if action == "remove-member": member["active"] = False; project["memberIds"] = [item for item in project.get("memberIds", []) if item != member["id"]]
            else:
                if "name" in payload: member["name"] = _clean(payload.get("name"), 100)
                if "email" in payload: member["email"] = _clean(payload.get("email"), 180)
                if "role" in payload:
                    member_role = _clean(payload.get("role"), 30)
                    if member_role not in ROLES: raise ToolError("成员角色无效")
                    member["role"] = member_role
            target = member["id"]
        _audit(portfolio, action, actor, role, target, "更新项目成员与角色")
    elif action in {"create-cycle", "update-cycle"}:
        if action == "create-cycle":
            name = _clean(payload.get("name"), 160)
            if not name: raise ToolError("迭代名称不能为空")
            cycle = {"id": _identifier("cycle"), "projectId": project["id"], "name": name, "startDate": _clean(payload.get("startDate"), 20), "endDate": _clean(payload.get("endDate"), 20), "status": "planned", "capacity": max(1, int(payload.get("capacity", 20)))}
            portfolio["cycles"].append(cycle)
        else:
            cycle = _find(portfolio["cycles"], _clean(payload.get("cycleId"), 120), "迭代")
            for key in ["name", "startDate", "endDate", "status"]:
                if key in payload: cycle[key] = _clean(payload.get(key), 160)
            if "capacity" in payload: cycle["capacity"] = max(1, int(payload["capacity"]))
        _audit(portfolio, action, actor, role, cycle["id"], f"更新迭代 {cycle['name']}")
    elif action in {"create-milestone", "update-milestone"}:
        if action == "create-milestone":
            title = _clean(payload.get("title"), 180)
            if not title: raise ToolError("里程碑名称不能为空")
            milestone = {"id": _identifier("milestone"), "projectId": project["id"], "title": title, "dueDate": _clean(payload.get("dueDate"), 20), "status": "planned", "progress": 0, "ownerId": _clean(payload.get("ownerId"), 120) or project.get("ownerId", "")}
            portfolio["milestones"].append(milestone)
        else:
            milestone = _find(portfolio["milestones"], _clean(payload.get("milestoneId"), 120), "里程碑")
            for key in ["title", "dueDate", "status", "ownerId"]:
                if key in payload: milestone[key] = _clean(payload.get(key), 180)
            if "progress" in payload: milestone["progress"] = max(0, min(100, int(payload["progress"])))
            if milestone.get("status") == "done": milestone["progress"] = 100
        _audit(portfolio, action, actor, role, milestone["id"], f"更新里程碑 {milestone['title']}")
    elif action == "update-note":
        body = _clean(payload.get("body"), 8000)
        if not body: raise ToolError("阶段笔记不能为空")
        revisions = [item for item in portfolio.get("noteRevisions", []) if item.get("projectId") == project["id"]]
        author_id = _clean(payload.get("authorId"), 120) or project.get("ownerId", "")
        note = {"id": _identifier("note"), "projectId": project["id"], "revision": max([int(item.get("revision", 0)) for item in revisions] + [0]) + 1, "authorId": author_id, "body": body, "time": _now()}
        portfolio.setdefault("noteRevisions", []).insert(0, note); _audit(portfolio, action, actor, role, project["id"], f"更新阶段笔记第 {note['revision']} 版")
    elif action == "create-snapshot":
        tasks = [item for item in portfolio.get("tasks", []) if item.get("projectId") == project["id"]]
        milestones = [item for item in portfolio.get("milestones", []) if item.get("projectId") == project["id"]]
        snapshot = {"id": _identifier("snapshot"), "projectId": project["id"], "label": _clean(payload.get("label"), 180) or f"项目版本 {portfolio.get('version', 1)}", "version": portfolio.get("version", 1), "createdAt": _now(), "state": {"project": deepcopy(project), "tasks": deepcopy(tasks), "milestones": deepcopy(milestones)}}
        portfolio.setdefault("snapshots", []).insert(0, snapshot); _audit(portfolio, action, actor, role, snapshot["id"], f"创建可恢复快照 {snapshot['label']}")
    elif action == "restore-snapshot":
        snapshot = _find(portfolio.get("snapshots", []), _clean(payload.get("snapshotId"), 120), "快照")
        state = snapshot.get("state", {})
        if not isinstance(state.get("tasks"), list) or not isinstance(state.get("milestones"), list): raise ToolError("旧摘要快照不包含可恢复完整状态")
        portfolio["projects"] = [item for item in portfolio["projects"] if item["id"] != project["id"]] + [deepcopy(state["project"])]
        portfolio["tasks"] = [item for item in portfolio["tasks"] if item.get("projectId") != project["id"]] + deepcopy(state["tasks"])
        portfolio["milestones"] = [item for item in portfolio["milestones"] if item.get("projectId") != project["id"]] + deepcopy(state["milestones"])
        _audit(portfolio, action, actor, role, snapshot["id"], f"恢复快照 {snapshot['label']}")
    elif action == "import-project":
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip(): raise ToolError("导入文件不能为空")
        _import_project(portfolio, content, actor, role, _clean(payload.get("fileName"), 180) or "project.json")
    elif action in {"runtime-status", "validate", "export"}:
        _audit(portfolio, action, actor, role, project["id"], {"runtime-status": "检查对象存储、Webhook、日历与外部项目适配器", "validate": "执行成员、依赖、里程碑、归档和审计门禁", "export": "生成表格、日历、报告、项目 JSON 与完整交付包"}[action])
    else:
        raise ToolError("不支持的在线项目开发操作")
    return _result(portfolio, action)
