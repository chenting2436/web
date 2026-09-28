from __future__ import annotations

import csv
import io
import json
import unittest

from app.tools.dispatcher import run_tool


class ResearchRadarFullTests(unittest.TestCase):
    def test_complete_baseline_has_eight_area_data_and_exports(self) -> None:
        result = run_tool("research-radar", "run-all", {})

        self.assertEqual(result["schema"], "skyview-research-radar-results")
        self.assertEqual(len(result["records"]), 12)
        self.assertTrue(all(item["isDemo"] and item["datasetMode"] == "demo" for item in result["records"]))
        self.assertGreaterEqual(len(result["workspace"]["library"]), 5)
        self.assertGreater(len(result["analysis"]["yearlyTrend"]), 1)
        self.assertGreater(len(result["analysis"]["topics"]), 3)
        self.assertGreater(len(result["analysis"]["graph"]["nodes"]), 8)
        self.assertEqual(len(result["analysis"]["evidenceGrades"]), 4)
        self.assertIn("@article", result["exports"]["bibtex"])
        self.assertIn("TY  - JOUR", result["exports"]["ris"])
        self.assertIn("skyview-research-radar-backup", result["exports"]["backupJson"])
        self.assertTrue(result["runtime"]["liveSearchRequiresExplicitAction"])
        self.assertFalse(result["runtime"]["backgroundSchedulerConfigured"])

    def test_deduplication_uses_doi_and_merges_providers(self) -> None:
        baseline = run_tool("research-radar", "run-all", {})
        duplicate = dict(baseline["records"][0])
        duplicate.update({"id": "openalex-copy", "provider": "openalex", "providers": ["openalex"], "abstract": "A much longer abstract supplied by another provider for deterministic merge testing."})
        result = run_tool("research-radar", "dedupe", {"state": {"workspace": baseline["workspace"], "records": [*baseline["records"], duplicate], "sources": baseline["sources"]}})

        self.assertEqual(len(result["records"]), 12)
        merged = next(item for item in result["records"] if item["doi"] == baseline["records"][0]["doi"])
        self.assertEqual(set(merged["providers"]), {"demo", "openalex"})
        self.assertGreaterEqual(result["analysis"]["duplicateCount"], 1)

    def test_bibtex_ris_and_json_import_are_supported(self) -> None:
        baseline = run_tool("research-radar", "run-all", {})
        state = {"workspace": baseline["workspace"], "records": baseline["records"], "sources": baseline["sources"]}
        bibtex = "@article{Example2026, title={Imported evidence graph study}, author={Li Jiangfeng and Chen Xing}, year={2026}, doi={10.1000/imported.1}, abstract={A source abstract.}}"
        imported = run_tool("research-radar", "import-records", {"state": state, "fileName": "records.bib", "content": bibtex})
        self.assertEqual(imported["importSummary"]["parsed"], 1)
        self.assertTrue(any(item["doi"] == "10.1000/imported.1" for item in imported["records"]))

        ris = "TY  - JOUR\nTI  - Imported RIS record\nAU  - Zhao Lan\nPY  - 2025\nDO  - 10.1000/imported.2\nER  - \n"
        imported_ris = run_tool("research-radar", "import-records", {"state": state, "fileName": "records.ris", "content": ris})
        self.assertTrue(any(item["title"] == "Imported RIS record" for item in imported_ris["records"]))

        payload = json.dumps({"records": [{"title": "Imported JSON record", "year": 2024, "doi": "10.1000/imported.3"}]})
        imported_json = run_tool("research-radar", "import-records", {"state": state, "fileName": "records.json", "content": payload})
        self.assertTrue(any(item["title"] == "Imported JSON record" for item in imported_json["records"]))

    def test_library_monitor_transfer_and_csv_safety_are_stateful(self) -> None:
        baseline = run_tool("research-radar", "run-all", {})
        state = {"workspace": baseline["workspace"], "records": baseline["records"], "sources": baseline["sources"]}
        updated = run_tool("research-radar", "update-library", {"state": state, "recordId": "radar-03", "collectionId": "core", "status": "included", "priority": "high", "tags": ["质量"], "note": "=HYPERLINK(\"bad\")"})
        member = next(item for item in updated["workspace"]["library"] if item["recordId"] == "radar-03")
        self.assertEqual(member["priority"], "high")
        rows = list(csv.reader(io.StringIO(updated["exports"]["libraryCsv"])))
        record_row = next(row for row in rows if row[0] == "radar-03")
        self.assertTrue(record_row[-1].startswith("'="))

        monitored = run_tool("research-radar", "run-monitor", {"state": {"workspace": updated["workspace"], "records": updated["records"], "sources": updated["sources"]}, "monitorId": "monitor-weekly"})
        self.assertEqual(monitored["monitorRun"]["status"], "succeeded")
        self.assertEqual(monitored["monitorRun"]["notificationStatus"], "recorded")

        transferred = run_tool("research-radar", "transfer", {"state": {"workspace": monitored["workspace"], "records": monitored["records"], "sources": monitored["sources"]}, "recordIds": ["radar-01", "radar-03"], "destination": "paper-writing"})
        self.assertEqual(transferred["workspace"]["transfer"]["history"][0]["status"], "packaged")
        self.assertIn("skyview-radar-evidence-transfer", transferred["exports"]["knowledgeJson"])


if __name__ == "__main__":
    unittest.main()
