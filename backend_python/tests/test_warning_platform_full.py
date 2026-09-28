from __future__ import annotations

import unittest

from app.tools.common import ToolError
from app.tools.warning_platform_full import run_warning_platform


class WarningPlatformFullTests(unittest.TestCase):
    def test_sample_contains_monitoring_rule_alarm_and_delivery_models(self) -> None:
        result = run_warning_platform("load-sample", {})
        self.assertEqual(result["schema"], "skyview-warning-platform-results")
        self.assertGreaterEqual(len(result["sites"]), 3)
        self.assertGreaterEqual(len(result["devices"]), 6)
        self.assertGreaterEqual(len(result["analysis"]["timeSeries"]), 6)
        self.assertGreaterEqual(result["analysis"]["metrics"]["openAlarms"], 1)
        self.assertTrue(result["exports"]["packageBase64"])

    def test_alarm_lifecycle_is_stateful_and_audited(self) -> None:
        state = run_warning_platform("load-sample", {})
        acknowledged = run_warning_platform("acknowledge-alarm", {
            "state": state, "alarmId": "alarm-20260910-001", "actor": "测试值班员", "note": "已确认",
        })
        alarm = next(item for item in acknowledged["workspace"]["alarms"] if item["id"] == "alarm-20260910-001")
        self.assertEqual(alarm["status"], "acknowledged")
        closed = run_warning_platform("close-alarm", {
            "state": acknowledged, "alarmId": alarm["id"], "actor": "测试值班员", "resolution": "完成现场复核",
        })
        alarm = next(item for item in closed["workspace"]["alarms"] if item["id"] == "alarm-20260910-001")
        self.assertEqual(alarm["status"], "closed")
        self.assertEqual(closed["workspace"]["audit"][0]["action"], "close-alarm")

    def test_rule_publish_requires_two_distinct_approvals(self) -> None:
        state = run_warning_platform("load-sample", {})
        with self.assertRaises(ToolError):
            run_warning_platform("publish-rule", {"state": state, "ruleId": "rule-pore", "actor": "发布人"})
        approved = run_warning_platform("approve-rule", {"state": state, "ruleId": "rule-pore", "actor": "第二复核人"})
        published = run_warning_platform("publish-rule", {"state": approved, "ruleId": "rule-pore", "actor": "发布人", "warning": 122, "critical": 145})
        rule = next(item for item in published["workspace"]["rules"] if item["id"] == "rule-pore")
        self.assertEqual(rule["status"], "active")
        self.assertEqual(rule["critical"], 145)

    def test_observation_import_rejects_unknown_sensors(self) -> None:
        state = run_warning_platform("load-sample", {})
        content = "sensorId,time,value,quality\nsensor-disp,2026-09-10T12:00:00Z,35.6,good\nunknown,2026-09-10T12:00:00Z,3,good\n"
        result = run_warning_platform("ingest-observations", {"state": state, "fileName": "field.csv", "content": content, "actor": "导入员"})
        self.assertEqual(result["importSummary"]["accepted"], 1)
        self.assertEqual(result["importSummary"]["rejected"], 1)


if __name__ == "__main__":
    unittest.main()
