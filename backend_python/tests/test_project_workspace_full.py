from __future__ import annotations

import json
import unittest

from app.tools.common import ToolError
from app.tools.project_workspace_full import run_project_workspace


class ProjectWorkspaceFullTests(unittest.TestCase):
    def test_sample_contains_complete_portfolio_and_exports(self) -> None:
        result = run_project_workspace("load-sample", {})
        self.assertEqual(result["schema"], "skyview-project-workspace-results")
        self.assertGreaterEqual(len(result["portfolio"]["projects"]), 3)
        self.assertGreaterEqual(len(result["portfolio"]["tasks"]), 12)
        self.assertGreaterEqual(len(result["portfolio"]["members"]), 5)
        self.assertGreaterEqual(len(result["portfolio"]["milestones"]), 4)
        self.assertTrue(result["exports"]["packageBase64"])
        self.assertIn("BEGIN:VCALENDAR", result["exports"]["calendarIcs"])

    def test_task_move_is_persistent_and_server_audited(self) -> None:
        state = run_project_workspace("load-sample", {})
        result = run_project_workspace("move-task", {"state": state, "taskId": "task-006", "status": "doing", "progress": 20, "actor": "周明", "actorRole": "maintainer"})
        task = next(item for item in result["portfolio"]["tasks"] if item["id"] == "task-006")
        self.assertEqual(task["status"], "doing")
        self.assertEqual(task["progress"], 20)
        self.assertEqual(result["portfolio"]["audit"][0]["action"], "move-task")
        self.assertEqual(result["portfolio"]["activities"][0]["actor"], "周明")

    def test_viewer_cannot_mutate_tasks(self) -> None:
        state = run_project_workspace("load-sample", {})
        with self.assertRaises(ToolError):
            run_project_workspace("create-task", {"state": state, "title": "越权任务", "actorRole": "viewer"})

    def test_task_archive_is_recoverable(self) -> None:
        state = run_project_workspace("load-sample", {})
        archived = run_project_workspace("archive-task", {"state": state, "taskId": "task-006"})
        task = next(item for item in archived["portfolio"]["tasks"] if item["id"] == "task-006")
        self.assertTrue(task["archivedAt"])
        restored = run_project_workspace("restore-task", {"state": archived, "taskId": "task-006"})
        task = next(item for item in restored["portfolio"]["tasks"] if item["id"] == "task-006")
        self.assertEqual(task["archivedAt"], "")

    def test_import_creates_a_new_project_without_trusting_source_audit(self) -> None:
        state = run_project_workspace("load-sample", {})
        content = json.dumps({"title": "外部课程项目", "objective": "迁移测试", "tasks": [{"id": "old-1", "title": "任务一", "status": "done"}], "audit": [{"actor": "伪造管理员"}]}, ensure_ascii=False)
        result = run_project_workspace("import-project", {"state": state, "fileName": "legacy.json", "content": content, "actor": "导入员"})
        project = result["analysis"]["currentProject"]
        self.assertIn("导入副本", project["title"])
        self.assertNotEqual(project["id"], "old-1")
        self.assertEqual(result["portfolio"]["importJobs"][0]["acceptedTasks"], 1)
        self.assertNotIn("伪造管理员", json.dumps(result["portfolio"]["audit"], ensure_ascii=False))

    def test_snapshot_restores_task_state(self) -> None:
        state = run_project_workspace("load-sample", {})
        created = run_project_workspace("create-snapshot", {"state": state, "label": "可恢复基线"})
        snapshot_id = created["portfolio"]["snapshots"][0]["id"]
        changed = run_project_workspace("move-task", {"state": created, "taskId": "task-006", "status": "done"})
        restored = run_project_workspace("restore-snapshot", {"state": changed, "snapshotId": snapshot_id})
        task = next(item for item in restored["portfolio"]["tasks"] if item["id"] == "task-006")
        self.assertEqual(task["status"], "todo")

    def test_legacy_summary_contract_is_preserved(self) -> None:
        result = run_project_workspace("summary", {"tasks": [{"title": "A", "status": "done"}]})
        self.assertEqual(result["progress"], 100)


if __name__ == "__main__":
    unittest.main()
