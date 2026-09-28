from __future__ import annotations

import unittest

from app.tools.common import ToolError
from app.tools.emergency_console_full import run_emergency_console


class EmergencyConsoleFullTests(unittest.TestCase):
    def test_sample_contains_incident_resources_decisions_and_exports(self) -> None:
        result = run_emergency_console("load-sample", {})
        self.assertEqual(result["schema"], "skyview-emergency-console-results")
        self.assertGreaterEqual(len(result["console"]["reports"]), 5)
        self.assertGreaterEqual(len(result["console"]["tasks"]), 8)
        self.assertGreaterEqual(len(result["console"]["resources"]), 5)
        self.assertGreaterEqual(len(result["console"]["decisions"]), 3)
        self.assertTrue(result["exports"]["packageBase64"])
        self.assertIn("<alert", result["exports"]["capXml"])

    def test_report_verification_is_audited(self) -> None:
        state = run_emergency_console("load-sample", {})
        result = run_emergency_console("verify-report", {"state": state, "reportId": "report-003", "decision": "verified", "note": "现场与影像一致", "actor": "审核员"})
        report = next(item for item in result["console"]["reports"] if item["id"] == "report-003")
        self.assertEqual(report["status"], "verified")
        self.assertEqual(result["console"]["audit"][0]["action"], "verify-report")

    def test_decision_requires_traceable_evidence(self) -> None:
        state = run_emergency_console("load-sample", {})
        with self.assertRaises(ToolError):
            run_emergency_console("record-decision", {"state": state, "title": "测试决策", "option": "方案 A", "reason": "测试", "evidenceIds": []})
        result = run_emergency_console("record-decision", {"state": state, "title": "增设监测点", "option": "坡脚加设 2 点", "reason": "孔压持续升高", "evidenceIds": ["report-001", "report-004"], "approve": True, "actor": "李指挥"})
        self.assertEqual(result["console"]["decisions"][-1]["status"], "approved")
        self.assertEqual(len(result["console"]["decisions"][-1]["evidenceIds"]), 2)

    def test_external_communication_stays_prepared_without_gateway(self) -> None:
        state = run_emergency_console("load-sample", {})
        result = run_emergency_console("send-communication", {"state": state, "channel": "sms", "audience": "外部单位", "subject": "协同请求"})
        self.assertEqual(result["console"]["communications"][0]["status"], "prepared")
        self.assertEqual(result["runtime"]["communications"]["sms"], "not-configured")

    def test_shift_handover_requires_note_and_receiver(self) -> None:
        state = run_emergency_console("load-sample", {})
        with self.assertRaises(ToolError):
            run_emergency_console("handover-shift", {"state": state, "shiftId": "shift-day", "nextShiftId": "shift-night"})
        result = run_emergency_console("handover-shift", {"state": state, "shiftId": "shift-day", "nextShiftId": "shift-night", "note": "继续跟踪排水与复飞", "acceptedBy": "周值班长", "actor": "王值班长"})
        self.assertEqual(result["console"]["shifts"][0]["status"], "handed-over")
        self.assertEqual(result["console"]["shifts"][1]["status"], "active")

    def test_close_rejects_open_tasks_without_explicit_force(self) -> None:
        state = run_emergency_console("load-sample", {})
        with self.assertRaises(ToolError):
            run_emergency_console("close-incident", {"state": state, "reason": "测试"})

    def test_bounded_report_import_rejects_invalid_coordinates(self) -> None:
        state = run_emergency_console("load-sample", {})
        content = "source,title,type,x,y,content\n现场三组,新增渗水,field,55,60,坡脚渗水\n热线,无效位置,public,170,20,位置越界\n"
        result = run_emergency_console("import-reports", {"state": state, "fileName": "reports.csv", "content": content})
        self.assertEqual(result["importSummary"]["accepted"], 1)
        self.assertEqual(result["importSummary"]["rejected"], 1)


if __name__ == "__main__":
    unittest.main()
