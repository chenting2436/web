from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.ai_report_full import run_ai_report
from app.tools.common import ToolError


class AiReportFullTests(unittest.TestCase):
    def test_sample_is_complete_and_directly_usable(self) -> None:
        result = run_ai_report("load-sample", {})
        self.assertEqual(result["schema"], "skyview-ai-report-results")
        self.assertEqual(len(result["analysis"]["reportTypes"]), 8)
        self.assertEqual(result["analysis"]["metrics"]["materials"], 4)
        self.assertEqual(result["analysis"]["metrics"]["coverage"], 100)
        self.assertTrue(all(item["passed"] for item in result["analysis"]["qualityChecks"]))
        self.assertTrue(result["project"]["report"]["content"])
        self.assertTrue(result["exports"]["packageBase64"])

    def test_material_import_preserves_checksum_and_stable_chunks(self) -> None:
        state = run_ai_report("load-sample", {})
        output = run_ai_report("import-text", {
            "state": state,
            "actorRole": "editor",
            "fileName": "现场复核.md",
            "content": "# 现场复核\n坡脚排水沟畅通。监测点 P12 位移速率为 1.4 mm/d。",
        })
        material = output["project"]["materials"][-1]
        self.assertEqual(material["status"], "ready")
        self.assertEqual(len(material["checksum"]), 64)
        self.assertTrue(material["chunks"][0]["id"].startswith(f"{material['id']}-chunk-"))
        self.assertEqual(material["chunks"][0]["label"], "S5.1")

    def test_scanned_pdf_is_not_falsely_presented_as_extracted(self) -> None:
        state = run_ai_report("load-sample", {})
        content = base64.b64encode(b"%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n%%EOF").decode("ascii")
        output = run_ai_report("import-material", {
            "state": state,
            "actorRole": "owner",
            "fileName": "scan.pdf",
            "contentBase64": content,
        })
        material = output["project"]["materials"][-1]
        self.assertEqual(material["status"], "ocr-required")
        self.assertFalse(material["selected"])
        self.assertEqual(output["runtime"]["ocrLayoutParser"]["status"], "not-configured")

    def test_audit_detects_unresolved_citations_and_numeric_claims(self) -> None:
        state = run_ai_report("load-sample", {})
        edited = run_ai_report("update-report", {
            "state": state,
            "actorRole": "editor",
            "content": state["project"]["report"]["content"] + "\n\n新增结论为 99.9%，但尚未给出依据。\n另一个引用编号无法解析 [S99.9]。",
        })
        audited = run_ai_report("audit-report", {"state": edited, "actorRole": "editor"})
        stats = audited["analysis"]["audit"]["stats"]
        self.assertGreater(stats["invalidCitations"], 0)
        self.assertGreater(stats["uncitedNumericLines"], 0)

    def test_extractive_chat_and_generation_are_recorded(self) -> None:
        state = run_ai_report("load-sample", {})
        answer = run_ai_report("ask-extractive", {
            "state": state,
            "actorRole": "editor",
            "question": "监测频率和预警阈值是什么？",
        })
        self.assertEqual(len(answer["project"]["chats"]), len(state["project"]["chats"]) + 2)
        self.assertTrue(answer["project"]["chats"][-1]["evidenceChunkIds"])
        regenerated = run_ai_report("run-all", {"state": answer, "actorRole": "owner"})
        self.assertEqual(regenerated["stage"], "run-all")
        self.assertGreater(len(regenerated["project"]["versions"]), len(answer["project"]["versions"]))

    def test_local_records_enforce_models_and_evidence(self) -> None:
        state = run_ai_report("load-sample", {})
        prompt = state["analysis"]["localPrompt"]
        recorded = run_ai_report("record-local-generation", {
            "state": state,
            "actorRole": "owner",
            "model": state["analysis"]["localModels"][0]["id"],
            "content": state["project"]["report"]["content"],
            "evidenceChunkIds": prompt["evidenceChunkIds"],
            "promptChecksum": prompt["promptChecksum"],
            "evidenceChecksum": prompt["evidenceChecksum"],
        })
        self.assertEqual(recorded["project"]["report"]["mode"], "local-webllm")
        with self.assertRaises(ToolError):
            run_ai_report("record-local-chat", {
                "state": state,
                "actorRole": "owner",
                "model": state["analysis"]["localModels"][0]["id"],
                "question": "问题",
                "answer": "回答",
                "evidenceChunkIds": ["forged-chunk"],
            })

    def test_restore_creates_a_new_immutable_version(self) -> None:
        state = run_ai_report("load-sample", {})
        saved = run_ai_report("create-version", {"state": state, "actorRole": "owner", "label": "评审稿"})
        original_count = len(saved["project"]["versions"])
        restored = run_ai_report("restore-version", {
            "state": saved,
            "actorRole": "owner",
            "versionId": saved["project"]["versions"][0]["id"],
        })
        self.assertEqual(len(restored["project"]["versions"]), original_count + 2)
        self.assertEqual(restored["project"]["versions"][-1]["kind"], "restore")

    def test_delivery_package_contains_real_docx_and_traceability_files(self) -> None:
        state = run_ai_report("load-sample", {})
        document = base64.b64decode(state["exports"]["docxBase64"])
        with zipfile.ZipFile(io.BytesIO(document)) as archive:
            self.assertIn("word/document.xml", archive.namelist())
        package = base64.b64decode(state["exports"]["packageBase64"])
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            names = set(archive.namelist())
            self.assertTrue({"README.md", "manifest.json", "project.json", "report/report.md", "report/report.docx", "evidence/source-index.json", "audit/latest-audit.json", "versions/versions.json"}.issubset(names))
            project = json.loads(archive.read("project.json"))
            self.assertEqual(project["schema"], "skyview-ai-report-project")
        roundtrip = run_ai_report("import-project", {
            "state": state,
            "actorRole": "owner",
            "project": state["exports"]["projectJson"],
        })
        self.assertEqual(roundtrip["project"]["schema"], "skyview-ai-report-project")
        self.assertTrue(roundtrip["project"]["title"].endswith("（导入副本）"))

    def test_viewer_cannot_mutate_project(self) -> None:
        state = run_ai_report("load-sample", {})
        with self.assertRaises(ToolError):
            run_ai_report("update-report", {"state": state, "actorRole": "viewer", "content": "不可写"})


if __name__ == "__main__":
    unittest.main()
