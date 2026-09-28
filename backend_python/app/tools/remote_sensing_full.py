from __future__ import annotations

import base64
import csv
import io
import json
import math
import random
import struct
import zipfile
import zlib
from collections import deque
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError, clamp, mean, parse_numbers, standard_deviation


MAX_ANALYSIS_PIXELS = 1_000_000
SCHEMA = "skyview-remote-sensing-results"
METHODS = {"ndvi-loss", "dnbr", "ndwi-gain", "rgb-cva", "brightness", "band-abs"}
CLASS_LABELS = ["未变化", "植被损失候选", "积水/水体扩张候选", "烧毁/裸地或碎屑候选", "其他地表变化候选"]


def _quantile(values: list[float], probability: float) -> float:
    ordered = sorted(value for value in values if math.isfinite(value))
    if not ordered:
        return 0.0
    position = clamp(probability, 0, 1) * (len(ordered) - 1)
    lower = int(position)
    weight = position - lower
    upper = ordered[min(len(ordered) - 1, lower + 1)]
    return ordered[lower] * (1 - weight) + upper * weight


def _describe(values: list[float]) -> dict[str, float | int]:
    finite = [value for value in values if math.isfinite(value)]
    if not finite:
        return {"count": 0, "min": 0, "max": 0, "mean": 0, "std": 0, "p2": 0, "p50": 0, "p98": 0}
    return {
        "count": len(finite), "min": min(finite), "max": max(finite),
        "mean": mean(finite), "std": standard_deviation(finite),
        "p2": _quantile(finite, 0.02), "p50": _quantile(finite, 0.5), "p98": _quantile(finite, 0.98),
    }


def _benchmark(width: int = 96, height: int = 64) -> tuple[dict[str, Any], dict[str, Any], list[int]]:
    width = max(16, min(320, int(width)))
    height = max(16, min(240, int(height)))
    rng = random.Random(20260809)
    before = [[] for _ in range(6)]
    after = [[] for _ in range(6)]
    truth: list[int] = []
    for y in range(height):
        for x in range(width):
            relief = 0.06 * math.sin(x / 6.2) + 0.04 * math.cos(y / 4.6)
            texture = (rng.random() - 0.5) * 0.025
            base = [clamp(value + relief + texture, 0.02, 0.92) for value in (0.18, 0.27, 0.16, 0.58, 0.31, 0.24)]
            vegetation = ((x - width * 0.30) / (width * 0.13)) ** 2 + ((y - height * 0.35) / (height * 0.16)) ** 2 < 1
            burned = width * 0.59 < x < width * 0.88 and height * 0.20 + (x - width * 0.59) * 0.20 < y < height * 0.62
            flood = ((x - width * 0.54) / (width * 0.22)) ** 2 + ((y - height * 0.80) / (height * 0.11)) ** 2 < 1
            changed = vegetation or burned or flood
            post = [clamp(value * 1.015 + 0.004, 0, 1) for value in base]
            if vegetation:
                post[0] += 0.13; post[2] += 0.08; post[3] -= 0.27; post[5] += 0.11
            if burned:
                post[0] += 0.08; post[1] -= 0.05; post[3] -= 0.24; post[5] += 0.25
            if flood:
                post[1] += 0.09; post[2] -= 0.08; post[3] -= 0.34; post[5] -= 0.08
            for band in range(6):
                before[band].append(round(base[band], 6))
                after[band].append(round(clamp(post[band], 0, 1), 6))
            truth.append(1 if changed else 0)
    geo = {"epsg": 32650, "origin": [500000, 4000000], "resolution": [2, -2], "noData": None}
    common = {"width": width, "height": height, "originalWidth": width, "originalHeight": height, "bandCount": 6, "format": "synthetic-geotiff", "geo": geo, "downsampleFactor": 1}
    return ({**common, "name": "benchmark_T1.tif", "date": "2026-06-01", "bands": before}, {**common, "name": "benchmark_T2.tif", "date": "2026-07-15", "bands": after}, truth)


