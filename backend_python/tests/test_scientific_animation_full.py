from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.common import ToolError
from app.tools.scientific_animation_full import run_scientific_animation


class ScientificAnimationFullTests(unittest.TestCase):
    def test_sample_is_a_complete_animation_workspace(self) -> None:
        result = run_scientific_animation("load-sample", {})
        self.assertEqual(result["schema"], "skyview-scientific-animation-results")
        self.assertEqual(len(result["workspace"]["scenes"]), 3)
        self.assertGreaterEqual(len(result["workspace"]["objects"]), 15)
        self.assertGreaterEqual(len(result["workspace"]["keyframes"]), 21)
        self.assertEqual(result["analysis"]["metrics"]["qualityPassed"], 6)
        self.assertTrue(result["exports"]["packageBase64"])

    def test_preview_frame_interpolates_timeline_properties(self) -> None:
        state = run_scientific_animation("load-sample", {})
        result = run_scientific_animation("render-preview", {"state": state, "time": 3.9})
        wave = next(item for item in result["analysis"]["currentFrame"]["objects"] if item["id"] == "obj-wave-a")
        self.assertGreater(wave["props"]["x"], -180)
        self.assertLess(wave["props"]["x"], 240)
        self.assertEqual(result["workspace"]["currentTime"], 3.9)

    def test_object_and_keyframe_edits_are_persistent_and_audited(self) -> None:
        state = run_scientific_animation("load-sample", {})
        added = run_scientific_animation("add-object", {"state": state, "type": "circle", "name": "观测点", "actor": "编辑员", "actorRole": "editor"})
        object_id = added["workspace"]["selectedObjectId"]
        updated = run_scientific_animation("update-object", {"state": added, "objectId": object_id, "props": {"x": 420, "opacity": .6}, "actorRole": "editor"})
        framed = run_scientific_animation("add-keyframe", {"state": updated, "objectId": object_id, "property": "x", "time": 5, "value": 700, "easing": "smooth", "actorRole": "editor"})
        item = next(row for row in framed["workspace"]["objects"] if row["id"] == object_id)
        self.assertEqual(item["props"]["x"], 420)
        self.assertTrue(any(row["objectId"] == object_id for row in framed["workspace"]["keyframes"]))
        self.assertEqual(framed["workspace"]["audit"][0]["actor"], "当前创作者")

    def test_viewer_cannot_mutate_animation(self) -> None:
        state = run_scientific_animation("load-sample", {})
        with self.assertRaises(ToolError):
            run_scientific_animation("delete-object", {"state": state, "objectId": "obj-wave-a", "actorRole": "viewer"})

    def test_external_render_is_prepared_but_never_falsely_completed(self) -> None:
        state = run_scientific_animation("load-sample", {})
        prepared = run_scientific_animation("prepare-render", {"state": state, "profileId": "video-hd"})
        job = prepared["workspace"]["renderJobs"][0]
        self.assertEqual(job["status"], "prepared")
        self.assertTrue(job["runtimeRequired"])
        self.assertEqual(prepared["runtime"]["manimGL"]["status"], "not-configured")

    def test_export_package_contains_reproducible_artifacts(self) -> None:
        result = run_scientific_animation("load-sample", {})
        payload = base64.b64decode(result["exports"]["packageBase64"])
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertEqual(set(archive.namelist()), {"README.md", "project.json", "scene.py", "timeline.csv", "storyboard.html", "render-manifest.json"})
            self.assertIn("SkyViewScientificScene", archive.read("scene.py").decode("utf-8"))

    def test_import_rebuilds_ids_and_drops_untrusted_code(self) -> None:
        state = run_scientific_animation("load-sample", {})
        content = json.dumps({
            "name": "外部动画", "code": "import os; os.system('bad')",
            "scenes": [{"id": "old-scene", "name": "导入场景", "duration": 5}],
            "objects": [{"id": "old-object", "sceneId": "old-scene", "type": "text", "name": "标签", "props": {"text": "安全文本", "x": 20, "onClick": "bad()"}}],
            "keyframes": [],
        }, ensure_ascii=False)
        result = run_scientific_animation("import-project", {"state": state, "content": content, "actorRole": "owner"})
        self.assertNotEqual(result["workspace"]["scenes"][0]["id"], "old-scene")
        self.assertNotEqual(result["workspace"]["objects"][0]["id"], "old-object")
        self.assertNotIn("code", result["workspace"])
        self.assertNotIn("onClick", result["workspace"]["objects"][0]["props"])


if __name__ == "__main__":
    unittest.main()
