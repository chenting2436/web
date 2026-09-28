from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.common import ToolError
from app.tools.dispatcher import run_tool


class KnowledgeSystemFullTests(unittest.TestCase):
    def test_complete_baseline_has_documents_search_graph_quality_and_backup(self) -> None:
        result = run_tool("knowledge-system", "run-all", {})

        self.assertEqual(result["schema"], "skyview-knowledge-system-results")
        self.assertEqual(len(result["bundle"]["documents"]), 4)
        self.assertGreaterEqual(len(result["bundle"]["chunks"]), 4)
        self.assertGreater(len(result["search"]["results"]), 0)
        self.assertGreater(len(result["answer"]["citations"]), 0)
        self.assertGreater(len(result["graph"]["nodes"]), 0)
        self.assertEqual(result["quality"]["score"], 100)
        self.assertEqual(result["evaluation"]["hitAtK"], 1)
        self.assertEqual(result["evaluation"]["mrr"], 1)
        self.assertFalse(result["runtime"]["externalAi"])
        self.assertFalse(result["runtime"]["uploadedCodeExecution"])

        package = zipfile.ZipFile(io.BytesIO(base64.b64decode(result["exports"]["backupBase64"])))
        names = set(package.namelist())
        self.assertTrue({"knowledge-base.json", "checksums.json", "README.txt"}.issubset(names))
        self.assertTrue(any(name.startswith("files/doc-slope/") for name in names))

    def test_search_filters_by_document_and_answer_preserves_citation_location(self) -> None:
        baseline = run_tool("knowledge-system", "run-all", {})
        result = run_tool("knowledge-system", "ask", {
            "bundle": baseline["bundle"],
            "query": "有效频散点和层析反演周期",
            "documentId": "doc-imaging",
        })

        self.assertEqual(result["search"]["documentId"], "doc-imaging")
        self.assertTrue(result["search"]["results"])
        self.assertTrue(all(item["documentId"] == "doc-imaging" for item in result["search"]["results"]))
        self.assertTrue(result["answer"]["citations"][0]["chunkId"])
        self.assertTrue(result["answer"]["citations"][0]["sourceLocation"])
        self.assertEqual(len(result["bundle"]["conversations"]), 1)

    def test_text_ingest_deduplicates_by_sha_and_creates_chunks(self) -> None:
        baseline = run_tool("knowledge-system", "run-all", {})
        payload = {
            "bundle": baseline["bundle"],
            "name": "新的现场记录.md",
            "text": "# 现场复核\n新的排水沟巡查记录显示局部堵塞。位移变化仍需结合连续观测复核。",
            "metadata": {"tags": ["现场", "排水"]},
        }
        imported = run_tool("knowledge-system", "ingest-text", payload)
        self.assertEqual(len(imported["bundle"]["documents"]), 5)
        self.assertEqual(imported["bundle"]["documents"][0]["name"], "新的现场记录.md")
        self.assertTrue(any(item["documentId"] == imported["bundle"]["documents"][0]["id"] for item in imported["bundle"]["chunks"]))

        with self.assertRaises(ToolError):
            run_tool("knowledge-system", "ingest-text", {**payload, "bundle": imported["bundle"]})

    def test_backup_roundtrip_rebinds_ids_and_rejects_path_traversal(self) -> None:
        baseline = run_tool("knowledge-system", "run-all", {})
        restored = run_tool("knowledge-system", "import-backup", {"backupBase64": baseline["exports"]["backupBase64"]})
        self.assertNotEqual(restored["bundle"]["workspace"]["id"], baseline["bundle"]["workspace"]["id"])
        self.assertTrue(restored["bundle"]["workspace"]["name"].endswith("（导入）"))
        self.assertEqual(len(restored["bundle"]["documents"]), 4)

        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("../escape.txt", "blocked")
            archive.writestr("knowledge-base.json", json.dumps({"schema": "skyview-personal-knowledge-database", "documents": [], "chunks": []}))
            archive.writestr("checksums.json", json.dumps({"files": {}}))
        with self.assertRaises(ToolError):
            run_tool("knowledge-system", "import-backup", {"backupBase64": base64.b64encode(stream.getvalue()).decode("ascii")})


if __name__ == "__main__":
    unittest.main()
