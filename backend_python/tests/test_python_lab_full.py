from __future__ import annotations

import json
import unittest

from app.tools.common import ToolError
from app.tools.dispatcher import run_tool


class PythonLabFullTests(unittest.TestCase):
    def test_baseline_restores_complete_browser_ide_workspace(self) -> None:
        result = run_tool("python-lab", "run-all", {})

        self.assertEqual(result["schema"], "skyview-python-lab-results")
        self.assertEqual(len(result["workspace"]["files"]), 6)
        self.assertEqual(result["workspace"]["activePath"], "main.py")
        self.assertEqual(len(result["templates"]), 4)
        self.assertEqual(result["analysis"]["metrics"]["pythonFiles"], 2)
        self.assertTrue(result["analysis"]["valid"])
        self.assertEqual(result["runtime"]["browserRuntime"], "Pyodide 0.28.3")
        self.assertTrue(result["runtime"]["workerTerminationStopsExecution"])
        self.assertFalse(result["runtime"]["serverCodeExecutionEnabled"])
        self.assertFalse(result["runtime"]["serverArbitraryCodeExecution"])
        self.assertEqual(result["runtime"]["editor"], "Monaco Editor 0.56.0")
        self.assertEqual(result["runtime"]["terminal"], "xterm.js 5.5.0")
        self.assertEqual(len(result["workspace"]["notebooks"][0]["cells"]), 3)
        self.assertIn('"nbformat": 4', result["exports"]["notebookIpynb"])

    def test_file_folder_revision_and_template_actions_round_trip(self) -> None:
        baseline = run_tool("python-lab", "run-all", {})
        state = {"workspace": baseline["workspace"]}
        folder = run_tool("python-lab", "create-folder", {"state": state, "path": "tests/unit"})
        created = run_tool("python-lab", "create-file", {"state": {"workspace": folder["workspace"]}, "path": "tests/unit/test_math.py", "content": "assert 2 + 2 == 4\n"})
        renamed = run_tool("python-lab", "rename-path", {"state": {"workspace": created["workspace"]}, "oldPath": "tests/unit", "newPath": "tests/core"})
        saved = run_tool("python-lab", "save-file", {"state": {"workspace": renamed["workspace"]}, "path": "tests/core/test_math.py", "content": "def test_sum():\n    assert sum([2, 2]) == 4\n"})
        templated = run_tool("python-lab", "apply-template", {"state": {"workspace": saved["workspace"]}, "templateId": "visual"})
        deleted = run_tool("python-lab", "delete-path", {"state": {"workspace": templated["workspace"]}, "path": "tests/core"})

        self.assertIn("tests/core/test_math.py", saved["workspace"]["files"])
        self.assertGreaterEqual(saved["workspace"]["fileRevisions"]["tests/core/test_math.py"]["revision"], 2)
        self.assertIn("bar =", templated["workspace"]["files"][templated["workspace"]["activePath"]])
        self.assertNotIn("tests/core/test_math.py", deleted["workspace"]["files"])

    def test_run_configuration_browser_evidence_and_snapshot_restore(self) -> None:
        baseline = run_tool("python-lab", "run-all", {})
        configured = run_tool("python-lab", "update-run-config", {
            "state": {"workspace": baseline["workspace"]},
            "entryPath": "main.py",
            "stdin": "sample\n",
            "argv": ["--mode", "test"],
            "env": {"COURSE": "AdvancedPython"},
        })
        packaged = run_tool("python-lab", "install-package", {"state": {"workspace": configured["workspace"]}, "package": "numpy==2.2.0"})
        recorded = run_tool("python-lab", "record-run", {
            "state": {"workspace": packaged["workspace"]},
            "entryPath": "main.py",
            "command": "python main.py --mode test",
            "status": "succeeded",
            "exitCode": 0,
            "durationMs": 42.5,
            "stdout": "ok\n",
            "stderr": "",
            "runtime": "Pyodide 0.28.3",
        })
        snapshotted = run_tool("python-lab", "create-snapshot", {"state": {"workspace": recorded["workspace"]}, "label": "验收快照"})
        changed = run_tool("python-lab", "save-file", {"state": {"workspace": snapshotted["workspace"]}, "path": "main.py", "content": "print('changed')\n"})
        restored = run_tool("python-lab", "restore-snapshot", {"state": {"workspace": changed["workspace"]}, "snapshotId": snapshotted["createdSnapshot"]["id"]})

        self.assertIn("numpy==2.2.0", recorded["workspace"]["installedPackages"])
        self.assertEqual(recorded["recordedRun"]["evidenceSource"], "browser-local")
        self.assertFalse(recorded["recordedRun"]["verified"])
        self.assertNotEqual(restored["workspace"]["files"]["main.py"], "print('changed')\n")

    def test_legacy_import_is_bounded_and_never_executes_content(self) -> None:
        legacy = {
            "files": {"main.py": "print('import only')\n", "data/value.txt": "7\n"},
            "folders": ["data"],
            "openFiles": ["main.py"],
            "activePath": "main.py",
            "expandedFolders": ["data"],
            "runs": [{"status": "forged"}],
        }
        imported = run_tool("python-lab", "import-workspace", {"content": json.dumps(legacy), "title": "迁移实验"})

        self.assertEqual(imported["workspace"]["title"], "迁移实验")
        self.assertEqual(imported["importSummary"]["files"], 2)
        self.assertFalse(imported["importSummary"]["executionStarted"])
        self.assertFalse(imported["importSummary"]["runHistoryImported"])
        self.assertFalse(imported["workspace"]["runs"])
        self.assertIn('"schema": "skyview-python-lab-workspace"', imported["exports"]["workspaceJson"])

        unsafe_requirement = {"files": {"main.py": "print(1)", "requirements.txt": "https://example.com/a.whl"}}
        with self.assertRaises(ToolError):
            run_tool("python-lab", "import-workspace", {"content": json.dumps(unsafe_requirement)})

    def test_notebook_cells_outputs_checks_and_runs_are_persisted(self) -> None:
        baseline = run_tool("python-lab", "run-all", {})
        notebook = baseline["workspace"]["notebooks"][0]
        notebook["cells"][1]["source"] = "records = [{'site': 'A'}, {'site': 'B'}, {'site': 'C'}]\nrecords"
        saved = run_tool("python-lab", "save-notebook", {
            "state": {"workspace": baseline["workspace"]},
            "notebook": notebook,
        })
        recorded = run_tool("python-lab", "record-cell-run", {
            "state": {"workspace": saved["workspace"]},
            "notebookId": notebook["id"],
            "cellId": "cell-analyse",
            "status": "succeeded",
            "exitCode": 0,
            "durationMs": 18.4,
            "executionCount": 2,
            "stdout": "平均风险: 0.62\n高风险站点: ['B']\n",
            "stderr": "",
            "outputs": [
                {"kind": "text", "text": "平均风险: 0.62\n"},
                {"kind": "table", "columns": ["site", "risk"], "rows": [["B", 0.81]]},
            ],
            "variables": [
                {"name": "records", "type": "list", "value": "[{'site': 'A'}, {'site': 'B'}, {'site': 'C'}]"},
                {"name": "average", "type": "float", "value": "0.62"},
                {"name": "high_risk", "type": "list", "value": "['B']"},
            ],
        })

        cell = next(item for item in recorded["workspace"]["notebooks"][0]["cells"] if item["id"] == "cell-analyse")
        self.assertEqual(cell["executionCount"], 2)
        self.assertEqual(cell["outputs"][1]["kind"], "table")
        self.assertTrue(all(item["passed"] for item in recorded["workspace"]["course"]["checks"]))
        self.assertTrue(recorded["recordedRun"]["entryPath"].startswith("notebook:"))
        self.assertIn("application/vnd.skyview.table+json", recorded["exports"]["notebookIpynb"])


if __name__ == "__main__":
    unittest.main()
