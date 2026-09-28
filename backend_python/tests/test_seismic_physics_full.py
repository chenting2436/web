import base64
import io
import json
import unittest
import zipfile

from app.tools.dispatcher import catalog, run_tool


class SeismicPhysicsFullTests(unittest.TestCase):
    def test_deterministic_benchmark_runs_complete_workflow(self):
        first = run_tool("seismic-physics", "run-all", {})
        second = run_tool("seismic-physics", "run-all", {})

        self.assertEqual(first["schema"], "skyview-seismic-physics-results")
        self.assertEqual(first["version"], 2)
        self.assertEqual(len(first["dataset"]["traces"]), 3)
        self.assertEqual([trace["channel"] for trace in first["dataset"]["traces"]], ["BHZ", "BHN", "BHE"])
        self.assertEqual(first["dataset"]["sampleRate"], 200)
        self.assertEqual(first["dataset"]["traces"][0]["samples"], 6000)
        self.assertGreaterEqual(len(first["events"]), 2)
        self.assertEqual({pick["phase"] for pick in first["picks"]}, {"P", "S"})
        self.assertGreaterEqual(first["validation"]["f1"], 0.8)
        self.assertEqual(first["psd"]["dominantFrequency"], second["psd"]["dominantFrequency"])
        self.assertEqual(first["preview"]["raw"], second["preview"]["raw"])
        self.assertTrue(all(item["passed"] for item in first["qualityChecks"]))

    def test_csv_import_preprocess_detection_and_frequency_outputs(self):
        rows = ["time,BHZ,BHN,BHE"]
        for index in range(400):
            time = index / 40
            pulse = 2 if 150 <= index <= 170 else 0
            rows.append(f"{time},{pulse},{pulse * 0.7},{pulse * 0.5}")
        result = run_tool("seismic-physics", "run-all", {
            "fileName": "three-component.csv",
            "waveformText": "\n".join(rows),
            "settings": {"lowCut": 0.5, "highCut": 10, "signalStart": 3, "signalEnd": 5},
        })

        self.assertFalse(result["dataset"]["benchmark"])
        self.assertEqual(result["dataset"]["sourceType"], "table-csv")
        self.assertAlmostEqual(result["dataset"]["sampleRate"], 40, places=4)
        self.assertEqual(len(result["tracePreviews"]), 3)
        self.assertGreater(len(result["psd"]["frequencies"]), 20)
        self.assertGreater(len(result["spectrogram"]["frames"]), 0)
        self.assertIn("time_s,raw_counts,processed", result["exports"]["processedCsv"])

    def test_aic_adds_candidate_without_removing_existing_picks(self):
        initial = run_tool("seismic-physics", "run-all", {})
        result = run_tool("seismic-physics", "aic-pick", {
            "picks": initial["picks"],
            "settings": {"aicPhase": "P", "aicStart": 7.5, "aicEnd": 9},
        })
        self.assertEqual(len(result["picks"]), len(initial["picks"]) + 1)
        self.assertEqual(result["picks"][-1]["source"], "AIC-window")

    def test_reproducible_package_contains_reports_data_and_catalogs(self):
        result = run_tool("seismic-physics", "run-all", {})
        archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(result["exports"]["packageBase64"])))
        self.assertEqual(
            set(archive.namelist()),
            {
                "README.md",
                "metadata/analysis.json",
                "waveform/processed.csv",
                "spectrum/welch-psd.csv",
                "catalog/events.csv",
                "catalog/picks.csv",
                "validation/reference-picks.csv",
            },
        )
        metadata = json.loads(archive.read("metadata/analysis.json"))
        self.assertEqual(metadata["schema"], "skyview-seismic-physics-analysis")
        self.assertEqual(metadata["source"]["traces"][0]["samples"], 6000)

    def test_catalog_advertises_dedicated_actions(self):
        seismic = next(item for item in catalog() if item["slug"] == "seismic-physics")
        for action in ("run-all", "preprocess", "detect", "aic-pick", "validate"):
            self.assertIn(action, seismic["extendedActions"])


if __name__ == "__main__":
    unittest.main()
