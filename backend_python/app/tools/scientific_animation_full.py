from __future__ import annotations

import base64
import csv
import io
import json
import re
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-scientific-animation-results"
MAX_IMPORT_BYTES = 4_000_000
MAX_OBJECTS = 500
OBJECT_TYPES = {"rect", "circle", "text", "line", "path", "plot", "group"}
EASINGS = {"linear", "ease-in", "ease-out", "ease-in-out", "smooth"}
MUTATING_ACTIONS = {
    "create-scene", "update-scene", "add-object", "update-object",
    "delete-object", "add-keyframe", "update-keyframe", "remove-keyframe",
    "reorder-layer", "update-camera", "create-snapshot", "import-project",
    "prepare-render", "record-render",
}


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _find(rows: list[dict[str, Any]], identifier: str, label: str) -> dict[str, Any]:
    item = next((row for row in rows if row.get("id") == identifier), None)
    if item is None:
        raise ToolError(f"{label}不存在")
    return item


def _audit(workspace: dict[str, Any], action: str, actor: str, target: str, detail: str) -> None:
    workspace.setdefault("audit", []).insert(0, {
        "id": _id("audit"), "time": _now(), "action": action,
        "actor": _clean(actor, 80) or "当前创作者", "target": _clean(target, 120),
        "detail": _clean(detail, 600),
    })
    workspace["audit"] = workspace["audit"][:500]
    workspace["version"] = int(workspace.get("version", 1)) + 1
    workspace["updatedAt"] = _now()


