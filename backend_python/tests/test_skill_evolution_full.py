from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.common import ToolError
from app.tools.dispatcher import run_tool


class SkillEvolutionFullTests(unittest.TestCase):
    def test_complete_baseline_runs_and_exports_a_verifiable_package(self):
        result = run_tool("skill-evolution", "run-all", {})

        self.assertEqual(result["schema"], "skyview-skill-evolution-results")
        self.assertEqual(result["version"], 2)
        self.assertEqual(len(result["skill"]["steps"]), 6)
        self.assertEqual(len(result["skill"]["tests"]), 4)
        self.assertEqual(result["evaluation"]["passed"], 4)
        self.assertEqual(result["evaluation"]["passRate"], 1)
        self.assertEqual(result["evaluation"]["assertionRate"], 1)
        self.assertEqual(result["evaluation"]["stepCoverage"], 1)
        self.assertGreater(result["evaluation"]["uplift"], 0)
        self.assertTrue(result["security"]["pass"])
        self.assertTrue(result["releaseGate"]["pass"])
        self.assertFalse(result["runtime"]["arbitraryCodeExecution"])
        self.assertFalse(result["runtime"]["networkAccess"])

        package = zipfile.ZipFile(io.BytesIO(base64.b64decode(result["exports"]["packageBase64"])))
        names = set(package.namelist())
        self.assertTrue({"SKILL.md", "manifest.json", "checksums.json", "BENCHMARK.md", "skill-card.md", "eval/evals.json"}.issubset(names))
        checksums = json.loads(package.read("checksums.json"))
        self.assertEqual(checksums["algorithm"], "SHA-256")
        self.assertIn("SKILL.md", checksums["files"])

    def test_publish_creates_semantic_release_snapshot(self):
        baseline = run_tool("skill-evolution", "run-all", {})
        published = run_tool("skill-evolution", "publish", {"skill": baseline["skill"], "level": "patch", "channel": "canary"})

        self.assertEqual(published["skill"]["version"], "1.0.1")
        self.assertEqual(published["skill"]["status"], "candidate")
        self.assertEqual(len(published["skill"]["releases"]), 1)
        self.assertEqual(published["skill"]["releases"][0]["version"], "1.0.1")

    def test_package_import_rejects_path_traversal(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("SKILL.md", "---\nname: safe-skill\ndescription: safe\n---\n# Safe")
            archive.writestr("../escape.txt", "blocked")

        with self.assertRaises(ToolError):
            run_tool("skill-evolution", "import-package", {"fileName": "unsafe.zip", "packageBase64": base64.b64encode(stream.getvalue()).decode("ascii")})

    def test_json_dataset_import_is_evaluated(self):
        baseline = run_tool("skill-evolution", "run-all", {})
        dataset = json.dumps(
            {
                "tests": [
                    {
                        "id": "extra",
                        "name": "额外用例",
                        "input": {"title": "额外材料", "content": "第一条证据。第二条证据。"},
                        "tags": ["edge"],
                        "assertions": [
                            {"id": "extra-a", "type": "equals", "path": "reviewRequired", "value": True}
                        ],
                    }
                ]
            },
            ensure_ascii=False,
        )
        imported = run_tool("skill-evolution", "import-dataset", {"skill": baseline["skill"], "dataset": dataset, "fileName": "evals.json"})

        self.assertEqual(len(imported["skill"]["tests"]), 5)
        self.assertEqual(imported["evaluation"]["passed"], 5)


if __name__ == "__main__":
    unittest.main()
