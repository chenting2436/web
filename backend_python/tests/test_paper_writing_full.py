from __future__ import annotations

import base64
import io
import unittest
import zipfile

from app.tools import paper_writing_full as paper


def configured_project():
    project = paper.create_project("多源监测数据融合研究")
    project["framing"].update({
        "question": "时间对齐如何影响预警结果？",
        "gap": "现有研究缺少可追溯的对齐记录。",
        "contribution": "建立证据链驱动的分析流程。",
        "problem": "多源记录难以复核。",
        "scope": "边坡监测项目",
    })
    project["methodology"].update({
        "design": "回顾性观测研究与消融对比",
        "dataSources": "GNSS、降雨和微震记录 v1",
        "analysis": "按时间窗口比较验证指标",
        "preprocessing": "统一时区与采样间隔",
        "validation": "时间切分验证",
        "limitations": "样本范围限制外推",
        "ethics": "授权数据，已脱敏",
    })
    return project


class PaperWritingParityTests(unittest.TestCase):
    def test_project_has_exact_ten_stage_state_machine_and_empirical_sections(self) -> None:
        project = paper.create_project()
        self.assertEqual([item["id"] for item in paper.STAGES], [
            "research", "write", "integrity_pre", "review", "revise",
            "re_review", "re_revise", "integrity_final", "finalize", "process",
        ])
        self.assertEqual(project["currentStage"], "research")
        self.assertEqual(project["stageRecords"][0]["status"], "in_progress")
        self.assertTrue(all(item["status"] == "pending" for item in project["stageRecords"][1:]))
        self.assertEqual([item["id"] for item in project["sections"]], [
            "abstract", "introduction", "literature", "materials", "methods",
            "results", "discussion", "conclusion", "declarations",
        ])

    def test_bibtex_normalizes_doi_and_deduplicates_by_doi_or_title(self) -> None:
        source = """@article{Li2026, title={A Test Paper}, author={Li, J.}, year={2026}, doi={https://doi.org/10.1000/Test.01}}
@article{Li2026b, title={Another title}, author={Li, J.}, year={2026}, doi={doi:10.1000/test.01}}"""
        records = paper.parse_bibtex(source)
        kept, duplicates = paper.dedupe_references(records)
        self.assertEqual(kept[0]["doi"], "10.1000/test.01")
        self.assertEqual(kept[0]["verification"], "unverified")
        self.assertEqual((len(kept), len(duplicates)), (1, 1))

    def test_draft_uses_registered_material_and_keeps_author_verification_markers(self) -> None:
        generated = paper.generate_draft(configured_project())
        self.assertTrue(all(item["content"] for item in generated["sections"]))
        manuscript = paper.manuscript_markdown(generated)
        self.assertIn("时间对齐如何影响预警结果", manuscript)
        self.assertIn("待作者", manuscript)

    def test_integrity_exposes_seven_failure_modes_and_blocks_blank_project(self) -> None:
        report = paper.audit_integrity(paper.create_project(), "pre")
        self.assertFalse(report["pass"])
        self.assertTrue(any(item["severity"] == "critical" for item in report["issues"]))
        self.assertEqual(len(report["failureModes"]), 7)
        self.assertTrue(all(item["status"] in {"clear", "suspected"} for item in report["failureModes"]))

    def test_review_has_five_roles_decision_and_revision_roadmap(self) -> None:
        project = paper.generate_draft(configured_project())
        review = paper.reviewer_panel(project)
        self.assertEqual(len(review["reports"]), 5)
        self.assertIn(review["decision"], {"accept", "minor", "major", "reject"})
        self.assertTrue(all(item["role"] and item["findings"] for item in review["reports"]))
        self.assertGreater(len(review["roadmap"]), 0)

    def test_stage_requires_submission_and_author_confirmation_before_advance(self) -> None:
        project = configured_project()
        prepared = paper.run_paper_writing("prepare-stage", {"project": project, "stageId": "research"})["project"]
        self.assertEqual(prepared["currentStage"], "research")
        self.assertEqual(prepared["stageRecords"][0]["status"], "awaiting_confirmation")
        confirmed = paper.run_paper_writing("confirm-stage", {"project": prepared, "stageId": "research", "note": "作者已核对研究设计。"})["project"]
        self.assertEqual(confirmed["currentStage"], "write")
        self.assertEqual(confirmed["stageRecords"][0]["status"], "completed")
        self.assertIn("作者已核对", confirmed["decisions"][0]["note"])

    def test_docx_and_submission_zip_are_real_archives_with_complete_file_set(self) -> None:
        project = paper.generate_draft(configured_project())
        output = paper.run_paper_writing("export", {"project": project})
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(output["docxBase64"]))) as archive:
            self.assertIn("word/document.xml", archive.namelist())
            self.assertIn("多源监测数据融合研究", archive.read("word/document.xml").decode("utf-8"))
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(output["packageBase64"]))) as archive:
            self.assertEqual(set(archive.namelist()), {
                "manuscript.md", "manuscript.html", "manuscript.tex", "references.bib",
                "material-passport.json", "process-record.md", "project-record.json", "README.txt",
            })
        self.assertIn("论文创建过程记录", output["processMarkdown"])
        self.assertIn("skyview-material-passport", output["passportJson"])


if __name__ == "__main__":
    unittest.main()
