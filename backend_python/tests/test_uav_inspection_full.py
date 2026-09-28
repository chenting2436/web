from __future__ import annotations

import unittest

from app.tools.common import ToolError
from app.tools.uav_inspection_full import run_uav_inspection


class UavInspectionFullTests(unittest.TestCase):
    def test_sample_contains_route_assets_products_defects_and_orders(self) -> None:
        result = run_uav_inspection("load-sample", {})
        self.assertEqual(result["schema"], "skyview-uav-inspection-results")
        self.assertGreaterEqual(len(result["project"]["missions"]), 2)
        self.assertGreaterEqual(len(result["imageAssets"]), 12)
        self.assertGreaterEqual(len(result["project"]["detections"]), 8)
        self.assertTrue(result["analysis"]["route"]["passed"])
        self.assertTrue(result["exports"]["packageBase64"])

    def test_route_change_recomputes_and_can_block_validation(self) -> None:
        state = run_uav_inspection("load-sample", {})
        changed = run_uav_inspection("update-flight-plan", {"state": state, "planId": "plan-bridge-a", "altitudeM": 150, "frontOverlap": 60, "sideOverlap": 50, "actor": "测试飞手"})
        checked = run_uav_inspection("validate-flight-plan", {"state": changed, "planId": "plan-bridge-a", "actor": "测试负责人"})
        self.assertFalse(checked["analysis"]["route"]["passed"])
        self.assertEqual(checked["project"]["flightPlans"][0]["status"], "blocked")

    def test_detection_review_and_work_order_lifecycle_are_audited(self) -> None:
        state = run_uav_inspection("load-sample", {})
        reviewed = run_uav_inspection("review-detection", {"state": state, "detectionId": "det-003", "decision": "confirmed", "note": "人工确认", "actor": "审核员"})
        detection = next(item for item in reviewed["project"]["detections"] if item["id"] == "det-003")
        self.assertEqual(detection["status"], "confirmed")
        created = run_uav_inspection("create-work-order", {"state": reviewed, "detectionIds": ["det-003"], "title": "锈蚀近距复核", "assignee": "检测组", "dueAt": "2026-09-12T12:00:00Z", "actor": "审核员"})
        order = created["project"]["workOrders"][0]
        closed = run_uav_inspection("update-work-order", {"state": created, "workOrderId": order["id"], "status": "closed", "resolution": "完成检测", "actor": "检测组"})
        self.assertEqual(closed["project"]["workOrders"][0]["status"], "closed")
        self.assertEqual(closed["project"]["audit"][0]["action"], "update-work-order")

    def test_manifest_import_validates_mission_and_coordinates(self) -> None:
        state = run_uav_inspection("load-sample", {})
        content = "missionId,fileName,capturedAt,x,y,altitudeM\nmission-20260910,field-01.jpg,2026-09-10T10:00:00Z,25,32,70\nunknown,bad.jpg,2026-09-10T10:00:00Z,1,2,3\n"
        result = run_uav_inspection("import-image-manifest", {"state": state, "fileName": "manifest.csv", "content": content, "actor": "导入员"})
        self.assertEqual(result["importSummary"]["accepted"], 1)
        self.assertEqual(result["importSummary"]["rejected"], 1)

    def test_photogrammetry_does_not_claim_unconfigured_runtime_execution(self) -> None:
        state = run_uav_inspection("load-sample", {})
        prepared = run_uav_inspection("prepare-photogrammetry", {"state": state, "missionId": "mission-20260910", "actor": "处理员"})
        self.assertEqual(prepared["project"]["odmJobs"][0]["status"], "prepared")
        self.assertEqual(prepared["runtime"]["photogrammetry"]["status"], "not-configured")
        with self.assertRaises(ToolError):
            run_uav_inspection("review-detection", {"state": state, "detectionId": "missing", "decision": "confirmed"})


if __name__ == "__main__":
    unittest.main()
