from __future__ import annotations

import base64
import csv
import io
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any, Callable

from app.tools import research, teaching
from app.tools.common import (
    ToolError,
    clamp,
    mean,
    number,
    parse_json,
    parse_numbers,
    require_text,
    standard_deviation,
    tokenize,
)

ActionHandler = Callable[[dict[str, Any]], dict[str, Any]]


def _json_list(payload: dict[str, Any], key: str, *, required: bool = False) -> list[Any]:
    value = parse_json(payload.get(key), fallback=[])
    if not isinstance(value, list) or (required and not value):
        raise ToolError(f"{key} 必须是{'非空' if required else ''} JSON 数组")
    return value


def _describe(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)

    def quantile(probability: float) -> float:
        position = probability * (len(ordered) - 1)
        lower = int(math.floor(position))
        upper = int(math.ceil(position))
        if lower == upper:
            return ordered[lower]
        weight = position - lower
        return ordered[lower] * (1 - weight) + ordered[upper] * weight

    return {
        "count": len(values),
        "minimum": round(ordered[0], 6),
        "maximum": round(ordered[-1], 6),
        "mean": round(mean(values), 6),
        "standardDeviation": round(standard_deviation(values), 6),
        "p2": round(quantile(0.02), 6),
        "median": round(quantile(0.5), 6),
        "p98": round(quantile(0.98), 6),
    }


def paper_generate(payload: dict[str, Any]) -> dict[str, Any]:
    title = require_text(payload, "title", max_length=500)
    question = require_text(payload, "question", max_length=2_000)
    design = str(payload.get("design", "")).strip() or "【待作者补充研究设计】"
    sources = [line.strip() for line in str(payload.get("sources", "")).splitlines() if line.strip()]
    findings = [line.strip() for line in str(payload.get("findings", "")).splitlines() if line.strip()]
    evidence = "\n".join(f"- {item}" for item in sources) or "- 【待作者补充并核验来源】"
    result_lines = "\n".join(f"- {item}" for item in findings) or "- 【待作者基于真实分析结果填写】"
    manuscript = f"""# {title}

## 摘要

本研究围绕“{question}”展开。数据、结果和引用必须由作者逐项核验。

## 研究背景与问题

{question}

## 证据与相关研究

{evidence}

## 数据与方法

{design}

## 结果

{result_lines}

## 讨论

【待作者讨论替代解释、不确定性和适用边界】

## 结论

【待作者仅依据已核验结果形成结论】

## 数据与 AI 披露

【待作者确认数据可用性、伦理要求与 AI 使用情况】
"""
    return {
        "manuscript": manuscript,
        "sections": 8,
        "verificationRequired": not sources or not findings,
        "checkpoints": ["研究问题", "来源核验", "方法复现", "结果核验", "完整性门禁"],
    }


def paper_bibtex(payload: dict[str, Any]) -> dict[str, Any]:
    source = require_text(payload, "bibtex")
    matches = list(re.finditer(r"@(article|book|inproceedings|misc|techreport)\s*\{\s*([^,]+),([\s\S]*?)(?=\n@|\Z)", source, re.I))
    records = []
    seen: set[str] = set()
    duplicates = []
    for match in matches:
        body = match.group(3)

        def field(name: str) -> str:
            found = re.search(rf"\b{name}\s*=\s*(?:\{{([^}}]*)\}}|\"([^\"]*)\")", body, re.I)
            return (found.group(1) or found.group(2)).strip() if found else ""

        key = match.group(2).strip()
        doi = field("doi").lower().replace("https://doi.org/", "")
        identity = doi or re.sub(r"\W+", "", field("title").lower())
        record = {"key": key, "type": match.group(1).lower(), "title": field("title"), "authors": field("author"), "year": field("year"), "doi": doi}
        if identity and identity in seen:
            duplicates.append(record)
        else:
            if identity:
                seen.add(identity)
            records.append(record)
    if not records and not duplicates:
        raise ToolError("没有识别到 BibTeX 条目")
    return {"records": records, "duplicates": duplicates, "imported": len(records)}


