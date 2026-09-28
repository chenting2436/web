from __future__ import annotations

import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from datetime import UTC, datetime
from typing import Any

from app.tools.common import (
    ToolError,
    clamp,
    mean,
    number,
    optional_text,
    parse_json,
    parse_numbers,
    require_text,
    standard_deviation,
    tokenize,
)


def _lines(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [line.strip() for line in str(value or "").splitlines() if line.strip()]


def paper_writing(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "outline":
        topic = require_text(payload, "topic", max_length=500)
        question = optional_text(payload, "question", max_length=1_000)
        return {
            "title": topic,
            "researchQuestion": question or f"{topic}中的关键机制与证据是什么？",
            "sections": [
                "摘要", "研究背景与问题", "数据与方法", "结果", "讨论", "结论", "参考文献"
            ],
            "next": ["补充数据来源", "明确方法与参数", "为主要结论绑定证据"],
        }
    if action != "audit":
        raise ToolError("不支持的论文操作")

    manuscript = require_text(payload, "manuscript")
    words = re.findall(r"[A-Za-z0-9]+|[\u4e00-\u9fff]", manuscript)
    headings = re.findall(r"(?m)^#{1,3}\s+(.+)$", manuscript)
    citations = re.findall(r"\[[^\]\n]{1,60}\]|\([^()\n]+,\s*\d{4}[a-z]?\)", manuscript)
    issues: list[dict[str, str]] = []
    required = {
        "方法": r"方法|method",
        "结果": r"结果|result",
        "讨论": r"讨论|discussion",
        "结论": r"结论|conclusion",
    }
    for name, pattern in required.items():
        if not re.search(pattern, manuscript, re.IGNORECASE):
            issues.append({"level": "high", "message": f"缺少{name}部分"})
    if not citations:
        issues.append({"level": "high", "message": "没有识别到文献引用"})
    if re.search(r"TODO|待补充|待核验|XXX", manuscript, re.IGNORECASE):
        issues.append({"level": "medium", "message": "正文仍包含待处理标记"})
    if not re.search(r"局限|不确定|limitation|uncertain", manuscript, re.IGNORECASE):
        issues.append({"level": "medium", "message": "尚未说明局限或不确定性"})
    score = int(clamp(100 - sum(18 if item["level"] == "high" else 7 for item in issues), 0, 100))
    return {
        "score": score,
        "passed": not any(item["level"] == "high" for item in issues),
        "stats": {"characters": len(manuscript), "words": len(words), "headings": len(headings), "citations": len(citations)},
        "headings": headings,
        "issues": issues,
    }


def remote_sensing(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "change-detection":
        raise ToolError("不支持的遥感操作")
    before = parse_numbers(payload.get("before"), key="before", minimum=4)
    after = parse_numbers(payload.get("after"), key="after", minimum=4)
    if len(before) != len(after):
        raise ToolError("before 和 after 的像元数量必须一致")
    differences = [right - left for left, right in zip(before, after, strict=True)]
    requested_threshold = number(payload, "threshold", 0)
    threshold = requested_threshold if requested_threshold > 0 else mean([abs(value) for value in differences]) + standard_deviation(differences)
    changed = [index for index, value in enumerate(differences) if abs(value) >= threshold]
    increased = sum(differences[index] > 0 for index in changed)
    return {
        "pixels": len(differences),
        "threshold": round(threshold, 6),
        "changedPixels": len(changed),
        "changeRate": round(len(changed) / len(differences), 6),
        "increased": increased,
        "decreased": len(changed) - increased,
        "meanDifference": round(mean(differences), 6),
        "changedIndexes": changed[:500],
    }


def _moving_mean(values: list[float], window: int) -> list[float]:
    result: list[float] = []
    queue: deque[float] = deque()
    total = 0.0
    for value in values:
        queue.append(value)
        total += value
        if len(queue) > window:
            total -= queue.popleft()
        result.append(total / len(queue))
    return result


def seismic_physics(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "source-distance":
        p_time = number(payload, "pTime")
        s_time = number(payload, "sTime")
        vp = number(payload, "vp", 6)
        vs = number(payload, "vs", 3.5)
        if s_time <= p_time or vp <= vs or vs <= 0:
            raise ToolError("需要 S 到时晚于 P 到时，且 Vp > Vs > 0")
        distance = (s_time - p_time) * vp * vs / (vp - vs)
        return {"deltaTime": s_time - p_time, "hypocentralKm": round(distance, 4), "vpVs": round(vp / vs, 4)}
    if action != "detect":
        raise ToolError("不支持的地震操作")
    values = parse_numbers(payload.get("values"), minimum=20)
    sample_rate = number(payload, "sampleRate", 100)
    if sample_rate <= 0:
        raise ToolError("sampleRate 必须大于 0")
    sta = max(2, int(number(payload, "sta", max(2, sample_rate * 0.2))))
    lta = max(sta + 1, int(number(payload, "lta", max(sta + 1, sample_rate * 2))))
    threshold = number(payload, "threshold", 3)
    absolute = [abs(value - mean(values)) for value in values]
    short = _moving_mean(absolute, sta)
    long = _moving_mean(absolute, lta)
    ratios = [short[index] / max(long[index], 1e-12) for index in range(len(values))]
    triggers: list[dict[str, float]] = []
    armed = True
    for index, ratio in enumerate(ratios):
        if armed and ratio >= threshold and index >= lta:
            triggers.append({"index": index, "time": round(index / sample_rate, 6), "ratio": round(ratio, 4)})
            armed = False
        elif ratio < threshold * 0.55:
            armed = True
    return {
        "samples": len(values),
        "duration": round(len(values) / sample_rate, 4),
        "mean": round(mean(values), 6),
        "standardDeviation": round(standard_deviation(values), 6),
        "peak": max(abs(value) for value in values),
        "triggers": triggers[:100],
    }


def patent_transfer(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "valuation":
        annual_revenue = number(payload, "annualRevenue")
        royalty = number(payload, "royalty", 3) / 100
        probability = number(payload, "probability", 50) / 100
        discount = number(payload, "discount", 12) / 100
        years = max(1, min(20, int(number(payload, "years", 5))))
        cashflows = []
        npv = 0.0
        for year in range(1, years + 1):
            nominal = annual_revenue * royalty * probability
            present = nominal / ((1 + discount) ** year)
            cashflows.append({"year": year, "nominal": round(nominal, 2), "presentValue": round(present, 2)})
            npv += present
        return {"npv": round(npv, 2), "cashflows": cashflows}
    if action != "claim-lint":
        raise ToolError("不支持的专利操作")
    claims = _lines(payload.get("claims"))
    features = _lines(payload.get("features"))
    if not claims:
        raise ToolError("至少需要一项权利要求")
    issues: list[dict[str, str]] = []
    if not re.search(r"一种|a\s+method|a\s+system", claims[0], re.IGNORECASE):
        issues.append({"level": "warning", "message": "独立权利要求的主题类型不明确"})
    if not re.search(r"其特征在于|comprising|包括", claims[0], re.IGNORECASE):
        issues.append({"level": "error", "message": "独立权利要求缺少过渡语"})
    uncovered = [feature for feature in features if not any(feature in claim for claim in claims)]
    if uncovered:
        issues.append({"level": "warning", "message": f"有 {len(uncovered)} 项技术特征未进入权利要求"})
    return {
        "claims": len(claims),
        "features": len(features),
        "coverageRate": round((len(features) - len(uncovered)) / max(1, len(features)), 4),
        "uncoveredFeatures": uncovered,
        "issues": issues,
        "passed": not any(item["level"] == "error" for item in issues),
    }


def _skill_frontmatter(specification: str) -> tuple[dict[str, str], str]:
    if not specification.startswith("---"):
        return {}, specification
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", specification, re.DOTALL)
    if not match:
        return {}, specification
    metadata: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip().strip('"\'')
    return metadata, specification[match.end() :]


def skill_evolution(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    specification = require_text(payload, "specification")
    metadata, body = _skill_frontmatter(specification)
    issues: list[dict[str, str]] = []
    if action == "security-scan":
        checks = [
            (r"\.\.[/\\]", "high", "检测到路径穿越"),
            (r"\b(rm\s+-rf|del\s+/[sq]|format\s+[a-z]:)", "critical", "检测到破坏性命令"),
            (r"\b(eval|exec|Function)\s*\(", "high", "检测到动态代码执行"),
            (r"(?:api[_-]?key|password|secret|token)\s*[:=]\s*['\"][^'\"]+", "high", "检测到疑似明文密钥"),
            (r"ignore\s+(?:all\s+)?previous\s+instructions", "high", "检测到提示词注入模式"),
        ]
        for pattern, level, message in checks:
            if re.search(pattern, specification, re.IGNORECASE):
                issues.append({"level": level, "message": message})
        return {"passed": not any(item["level"] in {"critical", "high"} for item in issues), "findings": issues}
    if action != "validate":
        raise ToolError("不支持的 Skill 操作")
    for key in ("name", "description"):
        if not metadata.get(key):
            issues.append({"level": "error", "message": f"frontmatter 缺少 {key}"})
    if metadata.get("name") and not re.fullmatch(r"[a-z0-9-]{1,64}", metadata["name"]):
        issues.append({"level": "error", "message": "name 只能包含小写字母、数字和连字符"})
    if len(body.strip()) < 40:
        issues.append({"level": "warning", "message": "正文过短，难以说明触发条件和操作步骤"})
    if not re.search(r"(?m)^#{1,3}\s+", body):
        issues.append({"level": "warning", "message": "正文缺少标题结构"})
    return {"valid": not any(item["level"] == "error" for item in issues), "metadata": metadata, "issues": issues}


def _workflow_nodes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = parse_json(payload.get("nodes"), fallback=[])
    if not isinstance(nodes, list) or not nodes:
        raise ToolError("nodes 必须是非空 JSON 数组")
    normalized = []
    for index, node in enumerate(nodes):
        if not isinstance(node, dict) or not str(node.get("id", "")).strip():
            raise ToolError(f"第 {index + 1} 个节点缺少 id")
        normalized.append({
            "id": str(node["id"]),
            "name": str(node.get("name") or node["id"]),
            "dependsOn": [str(item) for item in node.get("dependsOn", [])],
            "enabled": node.get("enabled", True) is not False,
            "config": str(node.get("config", "")),
        })
    return normalized


def _topological_order(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node_map = {node["id"]: node for node in nodes}
    indegree = {node["id"]: 0 for node in nodes}
    outgoing: dict[str, list[str]] = {node["id"]: [] for node in nodes}
    for node in nodes:
        for dependency in node["dependsOn"]:
            if dependency not in node_map:
                raise ToolError(f"节点 {node['id']} 引用了不存在的依赖 {dependency}")
            indegree[node["id"]] += 1
            outgoing[dependency].append(node["id"])
    queue = deque(node_id for node_id, degree in indegree.items() if degree == 0)
    order: list[dict[str, Any]] = []
    while queue:
        node_id = queue.popleft()
        order.append(node_map[node_id])
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(order) != len(nodes):
        raise ToolError("工作流存在循环依赖")
    return order


def research_automation(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    nodes = _workflow_nodes(payload)
    order = _topological_order(nodes)
    if action == "validate":
        return {"valid": True, "order": [node["id"] for node in order], "nodes": len(nodes)}
    if action != "run":
        raise ToolError("不支持的工作流操作")
    trace = []
    status = "success"
    for node in order:
        node_status = "skipped" if not node["enabled"] else "failed" if "fail" in node["config"].lower() else "completed"
        trace.append({"id": node["id"], "name": node["name"], "status": node_status})
        if node_status == "failed":
            status = "failed"
            break
    return {"status": status, "trace": trace, "finishedAt": datetime.now(UTC).isoformat()}


def knowledge_system(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    material = require_text(payload, "material")
    chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n|(?<=[。！？.!?])\s+", material) if chunk.strip()]
    if action == "index":
        counts = Counter(tokenize(material))
        return {"chunks": len(chunks), "characters": len(material), "topTerms": [{"term": term, "count": count} for term, count in counts.most_common(12)]}
    if action != "query":
        raise ToolError("不支持的知识库操作")
    query = require_text(payload, "query", max_length=1_000)
    terms = set(tokenize(query))
    ranked = []
    for index, chunk in enumerate(chunks):
        chunk_terms = tokenize(chunk)
        overlap = sum(chunk_terms.count(term) for term in terms)
        phrase = 3 if query.lower() in chunk.lower() else 0
        score = overlap + phrase
        if score:
            ranked.append({"id": f"S1.{index + 1}", "score": score, "text": chunk[:1_000]})
    ranked.sort(key=lambda item: item["score"], reverse=True)
    selected = ranked[:5]
    answer = "\n".join(f"[{item['id']}] {item['text']}" for item in selected) or "没有找到足够相关的材料。"
    return {"answer": answer, "citations": selected, "evidenceCount": len(selected)}


def research_radar(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "search":
        raise ToolError("不支持的研究雷达操作")
    query = require_text(payload, "query", max_length=500)
    limit = int(clamp(number(payload, "limit", 10), 1, 20))
    params = urllib.parse.urlencode({"query": query, "rows": limit, "select": "DOI,title,author,published,container-title,URL,is-referenced-by-count"})
    request = urllib.request.Request(
        f"https://api.crossref.org/works?{params}",
        headers={"Accept": "application/json", "User-Agent": "SkyViewLab/0.1 (mailto:admin@skyviewlab.local)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ToolError(f"公开文献服务暂不可用：{exc}") from exc
    records = []
    for item in data.get("message", {}).get("items", []):
        date_parts = (item.get("published") or {}).get("date-parts") or [[]]
        year = date_parts[0][0] if date_parts and date_parts[0] else None
        authors = [" ".join(filter(None, [author.get("given"), author.get("family")])) for author in item.get("author", [])]
        records.append({
            "doi": item.get("DOI", ""),
            "title": (item.get("title") or ["未命名文献"])[0],
            "authors": authors,
            "year": year,
            "venue": (item.get("container-title") or [""])[0],
            "citedByCount": item.get("is-referenced-by-count", 0),
            "url": item.get("URL", ""),
        })
    return {"query": query, "provider": "Crossref", "total": len(records), "records": records}


MINE_TAXONOMY = {
    "边坡与滑坡": ["边坡", "滑坡", "slope", "landslide", "deformation"],
    "冲击地压": ["冲击地压", "rockburst", "microseismic", "微震"],
    "瓦斯与通风": ["瓦斯", "通风", "gas", "ventilation", "methane"],
    "矿井水害": ["水害", "突水", "mine water", "inrush", "flood"],
    "火灾与粉尘": ["火灾", "粉尘", "fire", "dust", "combustion"],
    "设备与人员安全": ["设备", "人员", "worker", "equipment", "vision", "PPE"],
}


def mine_safety_radar(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action != "classify":
        raise ToolError("不支持的矿山雷达操作")
    text = require_text(payload, "text").lower()
    rows = []
    for category, terms in MINE_TAXONOMY.items():
        matched = [term for term in terms if term.lower() in text]
        rows.append({"category": category, "score": min(100, len(matched) * 25), "matchedTerms": matched})
    rows.sort(key=lambda item: item["score"], reverse=True)
    return {"categories": rows, "primary": rows[0]["category"] if rows and rows[0]["score"] else "未分类"}