def _dataset(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ToolError(f"{name} 必须是已解析的栅格数据")
    width = int(value.get("width") or 0)
    height = int(value.get("height") or 0)
    bands = value.get("bands")
    if width <= 0 or height <= 0 or width * height > MAX_ANALYSIS_PIXELS:
        raise ToolError(f"{name} 栅格尺寸无效或超过 100 万像元分析上限")
    if not isinstance(bands, list) or not bands:
        raise ToolError(f"{name} 缺少波段数据")
    normalized = []
    for index, band in enumerate(bands):
        if not isinstance(band, list) or len(band) != width * height:
            raise ToolError(f"{name} 第 {index + 1} 波段长度与栅格尺寸不一致")
        normalized.append([float(item) for item in band])
    return {**value, "width": width, "height": height, "bandCount": len(normalized), "bands": normalized}


def _inputs(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[int] | None, bool]:
    if isinstance(payload.get("before"), dict) and isinstance(payload.get("after"), dict):
        return _dataset(payload["before"], "before"), _dataset(payload["after"], "after"), payload.get("truth") if isinstance(payload.get("truth"), list) else None, False
    if payload.get("before") is not None and payload.get("after") is not None:
        before_values = parse_numbers(payload.get("before"), key="before", minimum=4)
        after_values = parse_numbers(payload.get("after"), key="after", minimum=4)
        if len(before_values) != len(after_values):
            raise ToolError("before 和 after 的像元数量必须一致")
        width = int(payload.get("width") or round(math.sqrt(len(before_values))))
        if width <= 0 or len(before_values) % width:
            raise ToolError("像元数量必须能被 width 整除")
        height = len(before_values) // width
        common = {"width": width, "height": height, "bandCount": 1, "format": "numeric-grid", "geo": None}
        return {**common, "name": "T1", "bands": [before_values]}, {**common, "name": "T2", "bands": [after_values]}, None, False
    before, after, truth = _benchmark(int(payload.get("width") or 96), int(payload.get("height") or 64))
    return before, after, truth, True


def _compatibility(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if (before["width"], before["height"]) != (after["width"], after["height"]):
        errors.append("两期影像的分析网格尺寸不一致")
    a_geo, b_geo = before.get("geo"), after.get("geo")
    if a_geo and b_geo:
        if a_geo.get("epsg") and b_geo.get("epsg") and a_geo["epsg"] != b_geo["epsg"]:
            errors.append("两期影像 CRS 不一致")
        ar, br = a_geo.get("resolution"), b_geo.get("resolution")
        if ar and br and any(abs(float(ar[i]) - float(br[i])) > max(abs(float(ar[i])), 1e-9) * 0.02 for i in range(2)):
            errors.append("两期影像空间分辨率差异超过 2%")
    else:
        warnings.append("至少一期影像缺少地理参考，面积与位置只能使用像素坐标")
    if before.get("noData") != after.get("noData"):
        warnings.append("两期影像的 NoData 声明不同，计算时分别按各自声明排除")
    return {"ready": not errors, "errors": errors, "warnings": warnings}


def _normalized_difference(a: float, b: float) -> float:
    return 0.0 if abs(a + b) < 1e-12 else (a - b) / (a + b)


def _band(dataset: dict[str, Any], mapping: dict[str, Any], key: str, fallback: int) -> list[float]:
    index = int(mapping.get(key, fallback)) - 1
    if index < 0 or index >= len(dataset["bands"]):
        raise ToolError(f"算法所需的 {key} 波段未正确映射")
    return dataset["bands"][index]


def _scores(before: dict[str, Any], after: dict[str, Any], settings: dict[str, Any]) -> tuple[list[float], list[float], list[float], list[int]]:
    method = str(settings.get("method") or ("band-abs" if before["bandCount"] == 1 else "ndvi-loss"))
    if method not in METHODS:
        raise ToolError("不支持的变化检测算法")
    mapping = settings.get("mapping") if isinstance(settings.get("mapping"), dict) else {}
    count = before["width"] * before["height"]
    first = [0.0] * count
    second = [0.0] * count
    scores = [0.0] * count
    valid = [0] * count
    offset_x, offset_y = int(round(float(settings.get("offsetX") or 0))), int(round(float(settings.get("offsetY") or 0)))
    no_data_a, no_data_b = before.get("noData"), after.get("noData")
    def aligned(index: int) -> int | None:
        x, y = index % before["width"] + offset_x, index // before["width"] + offset_y
        return y * after["width"] + x if 0 <= x < after["width"] and 0 <= y < after["height"] else None
    def usable(values: list[float], index: int, no_data: Any) -> bool:
        value = values[index]
        return math.isfinite(value) and (no_data is None or abs(value - float(no_data)) > 1e-12)
    if method in {"ndvi-loss", "dnbr", "ndwi-gain"}:
        if method == "ndvi-loss": keys, direction = (("nir", 4), ("red", 1)), -1
        elif method == "dnbr": keys, direction = (("nir", 4), ("swir2", 6)), -1
        else: keys, direction = (("green", 2), ("nir", 4)), 1
        a1, a2 = _band(before, mapping, *keys[0]), _band(before, mapping, *keys[1])
        b1, b2 = _band(after, mapping, *keys[0]), _band(after, mapping, *keys[1])
        for index in range(count):
            right = aligned(index)
            if right is None or not usable(a1, index, no_data_a) or not usable(a2, index, no_data_a) or not usable(b1, right, no_data_b) or not usable(b2, right, no_data_b): continue
            first[index] = _normalized_difference(a1[index], a2[index])
            second[index] = _normalized_difference(b1[right], b2[right])
            scores[index] = (second[index] - first[index]) * direction
            valid[index] = 1
    elif method in {"rgb-cva", "brightness"}:
        a = [_band(before, mapping, key, fallback) for key, fallback in (("red", 1), ("green", 2), ("blue", 3))]
        b = [_band(after, mapping, key, fallback) for key, fallback in (("red", 1), ("green", 2), ("blue", 3))]
        bounds = [(min(left + right), max(left + right)) if settings.get("radiometricNormalization", True) else (0.0, 1.0) for left, right in zip(a, b, strict=True)]
        for index in range(count):
            right = aligned(index)
            if right is None or any(not usable(band, index, no_data_a) for band in a) or any(not usable(band, right, no_data_b) for band in b): continue
            av = [(a[position][index] - bounds[position][0]) / max(1e-12, bounds[position][1] - bounds[position][0]) for position in range(3)]
            bv = [(b[position][right] - bounds[position][0]) / max(1e-12, bounds[position][1] - bounds[position][0]) for position in range(3)]
            first[index], second[index] = mean(av), mean(bv)
            scores[index] = math.sqrt(mean([(av[p] - bv[p]) ** 2 for p in range(3)])) if method == "rgb-cva" else abs(second[index] - first[index])
            valid[index] = 1
    else:
        index = max(0, int(settings.get("singleBand") or 1) - 1)
        if index >= before["bandCount"] or index >= after["bandCount"]:
            raise ToolError("指定波段不存在")
        left_band, right_band = before["bands"][index], after["bands"][index]
        for item in range(count):
            right = aligned(item)
            if right is None or not usable(left_band, item, no_data_a) or not usable(right_band, right, no_data_b): continue
            first[item], second[item] = left_band[item], right_band[right]
            scores[item] = abs(second[item] - first[item]); valid[item] = 1
    return first, second, scores, valid


def _histogram(values: list[float], bins: int = 48) -> dict[str, Any]:
    values = [value for value in values if math.isfinite(value)]
    stats = _describe(values)
    counts = [0] * bins
    span = float(stats["max"]) - float(stats["min"])
    for value in values:
        slot = 0 if span <= 1e-12 else min(bins - 1, int((value - float(stats["min"])) / span * bins))
        counts[slot] += 1
    return {**stats, "bins": bins, "counts": counts}


def _otsu(values: list[float]) -> float:
    hist = _histogram(values, 128)
    counts = hist["counts"]
    total = sum(counts)
    total_moment = sum(index * count for index, count in enumerate(counts))
    bg_weight = bg_moment = 0
    best_variance = -1.0
    best = 0
    for index, count in enumerate(counts):
        bg_weight += count; bg_moment += index * count
        fg_weight = total - bg_weight
        if not bg_weight or not fg_weight:
            continue
        variance = bg_weight * fg_weight * ((bg_moment / bg_weight) - ((total_moment - bg_moment) / fg_weight)) ** 2
        if variance > best_variance:
            best_variance, best = variance, index
    return float(hist["min"]) + (best + 0.5) / len(counts) * (float(hist["max"]) - float(hist["min"]))


def _morph(mask: list[int], width: int, height: int, operation: str, radius: int) -> list[int]:
    radius = max(0, min(3, int(radius)))
    if radius == 0 or operation == "none":
        return mask[:]
    def pass_once(source: list[int], dilate: bool) -> list[int]:
        output = [0] * len(source)
        for y in range(height):
            for x in range(width):
                cells = [source[yy * width + xx] for yy in range(max(0, y - radius), min(height, y + radius + 1)) for xx in range(max(0, x - radius), min(width, x + radius + 1))]
                output[y * width + x] = int(any(cells) if dilate else len(cells) == (2 * radius + 1) ** 2 and all(cells))
        return output
    if operation == "open": return pass_once(pass_once(mask, False), True)
    if operation == "close": return pass_once(pass_once(mask, True), False)
    if operation == "open-close": return pass_once(pass_once(pass_once(pass_once(mask, False), True), True), False)
    return mask[:]


def _components(mask: list[int], scores: list[float], width: int, height: int, min_pixels: int, geo: dict[str, Any] | None) -> tuple[list[int], list[dict[str, Any]]]:
    visited = [False] * len(mask)
    cleaned = mask[:]
    items = []
    directions = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
    for start in range(len(mask)):
        if not mask[start] or visited[start]: continue
        queue = deque([start]); visited[start] = True; pixels = []
        while queue:
            current = queue.popleft(); pixels.append(current); x, y = current % width, current // width
            for dx, dy in directions:
                xx, yy = x + dx, y + dy
                if 0 <= xx < width and 0 <= yy < height:
                    neighbor = yy * width + xx
                    if mask[neighbor] and not visited[neighbor]: visited[neighbor] = True; queue.append(neighbor)
        if len(pixels) < min_pixels:
            for index in pixels: cleaned[index] = 0
            continue
        xs, ys = [index % width for index in pixels], [index // width for index in pixels]
        cx, cy = mean(xs), mean(ys)
        resolution = geo.get("resolution") if geo else None
        area_m2 = len(pixels) * abs(float(resolution[0]) * float(resolution[1])) if resolution else None
        origin = geo.get("origin") if geo else None
        coordinate = [origin[0] + (cx + .5) * resolution[0], origin[1] + (cy + .5) * resolution[1]] if origin and resolution else [cx, cy]
        items.append({"id": len(items) + 1, "pixelCount": len(pixels), "areaM2": area_m2, "areaHa": area_m2 / 10000 if area_m2 is not None else None, "centroid": [cx, cy], "coordinate": coordinate, "bbox": [min(xs), min(ys), max(xs), max(ys)], "meanScore": mean([scores[i] for i in pixels]), "maxScore": max(scores[i] for i in pixels)})
    items.sort(key=lambda item: item["pixelCount"], reverse=True)
    for rank, item in enumerate(items, 1): item["rank"] = rank
    return cleaned, items


def _classes(before: dict[str, Any], after: dict[str, Any], mask: list[int], mapping: dict[str, Any]) -> tuple[list[int], list[dict[str, Any]]]:
    count = len(mask); classes = [0] * count
    if before["bandCount"] < 4:
        classes = [4 if value else 0 for value in mask]
    else:
        red_a, red_b = _band(before, mapping, "red", 1), _band(after, mapping, "red", 1)
        green_a, green_b = _band(before, mapping, "green", 2), _band(after, mapping, "green", 2)
        nir_a, nir_b = _band(before, mapping, "nir", 4), _band(after, mapping, "nir", 4)
        swir_a = _band(before, mapping, "swir2", min(6, before["bandCount"]))
        swir_b = _band(after, mapping, "swir2", min(6, after["bandCount"]))
        for index, changed in enumerate(mask):
            if not changed: continue
            signals = [(1, _normalized_difference(nir_a[index], red_a[index]) - _normalized_difference(nir_b[index], red_b[index])), (2, _normalized_difference(green_b[index], nir_b[index]) - _normalized_difference(green_a[index], nir_a[index])), (3, _normalized_difference(nir_a[index], swir_a[index]) - _normalized_difference(nir_b[index], swir_b[index]))]
            strongest = max(signals, key=lambda item: item[1])
            classes[index] = strongest[0] if strongest[1] >= (0.10 if strongest[0] == 3 else 0.08) else 4
    changed_count = max(1, sum(mask))
    categories = [{"id": class_id, "label": CLASS_LABELS[class_id], "count": classes.count(class_id), "ratio": classes.count(class_id) / changed_count} for class_id in range(1, 5)]
    return classes, categories


def _zones(mask: list[int], scores: list[float], classes: list[int], width: int, height: int, threshold: float, geo: dict[str, Any] | None) -> list[dict[str, Any]]:
    zones = []
    for row in range(4):
        for col in range(4):
            x0, x1 = col * width // 4, (col + 1) * width // 4
            y0, y1 = row * height // 4, (row + 1) * height // 4
            indexes = [y * width + x for y in range(y0, y1) for x in range(x0, x1)]
            changed = [index for index in indexes if mask[index]]
            changed_ratio = len(changed) / max(1, len(indexes)); mean_score = mean([scores[index] for index in changed]) if changed else 0
            impact = clamp(0.6 * clamp(mean_score / max(threshold * 2, 1e-12), 0, 1) + 0.4 * clamp(changed_ratio / .25, 0, 1), 0, 1)
            severity = "CRITICAL" if impact >= .8 else "SEVERE" if impact >= .6 else "MODERATE" if impact >= .4 else "MINOR" if impact >= .2 else "MINIMAL"
            counts = [sum(classes[index] == class_id for index in changed) for class_id in range(5)]
            dominant = max(range(1, 5), key=lambda class_id: counts[class_id]) if changed else 0
            resolution = geo.get("resolution") if geo else None
            area_m2 = len(changed) * abs(float(resolution[0]) * float(resolution[1])) if resolution else None
            zones.append({"id": f"{chr(65 + row)}{col + 1}", "row": row, "col": col, "bounds": [x0, y0, x1 - 1, y1 - 1], "totalPixels": len(indexes), "changedPixels": len(changed), "changedRatio": changed_ratio, "meanScore": mean_score, "impactScore": impact, "severity": severity, "dominantClass": CLASS_LABELS[dominant], "areaM2": area_m2, "areaHa": area_m2 / 10000 if area_m2 is not None else None})
    return zones


def _metrics(samples: list[dict[str, Any]], mask: list[int], width: int, height: int) -> dict[str, Any]:
    tp = fp = tn = fn = outside = 0
    for sample in samples:
        x, y = int(round(float(sample.get("x", -1)))), int(round(float(sample.get("y", -1))))
        if not (0 <= x < width and 0 <= y < height): outside += 1; continue
        predicted = bool(mask[y * width + x]); actual = str(sample.get("label", 0)).lower() in {"1", "true", "changed", "变化"}
        if predicted and actual: tp += 1
        elif predicted: fp += 1
        elif actual: fn += 1
        else: tn += 1
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision is not None and recall is not None and precision + recall else None
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn, "outside": outside, "evaluated": tp + fp + tn + fn, "precision": precision, "recall": recall, "f1": f1, "iou": tp / (tp + fp + fn) if tp + fp + fn else None, "accuracy": (tp + tn) / (tp + fp + tn + fn) if tp + fp + tn + fn else None}


def _png(mask: list[int], width: int, height: int) -> bytes:
    raw = b"".join(b"\x00" + bytes(255 if mask[y * width + x] else 0 for x in range(width)) for y in range(height))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def _geotiff(mask: list[int], width: int, height: int, geo: dict[str, Any] | None) -> bytes:
    # Little-endian baseline TIFF with one 8-bit strip plus GeoTIFF scale/tiepoint/CRS tags.
    pixels = bytes(255 if value else 0 for value in mask)
    resolution = (geo or {}).get("resolution") or [1, -1]
    origin = (geo or {}).get("origin") or [0, 0]
    epsg = int((geo or {}).get("epsg") or 0)
    scale = struct.pack("<3d", abs(float(resolution[0])), abs(float(resolution[1])), 0)
    tie = struct.pack("<6d", 0, 0, 0, float(origin[0]), float(origin[1]), 0)
    geokeys = struct.pack("<8H", 1, 1, 0, 1, 3072 if epsg and not 4000 <= epsg < 5000 else 2048, 0, 1, epsg or 32767)
    entries_count = 13
    ifd_offset = 8
    extra_offset = ifd_offset + 2 + entries_count * 12 + 4
    scale_offset = extra_offset; tie_offset = scale_offset + len(scale); keys_offset = tie_offset + len(tie); strip_offset = keys_offset + len(geokeys)
    entries = [
        (256, 4, 1, width), (257, 4, 1, height), (258, 3, 1, 8), (259, 3, 1, 1),
        (262, 3, 1, 1), (273, 4, 1, strip_offset), (277, 3, 1, 1), (278, 4, 1, height),
        (279, 4, 1, len(pixels)), (284, 3, 1, 1), (33550, 12, 3, scale_offset),
        (33922, 12, 6, tie_offset), (34735, 3, 8, keys_offset),
    ]
    ifd = struct.pack("<H", entries_count) + b"".join(struct.pack("<HHII", *entry) for entry in entries) + struct.pack("<I", 0)
    return b"II*\x00" + struct.pack("<I", ifd_offset) + ifd + scale + tie + geokeys + pixels


def _csv_text(headers: list[str], rows: list[list[Any]]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer); writer.writerow(headers); writer.writerows(rows)
    return buffer.getvalue()


def _exports(result: dict[str, Any], evidence: list[dict[str, Any]]) -> dict[str, str]:
    summary, zones, components, metrics = result["summary"], result["zones"], result["components"], result["validation"]
    report = f"""# 灾害遥感损毁评估报告

- 项目：{result['project']['name']}
- 事件编号：{result['project']['incidentId']}
- 算法：{result['settings']['method']}
- 阈值：{result['threshold']:.6f}（{result['settings']['thresholdStrategy']}）
- 变化像元：{summary['changedPixels']} / {summary['validPixels']}（{summary['changedRatio']:.2%}）
- 变化面积：{summary['areaHa'] if summary['areaHa'] is not None else '坐标信息不足'} ha
- 候选斑块：{len(components)}
- 综合等级：{result['assessment']['severity']}

## 精度验证

样本 {metrics['evaluated']}；Precision {metrics['precision']}；Recall {metrics['recall']}；F1 {metrics['f1']}；IoU {metrics['iou']}。

## 方法与证据链

本次任务由 Go 控制面编排、Python 固定算法执行，记录波段映射、阈值、形态学、最小斑块和输入元数据。证据记录 {len(evidence)} 条。
"""
    html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>灾害遥感损毁评估报告</title><body>" + "".join(f"<p>{line}</p>" if line and not line.startswith("#") else f"<h2>{line.lstrip('# ')}</h2>" for line in report.splitlines()) + "</body></html>"
    regions_csv = _csv_text(["rank","id","pixels","area_ha","mean_score","max_score","center_x","center_y","bbox"], [[item["rank"], item["id"], item["pixelCount"], item["areaHa"], item["meanScore"], item["maxScore"], *item["coordinate"], " ".join(map(str, item["bbox"]))] for item in components])
    zones_csv = _csv_text(["zone","severity","changed_pixels","changed_ratio","impact_score","area_ha","dominant_class"], [[item["id"], item["severity"], item["changedPixels"], item["changedRatio"], item["impactScore"], item["areaHa"], item["dominantClass"]] for item in zones])
    validation_csv = _csv_text(["metric","value"], [[key, value] for key, value in metrics.items()])
    features = [{"type": "Feature", "properties": {key: value for key, value in item.items() if key not in {"bbox", "centroid", "coordinate"}}, "geometry": {"type": "Point", "coordinates": item["coordinate"]}} for item in components]
    geojson = json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2)
    png = _png(result["mask"], result["width"], result["height"])
    tiff = _geotiff(result["mask"], result["width"], result["height"], result["datasets"]["before"].get("geo"))
    archive = io.BytesIO()
    manifest = {"schema": SCHEMA, "version": 1, "createdAt": result["createdAt"], "files": ["README.md", "metadata/analysis.json", "results/regions.csv", "results/zones.csv", "results/regions.geojson", "results/change-mask.png", "results/change-mask.tif", "validation/metrics.csv"]}
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("README.md", report); package.writestr("metadata/analysis.json", json.dumps({key: value for key, value in result.items() if key not in {"exports"}}, ensure_ascii=False, indent=2))
        package.writestr("results/regions.csv", regions_csv); package.writestr("results/zones.csv", zones_csv); package.writestr("results/regions.geojson", geojson)
        package.writestr("results/change-mask.png", png); package.writestr("results/change-mask.tif", tiff); package.writestr("validation/metrics.csv", validation_csv); package.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return {"reportMarkdown": report, "reportHtml": html, "regionsCsv": regions_csv, "zonesCsv": zones_csv, "validationCsv": validation_csv, "regionsGeoJson": geojson, "maskPngBase64": base64.b64encode(png).decode("ascii"), "maskGeoTiffBase64": base64.b64encode(tiff).decode("ascii"), "packageBase64": base64.b64encode(archive.getvalue()).decode("ascii")}


def _analyze(payload: dict[str, Any]) -> dict[str, Any]:
    before, after, truth, synthetic = _inputs(payload)
    compatibility = _compatibility(before, after)
    if not compatibility["ready"]: raise ToolError("；".join(compatibility["errors"]))
    settings = {"method": "ndvi-loss" if before["bandCount"] >= 4 else "band-abs", "thresholdStrategy": "otsu", "manualThreshold": .18, "percentile": 95, "morphology": "open-close", "morphologyRadius": 1, "minPatchPixels": 8, "singleBand": 1, "mapping": {"red": 1, "green": 2, "blue": 3, "nir": 4, "swir1": 5, "swir2": 6}, **(payload.get("settings") if isinstance(payload.get("settings"), dict) else {})}
    if isinstance(payload.get("mapping"), dict): settings["mapping"] = payload["mapping"]
    first, second, scores, valid = _scores(before, after, settings)
    valid_scores = [score for score, keep in zip(scores, valid, strict=True) if keep]
    if not valid_scores: raise ToolError("双时相影像没有可参与计算的有效重叠像元")
    strategy = str(settings["thresholdStrategy"])
    threshold = float(settings["manualThreshold"]) if strategy == "manual" else _quantile(valid_scores, float(settings["percentile"]) / 100) if strategy == "percentile" else _otsu(valid_scores)
    mask = [int(keep and value >= threshold) for value, keep in zip(scores, valid, strict=True)]
    mask = _morph(mask, before["width"], before["height"], str(settings["morphology"]), int(settings["morphologyRadius"]))
    mask, components = _components(mask, scores, before["width"], before["height"], int(settings["minPatchPixels"]), before.get("geo"))
    classes, categories = _classes(before, after, mask, settings["mapping"])
    zones = _zones(mask, scores, classes, before["width"], before["height"], threshold, before.get("geo"))
    validation_samples = payload.get("validationSamples") if isinstance(payload.get("validationSamples"), list) else []
    validation = _metrics(validation_samples, mask, before["width"], before["height"])
    benchmark_validation = _metrics([{"x": index % before["width"], "y": index // before["width"], "label": label} for index, label in enumerate(truth or [])], mask, before["width"], before["height"]) if truth else None
    changed = sum(mask); resolution = (before.get("geo") or {}).get("resolution"); area_m2 = changed * abs(float(resolution[0]) * float(resolution[1])) if resolution else None
    zone_impact = mean([zone["impactScore"] for zone in zones]); change_signal = .5 * clamp(mean([scores[i] for i, value in enumerate(mask) if value] or [0]) / max(threshold * 2, 1e-12), 0, 1) + .5 * clamp(changed / len(mask) / .25, 0, 1); composite = .6 * change_signal + .4 * zone_impact
    severity = "CRITICAL" if composite >= .8 else "SEVERE" if composite >= .6 else "MODERATE" if composite >= .4 else "MINOR" if composite >= .2 else "MINIMAL"
    project = {"name": "矿山灾害遥感变化分析", "incidentId": "INC-2026-001", "hazard": "landslide", **(payload.get("project") if isinstance(payload.get("project"), dict) else {})}
    dataset_info = lambda data: {key: value for key, value in data.items() if key != "bands"}
    valid_count = sum(valid)
    result: dict[str, Any] = {"schema": SCHEMA, "version": 1, "createdAt": datetime.now(UTC).isoformat(), "stage": "run-all", "processingMode": "synthetic-benchmark-python-worker" if synthetic else "raster-python-worker", "synthetic": synthetic, "project": project, "settings": settings, "width": before["width"], "height": before["height"], "datasets": {"before": dataset_info(before), "after": dataset_info(after)}, "compatibility": compatibility, "score": scores, "beforeIndex": first, "afterIndex": second, "histogram": _histogram(valid_scores), "threshold": threshold, "mask": mask, "classes": classes, "categories": categories, "components": components, "zones": zones, "validation": validation, "benchmarkValidation": benchmark_validation, "summary": {"validPixels": valid_count, "validRatio": valid_count / len(scores), "changedPixels": changed, "changedRatio": changed / valid_count, "areaM2": area_m2, "areaHa": area_m2 / 10000 if area_m2 is not None else None}, "assessment": {"formula": "60% change signal + 40% zonal impact", "changeSignal": change_signal, "zoneImpact": zone_impact, "compositeScore": composite, "severity": severity, "affectedZones": sum(zone["changedPixels"] > 0 for zone in zones), "totalZones": 16, "recommendations": ["优先复核影响分最高的分区，并关联现场照片、测量记录和资产清单。", "使用独立于阈值选择过程的变化/未变化样本完成精度验证。"]}, "quality": {"pixelLimit": MAX_ANALYSIS_PIXELS, "crs": (before.get("geo") or {}).get("epsg"), "noData": {"before": before.get("noData"), "after": after.get("noData")}, "resolution": resolution, "bandMappingComplete": True, "offset": [settings.get("offsetX", 0), settings.get("offsetY", 0)], "radiometricNormalization": bool(settings.get("radiometricNormalization", True))}, "evidence": payload.get("evidence") if isinstance(payload.get("evidence"), list) else []}
    result["exports"] = _exports(result, result["evidence"])
    return result


def run_remote_sensing(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action in {"load-sample", "run-all", "analyze", "screening", "assess", "validate", "export"}:
        return _analyze(payload)
    if action == "describe":
        before, after, _, synthetic = _inputs(payload)
        compatibility = _compatibility(before, after)
        return {"compatible": compatibility["ready"], "compatibility": compatibility, "synthetic": synthetic, "before": {"width": before["width"], "height": before["height"], "bands": before["bandCount"], "stats": [_describe(band) for band in before["bands"]]}, "after": {"width": after["width"], "height": after["height"], "bands": after["bandCount"], "stats": [_describe(band) for band in after["bands"]]}}
    if action in {"change-detection", "zone-assessment"}:
        legacy_settings = {
            "method": "band-abs", "thresholdStrategy": "manual",
            "manualThreshold": float(payload.get("threshold") or 0.2),
            "morphology": "none", "morphologyRadius": 0, "minPatchPixels": 1,
        }
        result = _analyze({**payload, "settings": {**legacy_settings, **(payload.get("settings") if isinstance(payload.get("settings"), dict) else {})}})
        if action == "zone-assessment": return {"grid": {"width": result["width"], "height": result["height"]}, "zones": result["zones"], "overallChangeRate": result["summary"]["changedRatio"]}
        return {"pixels": result["summary"]["validPixels"], "threshold": result["threshold"], "changedPixels": result["summary"]["changedPixels"], "changeRate": result["summary"]["changedRatio"], "increased": sum(result["afterIndex"][i] > result["beforeIndex"][i] for i, value in enumerate(result["mask"]) if value), "decreased": sum(result["afterIndex"][i] <= result["beforeIndex"][i] for i, value in enumerate(result["mask"]) if value), "meanDifference": mean([right - left for left, right in zip(result["beforeIndex"], result["afterIndex"], strict=True)]), "changedIndexes": [i for i, value in enumerate(result["mask"]) if value][:500]}
    raise ToolError("不支持的遥感操作")
