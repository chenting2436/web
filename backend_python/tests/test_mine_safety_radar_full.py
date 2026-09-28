from __future__ import annotations

import json
import unittest

from app.tools.common import ToolError
from app.tools.dispatcher import run_tool


class MineSafetyRadarFullTests(unittest.TestCase):
    def test_complete_baseline_isolated_taxonomy_readiness_and_exports(self) -> None:
        result = run_tool("mine-safety-radar", "run-all", {})

        self.assertEqual(result["schema"], "skyview-mine-safety-radar-results")
        self.assertEqual(result["namespace"], "mine-safety")
        self.assertEqual(len(result["records"]), 16)
        self.assertTrue(all(item["datasetMode"] == "demo" and item["isDemo"] for item in result["records"]))
        self.assertEqual(len(result["analysis"]["hazards"]), 8)
        self.assertEqual(len(result["analysis"]["methods"]), 8)
        self.assertEqual(len(result["analysis"]["data"]), 6)
        self.assertEqual(len(result["analysis"]["hazardMethodMatrix"]), 64)
        self.assertGreater(len(result["analysis"]["graph"]["nodes"]), 10)
        self.assertGreater(len(result["analysis"]["riskSignals"]), 5)
        self.assertTrue(all("矿山安全" in item["source"] for item in result["records"]))
        self.assertTrue(result["runtime"]["dataSpaceIsolated"])
        self.assertTrue(result["runtime"]["crossModeReuseRequiresTransfer"])
        self.assertFalse(result["runtime"]["safetyDecisionAutomation"])
        self.assertIn("skyview-mine-safety-radar-backup", result["exports"]["backupJson"])
        self.assertIn("skyview-mine-evidence-transfer", result["exports"]["transferJson"])

    def test_rules_classify_hazard_method_data_and_engineering_signals(self) -> None:
        result = run_tool("mine-safety-radar", "classify", {"text": "某矿区现场采用 InSAR 与 GNSS 位移传感器监测露天矿边坡，使用数据集完成案例验证并报告不确定性。"})

        self.assertEqual(result["classification"]["primaryHazard"], "边坡与滑坡")
        self.assertTrue(any(item["id"] == "remote" for item in result["classification"]["methods"]))
        self.assertTrue(any(item["id"] == "displacement" for item in result["classification"]["data"]))
        self.assertGreaterEqual(result["readiness"]["score"], 75)
        self.assertIn("不形成安全判断", result["boundary"])

    def test_import_stays_in_mine_namespace_and_general_namespace_is_rejected(self) -> None:
        baseline = run_tool("mine-safety-radar", "run-all", {})
        payload = json.dumps({"records": [{"title": "Tailings dam LiDAR field validation", "year": 2026, "doi": "10.1000/mine.1", "abstract": "A field case study validates LiDAR point cloud monitoring at a tailings dam and reports uncertainty."}]})
        imported = run_tool("mine-safety-radar", "import-records", {"state": {"workspace": baseline["workspace"], "records": baseline["records"], "sources": baseline["sources"]}, "fileName": "mine.json", "content": payload})

        record = next(item for item in imported["records"] if item["doi"] == "10.1000/mine.1")
        self.assertTrue(any(item["id"] == "tailings" for item in record["mine"]["hazards"]))
        self.assertTrue(any(item["id"] == "pointcloud" for item in record["mine"]["data"]))
        self.assertEqual(imported["namespace"], "mine-safety")

        with self.assertRaises(ToolError):
            run_tool("mine-safety-radar", "export", {"state": {"workspace": {"namespace": "research"}, "records": []}})

    def test_monitor_and_transfer_keep_namespace_and_review_boundary(self) -> None:
        baseline = run_tool("mine-safety-radar", "run-all", {})
        state = {"workspace": baseline["workspace"], "records": baseline["records"], "sources": baseline["sources"]}
        monitored = run_tool("mine-safety-radar", "run-monitor", {"state": state, "monitorId": "mine-monitor-weekly"})
        self.assertEqual(monitored["monitorRun"]["namespace"], "mine-safety")
        self.assertTrue(monitored["monitorRun"]["deduplicationKey"].startswith("mine-safety:"))

        transferred = run_tool("mine-safety-radar", "transfer", {"state": {"workspace": monitored["workspace"], "records": monitored["records"], "sources": monitored["sources"]}, "recordIds": ["mine-01", "mine-03"], "destination": "seismic-physics"})
        transfer = transferred["workspace"]["transfer"]["history"][0]
        self.assertEqual(transfer["sourceNamespace"], "mine-safety")
        self.assertTrue(transfer["requiresDestinationReview"])


if __name__ == "__main__":
    unittest.main()
