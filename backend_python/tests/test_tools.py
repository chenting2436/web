import json
import unittest
from dataclasses import replace
from unittest.mock import patch

from app.config import settings
from app.tools.dispatcher import catalog, run_tool


class ToolDispatcherTests(unittest.TestCase):
    def test_catalog_covers_all_react_workbenches(self):
        self.assertEqual(len(catalog()), 26)

    def test_research_tools(self):
        paper = run_tool(
            "paper-writing",
            "audit",
            {"manuscript": "# 研究\n## 方法\n方法 [1]\n## 结果\n结果\n## 讨论\n讨论局限\n## 结论\n结论"},
        )
        self.assertTrue(paper["passed"])

        remote = run_tool(
            "disaster-remote-sensing",
            "change-detection",
            {"before": "1,1,1,1", "after": "1,1,5,1", "threshold": 2},
        )
        self.assertEqual(remote["changedPixels"], 1)

        seismic = run_tool(
            "seismic-physics",
            "source-distance",
            {"pTime": 2, "sTime": 5, "vp": 6, "vs": 3.5},
        )
        self.assertGreater(seismic["hypocentralKm"], 0)

        patent = run_tool(
            "patent-transfer",
            "claim-lint",
            {"claims": "一种监测方法，其特征在于，包括传感器融合", "features": "传感器融合"},
        )
        self.assertTrue(patent["passed"])

        skill = run_tool(
            "skill-evolution",
            "validate",
            {"specification": "---\nname: data-check\ndescription: Check data\n---\n# Steps\nValidate the input and return a report."},
        )
        self.assertTrue(skill["valid"])

        workflow = run_tool(
            "research-automation",
            "run",
            {"nodes": [{"id": "a"}, {"id": "b", "dependsOn": ["a"]}]},
        )
        self.assertEqual(workflow["status"], "success")

        knowledge = run_tool(
            "knowledge-system",
            "query",
            {"material": "地震监测使用波形。\n\n遥感用于变化检测。", "query": "遥感变化"},
        )
        self.assertGreater(knowledge["evidenceCount"], 0)

        mine = run_tool(
            "mine-safety-radar",
            "classify",
            {"text": "矿山边坡滑坡与微震监测"},
        )
        self.assertNotEqual(mine["primary"], "未分类")

        disclosure = run_tool(
            "patent-disclosure",
            "generate",
            {"concept": "多源监测预警装置", "problem": "单一传感器误报", "mechanism": "融合多个传感器并交叉核验"},
        )
        self.assertEqual(len(disclosure["chapters"]), 10)

    def test_engineering_tools(self):
        gateway = run_tool(
            "data-gateway",
            "process",
            {"csv": "id,value\n1,10\n2,", "requiredFields": ["id", "value"]},
        )
        self.assertEqual(gateway["published"], 1)

        noise = run_tool(
            "ambient-noise-imaging",
            "correlate",
            {"left": "0 1 0 -1 0 1 0 -1", "right": "0 1 0 -1 0 1 0 -1", "maxLag": 2},
        )
        self.assertEqual(noise["peakLag"], 0)

        warning = run_tool(
            "warning-platform",
            "evaluate",
            {"values": "10 50 90", "warning": 60, "critical": 80},
        )
        self.assertEqual(warning["status"], "critical")

        uav = run_tool(
            "uav-inspection",
            "prioritize",
            {"anomalies": [{"id": "a", "severity": 5, "confidence": 0.9, "exposure": 3}]},
        )
        self.assertEqual(uav["total"], 1)

        fusion = run_tool(
            "fusion-console",
            "align",
            {"observations": [{"source": "a", "timestamp": "2026-01-01T00:00:01Z", "value": 1}, {"source": "b", "timestamp": "2026-01-01T00:00:20Z", "value": 3}]},
        )
        self.assertEqual(fusion["groups"][0]["average"], 2)

        emergency = run_tool(
            "emergency-console",
            "plan",
            {"incident": "边坡异常", "severity": "high", "tasks": ["现场复核"]},
        )
        self.assertEqual(emergency["tasks"][0]["title"], "现场复核")

    def test_teaching_tools(self):
        unsafe_settings = replace(
            settings,
            app_environment="development",
            allow_unsafe_local_code_execution=True,
        )
        with patch("app.tools.teaching.settings", unsafe_settings):
            executed = run_tool("python-lab", "run", {"code": "print(sum([1, 2, 3]))"})
        self.assertEqual(executed["stdout"].strip(), "6")
        self.assertTrue(executed["prototype"])
        self.assertFalse(executed["productionSandbox"])

        grade = run_tool("daily-practice", "grade", {"expected": "A\nB", "answers": "A\nC"})
        self.assertEqual(grade["percent"], 50)

        project = run_tool("project-workspace", "summary", {"tasks": [{"title": "A", "status": "done"}]})
        self.assertEqual(project["progress"], 100)

        cleaned = run_tool(
            "data-lab",
            "clean",
            {"csv": "id,name\n1, Alice \n1, Alice ", "operations": ["trim", "deduplicate"]},
        )
        self.assertEqual(cleaned["outputRows"], 1)

        report = run_tool("ai-report", "draft", {"title": "测试", "material": "材料一。\n\n材料二。"})
        self.assertIn("局限", report["report"])

        english = run_tool(
            "python-english",
            "grade",
            {"questions": [{"term": "loop", "answer": "循环"}], "answers": ["循环"]},
        )
        self.assertEqual(english["percent"], 100)

        review = run_tool("ai-assessment", "review", {"language": "Python", "code": "def add(a, b):\n    return a + b\n\nprint(add(1, 2))"})
        self.assertIn("findings", review)

        manifest = run_tool(
            "project-submission",
            "manifest",
            {"files": [{"path": "README.md", "content": "hello"}]},
        )
        self.assertTrue(manifest["valid"])

    def test_professional_workflows(self):
        draft = run_tool("paper-writing", "generate-draft", {
            "title": "监测研究", "question": "融合是否有效？", "design": "对比实验",
            "sources": "doi:10.1/example", "findings": "误报率降低",
        })
        self.assertIn("数据与方法", draft["manuscript"])
        references = run_tool("paper-writing", "bibtex-import", {
            "bibtex": "@article{Li2026, title={Test}, author={Li}, year={2026}, doi={10.1/test}}",
        })
        self.assertEqual(references["imported"], 1)

        raster = run_tool("disaster-remote-sensing", "zone-assessment", {
            "before": [0] * 16, "after": [0, 1] * 8, "width": 4, "threshold": 0.5,
        })
        self.assertEqual(len(raster["zones"]), 16)
        spectrum = run_tool("seismic-physics", "spectrum", {
            "values": "0 1 0 -1 0 1 0 -1", "sampleRate": 8,
        })
        self.assertGreater(spectrum["peakFrequency"], 0)

        trl = run_tool("patent-transfer", "trl-assess", {
            "evidence": [{"name": "原理", "passed": True}, {"name": "现场", "passed": False}],
        })
        self.assertEqual(trl["trl"], 2)
        transfer = run_tool("patent-transfer", "run-all", {})
        self.assertEqual(transfer["schema"], "skyview-patent-transfer-results")
        self.assertEqual(len(transfer["patents"]), 6)
        self.assertEqual(len(transfer["features"]), 4)
        self.assertEqual(len(transfer["claims"]), 4)
        self.assertEqual(transfer["trl"]["backed"], 3)
        self.assertTrue(transfer["exports"]["packageBase64"])
        self.assertFalse(transfer["runtime"]["officialLegalStatusConfigured"])
        contract = run_tool("skill-evolution", "contract-validate", {
            "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]},
            "outputSchema": {"type": "object", "properties": {"y": {"type": "number"}}},
        })
        self.assertTrue(contract["valid"])

        concepts = run_tool("knowledge-system", "concept-map", {
            "material": "微震监测识别破裂。微震数据与位移数据融合。",
        })
        self.assertGreater(len(concepts["nodes"]), 0)
        readiness = run_tool("mine-safety-radar", "readiness", {
            "text": "现场使用微震传感器，与 baseline 比较，公开 dataset 和不确定性。",
        })
        self.assertGreaterEqual(readiness["score"], 80)

        flow = run_tool("data-gateway", "validate-flow", {
            "nodes": [{"id": "a"}, {"id": "b"}],
            "connections": [{"source": "a", "target": "b"}],
        })
        self.assertTrue(flow["valid"])
        preprocessed = run_tool("ambient-noise-imaging", "preprocess", {
            "values": "0 1 0 -1 0 1 0 -1",
        })
        self.assertEqual(len(preprocessed["values"]), 8)

        profile = run_tool("data-lab", "profile", {"csv": "name,value\nA,1\nA,1\nB,2"})
        self.assertEqual(profile["duplicates"], 1)
        index = run_tool("ai-report", "source-index", {
            "material": "材料一。\n\n材料二。", "report": "结论 [S1.1]",
        })
        self.assertTrue(index["sources"][0]["valid"])
        mastery = run_tool("python-english", "mastery", {
            "progress": [{"word": "loop", "attempts": 5, "correct": 5}],
        })
        self.assertEqual(mastery["mastered"], 1)
        unsafe_settings = replace(
            settings,
            app_environment="development",
            allow_unsafe_local_code_execution=True,
        )
        with patch("app.tools.teaching.settings", unsafe_settings):
            judged = run_tool("ai-assessment", "judge", {
                "code": "print(sum(int(v) for v in input().split()))",
                "tests": [{"stdin": "1 2 3", "expected": "6"}],
            })
        self.assertEqual(judged["verdict"], "Accepted")
        self.assertTrue(judged["prototype"])
        self.assertFalse(judged["productionSandbox"])
        package = run_tool("project-submission", "package", {
            "files": [{"path": "README.md", "content": "hello"}],
        })
        self.assertTrue(package["packageCreated"])


if __name__ == "__main__":
    unittest.main()
