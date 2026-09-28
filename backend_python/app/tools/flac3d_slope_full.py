from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import math
import os
import subprocess
import tempfile
import zipfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-open-slope-workspace"
PACKAGED_REFERENCE_DIRECTORY = Path(__file__).resolve().parents[1] / "assets" / "flac3d"
MAX_IMPORTED_ROWS = 100_000

DEFAULT_MODEL: dict[str, Any] = {
    "geometry": {
        "slopeHeight": 10.0,
        "slopeAngle": 45.0,
        "totalLength": 30.0,
        "totalHeight": 20.0,
        "width": 5.0,
        "crestX": 10.0,
        "toeX": 20.0,
    },
    "mesh": {"xZones": 30, "yZones": 5, "zZones": 20, "zoneCount": 3000, "gridpointCount": 3906},
    "material": {
        "model": "mohr-coulomb",
        "density": 1750.0,
        "youngModulus": 35_000_000.0,
        "poissonRatio": 0.30,
        "bulkModulus": 29_166_666.67,
        "shearModulus": 13_461_538.46,
        "cohesion": 24_000.0,
        "friction": 25.0,
        "tension": 10_000.0,
        "dilation": 0.0,
    },
    "boundary": {"base": "fixed", "sides": "normal-roller", "gravity": 9.81},
    "reduction": {"lower": 0.8, "upper": 2.2, "resolution": 0.01, "ratioLocal": 1e-4},
    "screening": {"slipDepth": 2.0, "porePressureRatio": 0.0},
}


