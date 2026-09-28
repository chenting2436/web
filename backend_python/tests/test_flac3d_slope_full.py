import base64
import io
import math
import unittest
import zipfile
from unittest.mock import patch

from app.tools.common import ToolError
from app.tools.flac3d_slope_full import run_flac3d_slope


class Flac3dSlopeFullTests(unittest.TestCase):
    def test_reference_workspace_uses_supplied_flac3d_results(self):
        workspace = run_flac3d_slope("load-sample", {})
        self.assertEqual(workspace["schema"], "skyview-open-slope-workspace")
        self.assertEqual(workspace["result"]["metrics"]["zoneCount"], 3000)
        self.assertEqual(len(workspace["result"]["section"]["zones"]), 600)
        self.assertEqual(workspace["result"]["metrics"]["factorOfSafety"], 1.81)
        self.assertAlmostEqual(workspace["result"]["metrics"]["maxDisplacement"], 0.250496)
        self.assertTrue(workspace["validation"]["passed"])
        self.assertTrue(workspace["result"]["source"]["sha256"])

    def test_model_update_recomputes_elastic_constants_and_screening(self):
        workspace = run_flac3d_slope(
            "update-model",
            {
                "model": {
                    "geometry": {"slopeHeight": 12, "slopeAngle": 38},
                    "material": {"youngModulus": 42_000_000, "poissonRatio": 0.28, "cohesion": 30_000, "friction": 28},
                    "screening": {"slipDepth": 2.5, "porePressureRatio": 0.2},
                }
            },
        )
        self.assertAlmostEqual(workspace["model"]["material"]["shearModulus"], 16_406_250)
        self.assertGreater(workspace["screening"]["factorOfSafety"], 0)
        self.assertEqual(workspace["model"]["geometry"]["slopeAngle"], 38)

    def test_run_package_contains_reproducible_inputs(self):
        workspace = run_flac3d_slope("prepare-run", {})
        content = base64.b64decode(workspace["exports"]["packageBase64"])
        with zipfile.ZipFile(io.BytesIO(content)) as package:
            names = set(package.namelist())
        self.assertTrue({"manifest.json", "model/model.json", "runtime/call_slope.dat", "runtime/run_slope.py", "README.md"}.issubset(names))

    def test_execution_is_closed_when_solver_is_not_configured(self):
        with patch.dict("os.environ", {"FLAC3D_CONSOLE_PATH": "", "ALLOW_FLAC3D_EXECUTION": "false"}, clear=False):
            with self.assertRaises(ToolError):
                run_flac3d_slope("execute-flac3d", {})

    def test_web_screening_is_ready_without_a_desktop_solver(self):
        status = run_flac3d_slope("solver-status", {})["runtime"]
        for engine in ("screening", "sweep2d", "spatial3d"):
            solver = next(item for item in status["solvers"] if item["id"] == engine)
            self.assertTrue(solver["available"])
            workspace = run_flac3d_slope("screen-stability", {"engine": engine})
            self.assertGreater(workspace["screening"]["factorOfSafety"], 0)

    def test_web_calculation_rebuilds_the_section_field_from_current_parameters(self):
        first = run_flac3d_slope("screen-stability", {"engine": "sweep2d"})
        second = run_flac3d_slope(
            "screen-stability",
            {
                "engine": "sweep2d",
                "model": {
                    "geometry": {"slopeHeight": 14, "slopeAngle": 58, "totalHeight": 24, "toeX": 23},
                    "material": {"cohesion": 15_000, "friction": 20},
                    "screening": {"porePressureRatio": 0.35},
                },
            },
        )
        self.assertEqual(first["result"]["source"]["kind"], "web-analytical-field")
        self.assertEqual(second["result"]["source"]["kind"], "web-analytical-field")
        self.assertNotEqual(first["result"]["source"]["sha256"], second["result"]["source"]["sha256"])
        self.assertNotEqual(first["result"]["section"]["zones"], second["result"]["section"]["zones"])
        self.assertAlmostEqual(second["result"]["metrics"]["factorOfSafety"], second["screening"]["factorOfSafety"])
        self.assertIn("网页解析模型", second["result"]["interpretation"][2])

    def test_extreme_slope_angles_control_the_section_geometry(self):
        steep = run_flac3d_slope("screen-stability", {"engine": "screening", "model": {"geometry": {"slopeHeight": 16, "slopeAngle": 85}}})
        shallow = run_flac3d_slope("screen-stability", {"engine": "screening", "model": {"geometry": {"slopeHeight": 16, "slopeAngle": 5}}})
        steep_geometry = steep["model"]["geometry"]
        shallow_geometry = shallow["model"]["geometry"]
        self.assertAlmostEqual(steep_geometry["toeX"] - steep_geometry["crestX"], 16 / math.tan(math.radians(85)), places=6)
        self.assertAlmostEqual(shallow_geometry["toeX"] - shallow_geometry["crestX"], 16 / math.tan(math.radians(5)), places=6)
        self.assertGreater(shallow_geometry["totalLength"], shallow_geometry["toeX"])
        self.assertNotEqual(steep["result"]["source"]["sha256"], shallow["result"]["source"]["sha256"])


if __name__ == "__main__":
    unittest.main()