def _sample_workspace() -> dict[str, Any]:
    scenes = [
        {"id": "scene-wave", "name": "面波传播与频散", "order": 1, "duration": 12.0, "fps": 30, "width": 960, "height": 540, "background": "#071426", "cameraId": "camera-wave", "status": "editing"},
        {"id": "scene-inversion", "name": "层析反演过程", "order": 2, "duration": 9.0, "fps": 30, "width": 960, "height": 540, "background": "#081a2c", "cameraId": "camera-inversion", "status": "ready"},
        {"id": "scene-summary", "name": "结果与方法总结", "order": 3, "duration": 7.0, "fps": 30, "width": 960, "height": 540, "background": "#0b1830", "cameraId": "camera-summary", "status": "draft"},
    ]
    objects = [
        {"id": "obj-title", "sceneId": "scene-wave", "type": "text", "name": "标题", "parentId": "", "locked": False, "hidden": False, "order": 1, "props": {"x": 64, "y": 56, "text": "面波传播与频散", "fontSize": 28, "fill": "#f4f8ff", "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-subtitle", "sceneId": "scene-wave", "type": "text", "name": "说明", "parentId": "", "locked": False, "hidden": False, "order": 2, "props": {"x": 66, "y": 88, "text": "不同周期的群速度沿测线传播", "fontSize": 15, "fill": "#8fb3d8", "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-ground", "sceneId": "scene-wave", "type": "rect", "name": "地层背景", "parentId": "", "locked": True, "hidden": False, "order": 3, "props": {"x": 56, "y": 246, "width": 848, "height": 214, "fill": "#123454", "stroke": "#4f7598", "strokeWidth": 2, "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-layer", "sceneId": "scene-wave", "type": "path", "name": "速度界面", "parentId": "", "locked": False, "hidden": False, "order": 4, "props": {"x": 0, "y": 0, "d": "M56 326 C220 292 350 362 510 328 S750 286 904 338 L904 460 L56 460 Z", "fill": "#0b5969", "stroke": "#3ab0b9", "strokeWidth": 2, "opacity": 0.86, "scale": 1, "rotation": 0}},
        {"id": "obj-source", "sceneId": "scene-wave", "type": "circle", "name": "震源", "parentId": "", "locked": False, "hidden": False, "order": 5, "props": {"x": 156, "y": 225, "radius": 12, "fill": "#f27649", "stroke": "#ffd7c8", "strokeWidth": 3, "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-wave-a", "sceneId": "scene-wave", "type": "path", "name": "短周期波列", "parentId": "", "locked": False, "hidden": False, "order": 6, "props": {"x": 0, "y": 0, "d": "M160 218 C190 158 220 278 250 218 S310 158 340 218 S400 278 430 218 S490 158 520 218 S580 278 610 218", "fill": "none", "stroke": "#55d6df", "strokeWidth": 5, "opacity": 0.95, "scale": 1, "rotation": 0}},
        {"id": "obj-wave-b", "sceneId": "scene-wave", "type": "path", "name": "长周期波列", "parentId": "", "locked": False, "hidden": False, "order": 7, "props": {"x": 0, "y": 0, "d": "M160 226 C220 120 280 332 340 226 S460 120 520 226 S640 332 700 226 S820 120 880 226", "fill": "none", "stroke": "#f5bb58", "strokeWidth": 4, "opacity": 0.8, "scale": 1, "rotation": 0}},
        {"id": "obj-station-a", "sceneId": "scene-wave", "type": "circle", "name": "台站 A", "parentId": "", "locked": False, "hidden": False, "order": 8, "props": {"x": 380, "y": 238, "radius": 8, "fill": "#ffffff", "stroke": "#55d6df", "strokeWidth": 4, "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-station-b", "sceneId": "scene-wave", "type": "circle", "name": "台站 B", "parentId": "", "locked": False, "hidden": False, "order": 9, "props": {"x": 780, "y": 238, "radius": 8, "fill": "#ffffff", "stroke": "#f5bb58", "strokeWidth": 4, "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-axis-x", "sceneId": "scene-wave", "type": "line", "name": "频散横轴", "parentId": "", "locked": True, "hidden": False, "order": 10, "props": {"x1": 610, "y1": 430, "x2": 866, "y2": 430, "stroke": "#a8bdd2", "strokeWidth": 2, "opacity": 1}},
        {"id": "obj-axis-y", "sceneId": "scene-wave", "type": "line", "name": "频散纵轴", "parentId": "", "locked": True, "hidden": False, "order": 11, "props": {"x1": 610, "y1": 430, "x2": 610, "y2": 346, "stroke": "#a8bdd2", "strokeWidth": 2, "opacity": 1}},
        {"id": "obj-curve", "sceneId": "scene-wave", "type": "path", "name": "频散曲线", "parentId": "", "locked": False, "hidden": False, "order": 12, "props": {"x": 0, "y": 0, "d": "M618 408 C662 394 694 378 728 380 S790 352 856 358", "fill": "none", "stroke": "#f27649", "strokeWidth": 4, "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-inversion-title", "sceneId": "scene-inversion", "type": "text", "name": "反演标题", "parentId": "", "locked": False, "hidden": False, "order": 1, "props": {"x": 68, "y": 58, "text": "层析反演：从射线路径到速度结构", "fontSize": 27, "fill": "#f4f8ff", "opacity": 1, "scale": 1, "rotation": 0}},
        {"id": "obj-inversion-grid", "sceneId": "scene-inversion", "type": "rect", "name": "反演网格", "parentId": "", "locked": False, "hidden": False, "order": 2, "props": {"x": 150, "y": 120, "width": 660, "height": 330, "fill": "#11495a", "stroke": "#56c4cd", "strokeWidth": 2, "opacity": 0.9, "scale": 1, "rotation": 0}},
        {"id": "obj-summary-title", "sceneId": "scene-summary", "type": "text", "name": "总结标题", "parentId": "", "locked": False, "hidden": False, "order": 1, "props": {"x": 92, "y": 84, "text": "可复核的成像结论", "fontSize": 34, "fill": "#f4f8ff", "opacity": 1, "scale": 1, "rotation": 0}},
    ]
    keyframes = [
        {"id": "kf-01", "sceneId": "scene-wave", "objectId": "obj-title", "property": "opacity", "time": 0.0, "value": 0.0, "easing": "ease-out"},
        {"id": "kf-02", "sceneId": "scene-wave", "objectId": "obj-title", "property": "opacity", "time": 0.8, "value": 1.0, "easing": "ease-out"},
        {"id": "kf-03", "sceneId": "scene-wave", "objectId": "obj-subtitle", "property": "opacity", "time": 0.4, "value": 0.0, "easing": "ease-out"},
        {"id": "kf-04", "sceneId": "scene-wave", "objectId": "obj-subtitle", "property": "opacity", "time": 1.4, "value": 1.0, "easing": "ease-out"},
        {"id": "kf-05", "sceneId": "scene-wave", "objectId": "obj-source", "property": "scale", "time": 1.0, "value": 0.4, "easing": "smooth"},
        {"id": "kf-06", "sceneId": "scene-wave", "objectId": "obj-source", "property": "scale", "time": 2.0, "value": 1.4, "easing": "smooth"},
        {"id": "kf-07", "sceneId": "scene-wave", "objectId": "obj-source", "property": "scale", "time": 2.8, "value": 1.0, "easing": "smooth"},
        {"id": "kf-08", "sceneId": "scene-wave", "objectId": "obj-wave-a", "property": "x", "time": 1.8, "value": -180.0, "easing": "linear"},
        {"id": "kf-09", "sceneId": "scene-wave", "objectId": "obj-wave-a", "property": "x", "time": 6.0, "value": 240.0, "easing": "linear"},
        {"id": "kf-10", "sceneId": "scene-wave", "objectId": "obj-wave-b", "property": "x", "time": 2.0, "value": -220.0, "easing": "ease-in-out"},
        {"id": "kf-11", "sceneId": "scene-wave", "objectId": "obj-wave-b", "property": "x", "time": 8.2, "value": 80.0, "easing": "ease-in-out"},
        {"id": "kf-12", "sceneId": "scene-wave", "objectId": "obj-station-a", "property": "scale", "time": 3.0, "value": 1.0, "easing": "smooth"},
        {"id": "kf-13", "sceneId": "scene-wave", "objectId": "obj-station-a", "property": "scale", "time": 4.0, "value": 1.8, "easing": "smooth"},
        {"id": "kf-14", "sceneId": "scene-wave", "objectId": "obj-station-a", "property": "scale", "time": 4.8, "value": 1.0, "easing": "smooth"},
        {"id": "kf-15", "sceneId": "scene-wave", "objectId": "obj-station-b", "property": "scale", "time": 6.3, "value": 1.0, "easing": "smooth"},
        {"id": "kf-16", "sceneId": "scene-wave", "objectId": "obj-station-b", "property": "scale", "time": 7.3, "value": 1.8, "easing": "smooth"},
        {"id": "kf-17", "sceneId": "scene-wave", "objectId": "obj-station-b", "property": "scale", "time": 8.0, "value": 1.0, "easing": "smooth"},
        {"id": "kf-18", "sceneId": "scene-wave", "objectId": "obj-curve", "property": "opacity", "time": 7.0, "value": 0.0, "easing": "ease-out"},
        {"id": "kf-19", "sceneId": "scene-wave", "objectId": "obj-curve", "property": "opacity", "time": 9.0, "value": 1.0, "easing": "ease-out"},
        {"id": "kf-20", "sceneId": "scene-wave", "objectId": "obj-curve", "property": "scale", "time": 7.0, "value": 0.6, "easing": "ease-out"},
        {"id": "kf-21", "sceneId": "scene-wave", "objectId": "obj-curve", "property": "scale", "time": 9.0, "value": 1.0, "easing": "ease-out"},
    ]
    return {
        "id": "animation-project-surface-wave", "name": "面波成像科普动画",
        "description": "用可复核场景、数据曲线与镜头组织解释面波传播和层析反演。",
        "version": 8, "currentSceneId": "scene-wave", "selectedObjectId": "obj-wave-a", "currentTime": 4.8,
        "scenes": scenes, "objects": objects, "keyframes": keyframes,
        "cameras": [
            {"id": "camera-wave", "sceneId": "scene-wave", "name": "主镜头", "x": 480, "y": 270, "zoom": 1.0, "rotation": 0, "projection": "orthographic"},
            {"id": "camera-inversion", "sceneId": "scene-inversion", "name": "反演镜头", "x": 480, "y": 270, "zoom": 1.0, "rotation": 0, "projection": "orthographic"},
            {"id": "camera-summary", "sceneId": "scene-summary", "name": "总结镜头", "x": 480, "y": 270, "zoom": 1.0, "rotation": 0, "projection": "orthographic"},
        ],
        "dataSources": [
            {"id": "data-dispersion", "name": "频散拾取结果", "format": "CSV", "rows": 8, "columns": ["period_s", "group_velocity_km_s", "quality"], "checksum": "sha256:sample-dispersion", "status": "bound"},
            {"id": "data-model", "name": "层析网格摘要", "format": "JSON", "rows": 80, "columns": ["x_km", "y_km", "velocity_km_s", "coverage"], "checksum": "sha256:sample-tomography", "status": "bound"},
        ],
        "bindings": [
            {"id": "binding-curve", "sceneId": "scene-wave", "sourceId": "data-dispersion", "objectId": "obj-curve", "mapping": {"x": "period_s", "y": "group_velocity_km_s", "filter": "quality >= 0.8"}, "status": "valid"},
            {"id": "binding-grid", "sceneId": "scene-inversion", "sourceId": "data-model", "objectId": "obj-inversion-grid", "mapping": {"x": "x_km", "y": "y_km", "color": "velocity_km_s", "opacity": "coverage"}, "status": "valid"},
        ],
        "narration": [
            {"id": "cue-01", "sceneId": "scene-wave", "start": 0.0, "end": 3.0, "text": "首先建立地层、震源与观测台站。", "status": "draft"},
            {"id": "cue-02", "sceneId": "scene-wave", "start": 3.0, "end": 8.2, "text": "不同周期的面波以不同群速度传播。", "status": "draft"},
            {"id": "cue-03", "sceneId": "scene-wave", "start": 8.2, "end": 12.0, "text": "由到时差形成频散曲线，为反演提供观测。", "status": "draft"},
        ],
        "renderProfiles": [
            {"id": "preview-web", "name": "网页实时预览", "width": 960, "height": 540, "fps": 30, "format": "SVG/Web Animation", "status": "enabled"},
            {"id": "video-hd", "name": "高清交付", "width": 1920, "height": 1080, "fps": 60, "format": "MP4/H.264", "status": "runtime-required"},
            {"id": "frame-4k", "name": "四倍高清关键帧", "width": 3840, "height": 2160, "fps": 1, "format": "PNG", "status": "runtime-required"},
        ],
        "renderJobs": [],
        "snapshots": [{"id": "snapshot-storyboard", "label": "传播场景分镜确认", "version": 6, "createdAt": "2026-09-10T08:30:00Z", "sceneIds": ["scene-wave", "scene-inversion", "scene-summary"]}],
        "audit": [{"id": "audit-seed", "time": "2026-09-10T08:30:00Z", "action": "create-snapshot", "actor": "动画负责人", "target": "snapshot-storyboard", "detail": "冻结三场景分镜结构"}],
        "createdAt": "2026-09-09T01:00:00Z", "updatedAt": "2026-09-10T08:30:00Z",
    }


def _bundle(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state")
    if isinstance(state, dict) and state.get("schema") == SCHEMA and isinstance(state.get("workspace"), dict):
        return deepcopy(state["workspace"])
    if isinstance(state, dict) and isinstance(state.get("workspace"), dict):
        return deepcopy(state["workspace"])
    if isinstance(state, dict) and isinstance(state.get("scenes"), list):
        return deepcopy(state)
    if isinstance(payload.get("workspace"), dict):
        return deepcopy(payload["workspace"])
    raise ToolError("缺少动画工作区状态，请先载入合成基准")


def _ease(value: float, mode: str) -> float:
    value = max(0.0, min(1.0, value))
    if mode == "ease-in": return value * value
    if mode == "ease-out": return 1 - (1 - value) ** 2
    if mode in {"ease-in-out", "smooth"}: return value * value * (3 - 2 * value)
    return value


def _interpolated_value(keyframes: list[dict[str, Any]], base: Any, time: float) -> Any:
    if not keyframes: return base
    ordered = sorted(keyframes, key=lambda row: float(row.get("time", 0)))
    if time <= float(ordered[0].get("time", 0)): return ordered[0].get("value", base)
    if time >= float(ordered[-1].get("time", 0)): return ordered[-1].get("value", base)
    for left, right in zip(ordered, ordered[1:]):
        left_time, right_time = float(left.get("time", 0)), float(right.get("time", 0))
        if left_time <= time <= right_time:
            if not isinstance(left.get("value"), (int, float)) or not isinstance(right.get("value"), (int, float)):
                return left.get("value")
            fraction = _ease((time - left_time) / max(0.0001, right_time - left_time), _clean(right.get("easing"), 30))
            return round(float(left["value"]) + (float(right["value"]) - float(left["value"])) * fraction, 4)
    return base


def _frame(workspace: dict[str, Any], scene: dict[str, Any], time: float) -> dict[str, Any]:
    time = max(0.0, min(float(scene.get("duration", 0)), float(time)))
    rows = [item for item in workspace.get("objects", []) if item.get("sceneId") == scene["id"] and not item.get("hidden")]
    output = []
    for item in sorted(rows, key=lambda row: int(row.get("order", 0))):
        props = deepcopy(item.get("props", {}))
        for key in list(props):
            keyframes = [row for row in workspace.get("keyframes", []) if row.get("objectId") == item["id"] and row.get("property") == key]
            props[key] = _interpolated_value(keyframes, props[key], time)
        output.append({"id": item["id"], "type": item["type"], "name": item["name"], "props": props, "locked": bool(item.get("locked"))})
    camera = next((item for item in workspace.get("cameras", []) if item.get("id") == scene.get("cameraId")), {})
    return {"sceneId": scene["id"], "time": round(time, 3), "duration": scene["duration"], "width": scene["width"], "height": scene["height"], "background": scene["background"], "camera": deepcopy(camera), "objects": output}


def _analysis(workspace: dict[str, Any]) -> dict[str, Any]:
    scene = _find(workspace.get("scenes", []), _clean(workspace.get("currentSceneId"), 120), "当前场景")
    objects = [item for item in workspace.get("objects", []) if item.get("sceneId") == scene["id"]]
    keyframes = [item for item in workspace.get("keyframes", []) if item.get("sceneId") == scene["id"]]
    ids = [item.get("id") for item in objects]
    diagnostics = []
    for item in objects:
        if item.get("type") not in OBJECT_TYPES: diagnostics.append({"level": "error", "target": item.get("id"), "message": "对象类型不在安全白名单"})
        if item.get("type") == "text" and not _clean(item.get("props", {}).get("text"), 1000): diagnostics.append({"level": "warning", "target": item.get("id"), "message": "文本对象内容为空"})
    for frame in keyframes:
        if frame.get("objectId") not in ids: diagnostics.append({"level": "error", "target": frame.get("id"), "message": "关键帧引用了不存在的对象"})
        if float(frame.get("time", -1)) < 0 or float(frame.get("time", 0)) > float(scene.get("duration", 0)): diagnostics.append({"level": "error", "target": frame.get("id"), "message": "关键帧超出场景时长"})
    total_duration = sum(float(item.get("duration", 0)) for item in workspace.get("scenes", []))
    quality = [
        {"label": "对象标识唯一", "passed": len(ids) == len(set(ids))},
        {"label": "关键帧位于场景时长内", "passed": not any(item["message"] == "关键帧超出场景时长" for item in diagnostics)},
        {"label": "数据绑定列映射完整", "passed": all(item.get("status") == "valid" for item in workspace.get("bindings", []))},
        {"label": "所有场景均绑定相机", "passed": all(item.get("cameraId") for item in workspace.get("scenes", []))},
        {"label": "网页预览不执行导入代码", "passed": True},
        {"label": "外部视频渲染未伪装为已完成", "passed": all(item.get("status") != "succeeded" or item.get("checksum") for item in workspace.get("renderJobs", []))},
    ]
    tracks = []
    for item in objects:
        item_frames = [row for row in keyframes if row.get("objectId") == item["id"]]
        tracks.append({"objectId": item["id"], "name": item["name"], "type": item["type"], "keyframes": sorted(item_frames, key=lambda row: float(row.get("time", 0))), "range": [min([float(row.get("time", 0)) for row in item_frames] + [0]), max([float(row.get("time", 0)) for row in item_frames] + [0])]})
    storyboard = []
    for item in sorted(workspace.get("scenes", []), key=lambda row: int(row.get("order", 0))):
        storyboard.append({"sceneId": item["id"], "name": item["name"], "duration": item["duration"], "frame": _frame(workspace, item, min(float(item["duration"]) * 0.55, float(item["duration"])))})
    return {
        "currentScene": deepcopy(scene), "currentFrame": _frame(workspace, scene, float(workspace.get("currentTime", 0))),
        "metrics": {"scenes": len(workspace.get("scenes", [])), "objects": len(workspace.get("objects", [])), "tracks": len(tracks), "keyframes": len(workspace.get("keyframes", [])), "duration": round(total_duration, 1), "qualityPassed": sum(item["passed"] for item in quality)},
        "tracks": tracks, "storyboard": storyboard, "diagnostics": diagnostics, "qualityChecks": quality,
        "dataBindings": [{**deepcopy(item), "source": next((row.get("name") for row in workspace.get("dataSources", []) if row.get("id") == item.get("sourceId")), ""), "object": next((row.get("name") for row in workspace.get("objects", []) if row.get("id") == item.get("objectId")), "")} for item in workspace.get("bindings", [])],
    }


def _runtime() -> dict[str, Any]:
    return {
        "webPreview": {"status": "enabled", "engine": "SVG + Web Animation timeline"},
        "composer": {"status": "enabled", "engine": "Python deterministic scene compiler"},
        "manimGL": {"status": "not-configured", "engine": "isolated ManimGL render worker"},
        "ffmpeg": {"status": "not-configured", "engine": "FFmpeg transcode worker"},
        "latex": {"status": "not-configured", "engine": "sandboxed LaTeX service"},
        "objectStorage": {"status": "not-configured", "engine": "S3 compatible artifacts"},
        "arbitraryCodeExecution": False,
        "sourceReference": {"repository": "https://github.com/3b1b/manim", "license": "MIT", "integration": "API/format inspiration only; no source copied"},
    }


def _manim_script(workspace: dict[str, Any], analysis: dict[str, Any]) -> str:
    scene = analysis["currentScene"]
    width, height = float(scene["width"]), float(scene["height"])

    def point(x: Any, y: Any) -> str:
        return f"np.array([{(float(x) - width / 2) / 100:.4f}, {(height / 2 - float(y)) / 100:.4f}, 0.0])"

    def offset(x: Any, y: Any) -> str:
        return f"np.array([{float(x) / 100:.4f}, {-float(y) / 100:.4f}, 0.0])"

    lines = [
        "from manimlib import *", "import numpy as np", "", "", "class SkyViewScientificScene(Scene):", "    def construct(self):",
        f"        # Generated from scene: {scene['name']}", f"        self.camera.background_color = \"{scene['background']}\"",
    ]
    for item in analysis["currentFrame"]["objects"]:
        safe_name = "obj_" + "".join(char if char.isalnum() else "_" for char in item["id"])
        props = item["props"]
        fill = _clean(props.get("fill"), 30)
        stroke = _clean(props.get("stroke"), 30) or (fill if fill != "none" else "#ffffff")
        opacity = max(0, min(1, float(props.get("opacity", 1))))
        scale = max(0.001, float(props.get("scale", 1)))
        rotation = float(props.get("rotation", 0))
        if item["type"] == "circle":
            lines.append(f"        {safe_name} = Circle(radius={float(props.get('radius', 10)) / 100:.4f}, color={json.dumps(stroke)})")
            lines.append(f"        {safe_name}.move_to({point(props.get('x', width / 2), props.get('y', height / 2))})")
        elif item["type"] == "rect":
            rect_width, rect_height = float(props.get("width", 100)), float(props.get("height", 100))
            lines.append(f"        {safe_name} = Rectangle(width={rect_width / 100:.4f}, height={rect_height / 100:.4f}, color={json.dumps(stroke)})")
            lines.append(f"        {safe_name}.move_to({point(float(props.get('x', 0)) + rect_width / 2, float(props.get('y', 0)) + rect_height / 2)})")
        elif item["type"] == "text":
            lines.append(f"        {safe_name} = Text({json.dumps(_clean(props.get('text'), 1000), ensure_ascii=False)}, font_size={int(props.get('fontSize', 24))}, color={json.dumps(fill if fill != 'none' else stroke)})")
            lines.append(f"        {safe_name}.move_to({point(props.get('x', width / 2), props.get('y', height / 2))}, aligned_edge=LEFT)")
        elif item["type"] == "line":
            lines.append(f"        {safe_name} = Line({point(props.get('x1', 0), props.get('y1', 0))}, {point(props.get('x2', 0), props.get('y2', 0))}, color={json.dumps(stroke)}, stroke_width={float(props.get('strokeWidth', 2)):.3f})")
        elif item["type"] == "path":
            numbers = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", _clean(props.get("d"), 4000))]
            points = [point(numbers[index], numbers[index + 1]) for index in range(0, min(len(numbers) - 1, 160), 2)]
            lines.append(f"        {safe_name} = VMobject()")
            if len(points) >= 2:
                lines.append(f"        {safe_name}.set_points_smoothly([{', '.join(points)}])")
                lines.append(f"        {safe_name}.shift({offset(props.get('x', 0), props.get('y', 0))})")
            lines.append(f"        {safe_name}.set_stroke(color={json.dumps(stroke)}, width={float(props.get('strokeWidth', 2)):.3f}, opacity={opacity:.3f})")
        else:
            lines.append(f"        # {safe_name}: {item['type']} geometry remains available in project.json")
            continue
        if item["type"] in {"circle", "rect"}:
            lines.append(f"        {safe_name}.set_fill(color={json.dumps(fill if fill != 'none' else stroke)}, opacity={opacity if fill != 'none' else 0:.3f})")
            lines.append(f"        {safe_name}.set_stroke(opacity={opacity:.3f}, width={float(props.get('strokeWidth', 2)):.3f})")
        elif item["type"] in {"text", "line"}:
            lines.append(f"        {safe_name}.set_opacity({opacity:.3f})")
        if abs(scale - 1) > 0.0001: lines.append(f"        {safe_name}.scale({scale:.4f})")
        if abs(rotation) > 0.0001: lines.append(f"        {safe_name}.rotate(np.deg2rad({rotation:.4f}))")
        lines.append(f"        self.add({safe_name})")
    lines += ["", "        # Exact timing and data bindings are also supplied in timeline.csv and project.json.", "        self.wait(1)", ""]
    return "\n".join(lines)


def _exports(workspace: dict[str, Any], analysis: dict[str, Any], runtime: dict[str, Any]) -> dict[str, str]:
    timeline = io.StringIO()
    writer = csv.writer(timeline, lineterminator="\n")
    writer.writerow(["scene_id", "object_id", "property", "time_s", "value", "easing"])
    for row in workspace.get("keyframes", []): writer.writerow([row.get("sceneId"), row.get("objectId"), row.get("property"), row.get("time"), row.get("value"), row.get("easing")])
    manifest = {"schema": "skyview-animation-render-manifest", "version": 1, "createdAt": _now(), "projectId": workspace["id"], "sceneIds": [item["id"] for item in workspace.get("scenes", [])], "profiles": workspace.get("renderProfiles", []), "runtime": runtime, "requiresIsolatedWorker": True}
    project = {"schema": SCHEMA, "version": 2, "exportedAt": _now(), "workspace": workspace}
    project_json = json.dumps(project, ensure_ascii=False, indent=2)
    manim_script = _manim_script(workspace, analysis)
    storyboard_rows = "".join(f"<article><h2>{item['name']}</h2><p>{item['duration']} 秒 · {len(item['frame']['objects'])} 个对象</p></article>" for item in analysis["storyboard"])
    storyboard_html = f"<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>{workspace['name']}分镜</title><style>body{{font:16px system-ui;background:#eef3f8;color:#102a4d;padding:32px}}main{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}article{{background:white;border:1px solid #cad7e7;border-radius:12px;padding:18px}}</style><h1>{workspace['name']}分镜</h1><main>{storyboard_rows}</main></html>"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", f"# {workspace['name']}\n\n网页预览可直接运行。MP4/PNG 正式渲染需配置隔离 ManimGL、FFmpeg 和 LaTeX 运行时。\n")
        archive.writestr("project.json", project_json)
        archive.writestr("scene.py", manim_script)
        archive.writestr("timeline.csv", timeline.getvalue())
        archive.writestr("storyboard.html", storyboard_html)
        archive.writestr("render-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return {"projectJson": project_json, "manimScript": manim_script, "timelineCsv": timeline.getvalue(), "storyboardHtml": storyboard_html, "renderManifest": json.dumps(manifest, ensure_ascii=False, indent=2), "packageBase64": base64.b64encode(buffer.getvalue()).decode("ascii")}


def _result(workspace: dict[str, Any], stage: str) -> dict[str, Any]:
    analysis = _analysis(workspace)
    runtime = _runtime()
    return {"schema": SCHEMA, "version": 2, "stage": stage, "workspace": workspace, "analysis": analysis, "runtime": runtime, "exports": _exports(workspace, analysis, runtime)}


def _import_workspace(content: str) -> dict[str, Any]:
    if len(content.encode("utf-8")) > MAX_IMPORT_BYTES: raise ToolError("动画项目不能超过 4 MB")
    try: imported = json.loads(content)
    except json.JSONDecodeError as exc: raise ToolError("动画项目不是有效 JSON") from exc
    if not isinstance(imported, dict): raise ToolError("动画项目必须是 JSON 对象")
    workspace = imported.get("workspace") if imported.get("schema") == SCHEMA else imported
    if not isinstance(workspace, dict) or not isinstance(workspace.get("scenes"), list) or not isinstance(workspace.get("objects"), list): raise ToolError("动画项目缺少场景或对象")
    if len(workspace["objects"]) > MAX_OBJECTS: raise ToolError("动画对象超过 500 个限制")
    clean = _sample_workspace()
    clean["id"], clean["name"] = _id("animation-project"), f"{_clean(workspace.get('name'), 180) or '导入动画'}（导入副本）"
    clean["description"] = _clean(workspace.get("description"), 1000)
    clean["scenes"], clean["objects"], clean["keyframes"], clean["cameras"] = [], [], [], []
    scene_map: dict[str, str] = {}
    object_map: dict[str, str] = {}
    for index, row in enumerate(workspace["scenes"]):
        if not isinstance(row, dict): continue
        old_id, new_id = _clean(row.get("id"), 120) or f"scene-{index}", _id("scene")
        scene_map[old_id] = new_id
        clean["scenes"].append({"id": new_id, "name": _clean(row.get("name"), 160) or f"场景 {index + 1}", "order": index + 1, "duration": max(0.1, min(600, float(row.get("duration", 10)))), "fps": max(1, min(120, int(row.get("fps", 30)))), "width": max(320, min(4096, int(row.get("width", 960)))), "height": max(180, min(2160, int(row.get("height", 540)))), "background": _clean(row.get("background"), 30) or "#071426", "cameraId": "", "status": "imported"})
    for index, row in enumerate(workspace["objects"]):
        if not isinstance(row, dict) or row.get("type") not in OBJECT_TYPES or row.get("sceneId") not in scene_map: continue
        old_id, new_id = _clean(row.get("id"), 120) or f"object-{index}", _id("object")
        object_map[old_id] = new_id
        props = row.get("props", {}) if isinstance(row.get("props"), dict) else {}
        clean["objects"].append({"id": new_id, "sceneId": scene_map[row["sceneId"]], "type": row["type"], "name": _clean(row.get("name"), 160) or f"对象 {index + 1}", "parentId": "", "locked": bool(row.get("locked")), "hidden": bool(row.get("hidden")), "order": index + 1, "props": {key: value for key, value in props.items() if key in {"x", "y", "x1", "y1", "x2", "y2", "width", "height", "radius", "text", "fontSize", "fill", "stroke", "strokeWidth", "opacity", "scale", "rotation", "d"} and isinstance(value, (str, int, float, bool))}})
    for row in workspace.get("keyframes", []):
        if not isinstance(row, dict) or row.get("objectId") not in object_map or row.get("sceneId") not in scene_map: continue
        easing = _clean(row.get("easing"), 30)
        clean["keyframes"].append({"id": _id("keyframe"), "sceneId": scene_map[row["sceneId"]], "objectId": object_map[row["objectId"]], "property": _clean(row.get("property"), 60), "time": max(0, float(row.get("time", 0))), "value": row.get("value") if isinstance(row.get("value"), (str, int, float, bool)) else 0, "easing": easing if easing in EASINGS else "linear"})
    for scene in clean["scenes"]:
        camera = {"id": _id("camera"), "sceneId": scene["id"], "name": "导入镜头", "x": scene["width"] / 2, "y": scene["height"] / 2, "zoom": 1, "rotation": 0, "projection": "orthographic"}
        clean["cameras"].append(camera); scene["cameraId"] = camera["id"]
    if not clean["scenes"]: raise ToolError("导入项目没有有效场景")
    clean["currentSceneId"] = clean["scenes"][0]["id"]
    clean["selectedObjectId"] = clean["objects"][0]["id"] if clean["objects"] else ""
    clean["dataSources"], clean["bindings"], clean["narration"], clean["renderJobs"], clean["snapshots"], clean["audit"] = [], [], [], [], [], []
    return clean


def run_scientific_animation(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action in {"load-sample", "run-all"}: return _result(_sample_workspace(), action)
    actor_role = _clean(payload.get("actorRole"), 30) or "owner"
    if action in MUTATING_ACTIONS and actor_role not in {"owner", "editor", "service"}:
        raise ToolError("当前角色没有修改动画项目的权限")
    workspace = _bundle(payload)
    actor = _clean(payload.get("actor"), 80) or "当前创作者"
    scene = _find(workspace.get("scenes", []), workspace.get("currentSceneId", ""), "当前场景")
    if action == "select-scene":
        scene = _find(workspace["scenes"], _clean(payload.get("sceneId"), 120), "场景")
        workspace["currentSceneId"] = scene["id"]; workspace["currentTime"] = 0
        workspace["selectedObjectId"] = next((item["id"] for item in workspace.get("objects", []) if item.get("sceneId") == scene["id"]), "")
    elif action == "create-scene":
        name = _clean(payload.get("name"), 160) or "新场景"
        camera_id, scene_id = _id("camera"), _id("scene")
        scene = {"id": scene_id, "name": name, "order": len(workspace["scenes"]) + 1, "duration": max(1, min(600, float(payload.get("duration", 8)))), "fps": 30, "width": 960, "height": 540, "background": "#071426", "cameraId": camera_id, "status": "draft"}
        workspace["scenes"].append(scene); workspace["cameras"].append({"id": camera_id, "sceneId": scene_id, "name": "主镜头", "x": 480, "y": 270, "zoom": 1, "rotation": 0, "projection": "orthographic"}); workspace["currentSceneId"] = scene_id; workspace["currentTime"] = 0; workspace["selectedObjectId"] = ""
        _audit(workspace, action, actor, scene_id, f"创建场景 {name}")
    elif action == "update-scene":
        for key in ["name", "background", "status"]:
            if key in payload: scene[key] = _clean(payload.get(key), 160)
        for key, lower, upper in [("duration", .1, 600), ("fps", 1, 120), ("width", 320, 4096), ("height", 180, 2160)]:
            if key in payload: scene[key] = max(lower, min(upper, float(payload[key])))
        _audit(workspace, action, actor, scene["id"], "更新场景画幅、时长或状态")
    elif action == "select-object":
        item = _find(workspace["objects"], _clean(payload.get("objectId"), 120), "对象"); workspace["selectedObjectId"] = item["id"]
    elif action == "add-object":
        object_type = _clean(payload.get("type"), 30) or "text"
        if object_type not in OBJECT_TYPES: raise ToolError("对象类型不在安全白名单")
        if len(workspace["objects"]) >= MAX_OBJECTS: raise ToolError("动画对象超过 500 个限制")
        props = {"x": 240, "y": 180, "width": 180, "height": 90, "radius": 42, "text": "新对象", "fontSize": 24, "fill": "#55d6df", "stroke": "#dffcff", "strokeWidth": 2, "opacity": 1, "scale": 1, "rotation": 0}
        props.update(payload.get("props", {}) if isinstance(payload.get("props"), dict) else {})
        item = {"id": _id("object"), "sceneId": scene["id"], "type": object_type, "name": _clean(payload.get("name"), 160) or "新对象", "parentId": "", "locked": False, "hidden": False, "order": len([row for row in workspace["objects"] if row.get("sceneId") == scene["id"]]) + 1, "props": props}
        workspace["objects"].append(item); workspace["selectedObjectId"] = item["id"]; _audit(workspace, action, actor, item["id"], f"添加 {object_type} 对象")
    elif action == "update-object":
        item = _find(workspace["objects"], _clean(payload.get("objectId"), 120), "对象")
        if item.get("locked") and not bool(payload.get("unlock")): raise ToolError("对象已锁定")
        if "name" in payload: item["name"] = _clean(payload.get("name"), 160)
        if "hidden" in payload: item["hidden"] = bool(payload.get("hidden"))
        if "locked" in payload: item["locked"] = bool(payload.get("locked"))
        updates = payload.get("props", {})
        if isinstance(updates, dict):
            for key, value in updates.items():
                if key in {"x", "y", "x1", "y1", "x2", "y2", "width", "height", "radius", "fontSize", "strokeWidth", "opacity", "scale", "rotation"}: item["props"][key] = float(value)
                elif key in {"text", "fill", "stroke", "d"}: item["props"][key] = _clean(value, 4000 if key == "d" else 1000)
        workspace["selectedObjectId"] = item["id"]; _audit(workspace, action, actor, item["id"], "更新对象属性")
    elif action == "delete-object":
        item = _find(workspace["objects"], _clean(payload.get("objectId"), 120), "对象")
        if item.get("locked"): raise ToolError("锁定对象不能删除")
        workspace["objects"] = [row for row in workspace["objects"] if row["id"] != item["id"]]
        workspace["keyframes"] = [row for row in workspace["keyframes"] if row.get("objectId") != item["id"]]
        workspace["selectedObjectId"] = ""; _audit(workspace, action, actor, item["id"], "删除对象及其关键帧")
    elif action in {"add-keyframe", "update-keyframe"}:
        if action == "add-keyframe":
            item = _find(workspace["objects"], _clean(payload.get("objectId"), 120), "对象")
            frame = {"id": _id("keyframe"), "sceneId": scene["id"], "objectId": item["id"], "property": _clean(payload.get("property"), 60) or "opacity", "time": max(0, min(float(scene["duration"]), float(payload.get("time", workspace.get("currentTime", 0))))), "value": payload.get("value", item.get("props", {}).get(_clean(payload.get("property"), 60), 1)), "easing": _clean(payload.get("easing"), 30) or "smooth"}
            if frame["easing"] not in EASINGS: raise ToolError("缓动类型无效")
            workspace["keyframes"].append(frame)
        else:
            frame = _find(workspace["keyframes"], _clean(payload.get("keyframeId"), 120), "关键帧")
            if "time" in payload: frame["time"] = max(0, min(float(scene["duration"]), float(payload["time"])))
            if "value" in payload: frame["value"] = payload["value"]
            if "easing" in payload and _clean(payload["easing"], 30) in EASINGS: frame["easing"] = _clean(payload["easing"], 30)
        _audit(workspace, action, actor, frame["id"], f"更新 {frame['property']} 关键帧")
    elif action == "remove-keyframe":
        frame = _find(workspace["keyframes"], _clean(payload.get("keyframeId"), 120), "关键帧")
        workspace["keyframes"] = [row for row in workspace["keyframes"] if row["id"] != frame["id"]]; _audit(workspace, action, actor, frame["id"], "删除关键帧")
    elif action == "reorder-layer":
        item = _find(workspace["objects"], _clean(payload.get("objectId"), 120), "对象"); item["order"] = max(1, int(payload.get("order", item.get("order", 1)))); _audit(workspace, action, actor, item["id"], f"图层顺序调整为 {item['order']}")
    elif action == "update-camera":
        camera = _find(workspace["cameras"], scene.get("cameraId", ""), "相机")
        for key in ["x", "y", "zoom", "rotation"]:
            if key in payload: camera[key] = float(payload[key])
        _audit(workspace, action, actor, camera["id"], "更新相机位置、缩放或旋转")
    elif action == "seek":
        workspace["currentTime"] = max(0, min(float(scene["duration"]), float(payload.get("time", 0))))
    elif action == "create-snapshot":
        snapshot = {"id": _id("snapshot"), "label": _clean(payload.get("label"), 180) or f"动画版本 {workspace.get('version', 1)}", "version": workspace.get("version", 1), "createdAt": _now(), "sceneIds": [item["id"] for item in workspace.get("scenes", [])]}
        workspace.setdefault("snapshots", []).insert(0, snapshot); _audit(workspace, action, actor, snapshot["id"], f"创建分镜快照 {snapshot['label']}")
    elif action == "import-project":
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip(): raise ToolError("导入内容不能为空")
        workspace = _import_workspace(content); _audit(workspace, action, actor, workspace["id"], "安全导入动画项目并重建全部标识")
    elif action == "prepare-render":
        profile = _find(workspace["renderProfiles"], _clean(payload.get("profileId"), 120) or "video-hd", "渲染配置")
        job = {"id": _id("render"), "sceneId": scene["id"], "profileId": profile["id"], "status": "prepared" if profile.get("status") == "runtime-required" else "preview-ready", "createdAt": _now(), "finishedAt": "", "checksum": "", "artifact": "", "runtimeRequired": profile.get("status") == "runtime-required"}
        workspace.setdefault("renderJobs", []).insert(0, job); _audit(workspace, action, actor, job["id"], f"准备 {profile['name']} 渲染任务，未声明外部运行完成")
    elif action == "record-render":
        job = _find(workspace.get("renderJobs", []), _clean(payload.get("renderJobId"), 120), "渲染任务")
        checksum, artifact = _clean(payload.get("checksum"), 180), _clean(payload.get("artifact"), 300)
        if not checksum.startswith("sha256:") or not artifact: raise ToolError("渲染回执必须包含 SHA-256 和产物引用")
        job.update({"status": "succeeded", "finishedAt": _now(), "checksum": checksum, "artifact": artifact}); _audit(workspace, action, actor, job["id"], "登记隔离渲染节点回执")
    elif action in {"render-preview", "validate-scene", "create-storyboard", "runtime-status", "export"}:
        if "time" in payload: workspace["currentTime"] = max(0, min(float(scene["duration"]), float(payload["time"])))
        _audit(workspace, action, actor, scene["id"], {"render-preview": "编译网页预览帧", "validate-scene": "检查场景、关键帧、数据绑定和外部渲染状态", "create-storyboard": "生成三场景分镜", "runtime-status": "检查网页、ManimGL、FFmpeg、LaTeX 与对象存储运行时", "export": "生成项目、ManimGL 脚本、时间轴、分镜与完整工程包"}[action])
    else:
        raise ToolError("不支持的科学动画操作")
    return _result(workspace, action)
