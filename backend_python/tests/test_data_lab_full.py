from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.common import ToolError
from app.tools.data_lab_full import run_data_lab


class DataLabFullTests(unittest.TestCase):
    def test_sample_is_a_complete_directly_usable_project(self) -> None:
        result = run_data_lab("load-sample", {})
        self.assertEqual(result["schema"], "skyview-data-refine-results")
        self.assertEqual(result["analysis"]["profile"]["rows"], 36)
        self.assertEqual(result["analysis"]["profile"]["columnCount"], 10)
        self.assertGreaterEqual(len(result["project"]["operations"]), 3)
        self.assertEqual(len(result["analysis"]["view"]["rows"]), 15)
        self.assertEqual(len(result["analysis"]["selectedProfile"]["histogram"]), 12)
        self.assertEqual(result["analysis"]["aggregation"]["groupBy"], "区域")
        self.assertTrue(result["exports"]["packageBase64"])

    def test_operations_are_replayed_with_undo_and_redo(self) -> None:
        state = run_data_lab("load-sample", {})
        applied = run_data_lab("apply-operation", {
            "state": state, "actorRole": "editor",
            "operation": {"type": "deduplicate", "columns": ["记录编号"], "label": "按编号去重"},
        })
        self.assertEqual(applied["analysis"]["profile"]["rows"], 35)
        undone = run_data_lab("undo", {"state": applied, "actorRole": "editor"})
        self.assertEqual(undone["analysis"]["profile"]["rows"], 36)
        redone = run_data_lab("redo", {"state": undone, "actorRole": "editor"})
        self.assertEqual(redone["analysis"]["profile"]["rows"], 35)

    def test_facets_sorting_and_paging_apply_to_the_current_view(self) -> None:
        state = run_data_lab("load-sample", {})
        faceted = run_data_lab("set-facet", {"state": state, "facet": {"type": "text", "column": "区域", "selected": ["北区"]}})
        self.assertEqual(faceted["analysis"]["view"]["total"], 9)
        sorted_result = run_data_lab("set-sort", {"state": faceted, "column": "累计降雨(mm)", "direction": "desc"})
        values = [row["累计降雨(mm)"] for row in sorted_result["analysis"]["view"]["rows"] if row["累计降雨(mm)"] is not None]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_imports_json_xml_and_real_xlsx(self) -> None:
        state = run_data_lab("load-sample", {})
        imported = run_data_lab("import-data", {"state": state, "actorRole": "owner", "fileName": "nested.json", "content": '[{"id":1,"place":{"city":"徐州"}}]'})
        self.assertEqual(imported["project"]["dataset"]["fields"], ["id", "place.city"])
        xml = run_data_lab("import-data", {"state": state, "actorRole": "owner", "fileName": "rows.xml", "content": "<rows><row><id>1</id><name>A</name></row><row><id>2</id><name>B</name></row></rows>"})
        self.assertEqual(xml["analysis"]["profile"]["rows"], 2)
        xlsx = base64.b64decode(state["exports"]["xlsxBase64"])
        roundtrip = run_data_lab("import-data", {"state": state, "actorRole": "owner", "fileName": "roundtrip.xlsx", "contentBase64": base64.b64encode(xlsx).decode("ascii")})
        self.assertEqual(roundtrip["analysis"]["profile"]["rows"], 36)

    def test_expression_language_is_allowlisted(self) -> None:
        state = run_data_lab("load-sample", {})
        good = run_data_lab("apply-operation", {"state": state, "actorRole": "editor", "operation": {"type": "transform", "column": "责任单位", "expression": "value.toUppercase()", "label": "统一大写"}})
        self.assertTrue(all(str(row["责任单位"]).upper() == row["责任单位"] for row in good["project"]["dataset"]["rows"]))
        with self.assertRaises(ToolError):
            run_data_lab("apply-operation", {"state": state, "actorRole": "editor", "operation": {"type": "transform", "column": "责任单位", "expression": "__import__('os').system('bad')"}})

    def test_viewer_cannot_mutate_data(self) -> None:
        state = run_data_lab("load-sample", {})
        with self.assertRaises(ToolError):
            run_data_lab("undo", {"state": state, "actorRole": "viewer"})

    def test_delivery_files_are_real_and_complete(self) -> None:
        state = run_data_lab("load-sample", {})
        xlsx = base64.b64decode(state["exports"]["xlsxBase64"])
        with zipfile.ZipFile(io.BytesIO(xlsx)) as archive:
            self.assertIn("xl/worksheets/sheet1.xml", archive.namelist())
        package = base64.b64decode(state["exports"]["packageBase64"])
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            self.assertEqual(set(archive.namelist()), {"README.md", "project.json", "operations.json", "profile.json", "analysis/aggregation.csv", "data/original.csv", "data/current.csv", "data/current-view.csv", "data/current.xlsx", "audit.json"})
            project = json.loads(archive.read("project.json"))
            self.assertEqual(project["schema"], "skyview-data-refine-project")
            self.assertIn("区域", archive.read("analysis/aggregation.csv").decode("utf-8-sig"))


if __name__ == "__main__":
    unittest.main()
