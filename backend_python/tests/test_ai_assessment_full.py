from __future__ import annotations

import base64
import io
import json
import os
import unittest
import zipfile
from unittest.mock import patch

from app.tools.ai_assessment_full import run_ai_assessment


class AiAssessmentWorkbenchTests(unittest.TestCase):
    def test_complete_baseline_and_hidden_test_projection(self):
        result = run_ai_assessment("load-sample", {})
        self.assertEqual(result["schema"], "skyview-ai-assessment-results")
        self.assertEqual(len(result["catalog"]["problems"]), 15)
        self.assertEqual(result["stats"]["testCases"], 60)
        self.assertEqual(result["stats"]["hiddenCases"], 30)
        self.assertEqual(len(result["languages"]), 4)
        self.assertGreaterEqual(len(result["state"]["submissions"]), 8)
        hidden = next(
            case
            for problem in result["catalog"]["problems"]
            for case in problem["tests"]
            if not case["visible"]
        )
        self.assertNotIn("stdin", hidden)
        self.assertNotIn("expectedOutput", hidden)
        self.assertTrue(result["quality"]["valid"])

    def test_draft_review_and_unconfigured_submission_are_auditable(self):
        baseline = run_ai_assessment("load-sample", {})
        source = "def solve():\n    values = map(int, input().split())\n    print(sum(values))\n\nsolve()\n"
        saved = run_ai_assessment("save-draft", {
            "state": baseline["state"],
            "problemId": "stream-sum",
            "language": "python",
            "code": source,
        })
        self.assertEqual(saved["state"]["drafts"]["stream-sum:python"], source.strip())
        reviewed = run_ai_assessment("review-source", {
            "state": saved["state"], "language": "python", "code": source,
        })
        self.assertEqual(len(reviewed["review"]["sourceHash"]), 64)
        with patch.dict(os.environ, {"JUDGE0_API_URL": ""}, clear=False):
            submitted = run_ai_assessment("submit", {
                "state": reviewed["state"],
                "problemId": "stream-sum",
                "language": "python",
                "code": source,
            })
        self.assertEqual(submitted["submission"]["status"], "Awaiting Runtime")
        self.assertEqual(submitted["submission"]["origin"], "server-submission")
        self.assertEqual(len(submitted["submission"]["sourceHash"]), 64)
        self.assertEqual(len(submitted["submission"]["cases"]), 4)

    def test_custom_bank_validation_and_real_zip_delivery(self):
        baseline = run_ai_assessment("load-sample", {})
        custom = {
            "id": "custom-quality-gate",
            "title": "自定义质量门禁",
            "statement": "输入整数并原样输出。",
            "inputFormat": "一个整数。",
            "outputFormat": "同一个整数。",
            "tests": [
                {"name": "公开", "stdin": "1\n", "expectedOutput": "1\n", "visible": True, "weight": 40},
                {"name": "隐藏", "stdin": "-1\n", "expectedOutput": "-1\n", "visible": False, "weight": 60},
            ],
        }
        imported = run_ai_assessment("import-problems", {
            "state": baseline["state"], "problems": [custom],
        })
        self.assertEqual(imported["stats"]["problems"], 16)
        validated = run_ai_assessment("validate-bank", {"state": imported["state"]})
        self.assertTrue(validated["validation"]["valid"])
        delivery = run_ai_assessment("export", {"state": imported["state"]})
        data = base64.b64decode(delivery["export"]["base64"])
        self.assertEqual(len(delivery["export"]["sha256"]), 64)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {"catalog.json", "submissions.json", "workspace.json", "README.txt"},
            )
            catalog = json.loads(archive.read("catalog.json"))
            self.assertEqual(len(catalog), 16)


if __name__ == "__main__":
    unittest.main()
