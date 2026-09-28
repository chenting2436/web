from __future__ import annotations

import unittest

from app.tools.common import ToolError
from app.tools.fusion_console_full import run_fusion_console


class FusionConsoleFullTests(unittest.TestCase):
    def test_sample_contains_sources_governance_alignment_events_and_exports(self) -> None:
        result = run_fusion_console("load-sample", {})
        self.assertEqual(result["schema"], "skyview-fusion-console-results")
        self.assertGreaterEqual(len(result["sources"]), 6)
        self.assertGreaterEqual(len(result["schemas"]), 6)
        self.assertGreaterEqual(len(result["observations"]), 90)
        self.assertGreaterEqual(len(result["workspace"]["fusedEvents"]), 3)
        self.assertTrue(result["exports"]["packageBase64"])

    def test_alignment_uses_event_time_and_records_job(self) -> None:
        state = run_fusion_console("load-sample", {})
        result = run_fusion_console("align-observations", {"state": state, "windowSeconds": 600, "actor": "数据工程师"})
        self.assertEqual(result["workspace"]["windowSeconds"], 600)
        self.assertEqual(result["workspace"]["alignmentJobs"][0]["mode"], "event-time")
        self.assertEqual(result["workspace"]["alignmentJobs"][0]["status"], "succeeded")

    def test_import_is_bounded_and_rejects_unknown_source(self) -> None:
        state = run_fusion_console("load-sample", {})
        content = "sourceId,eventTime,value,unit\nsrc-gnss,2026-09-10T09:20:00Z,38.2,mm\nunknown,2026-09-10T09:20:00Z,2,mm\n"
        result = run_fusion_console("import-observations", {"state": state, "fileName": "field.csv", "content": content})
        self.assertEqual(result["importSummary"]["accepted"], 1)
        self.assertEqual(result["importSummary"]["rejected"], 1)

    def test_fusion_result_keeps_evidence_and_human_review(self) -> None:
        state = run_fusion_console("load-sample", {})
        fused = run_fusion_console("run-fusion", {"state": state, "actor": "模型作者"})
        event = fused["workspace"]["fusedEvents"][-1]
        self.assertTrue(event["evidenceIds"])
        reviewed = run_fusion_console("review-fused-event", {"state": fused, "eventId": event["id"], "decision": "confirmed", "note": "证据一致", "actor": "业务审核"})
        self.assertEqual(reviewed["workspace"]["fusedEvents"][-1]["status"], "confirmed")
        self.assertEqual(reviewed["workspace"]["audit"][0]["action"], "review-fused-event")

    def test_model_publish_requires_two_distinct_approvers(self) -> None:
        state = run_fusion_console("load-sample", {})
        state["workspace"]["modelVersions"][0]["status"] = "draft"
        state["workspace"]["modelVersions"][0]["approvals"] = []
        first = run_fusion_console("publish-model-version", {"state": state, "versionId": "model-v3", "actor": "模型作者"})
        self.assertEqual(first["workspace"]["modelVersions"][0]["status"], "review")
        second = run_fusion_console("publish-model-version", {"state": first, "versionId": "model-v3", "actor": "业务审核"})
        self.assertEqual(second["workspace"]["modelVersions"][0]["status"], "published")

    def test_invalid_replay_window_is_rejected(self) -> None:
        state = run_fusion_console("load-sample", {})
        with self.assertRaises(ToolError):
            run_fusion_console("replay-window", {"state": state, "from": "2026-09-10T10:00:00Z", "to": "2026-09-10T09:00:00Z"})


if __name__ == "__main__":
    unittest.main()