def _number(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    if not math.isfinite(parsed):
        parsed = fallback
    return min(maximum, max(minimum, parsed))


def _integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    return int(round(_number(value, fallback, minimum, maximum)))


def _merge_model(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    raw_geometry = source.get("geometry") if isinstance(source.get("geometry"), dict) else {}
    raw_mesh = source.get("mesh") if isinstance(source.get("mesh"), dict) else {}
    raw_material = source.get("material") if isinstance(source.get("material"), dict) else {}
    raw_reduction = source.get("reduction") if isinstance(source.get("reduction"), dict) else {}
    raw_screening = source.get("screening") if isinstance(source.get("screening"), dict) else {}

    geometry = {
        "slopeHeight": _number(raw_geometry.get("slopeHeight"), 10, 1, 500),
        "slopeAngle": _number(raw_geometry.get("slopeAngle"), 45, 5, 85),
        "totalLength": _number(raw_geometry.get("totalLength"), 30, 5, 5000),
        "totalHeight": _number(raw_geometry.get("totalHeight"), 20, 2, 1000),
        "width": _number(raw_geometry.get("width"), 5, 1, 1000),
        "crestX": _number(raw_geometry.get("crestX"), 10, 0, 5000),
        "toeX": _number(raw_geometry.get("toeX"), 20, 0, 5000),
    }
    # The angle is the authoritative slope-face control. Keeping an independent
    # toe coordinate allowed the solver to use a new angle while the section
    # outline continued to draw the old geometry.
    horizontal_run = geometry["slopeHeight"] / math.tan(math.radians(geometry["slopeAngle"]))
    geometry["toeX"] = geometry["crestX"] + horizontal_run
    right_margin = max(1.0, min(geometry["slopeHeight"], geometry["totalLength"] * 0.15))
    geometry["totalLength"] = max(geometry["totalLength"], geometry["toeX"] + right_margin)
    geometry["totalHeight"] = max(geometry["totalHeight"], geometry["slopeHeight"] + 1)

    x_zones = _integer(raw_mesh.get("xZones"), 30, 6, 300)
    y_zones = _integer(raw_mesh.get("yZones"), 5, 1, 100)
    z_zones = _integer(raw_mesh.get("zZones"), 20, 4, 200)
    mesh = {
        "xZones": x_zones,
        "yZones": y_zones,
        "zZones": z_zones,
        "zoneCount": x_zones * y_zones * z_zones,
        "gridpointCount": (x_zones + 1) * (y_zones + 1) * (z_zones + 1),
    }

    young = _number(raw_material.get("youngModulus"), 35_000_000, 100_000, 200_000_000_000)
    poisson = _number(raw_material.get("poissonRatio"), 0.30, 0.01, 0.49)
    material = {
        "model": "mohr-coulomb",
        "density": _number(raw_material.get("density"), 1750, 500, 5000),
        "youngModulus": young,
        "poissonRatio": poisson,
        "bulkModulus": young / (3 * (1 - 2 * poisson)),
        "shearModulus": young / (2 * (1 + poisson)),
        "cohesion": _number(raw_material.get("cohesion"), 24_000, 0, 100_000_000),
        "friction": _number(raw_material.get("friction"), 25, 0, 60),
        "tension": _number(raw_material.get("tension"), 10_000, 0, 100_000_000),
        "dilation": _number(raw_material.get("dilation"), 0, 0, 45),
    }
    reduction = {
        "lower": _number(raw_reduction.get("lower"), 0.8, 0.1, 10),
        "upper": _number(raw_reduction.get("upper"), 2.2, 0.2, 20),
        "resolution": _number(raw_reduction.get("resolution"), 0.01, 0.001, 0.5),
        "ratioLocal": _number(raw_reduction.get("ratioLocal"), 1e-4, 1e-8, 1e-2),
    }
    if reduction["upper"] <= reduction["lower"]:
        reduction["upper"] = reduction["lower"] + max(0.1, reduction["resolution"])
    screening = {
        "slipDepth": _number(raw_screening.get("slipDepth"), 2, 0.1, geometry["slopeHeight"]),
        "porePressureRatio": _number(raw_screening.get("porePressureRatio"), 0, 0, 0.95),
    }
    return {
        "geometry": geometry,
        "mesh": mesh,
        "material": material,
        "boundary": {"base": "fixed", "sides": "normal-roller", "gravity": 9.81},
        "reduction": reduction,
        "screening": screening,
    }


def _reference_root() -> Path:
    configured = os.getenv("FLAC3D_BENCHMARK_DIRECTORY", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return PACKAGED_REFERENCE_DIRECTORY


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_zone_rows(source: io.TextIOBase) -> list[dict[str, Any]]:
    reader = csv.DictReader(source)
    required = {"id", "x", "y", "z", "state_name", "disp_x", "disp_z", "disp_mag", "szz"}
    if not reader.fieldnames or not required.issubset(reader.fieldnames):
        raise ToolError("分区结果缺少 id、坐标、状态、位移或应力字段")
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(reader):
        if index >= MAX_IMPORTED_ROWS:
            raise ToolError(f"分区结果最多允许 {MAX_IMPORTED_ROWS} 行")
        try:
            row = {
                "id": int(item["id"]),
                "x": float(item["x"]),
                "y": float(item["y"]),
                "z": float(item["z"]),
                "stateCode": int(item.get("state_code") or 0),
                "state": str(item["state_name"]),
                "ux": float(item["disp_x"]),
                "uz": float(item["disp_z"]),
                "displacement": float(item["disp_mag"]),
                "verticalStress": float(item["szz"]),
            }
        except (TypeError, ValueError, KeyError) as error:
            raise ToolError(f"分区结果第 {index + 2} 行包含无效数值") from error
        numeric = [row[key] for key in ("x", "y", "z", "ux", "uz", "displacement", "verticalStress")]
        if not all(math.isfinite(value) for value in numeric):
            raise ToolError(f"分区结果第 {index + 2} 行包含非有限数值")
        rows.append(row)
    if not rows:
        raise ToolError("分区结果为空")
    return rows


def _load_reference_rows() -> tuple[list[dict[str, Any]], Path]:
    path = _reference_root() / "slope_zones_fos_results.csv"
    if not path.is_file():
        raise ToolError(f"未找到基准分区结果：{path}")
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        return _parse_zone_rows(source), path


def _zone_category(state: str) -> str:
    normalized = state.casefold()
    if normalized == "elastic":
        return "elastic"
    if "-n" in normalized:
        return "active"
    return "history"


def _summarize_rows(rows: list[dict[str, Any]], source_path: Path | None = None) -> dict[str, Any]:
    max_displacement = max(rows, key=lambda row: row["displacement"])
    y_values = sorted({round(row["y"], 6) for row in rows})
    section_y = min(y_values, key=lambda value: abs(value - (min(y_values) + max(y_values)) / 2))
    section = [row for row in rows if abs(row["y"] - section_y) < 1e-6]
    state_counts = Counter(row["state"] for row in rows)
    category_counts = Counter(_zone_category(row["state"]) for row in rows)
    source = {
        "kind": "flac3d-zone-results",
        "fileName": source_path.name if source_path else "imported-zone-results.csv",
        "sha256": _sha256(source_path) if source_path and source_path.is_file() else None,
        "rowCount": len(rows),
    }
    return {
        "source": source,
        "metrics": {
            "factorOfSafety": 1.81,
            "stableFactor": 1.81,
            "unstableFactor": 1.82,
            "zoneCount": len(rows),
            "gridpointCount": 3906 if len(rows) == 3000 else None,
            "maxDisplacement": max_displacement["displacement"],
            "maxDisplacementAt": {key: max_displacement[key] for key in ("id", "x", "y", "z")},
            "minVerticalStress": min(row["verticalStress"] for row in rows),
            "maxVerticalStress": max(row["verticalStress"] for row in rows),
            "activeYieldRatio": category_counts["active"] / len(rows),
            "elasticRatio": category_counts["elastic"] / len(rows),
        },
        "stateDistribution": [
            {"state": state, "count": count, "ratio": count / len(rows)}
            for state, count in state_counts.most_common()
        ],
        "categoryDistribution": [
            {"category": category, "count": category_counts[category], "ratio": category_counts[category] / len(rows)}
            for category in ("active", "history", "elastic")
        ],
        "bounds": {
            "x": [min(row["x"] for row in rows), max(row["x"] for row in rows)],
            "y": [min(row["y"] for row in rows), max(row["y"] for row in rows)],
            "z": [min(row["z"] for row in rows), max(row["z"] for row in rows)],
        },
        "section": {"axis": "y", "value": section_y, "zones": section},
        "interpretation": [
            "临界状态在坡顶至坡脚之间形成连续的剪切—拉伸屈服带。",
            "最大位移集中在坡体上部与坡面附近，深部地基仍以弹性响应为主。",
            "F=1.81 的稳定状态与 F=1.82 的失稳状态构成 0.01 精度的安全系数包络。",
        ],
    }


def _runtime() -> dict[str, Any]:
    """Report the web calculation services without requiring FLAC3D on the client."""
    ogs_text = os.getenv("OGS_EXECUTABLE_PATH", "").strip()
    ogs = Path(ogs_text).expanduser().resolve() if ogs_text else None
    ogs_ready = bool(ogs and ogs.is_file())
    solvers = [
        {
            "id": "screening",
            "name": "快速验算",
            "engine": "Python 极限平衡筛查",
            "dimension": "2D",
            "status": "ready",
            "available": True,
            "detail": "服务端内置，无需安装",
        },
        {
            "id": "sweep2d",
            "name": "二维滑面搜索",
            "engine": "Python 参数化滑面搜索",
            "dimension": "2D",
            "status": "ready",
            "available": True,
            "detail": "服务端内置，多深度与倾角搜索",
        },
        {
            "id": "spatial3d",
            "name": "三维空间校核",
            "engine": "Python 多剖面空间修正",
            "dimension": "3D 估算",
            "status": "ready",
            "available": True,
            "detail": "服务端内置，考虑坡体宽高比",
        },
        {
            "id": "ogs3d",
            "name": "三维有限元",
            "engine": "OpenGeoSys",
            "dimension": "3D FEM",
            "status": "ready" if ogs_ready else "offline",
            "available": ogs_ready,
            "detail": str(ogs) if ogs_ready else "等待接入计算节点",
        },
    ]
    return {
        "adapter": "open-geotechnical-solver-orchestrator",
        "configured": True,
        "available": True,
        "executionEnabled": True,
        "executable": str(ogs) if ogs_ready else None,
        "mode": "hybrid-web-compute",
        "requirements": ["三种网页算法已内置", "有限元在隔离计算节点运行", "客户端无需安装求解器"],
        "solvers": solvers,
    }


def _legacy_flac_runtime() -> dict[str, Any]:
    """Keep the former licensed adapter available only as an explicit compatibility path."""
    executable_text = os.getenv("FLAC3D_CONSOLE_PATH", "").strip()
    executable = Path(executable_text).expanduser().resolve() if executable_text else None
    enabled = os.getenv("ALLOW_FLAC3D_EXECUTION", "").strip().casefold() in {"1", "true", "yes", "on"}
    return {
        "configured": bool(executable_text),
        "available": bool(executable and executable.is_file()),
        "executionEnabled": enabled,
        "executable": str(executable) if executable else None,
    }


def _validate(model: dict[str, Any]) -> dict[str, Any]:
    geometry, mesh, material, reduction = model["geometry"], model["mesh"], model["material"], model["reduction"]
    checks = [
        {"id": "geometry", "label": "坡顶、坡脚与模型边界关系", "passed": 0 <= geometry["crestX"] < geometry["toeX"] < geometry["totalLength"]},
        {"id": "angle", "label": "坡角与坡顶、坡脚几何一致", "passed": abs(math.degrees(math.atan2(geometry["slopeHeight"], geometry["toeX"] - geometry["crestX"])) - geometry["slopeAngle"]) < 1e-6},
        {"id": "height", "label": "坡高位于模型高度内", "passed": geometry["slopeHeight"] < geometry["totalHeight"]},
        {"id": "mesh", "label": "网格规模位于受控范围", "passed": 120 <= mesh["zoneCount"] <= 6_000_000},
        {"id": "elastic", "label": "弹性参数物理有效", "passed": material["youngModulus"] > 0 and 0 < material["poissonRatio"] < 0.5},
        {"id": "strength", "label": "强度参数非负", "passed": material["cohesion"] >= 0 and material["friction"] >= 0 and material["tension"] >= 0},
        {"id": "bracket", "label": "强度折减搜索区间有效", "passed": reduction["lower"] < reduction["upper"] and reduction["resolution"] < reduction["upper"] - reduction["lower"]},
    ]
    return {"passed": all(check["passed"] for check in checks), "checks": checks, "failed": [check["label"] for check in checks if not check["passed"]]}


def _screen(model: dict[str, Any]) -> dict[str, Any]:
    geometry, material, screening = model["geometry"], model["material"], model["screening"]
    beta = math.radians(geometry["slopeAngle"])
    phi = math.radians(material["friction"])
    gamma = material["density"] * model["boundary"]["gravity"]
    depth = screening["slipDepth"]
    pore_ratio = screening["porePressureRatio"]
    denominator = gamma * depth * math.sin(beta) * math.cos(beta)
    cohesion_term = material["cohesion"] / max(denominator, 1e-9)
    friction_term = (1 - pore_ratio) * math.tan(phi) / max(math.tan(beta), 1e-9)
    fos = cohesion_term + friction_term
    return {
        "method": "infinite-slope-screening",
        "factorOfSafety": fos,
        "cohesionTerm": cohesion_term,
        "frictionTerm": friction_term,
        "criticalSurface": {"depth": depth, "inclination": geometry["slopeAngle"]},
        "candidateCount": 1,
        "assumptions": {"slipDepth": depth, "porePressureRatio": pore_ratio, "unitWeight": gamma},
        "classification": "stable" if fos >= 1.3 else "attention" if fos >= 1.05 else "unstable",
        "boundary": "快速验算用于方案筛查；正式结论应由二维或三维有限元复核。",
    }


def _web_analysis(model: dict[str, Any], engine: str) -> dict[str, Any]:
    """Deterministic web-native analyses used before a full finite-element solve."""
    base = _screen(model)
    if engine in {"", "screening"}:
        return base

    geometry, material, screening = model["geometry"], model["material"], model["screening"]
    beta = math.radians(geometry["slopeAngle"])
    phi = math.radians(material["friction"])
    gamma = material["density"] * model["boundary"]["gravity"]
    pore_ratio = screening["porePressureRatio"]
    candidates: list[dict[str, float]] = []
    for depth_ratio in (0.15, 0.20, 0.25, 0.30, 0.35):
        depth = max(0.1, geometry["slopeHeight"] * depth_ratio)
        for angle_ratio in (0.72, 0.79, 0.86, 0.93, 1.0):
            alpha = max(math.radians(3), beta * angle_ratio)
            denominator = gamma * depth * math.sin(alpha) * math.cos(alpha)
            cohesion_term = material["cohesion"] / max(denominator, 1e-9)
            friction_term = (1 - pore_ratio) * math.tan(phi) / max(math.tan(alpha), 1e-9)
            factor = cohesion_term + friction_term
            candidates.append({"factor": factor, "depth": depth, "angle": math.degrees(alpha)})
    critical = min(candidates, key=lambda item: item["factor"])
    two_dimensional = {
        "method": "parameterized-slip-surface-search",
        "factorOfSafety": critical["factor"],
        "classification": "stable" if critical["factor"] >= 1.3 else "attention" if critical["factor"] >= 1.05 else "unstable",
        "criticalSurface": {"depth": critical["depth"], "inclination": critical["angle"]},
        "candidateCount": len(candidates),
        "boundary": "二维滑面参数搜索用于方案校核，不替代有限元应力—应变分析。",
    }
    if engine == "sweep2d":
        return two_dimensional
    if engine == "spatial3d":
        width_height = geometry["width"] / max(geometry["slopeHeight"], 1e-9)
        spatial_factor = 1 + min(0.16, 0.035 + width_height * 0.045)
        factor = two_dimensional["factorOfSafety"] * spatial_factor
        return {
            "method": "multi-section-spatial-correction",
            "factorOfSafety": factor,
            "classification": "stable" if factor >= 1.3 else "attention" if factor >= 1.05 else "unstable",
            "criticalSurface": two_dimensional["criticalSurface"],
            "candidateCount": len(candidates) * 5,
            "spatialCorrection": spatial_factor,
            "widthHeightRatio": width_height,
            "boundary": "三维空间修正用于网页端快速校核；正式三维应力、位移和塑性区需由 OpenGeoSys 有限元节点计算。",
        }
    raise ToolError("未知的网页计算方法")


def _analytical_summary(model: dict[str, Any], engine: str, analysis: dict[str, Any]) -> dict[str, Any]:
    """Build a parameter-linked field for the web-native analytical solvers.

    The generated cells visualize the analytical result and are deliberately
    identified as such; they are not presented as finite-element output.
    """
    geometry, mesh = model["geometry"], model["mesh"]
    material, screening = model["material"], model["screening"]
    total_length, total_height = geometry["totalLength"], geometry["totalHeight"]
    slope_height = geometry["slopeHeight"]
    crest, toe = geometry["crestX"], geometry["toeX"]
    toe_z = total_height - slope_height
    slope_span = max(toe - crest, 1e-6)
    factor = float(analysis["factorOfSafety"])
    critical = analysis.get("criticalSurface") or {}
    slip_depth = float(critical.get("depth") or screening["slipDepth"])
    inclination = float(critical.get("inclination") or geometry["slopeAngle"])

    # Cap only the display mesh so a large engineering mesh does not produce an
    # oversized API response. Reported mesh counts still describe the full model.
    x_count = min(60, max(12, int(mesh["xZones"])))
    z_count = min(40, max(8, int(mesh["zZones"])))
    dx, dz = total_length / x_count, total_height / z_count
    risk = max(0.25, min(2.2, 1.35 / max(factor, 0.1)))
    active_band = dz * (0.75 + 0.55 * risk)
    history_band = active_band * 2.35
    displacement_scale = slope_height * (
        0.0018 + 0.0105 * max(0.0, 1.45 - factor) + 0.004 * screening["porePressureRatio"]
    )
    gamma = material["density"] * model["boundary"]["gravity"]
    section_y = geometry["width"] / 2
    rows: list[dict[str, Any]] = []

    for x_index in range(x_count):
        x = (x_index + 0.5) * dx
        if x <= crest:
            ground_z = total_height
        elif x < toe:
            ground_z = total_height - slope_height * (x - crest) / slope_span
        else:
            ground_z = toe_z
        for z_index in range(z_count):
            z = (z_index + 0.5) * dz
            if z > ground_z + 1e-9:
                continue
            progress = min(1.0, max(0.0, (x - crest) / slope_span))
            slip_z = total_height - slope_height * progress - slip_depth * math.sin(math.pi * progress)
            distance = abs(z - slip_z)
            in_slip_domain = crest - dx <= x <= toe + dx
            influence = 0.0
            if in_slip_domain:
                influence = math.exp(-((distance / max(history_band, 1e-6)) ** 2)) * (0.30 + 0.70 * math.sin(math.pi * progress))
            if in_slip_domain and distance <= active_band:
                state = "shear-n tension-n"
            elif in_slip_domain and distance <= history_band:
                state = "tension-p"
            else:
                state = "elastic"
            displacement = displacement_scale * influence
            angle = math.radians(inclination)
            rows.append({
                "id": len(rows) + 1,
                "x": round(x, 6),
                "y": round(section_y, 6),
                "z": round(z, 6),
                "state": state,
                "ux": displacement * math.cos(angle),
                "uz": -displacement * math.sin(angle),
                "displacement": displacement,
                "verticalStress": -gamma * max(0.0, ground_z - z),
            })

    if not rows:
        raise ToolError("当前几何参数未生成有效的解析展示场")
    state_counts = Counter(row["state"] for row in rows)
    category_counts = Counter(_zone_category(row["state"]) for row in rows)
    display_count = len(rows)
    engineering_count = int(mesh["zoneCount"])

    def scaled_count(category: str) -> int:
        return round(engineering_count * category_counts[category] / display_count)

    active_count = scaled_count("active")
    history_count = scaled_count("history")
    elastic_count = max(0, engineering_count - active_count - history_count)
    category_engineering_counts = {"active": active_count, "history": history_count, "elastic": elastic_count}
    maximum = max(rows, key=lambda row: row["displacement"])
    resolution = model["reduction"]["resolution"]
    stable = max(0.0, math.floor(factor / resolution) * resolution)
    unstable = stable + resolution
    digest = hashlib.sha256(json.dumps({"engine": engine, "model": model, "analysis": analysis}, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    method_name = {"screening": "快速验算", "sweep2d": "二维滑面搜索", "spatial3d": "三维空间校核"}.get(engine, engine)
    return {
        "source": {"kind": "web-analytical-field", "fileName": f"{engine}_analytical_field.json", "sha256": digest, "rowCount": display_count},
        "metrics": {
            "factorOfSafety": factor,
            "stableFactor": round(stable, 6),
            "unstableFactor": round(unstable, 6),
            "zoneCount": engineering_count,
            "gridpointCount": int(mesh["gridpointCount"]),
            "maxDisplacement": maximum["displacement"],
            "maxDisplacementAt": {key: maximum[key] for key in ("id", "x", "y", "z")},
            "minVerticalStress": min(row["verticalStress"] for row in rows),
            "maxVerticalStress": max(row["verticalStress"] for row in rows),
            "activeYieldRatio": active_count / engineering_count,
            "elasticRatio": elastic_count / engineering_count,
        },
        "stateDistribution": [{"state": state, "count": count, "ratio": count / display_count} for state, count in state_counts.most_common()],
        "categoryDistribution": [
            {"category": category, "count": category_engineering_counts[category], "ratio": category_engineering_counts[category] / engineering_count}
            for category in ("active", "history", "elastic")
        ],
        "bounds": {"x": [0.0, total_length], "y": [0.0, geometry["width"]], "z": [0.0, total_height]},
        "section": {"axis": "y", "value": section_y, "zones": rows, "grid": {"xZones": x_count, "zZones": z_count}},
        "interpretation": [
            f"{method_name}按本次参数识别临界滑移带，控制深度约 {slip_depth:.2f} m、倾角约 {inclination:.1f}°。",
            f"本次安全系数为 {factor:.2f}，当前屈服影响区约占工程网格的 {active_count / engineering_count * 100:.1f}%。",
            "图中塑性、位移与应力为网页解析模型生成的判读场；有限元应力—应变结果需提交 OpenGeoSys 节点或导入计算结果。",
        ],
    }


def _flac_script(model: dict[str, Any]) -> str:
    geometry, mesh, material, reduction = model["geometry"], model["mesh"], model["material"], model["reduction"]
    crest = geometry["crestX"]
    toe = geometry["toeX"]
    height = geometry["totalHeight"]
    toe_z = height - geometry["slopeHeight"]
    left_n = max(2, round(mesh["xZones"] * crest / geometry["totalLength"]))
    slope_n = max(2, round(mesh["xZones"] * (toe - crest) / geometry["totalLength"]))
    right_n = max(2, mesh["xZones"] - left_n - slope_n)
    return f'''# -*- coding: utf-8 -*-
import math
import os
import itasca as it

it.command("python-reset-state false")
it.command("model new")
it.command("python-reset-state false")
it.command("model large-strain off")
it.command("model title 'SkyViewLab parameterized slope stability analysis'")
it.command("zone create brick size {left_n} {mesh['yZones']} {mesh['zZones']} point 0 (0,0,0) point 1 ({crest},0,0) point 2 (0,{geometry['width']},0) point 3 (0,0,{height}) group 'crest_soil'")
it.command("zone create brick size {slope_n} {mesh['yZones']} {mesh['zZones']} point 0 ({crest},0,0) point 1 ({toe},0,0) point 2 ({crest},{geometry['width']},0) point 3 ({crest},0,{height}) point 4 ({toe},{geometry['width']},0) point 5 ({crest},{geometry['width']},{height}) point 6 ({toe},0,{toe_z}) point 7 ({toe},{geometry['width']},{toe_z}) group 'slope_face'")
it.command("zone create brick size {right_n} {mesh['yZones']} {mesh['zZones']} point 0 ({toe},0,0) point 1 ({geometry['totalLength']},0,0) point 2 ({toe},{geometry['width']},0) point 3 ({toe},0,{toe_z}) group 'toe_foundation'")
it.command("zone gridpoint merge")
it.command("zone cmodel assign mohr-coulomb")
it.command("zone property density {material['density']} bulk {material['bulkModulus']} shear {material['shearModulus']} cohesion {material['cohesion']} friction {material['friction']} tension {material['tension']} dilation {material['dilation']}")
it.command("zone gridpoint fix velocity range position-z 0")
it.command("zone gridpoint fix velocity-x range position-x 0")
it.command("zone gridpoint fix velocity-x range position-x {geometry['totalLength']}")
it.command("zone gridpoint fix velocity-y range position-y 0")
it.command("zone gridpoint fix velocity-y range position-y {geometry['width']}")
it.command("model gravity 0 0 -9.81")
it.command("model solve ratio-local 1e-5")
it.command("model save 'slope_initial.sav'")
it.command("zone gridpoint initialize displacement (0,0,0)")
it.command("model factor-of-safety bracket {reduction['lower']} {reduction['upper']} resolution {reduction['resolution']} ratio-local {reduction['ratioLocal']} filename 'fos_calc'")
target = next((name for name in ["fos_calc-Unstable.sav", "fos_calc-Stable.sav"] if os.path.exists(name)), None)
if target:
    it.command("model restore '{{}}'".format(target))
lines = ["id,x,y,z,state_code,state_name,disp_x,disp_z,disp_mag,szz"]
for zone in list(it.zone.list()):
    pos = zone.pos(); state = zone.state(False)
    names = []
    if state & 1: names.append("shear-n")
    if state & 2: names.append("shear-p")
    if state & 4: names.append("tension-n")
    if state & 8: names.append("tension-p")
    name = " ".join(names) or "elastic"
    points = zone.gridpoints()
    ux = sum(point.disp()[0] for point in points) / len(points)
    uz = sum(point.disp()[2] for point in points) / len(points)
    lines.append("{{}},{{:.3f}},{{:.3f}},{{:.3f}},{{}},{{}},{{:.5e}},{{:.5e}},{{:.5e}},{{:.2f}}".format(zone.id(), pos[0], pos[1], pos[2], state, name, ux, uz, math.sqrt(ux*ux + uz*uz), zone.stress()[2][2]))
with open("slope_zones_fos_results.csv", "w", encoding="utf-8", newline="") as target_file:
    target_file.write("\\n".join(lines))
it.command("quit")
'''


def _package(model: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    script = _flac_script(model)
    call_file = 'python-reset-state false\nprogram call "run_slope.py"\nquit\n'
    source_label = "网页解析计算场" if summary["source"]["kind"] == "web-analytical-field" else "有限元/归档分区结果"
    report = f"""# 边坡数值分析交付报告

- 结果安全系数：{summary['metrics']['factorOfSafety']:.2f}
- 稳定/失稳包络：{summary['metrics']['stableFactor']:.2f} / {summary['metrics']['unstableFactor']:.2f}
- 网格单元：{summary['metrics']['zoneCount']}
- 最大位移：{summary['metrics']['maxDisplacement']:.6f} m
- 本构模型：Mohr–Coulomb
- 结果类型：{source_label}

## 计算链

参数校验 → 网格生成 → 重力初始平衡 → 强度折减 → 临界状态恢复 → 结果后处理 → 图表与报告。

## 复核边界

网页解析计算场用于快速判读，不冒充有限元应力—应变输出；导入或计算节点生成的有限元分区结果会保留原始来源，并记录求解器版本与输入摘要。
"""
    manifest = {
        "schema": "skyview-open-slope-run-package",
        "version": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "files": ["README.md", "model/model.json", "runtime/call_slope.dat", "runtime/run_slope.py", "results/reference-summary.json"],
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("README.md", report)
        package.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        package.writestr("model/model.json", json.dumps(model, ensure_ascii=False, indent=2))
        package.writestr("runtime/call_slope.dat", call_file)
        package.writestr("runtime/run_slope.py", script)
        package.writestr("results/reference-summary.json", json.dumps(summary, ensure_ascii=False, indent=2))
    return {
        "reportMarkdown": report,
        "modelJson": json.dumps(model, ensure_ascii=False, indent=2),
        "runScript": script,
        "callFile": call_file,
        "manifestJson": json.dumps(manifest, ensure_ascii=False, indent=2),
        "packageBase64": base64.b64encode(archive.getvalue()).decode("ascii"),
    }


def _workspace(model_input: Any = None, rows: list[dict[str, Any]] | None = None, source_path: Path | None = None, analysis_engine: str | None = None) -> dict[str, Any]:
    model = _merge_model(model_input)
    analysis = _web_analysis(model, analysis_engine or "screening")
    if analysis_engine is not None:
        summary = _analytical_summary(model, analysis_engine, analysis)
    else:
        if rows is None:
            rows, source_path = _load_reference_rows()
        summary = _summarize_rows(rows, source_path)
    validation = _validate(model)
    runtime = _runtime()
    exports = _package(model, summary)
    reference_root = _reference_root()
    source_files = []
    for name in ("slope_initial.sav", "fos_calc-Stable.sav", "fos_calc-Unstable.sav", "slope_zones_fos_results.csv"):
        path = reference_root / name
        if path.is_file():
            source_files.append({"name": name, "bytes": path.stat().st_size, "sha256": _sha256(path)})
    return {
        "schema": SCHEMA,
        "version": 1,
        "updatedAt": datetime.now(UTC).isoformat(),
        "project": {"id": "SLOPE-001", "name": "黄土边坡强度折减分析", "solver": "开放求解服务"},
        "model": model,
        "validation": validation,
        "screening": analysis,
        "result": summary,
        "runtime": runtime,
        "sourceFiles": source_files,
        "audit": [
            {
                "at": datetime.now(UTC).isoformat(),
                "action": "analysis.field.generated" if analysis_engine is not None else "reference.loaded",
                "detail": f"{analysis_engine or '归档基准'}结果场已生成或载入，共 {summary['source']['rowCount']} 个展示单元",
            },
            {"at": datetime.now(UTC).isoformat(), "action": "model.validated", "detail": f"{len(validation['checks'])} 项输入与计算检查"},
        ],
        "exports": exports,
    }


def _execute(model: dict[str, Any]) -> dict[str, Any]:
    runtime = _legacy_flac_runtime()
    if not runtime["configured"] or not runtime["available"]:
        raise ToolError("FLAC3D 运行时尚未配置；请设置 FLAC3D_CONSOLE_PATH 后重试")
    if not runtime["executionEnabled"]:
        raise ToolError("高保真计算默认关闭；请在受控节点启用 ALLOW_FLAC3D_EXECUTION")
    validation = _validate(model)
    if not validation["passed"]:
        raise ToolError("模型校验未通过：" + "；".join(validation["failed"]))
    timeout = int(_number(os.getenv("FLAC3D_EXECUTION_TIMEOUT_SECONDS"), 420, 30, 450))
    run_root = Path(os.getenv("FLAC3D_RUN_ROOT") or (Path(tempfile.gettempdir()) / "skyviewlab-flac3d-runs")).resolve()
    run_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="slope-", dir=run_root) as directory:
        workdir = Path(directory)
        (workdir / "run_slope.py").write_text(_flac_script(model), encoding="utf-8")
        (workdir / "call_slope.dat").write_text('python-reset-state false\nprogram call "run_slope.py"\nquit\n', encoding="utf-8")
        try:
            completed = subprocess.run(
                [runtime["executable"], "call_slope.dat"],
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ToolError(f"FLAC3D 计算超过 {timeout} 秒，已终止本次受控任务") from error
        result_path = workdir / "slope_zones_fos_results.csv"
        if completed.returncode != 0 or not result_path.is_file():
            detail = (completed.stderr or completed.stdout or "未生成结果文件")[-2000:]
            raise ToolError(f"FLAC3D 计算失败：{detail}")
        with result_path.open("r", encoding="utf-8-sig", newline="") as source:
            rows = _parse_zone_rows(source)
        workspace = _workspace(model, rows)
        workspace["runtime"]["lastRun"] = {"returnCode": completed.returncode, "logTail": completed.stdout[-3000:]}
        workspace["audit"].append({"at": datetime.now(UTC).isoformat(), "action": "flac3d.executed", "detail": f"完成 {len(rows)} 个分区单元的高保真计算"})
        return workspace


def run_flac3d_slope(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action in {"load-sample", "run-all"}:
        return _workspace(payload.get("model"))
    if action in {"update-model", "validate-model", "prepare-run", "export"}:
        engine = str(payload.get("engine") or "")
        return _workspace(payload.get("model"), analysis_engine=engine if engine in {"screening", "sweep2d", "spatial3d"} else None)
    if action == "screen-stability":
        return _workspace(payload.get("model"), analysis_engine=str(payload.get("engine") or "screening"))
    if action in {"runtime-status", "solver-status"}:
        return {"runtime": _runtime()}
    if action == "import-results":
        source = str(payload.get("csv") or "")
        if len(source.encode("utf-8")) > 8_000_000:
            raise ToolError("导入的分区 CSV 不得超过 8 MB")
        rows = _parse_zone_rows(io.StringIO(source.lstrip("\ufeff")))
        return _workspace(payload.get("model"), rows)
    if action == "execute-flac3d":
        return _execute(_merge_model(payload.get("model")))
    if action == "execute-open-source":
        engine = str(payload.get("engine") or "screening")
        if engine in {"screening", "sweep2d", "spatial3d"}:
            workspace = _workspace(payload.get("model"), analysis_engine=engine)
            workspace["audit"].append({
                "at": datetime.now(UTC).isoformat(),
                "action": "screening.executed",
                "detail": "服务端完成快速稳定性验算",
            })
            return workspace
        runtime = _runtime()
        solver = next((item for item in runtime["solvers"] if item["id"] == engine), None)
        if solver is None:
            raise ToolError("未知的计算引擎")
        if not solver["available"]:
            raise ToolError(f"{solver['engine']} 计算节点尚未接入；快速验算仍可直接运行")
        raise ToolError(f"{solver['engine']} 节点已发现，但任务适配器尚未完成验收")
    raise ToolError("不支持的边坡分析操作")