def paper_review(payload: dict[str, Any]) -> dict[str, Any]:
    manuscript = require_text(payload, "manuscript")
    audit = research.paper_writing("audit", {"manuscript": manuscript})
    roles = [
        ("期刊适配", ["标题", "摘要", "篇幅", "投稿"]),
        ("理论论证", ["理论", "机制", "假设", "解释"]),
        ("方法学", ["方法", "数据", "样本", "复现"]),
        ("证据引文", ["引用", "证据", "来源", "参考文献"]),
        ("反方挑战", ["局限", "不确定", "替代", "失败"]),
    ]
    reports = []
    for role, terms in roles:
        missing = [term for term in terms if term not in manuscript]
        findings = list(audit["issues"])
        if len(missing) >= 3:
            findings.append({"level": "medium", "message": f"{role}关注内容不足：{', '.join(missing)}"})
        penalty = sum(15 if item["level"] == "high" else 6 for item in findings)
        reports.append({"role": role, "score": max(0, 100 - penalty), "findings": findings})
    high = sum(any(item["level"] == "high" for item in report["findings"]) for report in reports)
    return {"decision": "major" if high >= 2 else "minor" if any(report["findings"] for report in reports) else "accept", "reports": reports, "audit": audit}


def remote_describe(payload: dict[str, Any]) -> dict[str, Any]:
    before = parse_numbers(payload.get("before"), key="before", minimum=4)
    after = parse_numbers(payload.get("after"), key="after", minimum=4)
    if len(before) != len(after):
        raise ToolError("前后时相像元数量必须一致")
    return {"compatible": True, "before": _describe(before), "after": _describe(after), "difference": _describe([right - left for left, right in zip(before, after, strict=True)])}


