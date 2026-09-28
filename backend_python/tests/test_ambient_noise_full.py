from __future__ import annotations

import unittest

from app.tools.ambient_noise_full import run_ambient_noise


class AmbientNoiseParityTests(unittest.TestCase):
    def test_sample_stage_returns_waveform_spectrum_and_station_inventory(self) -> None:
        result = run_ambient_noise("load-sample", {})
        self.assertEqual(result["schema"], "skyview-ambient-noise-results")
        self.assertEqual(len(result["network"]["stations"]), 9)
        self.assertEqual(len(result["stationPreviews"]), 9)
        self.assertEqual(len(result["preview"]["raw"]), 600)
        self.assertEqual(len(result["preview"]["processed"]), 600)
        self.assertGreater(len(result["preview"]["spectrum"]), 20)

    def test_full_flow_restores_tables_maps_quality_and_exports(self) -> None:
        result = run_ambient_noise("run-all", {})
        self.assertGreaterEqual(len(result["pairResults"]), 10)
        self.assertEqual(sum(item["accepted"] for item in result["pairResults"]), 18)
        self.assertEqual(len(result["dispersion"]), len(result["pairResults"]))
        self.assertEqual(sum(pick["accepted"] for entry in result["dispersion"] for pick in entry["picks"]), 96)
        self.assertEqual(len(result["tomography"]["anomalies"]), 80)
        self.assertEqual(result["tomography"]["observations"], 15)
        self.assertAlmostEqual(result["tomography"]["rms"], 0.273572456413999, places=12)
        self.assertEqual(len(result["checkerboard"]["target"]), 80)
        self.assertAlmostEqual(result["checkerboard"]["correlation"], 0.31254591020769346, places=12)
        self.assertIn("station,x_km,y_km", result["exports"]["stationCsv"])
        self.assertIn("pair,station_a,station_b", result["exports"]["dispersionCsv"])
        self.assertIn("层析", result["exports"]["methodsText"])
        self.assertIn("pairAcceptance", result["quality"])

    def test_multichannel_csv_can_replace_the_synthetic_benchmark(self) -> None:
        lines = ["time,A,B"]
        for index in range(20):
            lines.append(f"{index * 0.2},{index % 3},{(index + 1) % 3}")
        result = run_ambient_noise("preprocess", {"waveformCsv": "\n".join(lines)})
        self.assertFalse(result["network"]["benchmark"])
        self.assertEqual([station["id"] for station in result["network"]["stations"]], ["A", "B"])
        self.assertAlmostEqual(result["network"]["sampleRate"], 5.0)


if __name__ == "__main__":
    unittest.main()
