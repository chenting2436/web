import base64
import io
import json
import unittest
import zipfile

from app.tools.remote_sensing_full import MAX_ANALYSIS_PIXELS, run_remote_sensing


class RemoteSensingFullTests(unittest.TestCase):
    def test_benchmark_runs_complete_six_view_result(self):
        result = run_remote_sensing("run-all", {})
        self.assertEqual(result["schema"], "skyview-remote-sensing-results")
        self.assertEqual(result["processingMode"], "synthetic-benchmark-python-worker")
        self.assertEqual(len(result["zones"]), 16)
        self.assertGreater(result["summary"]["changedPixels"], 0)
        self.assertEqual(result["summary"]["changedPixels"], 1531)
        self.assertEqual(sum(zone["changedPixels"] for zone in result["zones"]), result["summary"]["changedPixels"])
        self.assertEqual(sum(item["pixelCount"] for item in result["components"]), result["summary"]["changedPixels"])
        self.assertEqual(sum(item["count"] for item in result["categories"]), result["summary"]["changedPixels"])
        self.assertEqual(result["benchmarkValidation"]["evaluated"], result["width"] * result["height"])
        self.assertEqual(result["quality"]["pixelLimit"], MAX_ANALYSIS_PIXELS)

    def test_algorithms_and_threshold_strategies_are_available(self):
        for method in ("ndvi-loss", "dnbr", "ndwi-gain", "rgb-cva", "brightness", "band-abs"):
            result = run_remote_sensing("analyze", {"settings": {"method": method, "singleBand": 1, "thresholdStrategy": "percentile", "percentile": 92, "morphology": "none", "minPatchPixels": 1}})
            self.assertEqual(result["settings"]["method"], method)
            self.assertEqual(len(result["score"]), result["width"] * result["height"])
        manual = run_remote_sensing("analyze", {"settings": {"method": "ndvi-loss", "thresholdStrategy": "manual", "manualThreshold": .2, "morphology": "none", "minPatchPixels": 1}})
        self.assertAlmostEqual(manual["threshold"], .2)

    def test_outputs_are_valid_png_geotiff_and_zip(self):
        result = run_remote_sensing("export", {})
        exports = result["exports"]
        self.assertTrue(base64.b64decode(exports["maskPngBase64"]).startswith(b"\x89PNG"))
        self.assertTrue(base64.b64decode(exports["maskGeoTiffBase64"]).startswith(b"II*\x00"))
        feature_collection = json.loads(exports["regionsGeoJson"])
        self.assertEqual(len(feature_collection["features"]), len(result["components"]))
        self.assertEqual(feature_collection["features"][0]["geometry"]["coordinates"], result["components"][0]["coordinate"])
        self.assertEqual(len(exports["zonesCsv"].splitlines()), 17)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(exports["packageBase64"]))) as archive:
            names = set(archive.namelist())
            self.assertIn("results/change-mask.tif", names)
            self.assertIn("results/regions.geojson", names)
            self.assertIn("manifest.json", names)

    def test_validation_metrics_use_user_samples(self):
        result = run_remote_sensing("validate", {"validationSamples": [{"x": 0, "y": 0, "label": 0}, {"x": 29, "y": 22, "label": 1}]})
        self.assertEqual(result["validation"]["evaluated"], 2)

    def test_offset_and_nodata_are_recorded_and_applied(self):
        before = {"name": "a", "width": 2, "height": 2, "bands": [[0, -9999, 0, 0]], "noData": -9999, "geo": None}
        after = {"name": "b", "width": 2, "height": 2, "bands": [[0, 1, 0, 0]], "noData": None, "geo": None}
        result = run_remote_sensing("analyze", {"before": before, "after": after, "settings": {"method": "band-abs", "thresholdStrategy": "manual", "manualThreshold": .5, "morphology": "none", "minPatchPixels": 1, "offsetX": 0, "offsetY": 0}})
        self.assertEqual(result["summary"]["validPixels"], 3)
        self.assertEqual(result["summary"]["changedPixels"], 0)
        self.assertEqual(result["quality"]["offset"], [0, 0])


if __name__ == "__main__":
    unittest.main()