def remote_zones(payload: dict[str, Any]) -> dict[str, Any]:
    before = parse_numbers(payload.get("before"), key="before", minimum=16)
    after = parse_numbers(payload.get("after"), key="after", minimum=16)
    width = max(4, int(number(payload, "width", 4)))
    if len(before) != len(after) or len(before) % width:
        raise ToolError("像元数量必须一致并能被宽度整除")
    height = len(before) // width
    threshold = number(payload, "threshold", 0.2)
    zones = []
    for zone_y in range(4):
        for zone_x in range(4):
            indexes = [
                y * width + x
                for y in range(zone_y * height // 4, (zone_y + 1) * height // 4)
                for x in range(zone_x * width // 4, (zone_x + 1) * width // 4)
            ]
            changed = [index for index in indexes if abs(after[index] - before[index]) >= threshold]
            rate = len(changed) / max(1, len(indexes))
            severity = "严重" if rate >= 0.6 else "高" if rate >= 0.4 else "中" if rate >= 0.2 else "低" if rate else "无"
            zones.append({"zone": f"Z{zone_y + 1}-{zone_x + 1}", "pixels": len(indexes), "changed": len(changed), "changeRate": round(rate, 4), "severity": severity})
    overall = sum(zone["changed"] for zone in zones) / len(before)
    return {"grid": {"width": width, "height": height}, "zones": zones, "overallChangeRate": round(overall, 4)}


def seismic_spectrum(payload: dict[str, Any]) -> dict[str, Any]:
    values = parse_numbers(payload.get("values"), minimum=8)
    sample_rate = number(payload, "sampleRate", 100)
    if sample_rate <= 0:
        raise ToolError("sampleRate 必须大于 0")
    values = values[:512]
    average = mean(values)
    centered = [value - average for value in values]
    spectrum = []
    for frequency_index in range(1, len(centered) // 2 + 1):
        real = sum(value * math.cos(2 * math.pi * frequency_index * index / len(centered)) for index, value in enumerate(centered))
        imaginary = -sum(value * math.sin(2 * math.pi * frequency_index * index / len(centered)) for index, value in enumerate(centered))
        amplitude = math.sqrt(real * real + imaginary * imaginary) / len(centered)
        spectrum.append({"frequency": round(frequency_index * sample_rate / len(centered), 6), "amplitude": round(amplitude, 6)})
    peak = max(spectrum, key=lambda item: item["amplitude"])
    return {"samples": len(centered), "peakFrequency": peak["frequency"], "peakAmplitude": peak["amplitude"], "spectrum": spectrum}


def seismic_smooth(payload: dict[str, Any]) -> dict[str, Any]:
    values = parse_numbers(payload.get("values"), minimum=3)
    window = max(1, min(101, int(number(payload, "window", 5))))
    output = []
    for index in range(len(values)):
        start = max(0, index - window // 2)
        end = min(len(values), index + window // 2 + 1)
        output.append(round(mean(values[start:end]), 8))
    return {"window": window, "input": _describe(values), "output": _describe(output), "values": output}


def patent_trl(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = _json_list(payload, "evidence", required=True)
    passed = sum(bool(item.get("passed")) if isinstance(item, dict) else bool(item) for item in evidence)
    level = min(9, max(1, passed + 1))
    gaps = [str(item.get("name", f"证据 {index + 1}")) for index, item in enumerate(evidence) if isinstance(item, dict) and not item.get("passed")]
    return {"trl": level, "passedEvidence": passed, "totalEvidence": len(evidence), "gaps": gaps, "gate": "ready" if level >= 7 else "develop" if level >= 4 else "research"}


def patent_risk(payload: dict[str, Any]) -> dict[str, Any]:
    description = require_text(payload, "description").lower()
    prior_art = _json_list(payload, "priorArt")
    risks = []
    for item in prior_art:
        if not isinstance(item, dict):
            continue
        overlap = [term for term in tokenize(str(item.get("abstract", ""))) if term in set(tokenize(description))]
        risks.append({"title": item.get("title", "未命名"), "overlapTerms": sorted(set(overlap))[:12], "risk": round(min(100, len(set(overlap)) * 8), 2), "status": item.get("status", "待核验")})
    risks.sort(key=lambda item: item["risk"], reverse=True)
    return {"risks": risks, "highestRisk": risks[0]["risk"] if risks else 0, "requiresCounsel": any(item["risk"] >= 60 for item in risks)}


PATENT_CHAPTERS = ["技术领域", "背景技术", "现有技术缺陷", "发明目的", "技术方案", "关键创新点", "实施方式", "技术效果", "附图说明", "可替代方案"]


def patent_disclosure(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    concept = require_text(payload, "concept", max_length=5_000)
    problem = str(payload.get("problem", "")).strip()
    mechanism = str(payload.get("mechanism", "")).strip()
    evidence = str(payload.get("evidence", "")).strip()
    if action == "structure":
        return {"concept": concept, "chapters": PATENT_CHAPTERS, "missing": [name for name, value in (("技术问题", problem), ("工作机理", mechanism), ("验证证据", evidence)) if not value]}
    if action == "generate":
        values = {
            "技术领域": f"本方案涉及与“{concept}”相关的工程技术领域。",
            "背景技术": problem or "【待发明人补充现有技术与实际问题】",
            "现有技术缺陷": problem or "【待发明人逐项说明现有方案缺陷】",
            "发明目的": f"针对上述问题，提出{concept}。",
            "技术方案": mechanism or "【待发明人补充部件、步骤、参数及其连接关系】",
            "关键创新点": f"核心构思：{concept}。需要与已核验现有技术逐项对比。",
            "实施方式": mechanism or "【待发明人补充可执行实施例】",
            "技术效果": evidence or "【待发明人提供试验、仿真或现场数据】",
            "附图说明": "【待发明人列出系统框图、流程图和关键结构图】",
            "可替代方案": "【待发明人补充等效部件、参数区间和替代步骤】",
        }
        return {"title": concept[:80], "chapters": [{"name": chapter, "content": values[chapter]} for chapter in PATENT_CHAPTERS], "verificationRequired": any("待发明人" in value for value in values.values())}
    if action == "audit":
        disclosure = str(payload.get("disclosure", concept))
        missing = [chapter for chapter in PATENT_CHAPTERS if chapter not in disclosure]
        placeholders = len(re.findall(r"待发明人|待核验|TODO|XXX", disclosure, re.I))
        return {"passed": not missing and placeholders == 0, "missingChapters": missing, "placeholders": placeholders}
    raise ToolError("不支持的专利交底书操作")


def skill_contract(payload: dict[str, Any]) -> dict[str, Any]:
    findings = []
    schemas = {}
    for key in ("inputSchema", "outputSchema"):
        schema = parse_json(payload.get(key), fallback={})
        if not isinstance(schema, dict):
            raise ToolError(f"{key} 必须是 JSON 对象")
        schemas[key] = schema
        if schema.get("type") != "object":
            findings.append({"level": "high", "message": f"{key} 顶层 type 应为 object"})
        properties = schema.get("properties")
        if not isinstance(properties, dict) or not properties:
            findings.append({"level": "medium", "message": f"{key} 没有声明 properties"})
        required = schema.get("required", [])
        if any(item not in (properties or {}) for item in required):
            findings.append({"level": "high", "message": f"{key} required 引用了未声明字段"})
    return {"valid": not any(item["level"] == "high" for item in findings), "schemas": schemas, "findings": findings}


def skill_release(payload: dict[str, Any]) -> dict[str, Any]:
    tests = int(number(payload, "tests", 0))
    assertion_rate = number(payload, "assertionRate", 0)
    high_findings = int(number(payload, "highFindings", 0))
    spec_valid = str(payload.get("specValid", "true")).lower() in {"true", "1", "yes"}
    gates = [
        {"name": "规格有效", "passed": spec_valid},
        {"name": "至少三个测试", "passed": tests >= 3},
        {"name": "断言通过率不低于 90%", "passed": assertion_rate >= 90},
        {"name": "无高危发现", "passed": high_findings == 0},
    ]
    return {"releasable": all(gate["passed"] for gate in gates), "gates": gates, "suggestedVersion": str(payload.get("version", "0.1.0"))}


def knowledge_concepts(payload: dict[str, Any]) -> dict[str, Any]:
    material = require_text(payload, "material")
    chunks = [chunk for chunk in re.split(r"\n\s*\n|[。！？.!?]", material) if chunk.strip()]
    term_counts = Counter(tokenize(material))
    selected = [term for term, _ in term_counts.most_common(18)]
    edges: Counter[tuple[str, str]] = Counter()
    for chunk in chunks:
        present = sorted(set(tokenize(chunk)) & set(selected))
        for left_index, left in enumerate(present):
            for right in present[left_index + 1:]:
                edges[(left, right)] += 1
    return {
        "nodes": [{"id": term, "weight": count} for term, count in term_counts.most_common(18)],
        "edges": [{"source": left, "target": right, "weight": count} for (left, right), count in edges.most_common(40)],
    }


def knowledge_evaluate(payload: dict[str, Any]) -> dict[str, Any]:
    material = require_text(payload, "material")
    tests = _json_list(payload, "tests", required=True)
    details = []
    reciprocal_ranks = []
    for index, item in enumerate(tests):
        if not isinstance(item, dict):
            continue
        query = str(item.get("query", ""))
        expected = [str(term).lower() for term in item.get("expected", [])]
        result = research.knowledge_system("query", {"material": material, "query": query})
        citations = result["citations"]
        rank = 0
        for citation_index, citation in enumerate(citations, start=1):
            if any(term in citation["text"].lower() for term in expected):
                rank = citation_index
                break
        reciprocal_ranks.append(1 / rank if rank else 0)
        details.append({"test": index + 1, "query": query, "hit": bool(rank), "rank": rank})
    return {"tests": len(details), "hitAt5": round(sum(item["hit"] for item in details) / max(1, len(details)), 4), "mrr": round(mean(reciprocal_ranks), 4), "details": details}


def radar_openalex(payload: dict[str, Any]) -> dict[str, Any]:
    query = require_text(payload, "query", max_length=500)
    limit = int(clamp(number(payload, "limit", 10), 1, 20))
    params = urllib.parse.urlencode({"search": query, "per-page": limit})
    request = urllib.request.Request(f"https://api.openalex.org/works?{params}", headers={"Accept": "application/json", "User-Agent": "SkyViewLab/0.2"})
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ToolError(f"OpenAlex 暂不可用：{exc}") from exc
    records = []
    for item in data.get("results", []):
        records.append({
            "id": item.get("id", ""), "doi": str(item.get("doi") or "").replace("https://doi.org/", ""),
            "title": item.get("display_name", "未命名文献"), "year": item.get("publication_year"),
            "venue": (item.get("primary_location") or {}).get("source", {}).get("display_name", "") if (item.get("primary_location") or {}).get("source") else "",
            "citedByCount": item.get("cited_by_count", 0), "url": (item.get("primary_location") or {}).get("landing_page_url") or item.get("id", ""),
            "source": "OpenAlex",
        })
    return {"query": query, "provider": "OpenAlex", "total": len(records), "records": records}


def radar_all(payload: dict[str, Any]) -> dict[str, Any]:
    errors = []
    records = []
    for provider in (lambda: research.research_radar("search", payload), lambda: radar_openalex(payload)):
        try:
            records.extend(provider()["records"])
        except ToolError as exc:
            errors.append(str(exc))
    if not records:
        raise ToolError("；".join(errors) or "文献服务暂不可用")
    deduplicated = {}
    for record in records:
        key = record.get("doi") or re.sub(r"\W+", "", str(record.get("title", "")).lower())
        existing = deduplicated.get(key)
        if not existing or record.get("citedByCount", 0) > existing.get("citedByCount", 0):
            deduplicated[key] = record
    output = sorted(deduplicated.values(), key=lambda item: item.get("citedByCount", 0), reverse=True)
    return {"query": payload.get("query"), "providers": ["Crossref", "OpenAlex"], "total": len(output), "records": output, "errors": errors}


def radar_bibtex(payload: dict[str, Any]) -> dict[str, Any]:
    records = _json_list(payload, "records", required=True)
    entries = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        key = re.sub(r"\W+", "", str(record.get("title", "ref")))[:18] or f"ref{index + 1}"
        entries.append(f"@article{{{key}{record.get('year') or 'nd'},\n  title = {{{record.get('title', '')}}},\n  year = {{{record.get('year', '')}}},\n  doi = {{{record.get('doi', '')}}},\n  url = {{{record.get('url', '')}}}\n}}")
    return {"records": len(entries), "bibtex": "\n\n".join(entries)}


def mine_readiness(payload: dict[str, Any]) -> dict[str, Any]:
    text = require_text(payload, "text").lower()
    signals = {
        "现场验证": ["现场", "field", "mine site"],
        "真实传感器": ["sensor", "传感器", "gnss", "microseismic", "微震"],
        "对比基线": ["baseline", "对比", "benchmark"],
        "公开数据或代码": ["dataset", "数据集", "github", "code", "开源"],
        "不确定性": ["uncertainty", "不确定", "confidence interval"],
    }
    checks = [{"signal": name, "present": any(term in text for term in terms), "matched": [term for term in terms if term in text]} for name, terms in signals.items()]
    return {"score": round(sum(item["present"] for item in checks) / len(checks) * 100), "signals": checks, "decision": "工程证据较完整" if sum(item["present"] for item in checks) >= 4 else "需要补充工程证据"}


def gateway_flow(payload: dict[str, Any]) -> dict[str, Any]:
    nodes = _json_list(payload, "nodes", required=True)
    connections = _json_list(payload, "connections")
    ids = {str(node.get("id")) for node in nodes if isinstance(node, dict) and node.get("id")}
    findings = []
    graph: dict[str, list[str]] = defaultdict(list)
    indegree = {node_id: 0 for node_id in ids}
    for connection in connections:
        if not isinstance(connection, dict):
            continue
        source, target = str(connection.get("source", "")), str(connection.get("target", ""))
        if source not in ids or target not in ids:
            findings.append({"level": "high", "message": f"连接引用不存在节点：{source} → {target}"})
            continue
        graph[source].append(target)
        indegree[target] += 1
    queue = [node_id for node_id, degree in indegree.items() if degree == 0]
    order = []
    while queue:
        current = queue.pop(0)
        order.append(current)
        for target in graph[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(order) != len(ids):
        findings.append({"level": "high", "message": "数据流存在循环依赖"})
    for node in nodes:
        if not isinstance(node, dict):
            continue
        settings = json.dumps(node.get("properties", {}), ensure_ascii=False)
        if re.search(r"(?:password|secret|token|key)\s*['\"]?\s*:\s*['\"](?!ref:)", settings, re.I):
            findings.append({"level": "high", "message": f"节点 {node.get('id')} 含未使用 ref: 的敏感配置"})
    return {"valid": not any(item["level"] == "high" for item in findings), "nodes": len(ids), "connections": len(connections), "order": order, "findings": findings}


def ambient_preprocess(payload: dict[str, Any]) -> dict[str, Any]:
    values = parse_numbers(payload.get("values"), minimum=8)
    detrended = [value - mean(values) for value in values]
    taper = min(0.2, max(0.0, number(payload, "taper", 0.05)))
    edge = max(1, int(len(values) * taper))
    output = []
    for index, value in enumerate(detrended):
        weight = 1.0
        if index < edge:
            weight = 0.5 * (1 - math.cos(math.pi * index / edge))
        elif index >= len(values) - edge:
            weight = 0.5 * (1 - math.cos(math.pi * (len(values) - 1 - index) / edge))
        output.append(value * weight)
    peak = max(abs(value) for value in output) or 1
    normalized = [round(value / peak, 8) for value in output]
    return {"input": _describe(values), "output": _describe(normalized), "values": normalized, "steps": ["demean", "cosine-taper", "peak-normalize"]}


def ambient_dispersion(payload: dict[str, Any]) -> dict[str, Any]:
    distances = parse_numbers(payload.get("distances"), key="distances", minimum=2)
    travel_times = parse_numbers(payload.get("travelTimes"), key="travelTimes", minimum=2)
    periods = parse_numbers(payload.get("periods"), key="periods", minimum=2)
    if not (len(distances) == len(travel_times) == len(periods)):
        raise ToolError("distances、travelTimes 和 periods 长度必须一致")
    picks = []
    for period, distance, travel_time in zip(periods, distances, travel_times, strict=True):
        velocity = distance / travel_time if travel_time > 0 else 0
        picks.append({"period": period, "distance": distance, "travelTime": travel_time, "groupVelocity": round(velocity, 6), "accepted": velocity > 0})
    return {"picks": picks, "meanVelocity": round(mean([item["groupVelocity"] for item in picks if item["accepted"]]), 6)}


def data_profile(payload: dict[str, Any]) -> dict[str, Any]:
    source = require_text(payload, "csv")
    reader = csv.DictReader(io.StringIO(source))
    if not reader.fieldnames:
        raise ToolError("未识别到表头")
    rows = list(reader)
    profiles = []
    for field in reader.fieldnames:
        values = [str(row.get(field) or "").strip() for row in rows]
        non_empty = [value for value in values if value]
        numeric = []
        for value in non_empty:
            try:
                numeric.append(float(value))
            except ValueError:
                pass
        profiles.append({
            "field": field, "missing": len(values) - len(non_empty), "unique": len(set(non_empty)),
            "type": "number" if non_empty and len(numeric) == len(non_empty) else "string",
            "minimum": min(numeric) if numeric else None, "maximum": max(numeric) if numeric else None,
            "topValues": [{"value": value, "count": count} for value, count in Counter(non_empty).most_common(8)],
        })
    duplicates = len(rows) - len({tuple((field, row.get(field)) for field in reader.fieldnames) for row in rows})
    return {"rows": len(rows), "fields": len(reader.fieldnames), "duplicates": duplicates, "profiles": profiles}


def report_source_index(payload: dict[str, Any]) -> dict[str, Any]:
    material = require_text(payload, "material")
    report = require_text(payload, "report")
    chunks = [chunk.strip() for chunk in re.split(r"\n\s*\n|(?<=[。！？.!?])\s+", material) if chunk.strip()]
    labels = sorted(set(re.findall(r"\[(S1\.\d+)\]", report)))
    sources = []
    for label in labels:
        index = int(label.split(".")[1]) - 1
        sources.append({"label": label, "valid": 0 <= index < len(chunks), "excerpt": chunks[index][:240] if 0 <= index < len(chunks) else ""})
    return {"usedLabels": labels, "sources": sources, "coverage": round(len([item for item in sources if item["valid"]]) / max(1, len(chunks)), 4)}


def english_mastery(payload: dict[str, Any]) -> dict[str, Any]:
    progress = _json_list(payload, "progress", required=True)
    normalized = []
    for item in progress:
        if not isinstance(item, dict):
            continue
        attempts = max(0, int(item.get("attempts", 0)))
        correct = min(attempts, max(0, int(item.get("correct", 0))))
        ratio = correct / attempts if attempts else 0
        normalized.append({**item, "mastery": round(ratio * 100), "status": "mastered" if attempts >= 3 and ratio >= 0.8 else "learning" if attempts else "new"})
    return {"words": len(normalized), "mastered": sum(item["status"] == "mastered" for item in normalized), "items": normalized}


def assessment_judge(payload: dict[str, Any]) -> dict[str, Any]:
    code = require_text(payload, "code", max_length=20_000)
    tests = _json_list(payload, "tests", required=True)
    results = []
    for index, test in enumerate(tests[:30]):
        if not isinstance(test, dict):
            continue
        execution = teaching.python_lab("run", {"code": code, "stdin": str(test.get("stdin", ""))})
        expected = str(test.get("expected", "")).strip().replace("\r\n", "\n")
        actual = str(execution["stdout"]).strip().replace("\r\n", "\n")
        passed = execution["exitCode"] == 0 and actual == expected
        results.append({"case": index + 1, "name": test.get("name", f"测试 {index + 1}"), "passed": passed, "expected": expected, "actual": actual, "stderr": execution["stderr"], "timeMs": execution["durationMs"]})
    if not results:
        raise ToolError("tests 至少需要一个有效测试对象")
    passed = sum(item["passed"] for item in results)
    return {
        "verdict": "Accepted" if passed == len(results) else "Wrong Answer",
        "passed": passed,
        "total": len(results),
        "score": round(passed / len(results) * 100),
        "cases": results,
        "executionMode": "unsafe-development-prototype",
        "prototype": True,
        "productionSandbox": False,
        "warning": "该评测来自显式启用的同机开发运行器，不是容器沙箱，不得用于正式评分。",
    }


def submission_package(payload: dict[str, Any]) -> dict[str, Any]:
    files = _json_list(payload, "files", required=True)
    manifest = teaching.project_submission("manifest", {"files": files})
    if not manifest["valid"]:
        return {**manifest, "packageCreated": False}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for item in files:
            if isinstance(item, dict):
                package.writestr(str(item.get("path", "")), str(item.get("content", "")))
        package.writestr("submission-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    encoded = base64.b64encode(archive.getvalue()).decode("ascii")
    return {**manifest, "packageCreated": True, "fileName": f"skyviewlab-submission-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.zip", "base64": encoded}


EXTENDED_ACTIONS: dict[tuple[str, str], ActionHandler] = {
    ("disaster-remote-sensing", "describe"): remote_describe,
    ("disaster-remote-sensing", "zone-assessment"): remote_zones,
    ("seismic-physics", "spectrum"): seismic_spectrum,
    ("seismic-physics", "smooth"): seismic_smooth,
    ("patent-transfer", "trl-assess"): patent_trl,
    ("patent-transfer", "risk-register"): patent_risk,
    ("skill-evolution", "contract-validate"): skill_contract,
    ("skill-evolution", "release-check"): skill_release,
    ("knowledge-system", "concept-map"): knowledge_concepts,
    ("knowledge-system", "evaluate-retrieval"): knowledge_evaluate,
    ("research-radar", "search-openalex"): radar_openalex,
    ("research-radar", "search-all"): radar_all,
    ("research-radar", "export-bibtex"): radar_bibtex,
    ("mine-safety-radar", "readiness"): mine_readiness,
    ("ambient-noise-imaging", "preprocess"): ambient_preprocess,
    ("ambient-noise-imaging", "spectrum"): seismic_spectrum,
    ("ambient-noise-imaging", "dispersion"): ambient_dispersion,
    ("data-lab", "profile"): data_profile,
    ("ai-report", "source-index"): report_source_index,
    ("python-english", "mastery"): english_mastery,
    ("ai-assessment", "judge"): assessment_judge,
    ("project-submission", "package"): submission_package,
}


def run_extended(slug: str, action: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    handler = EXTENDED_ACTIONS.get((slug, action))
    if handler is None:
        return False, {}
    return True, handler(payload)


def extended_actions(slug: str) -> list[str]:
    return [action for (route_slug, action) in EXTENDED_ACTIONS if route_slug == slug]
