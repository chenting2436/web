from __future__ import annotations

import json
import unittest

from app.tools.common import ToolError
from app.tools.dispatcher import run_tool


class ResearchAutomationFullTests(unittest.TestCase):
    def test_baseline_restores_templates_graph_runs_lineage_and_exports(self) -> None:
        result = run_tool("research-automation", "run-all", {})

        self.assertEqual(result["schema"], "skyview-research-automation-results")
        self.assertEqual(result["stage"], "run-all")
        self.assertEqual(len(result["workspace"]["templates"]), 3)
        self.assertEqual(len(result["workspace"]["workflows"][0]["nodes"]), 6)
        self.assertEqual({item["type"] for item in result["workspace"]["workflows"][0]["nodes"]}, {"trigger", "source", "transform", "analysis", "review", "output"})
        self.assertEqual(len(result["analysis"]["graph"]["edges"]), 5)
        self.assertGreaterEqual(len(result["workspace"]["runs"]), 2)
        self.assertGreaterEqual(len(result["workspace"]["artifacts"]), 3)
        self.assertGreaterEqual(len(result["workspace"]["lineage"]), 3)
        self.assertTrue(result["analysis"]["validation"]["valid"])
        self.assertIn("skyview-research-workflow", result["exports"]["workflowJson"])
        self.assertIn("skyview-research-automation-backup", result["exports"]["backupJson"])
        self.assertIn("run_id", result["exports"]["runCsv"])
        self.assertFalse(result["runtime"]["arbitraryCodeExecution"])
        self.assertFalse(result["runtime"]["persistentSchedulerConfigured"])
        self.assertFalse(result["runtime"]["previewResultsPublishable"])

    def test_preview_waits_for_human_approval_and_can_complete(self) -> None:
        baseline = run_tool("research-automation", "run-all", {})
        preview = run_tool("research-automation", "run-preview", {"state": {"workspace": baseline["workspace"]}})

        self.assertEqual(preview["run"]["status"], "awaiting-approval")
        self.assertTrue(any(item["status"] == "awaiting-approval" for item in preview["run"]["stepRuns"]))
        self.assertEqual(preview["analysis"]["metrics"]["pendingApprovals"], 1)

        approved = run_tool("research-automation", "approve", {"state": {"workspace": preview["workspace"]}, "runId": preview["run"]["id"], "decision": "approved", "note": "复核通过"})
        self.assertEqual(approved["run"]["status"], "succeeded")
        self.assertEqual(approved["analysis"]["metrics"]["pendingApprovals"], 0)
        self.assertTrue(any(item["runId"] == preview["run"]["id"] for item in approved["workspace"]["artifacts"]))

    def test_failure_retry_and_publish_keep_auditable_state(self) -> None:
        baseline = run_tool("research-automation", "run-all", {})
        updated = run_tool("research-automation", "update-node", {"state": {"workspace": baseline["workspace"]}, "nodeId": "node-analysis", "config": {"summary": "故障演练", "simulateFailure": True}, "maxAttempts": 3})
        failed = run_tool("research-automation", "run-preview", {"state": {"workspace": updated["workspace"]}})

        self.assertEqual(failed["run"]["status"], "failed")
        failed_step = next(item for item in failed["run"]["stepRuns"] if item["status"] == "failed")
        self.assertEqual(failed_step["attempts"], 3)
        retried = run_tool("research-automation", "retry-step", {"state": {"workspace": failed["workspace"]}, "runId": failed["run"]["id"], "nodeId": failed_step["nodeId"]})
        self.assertEqual(next(item for item in retried["run"]["stepRuns"] if item["nodeId"] == failed_step["nodeId"])["status"], "succeeded")
        published = run_tool("research-automation", "publish", {"state": {"workspace": retried["workspace"]}, "label": "复核版"})
        self.assertTrue(published["publishedVersion"]["immutable"])
        self.assertTrue(published["publishedVersion"]["checksum"].startswith("sha256:"))

    def test_v1_import_never_executes_and_strips_secret_values(self) -> None:
        baseline = run_tool("research-automation", "run-all", {})
        payload = {
            "schema": "skyview-research-workflow",
            "version": 1,
            "workflow": {
                "name": "安全导入流程",
                "variables": [{"key": "API_TOKEN", "value": "must-not-survive", "secret": True}],
                "history": [{"status": "success"}],
                "nodes": [
                    {"id": "start", "type": "trigger", "name": "开始", "dependsOn": [], "config": "manual"},
                    {"id": "output", "type": "output", "name": "交付", "dependsOn": ["start"], "config": "markdown"},
                ],
            },
        }
        imported = run_tool("research-automation", "import-workflow", {"state": {"workspace": baseline["workspace"]}, "content": json.dumps(payload, ensure_ascii=False)})

        self.assertEqual(imported["importSummary"]["secretValuesStripped"], 1)
        self.assertTrue(imported["importSummary"]["historyDiscarded"])
        self.assertFalse(imported["importSummary"]["executionStarted"])
        current = next(item for item in imported["workspace"]["workflows"] if item["id"] == imported["workspace"]["currentWorkflowId"])
        self.assertFalse(current["variables"])
        self.assertEqual(current["secretRefs"][0]["provider"], "unbound")
        self.assertNotIn("must-not-survive", imported["exports"]["workflowJson"])

        copy_payload = json.loads(json.dumps(payload, ensure_ascii=False))
        copy_payload["workflow"]["nodes"][1]["config"] = {"script": "rm -rf /"}
        with self.assertRaises(ToolError):
            run_tool("research-automation", "import-workflow", {"state": {"workspace": baseline["workspace"]}, "content": json.dumps(copy_payload, ensure_ascii=False)})

    def test_legacy_validate_and_run_contract_remain_compatible(self) -> None:
        nodes = [
            {"id": "collect", "name": "采集"},
            {"id": "clean", "name": "清洗", "dependsOn": ["collect"]},
            {"id": "report", "name": "报告", "dependsOn": ["clean"]},
        ]
        validated = run_tool("research-automation", "validate", {"nodes": nodes})
        self.assertTrue(validated["valid"])
        self.assertEqual(validated["order"], ["collect", "clean", "report"])
        executed = run_tool("research-automation", "run", {"nodes": nodes})
        self.assertEqual(executed["status"], "success")
        self.assertEqual(len(executed["trace"]), 3)


if __name__ == "__main__":
    unittest.main()
