from __future__ import annotations

import base64
import io
import unittest
import zipfile

from app.tools import patent_disclosure_full as patent


CONCEPT = "现有露天矿边坡监测依赖人工分别判断位移和微震数据，存在时间基准不一致、证据难以追溯的问题。本方案设置位移传感器、微震采集单元、时间同步模块和风险分析模块，先统一时间轴，再融合特征并输出分级预警，同时保存输入、参数和结果。与传统方案相比，其创新点是面向证据链的多源同步与分级研判。预期缩短人工研判时间，但具体指标仍需现场试验验证。"


class PatentDisclosureParityTests(unittest.TestCase):
    def test_ten_chapter_structure_and_analysis_match_card_version(self) -> None:
        self.assertEqual([item["name"] for item in patent.CHAPTERS], [
            "发明名称", "技术领域", "背景技术", "发明目的", "技术方案",
            "有益效果", "附图说明", "具体实施方式", "替代方案", "关键点与保护点",
        ])
        self.assertEqual(sum(item["mandatory"] for item in patent.CHAPTERS), 9)
        analysis = patent.analyze_concept(CONCEPT)
        self.assertGreaterEqual(len(analysis["keyComponents"]), 3)
        self.assertEqual(analysis["mode"], "local-structured")

    def test_full_generation_preserves_figures_quality_and_boundaries(self) -> None:
        project = patent.create_project("发明专利", CONCEPT)
        output = patent.generate_all(project)
        generated = output["project"]
        self.assertEqual(len(generated["chapters"]), 10)
        self.assertTrue(all(len(item["content"]) >= 4 for item in generated["chapters"]))
        self.assertIn("不虚构", next(item for item in generated["chapters"] if item["key"] == "background_art")["content"])
        self.assertIn("验证", next(item for item in generated["chapters"] if item["key"] == "beneficial_effects")["content"])
        self.assertGreaterEqual(len(generated["figures"]), 4)
        self.assertEqual(output["quality"]["completed"], 10)

    def test_exports_include_markdown_project_json_and_valid_docx(self) -> None:
        project = patent.generate_all(patent.create_project("实用新型", CONCEPT, "一种监测装置"))["project"]
        output = patent.run_patent_disclosure("export", {"project": project})
        self.assertIn("## 5. 技术方案", output["markdown"])
        self.assertIn("## 10. 关键点与保护点", output["markdown"])
        self.assertIn("提交前必须核验", output["markdown"])
        self.assertIn('"schema": "skyview-patent-assistant"', output["projectJson"])
        document = base64.b64decode(output["docxBase64"])
        with zipfile.ZipFile(io.BytesIO(document)) as archive:
            self.assertIn("word/document.xml", archive.namelist())
            self.assertIn("一种监测装置", archive.read("word/document.xml").decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
