from __future__ import annotations

import csv
import io
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-research-radar-results"
TOPICS = ["环境噪声", "层析成像", "可复现研究", "证据综合", "开放数据", "地震监测"]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).replace("\x00", "").strip()


def _doi(value: Any) -> str:
    text = _clean(value).lower()
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text)
    return re.sub(r"^doi:\s*", "", text).strip().rstrip(".,;)")


def _title_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u3400-\u9fff]", "", _clean(value).lower())


def _year(value: Any) -> int:
    match = re.search(r"(?:19|20)\d{2}", _clean(value))
    return int(match.group(0)) if match else 0


def _csv_safe(value: Any) -> str:
    text = _clean(value)
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


def _record(
    index: int, title: str, year: int, topic: str, *, citations: int, oa: bool,
    grade: str, source: str = "离线基准", provider: str = "demo", doi: str = "",
    authors: list[str] | None = None, abstract: str = "",
) -> dict[str, Any]:
    key = _doi(doi) or (f"10.9000/skyview.radar.{index:02d}" if provider == "demo" else "")
    return {
        "id": f"radar-{index:02d}", "title": title, "normalizedTitle": _title_key(title),
        "doi": key, "year": year, "authors": authors or ["陈星", "赵岚"],
        "venue": "地球科学研究方法", "abstract": abstract or f"围绕{topic}构建可复核的方法、数据与验证链路。",
        "topics": [topic, "可复现研究" if index % 3 == 0 else "证据综合"],
        "keywords": [topic, "开放数据" if oa else "同行评审"], "citations": citations,
        "references": max(18, 28 + index * 2), "openAccess": oa,
        "url": f"https://doi.org/{key}" if key else "", "provider": provider, "providers": [provider],
        "source": source, "isDemo": provider == "demo", "datasetMode": "demo" if provider == "demo" else "imported" if provider == "import" else "live",
        "verifiedAt": "2026-09-09T00:00:00Z" if provider == "demo" else _now(),
        "relevance": round(max(.55, .96 - index * .025), 3), "novelty": round(.62 + (index % 5) * .06, 3),
        "evidenceGrade": grade, "evidenceProfile": {"data": index % 3 != 1, "code": index % 4 == 0, "validation": index % 2 == 0},
    }


def _sample_records() -> list[dict[str, Any]]:
    rows = [
        ("背景噪声层析成像的可复现处理链", 2026, "环境噪声", 48, True, "A"),
        ("面波频散自动拾取与不确定性评估", 2026, "层析成像", 31, True, "A"),
        ("多台站连续波形质量控制基准", 2025, "地震监测", 65, False, "B"),
        ("开放地球物理数据的证据溯源规范", 2025, "开放数据", 76, True, "A"),
        ("研究证据矩阵在地学综述中的应用", 2024, "证据综合", 89, True, "B"),
        ("跨来源文献实体消歧与 DOI 去重", 2024, "可复现研究", 54, False, "B"),
        ("环境噪声互相关的稳定性检验", 2023, "环境噪声", 123, True, "A"),
        ("稀疏台网条件下的面波反演", 2023, "层析成像", 112, False, "B"),
        ("地震监测数据质量门禁与审计", 2022, "地震监测", 98, True, "B"),
        ("科学知识图谱的主题演化分析", 2022, "证据综合", 147, True, "C"),
        ("科研软件与数据的长期可复现性", 2021, "可复现研究", 205, True, "A"),
        ("开放获取政策对地学成果传播的影响", 2021, "开放数据", 178, False, "C"),
    ]
    return [_record(i + 1, title, year, topic, citations=citations, oa=oa, grade=grade) for i, (title, year, topic, citations, oa, grade) in enumerate(rows)]


def _workspace() -> dict[str, Any]:
    now = "2026-09-09T00:00:00Z"
    return {
        "id": "radar-research-frontier", "name": "地球科学研究前沿", "version": 3,
        "query": {"main": "环境噪声 层析成像 可复现研究", "must": "证据", "exact": "", "exclude": "", "startYear": 2021, "endYear": 2026, "sort": "relevance", "oaOnly": False, "providers": ["crossref", "openalex"], "page": 1, "perPage": 12},
        "collections": [
            {"id": "inbox", "name": "待筛选", "color": "#3156a6"},
            {"id": "core", "name": "核心证据", "color": "#087f73"},
            {"id": "methods", "name": "方法与工具", "color": "#b56a14"},
        ],
        "library": [
            {"recordId": "radar-01", "collectionId": "core", "status": "included", "priority": "high", "tags": ["主证据", "方法"], "note": "方法链完整，可作为复现基线。"},
            {"recordId": "radar-02", "collectionId": "methods", "status": "included", "priority": "high", "tags": ["频散", "不确定性"], "note": "补充自动拾取评价。"},
            {"recordId": "radar-04", "collectionId": "core", "status": "maybe", "priority": "medium", "tags": ["开放数据"], "note": "需核验适用范围。"},
            {"recordId": "radar-07", "collectionId": "methods", "status": "included", "priority": "medium", "tags": ["互相关"], "note": "用于稳定性讨论。"},
            {"recordId": "radar-11", "collectionId": "core", "status": "included", "priority": "medium", "tags": ["可复现"], "note": "支撑研究治理部分。"},
        ],
        "evidenceNotes": {"use": "优先使用 A/B 级、可核验 DOI 与明确验证信息的研究。", "limitations": "离线基准仅用于功能校验；正式结论必须重新运行公开来源检索并人工复核。"},
        "monitors": [{"id": "monitor-weekly", "name": "环境噪声成像周报", "query": "ambient noise tomography reproducibility", "frequency": "weekly", "enabled": True, "lastRunAt": now, "lastStatus": "succeeded", "baselineIds": ["radar-01", "radar-02", "radar-07"], "newIds": ["radar-01"], "delivery": "站内运行记录", "nextRunAt": None}],
        "transfer": {"selectedIds": ["radar-01", "radar-02", "radar-04"], "history": []},
        "createdAt": now, "updatedAt": now,
    }


def _dedupe(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    merged: dict[str, dict[str, Any]] = {}
    duplicates = 0
    for raw in records:
        record = deepcopy(raw)
        record["doi"] = _doi(record.get("doi"))
        record["title"] = _clean(record.get("title")) or "未命名记录"
        record["normalizedTitle"] = _title_key(record["title"])
        provider = _clean(record.get("provider")) or "import"
        providers = [str(item) for item in record.get("providers", []) if item] or [provider]
        key = f"doi:{record['doi']}" if record["doi"] else f"title:{record['normalizedTitle']}"
        if key not in merged:
            record.setdefault("id", f"record-{uuid.uuid4()}")
            record["providers"] = list(dict.fromkeys(providers))
            record.setdefault("provider", provider)
            record.setdefault("source", "导入文件")
            record.setdefault("isDemo", False)
            record.setdefault("datasetMode", "imported")
            record.setdefault("verifiedAt", _now())
            record.setdefault("authors", [])
            record.setdefault("abstract", "")
            record.setdefault("topics", [])
            record.setdefault("keywords", [])
            record.setdefault("year", _year(record.get("year")))
            record.setdefault("citations", 0)
            record.setdefault("references", 0)
            record.setdefault("openAccess", False)
            record.setdefault("url", f"https://doi.org/{record['doi']}" if record["doi"] else "")
            record.setdefault("relevance", .5)
            record.setdefault("novelty", .5)
            record.setdefault("evidenceGrade", "C")
            record.setdefault("evidenceProfile", {"data": False, "code": False, "validation": False})
            merged[key] = record
            continue
        duplicates += 1
        target = merged[key]
        target["providers"] = list(dict.fromkeys([*target.get("providers", []), *providers]))
        if len(_clean(record.get("abstract"))) > len(_clean(target.get("abstract"))):
            target["abstract"] = _clean(record.get("abstract"))
        target["citations"] = max(int(target.get("citations", 0)), int(record.get("citations", 0)))
        target["openAccess"] = bool(target.get("openAccess") or record.get("openAccess"))
    return list(merged.values()), duplicates


def _analysis(records: list[dict[str, Any]], duplicate_count: int = 0) -> dict[str, Any]:
    years = Counter(int(item.get("year") or 0) for item in records if int(item.get("year") or 0))
    topics = Counter(topic for item in records for topic in item.get("topics", []) if topic)
    grades = Counter(_clean(item.get("evidenceGrade")) or "C" for item in records)
    nodes = []
    edges: list[dict[str, Any]] = []
    for index, (topic, count) in enumerate(topics.most_common(12)):
        nodes.append({"id": f"topic-{index + 1}", "label": topic, "type": "topic", "weight": count})
    for index in range(1, len(nodes)):
        edges.append({"id": f"edge-{index}", "source": nodes[(index - 1) // 2]["id"], "target": nodes[index]["id"], "weight": 1 + index % 3})
    for record in records[:8]:
        node_id = f"record-{record['id']}"
        nodes.append({"id": node_id, "label": record["title"], "type": "record", "weight": 1})
        first = next((node for node in nodes if node["type"] == "topic" and node["label"] in record.get("topics", [])), None)
        if first:
            edges.append({"id": f"edge-record-{record['id']}", "source": first["id"], "target": node_id, "weight": 1})
    oa = sum(bool(item.get("openAccess")) for item in records)
    return {
        "yearlyTrend": [{"year": year, "count": years[year]} for year in sorted(years)],
        "openAccess": {"open": oa, "closed": len(records) - oa, "rate": round(oa / len(records), 4) if records else 0},
        "topics": [{"name": name, "count": count} for name, count in topics.most_common(10)],
        "evidenceGrades": [{"grade": grade, "count": grades.get(grade, 0)} for grade in ["A", "B", "C", "D"]],
        "graph": {"nodes": nodes, "edges": edges}, "duplicateCount": duplicate_count,
        "averageRelevance": round(sum(float(item.get("relevance", 0)) for item in records) / len(records), 3) if records else 0,
        "synthesis": [
            "环境噪声与层析成像是当前样本中的高频方法主题。",
            "开放获取记录可直接进入全文复核，非开放记录仍需合法获取原文。",
            "证据等级只反映元数据与复现线索，不替代人工质量评价。",
        ],
    }


def _bibtex(records: list[dict[str, Any]]) -> str:
    blocks = []
    for index, item in enumerate(records):
        key = re.sub(r"[^A-Za-z0-9]", "", (item.get("authors") or ["Record"])[0].split()[-1]) or "Record"
        blocks.append("\n".join([f"@article{{{key}{item.get('year') or 'nd'}{index + 1},", f"  title = {{{item['title']}}},", f"  author = {{{' and '.join(item.get('authors') or [])}}},", f"  year = {{{item.get('year') or ''}}},", f"  journal = {{{item.get('venue') or ''}}},", f"  doi = {{{item.get('doi') or ''}}},", f"  url = {{{item.get('url') or ''}}}", "}"]))
    return "\n\n".join(blocks)


def _ris(records: list[dict[str, Any]]) -> str:
    lines = []
    for item in records:
        lines.extend(["TY  - JOUR", f"TI  - {item['title']}", *[f"AU  - {author}" for author in item.get("authors", [])], f"PY  - {item.get('year') or ''}", f"JO  - {item.get('venue') or ''}", f"DO  - {item.get('doi') or ''}", f"UR  - {item.get('url') or ''}", "ER  - ", ""])
    return "\n".join(lines)


def _csv(records: list[dict[str, Any]], workspace: dict[str, Any]) -> str:
    membership = {item["recordId"]: item for item in workspace.get("library", [])}
    stream = io.StringIO()
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["记录ID", "标题", "年份", "DOI", "作者", "来源", "开放获取", "证据等级", "筛选状态", "优先级", "标签", "备注"])
    for item in records:
        member = membership.get(item["id"], {})
        writer.writerow([item["id"], _csv_safe(item["title"]), item.get("year", ""), item.get("doi", ""), _csv_safe("; ".join(item.get("authors", []))), "; ".join(item.get("providers", [])), "是" if item.get("openAccess") else "否", item.get("evidenceGrade", ""), member.get("status", ""), member.get("priority", ""), "; ".join(member.get("tags", [])), _csv_safe(member.get("note", ""))])
    return stream.getvalue()


def _exports(result: dict[str, Any]) -> dict[str, str]:
    records, workspace = result["records"], result["workspace"]
    selected = [item for item in records if item["id"] in workspace.get("transfer", {}).get("selectedIds", [])] or records
    alerts = "# 科研雷达监测任务\n\n" + "\n".join(f"- {item['name']}：{item['lastStatus']}，最近运行 {item['lastRunAt']}，新增 {len(item.get('newIds', []))} 条" for item in workspace.get("monitors", []))
    knowledge = "# 研究雷达证据包\n\n" + "\n\n".join(f"## {item['title']}\n\n- DOI：{item.get('doi') or '无'}\n- 来源：{', '.join(item.get('providers', []))}\n- 证据等级：{item.get('evidenceGrade')}\n\n{item.get('abstract', '')}" for item in selected)
    backup = {"schema": "skyview-research-radar-backup", "version": 2, "workspace": workspace, "records": records, "sources": result["sources"], "analysis": result["analysis"]}
    return {"bibtex": _bibtex(records), "ris": _ris(records), "libraryCsv": _csv(records, workspace), "alertsMarkdown": alerts, "knowledgeMarkdown": knowledge, "knowledgeJson": json.dumps({"schema": "skyview-radar-evidence-transfer", "records": selected}, ensure_ascii=False, indent=2), "backupJson": json.dumps(backup, ensure_ascii=False, indent=2)}


def _sources(overrides: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    output = [
        {"id": "crossref", "name": "Crossref", "configured": True, "enabled": True, "status": "not-checked", "endpoint": "https://api.crossref.org/works", "timeoutSeconds": 12, "rateLimit": "公开 API 限额", "lastCheckedAt": None, "lastError": ""},
        {"id": "openalex", "name": "OpenAlex", "configured": True, "enabled": True, "status": "not-checked", "endpoint": "https://api.openalex.org/works", "timeoutSeconds": 12, "rateLimit": "公开 API 限额", "lastCheckedAt": None, "lastError": ""},
        {"id": "semantic-scholar", "name": "Semantic Scholar", "configured": False, "enabled": False, "status": "not-configured", "endpoint": "", "timeoutSeconds": 12, "rateLimit": "需要单独配置", "lastCheckedAt": None, "lastError": "尚未配置"},
    ]
    if overrides:
        for item in output:
            item.update(overrides.get(item["id"], {}))
    return output


def _result(workspace: dict[str, Any], records: list[dict[str, Any]], stage: str, sources: list[dict[str, Any]] | None = None, duplicate_count: int = 0) -> dict[str, Any]:
    records, deduplicated = _dedupe(records)
    result = {
        "schema": SCHEMA, "version": 2, "stage": stage, "workspace": workspace, "records": records,
        "analysis": _analysis(records, duplicate_count + deduplicated), "sources": sources or _sources(),
        "runtime": {"controlPlane": "Go 项目、作业、版本、权限与审计", "computePlane": "Python 文献适配、去重、分析与导出", "defaultDataMode": "demo", "liveSearchRequiresExplicitAction": True, "backgroundSchedulerConfigured": False, "persistentNotificationConfigured": False, "arbitraryCodeExecution": False},
    }
    result["exports"] = _exports(result)
    return result


def _bundle(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    state = payload.get("state") or payload.get("bundle") or payload.get("radar") or {}
    if not isinstance(state, dict):
        raise ToolError("科研雷达状态必须是对象")
    workspace = deepcopy(state.get("workspace") or payload.get("workspace") or _workspace())
    records = deepcopy(state.get("records") or payload.get("records") or _sample_records())
    sources = deepcopy(state.get("sources") or payload.get("sources") or _sources())
    return workspace, records, sources


def _request_json(url: str, timeout: int = 12) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "SkyViewLab-ResearchRadar/2.0 (mailto:admin@example.local)"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(4_000_000).decode("utf-8"))


def _crossref(query: str, limit: int, page: int) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"query.bibliographic": query, "rows": limit, "offset": max(0, page - 1) * limit, "select": "DOI,title,author,published-print,published-online,container-title,abstract,is-referenced-by-count,reference,URL,license,subject"})
    items = _request_json(f"https://api.crossref.org/works?{params}").get("message", {}).get("items", [])
    output = []
    for index, item in enumerate(items):
        title = _clean((item.get("title") or [""])[0])
        if not title: continue
        date_parts = (item.get("published-print") or item.get("published-online") or {}).get("date-parts", [[0]])
        output.append(_record(index + 1, title, int(date_parts[0][0] or 0), _clean((item.get("subject") or ["综合研究"])[0]) or "综合研究", citations=int(item.get("is-referenced-by-count") or 0), oa=bool(item.get("license")), grade="B", source="Crossref 公开 API", provider="crossref", doi=_doi(item.get("DOI")), authors=[_clean(f"{author.get('given', '')} {author.get('family', '')}") for author in item.get("author", []) if _clean(author.get("family"))], abstract=re.sub(r"<[^>]+>", " ", _clean(item.get("abstract")))))
    return output


def _openalex(query: str, limit: int, page: int) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"search": query, "per-page": limit, "page": page})
    items = _request_json(f"https://api.openalex.org/works?{params}").get("results", [])
    output = []
    for index, item in enumerate(items):
        title = _clean(item.get("display_name"))
        if not title: continue
        concepts = [_clean(value.get("display_name")) for value in item.get("topics", [])[:2] if value.get("display_name")]
        oa = item.get("open_access") or {}
        output.append(_record(1000 + index, title, int(item.get("publication_year") or 0), concepts[0] if concepts else "综合研究", citations=int(item.get("cited_by_count") or 0), oa=bool(oa.get("is_oa")), grade="B", source="OpenAlex 公开 API", provider="openalex", doi=_doi(item.get("doi")), authors=[_clean(author.get("author", {}).get("display_name")) for author in item.get("authorships", []) if author.get("author", {}).get("display_name")], abstract=""))
    return output


def _live_search(workspace: dict[str, Any], records: list[dict[str, Any]], sources: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any]:
    query_settings = workspace.setdefault("query", {})
    query = _clean(payload.get("query") or query_settings.get("main"))
    if not query: raise ToolError("研究主题不能为空")
    limit = min(25, max(1, int(payload.get("limit") or query_settings.get("perPage") or 12)))
    page = min(50, max(1, int(payload.get("page") or query_settings.get("page") or 1)))
    requested = payload.get("providers") or query_settings.get("providers") or ["crossref", "openalex"]
    requested = [item for item in requested if item in {"crossref", "openalex"}]
    live: list[dict[str, Any]] = []
    health: dict[str, dict[str, Any]] = {}
    for provider in requested:
        started = time.perf_counter()
        try:
            found = _crossref(query, limit, page) if provider == "crossref" else _openalex(query, limit, page)
            live.extend(found)
            health[provider] = {"status": "healthy", "lastCheckedAt": _now(), "lastError": "", "latencyMs": round((time.perf_counter() - started) * 1000), "records": len(found)}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            health[provider] = {"status": "failed", "lastCheckedAt": _now(), "lastError": _clean(error)[:240], "latencyMs": round((time.perf_counter() - started) * 1000), "records": 0}
    updated_sources = _sources(health)
    query_settings.update({"main": query, "page": page, "perPage": limit, "providers": requested})
    workspace["updatedAt"] = _now()
    if not live:
        result = _result(workspace, records, "search-live-failed", updated_sources)
        result["liveSearch"] = {"requested": True, "query": query, "page": page, "providers": requested, "returned": 0, "fallbackUsed": True, "message": "公开来源未返回记录，继续显示明确标记的离线基准。"}
        return result
    result = _result(workspace, live, "search-live", updated_sources)
    result["liveSearch"] = {"requested": True, "query": query, "page": page, "providers": requested, "returned": len(result["records"]), "fallbackUsed": False, "message": "公开来源记录已完成归一化与去重；正式使用前仍需核验全文。"}
    return result


def _parse_bibtex(text: str) -> list[dict[str, Any]]:
    output = []
    entries = [item for item in re.split(r"(?=@\w+\s*\{)", text, flags=re.I) if item.lstrip().startswith("@")]
    for index, entry in enumerate(entries):
        body = entry.split(",", 1)[1] if "," in entry else ""
        fields = {key.lower(): _clean(value.strip().strip("{},\"")) for key, value in re.findall(r"(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\"[^\"]*\"|[^,\n]+)", body, re.S)}
        if fields.get("title"):
            output.append(_record(2000 + index, fields["title"], _year(fields.get("year")), (fields.get("keywords") or "导入研究").split(",")[0], citations=0, oa=False, grade="C", source="BibTeX 导入", provider="import", doi=fields.get("doi", ""), authors=[item.strip() for item in re.split(r"\s+and\s+", fields.get("author", ""), flags=re.I) if item.strip()], abstract=fields.get("abstract", "")))
    return output


def _parse_ris(text: str) -> list[dict[str, Any]]:
    output, current = [], defaultdict(list)
    for line in text.splitlines():
        match = re.match(r"^([A-Z0-9]{2})\s{0,2}-\s?(.*)$", line.strip())
        if not match: continue
        tag, value = match.groups()
        if tag == "TY" and current: current = defaultdict(list)
        if tag == "ER":
            if current.get("TI") or current.get("T1"):
                title = (current.get("TI") or current.get("T1"))[0]
                output.append(_record(3000 + len(output), title, _year((current.get("PY") or current.get("Y1") or [""])[0]), "导入研究", citations=0, oa=False, grade="C", source="RIS 导入", provider="import", doi=(current.get("DO") or [""])[0], authors=current.get("AU", []), abstract=(current.get("AB") or [""])[0]))
            current = defaultdict(list)
        else: current[tag].append(value)
    return output


def _import_records(payload: dict[str, Any], workspace: dict[str, Any], records: list[dict[str, Any]], sources: list[dict[str, Any]]) -> dict[str, Any]:
    content = _clean(payload.get("content"))
    file_name = _clean(payload.get("fileName")).lower()
    if not content: raise ToolError("导入内容不能为空")
    if len(content.encode("utf-8")) > 2_000_000: raise ToolError("导入文件超过 2 MB 安全上限")
    imported: list[dict[str, Any]] = []
    if file_name.endswith(".bib") or content.lstrip().startswith("@"):
        imported = _parse_bibtex(content)
    elif file_name.endswith(".ris") or content.startswith("TY  -"):
        imported = _parse_ris(content)
    else:
        try: parsed = json.loads(content)
        except json.JSONDecodeError as error: raise ToolError(f"JSON 无效：{error.msg}") from error
        rows = parsed if isinstance(parsed, list) else parsed.get("records", []) if isinstance(parsed, dict) else []
        if not isinstance(rows, list): raise ToolError("JSON 中未找到 records 数组")
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not _clean(row.get("title")): continue
            row = deepcopy(row); row.setdefault("id", f"import-{uuid.uuid4()}"); row["provider"] = "import"; row["providers"] = ["import"]; row["source"] = "JSON 导入"; row["isDemo"] = False; row["datasetMode"] = "imported"; row["verifiedAt"] = _now(); row.setdefault("evidenceGrade", "C"); row.setdefault("relevance", .5); row.setdefault("novelty", .5); imported.append(row)
    if not imported: raise ToolError("未从文件中解析出有效文献记录")
    merged, duplicates = _dedupe([*records, *imported])
    workspace["updatedAt"] = _now()
    result = _result(workspace, merged, "import-records", sources, duplicates)
    result["importSummary"] = {"parsed": len(imported), "duplicates": duplicates, "total": len(result["records"]), "executed": False}
    return result


def run_research_radar(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    workspace, records, sources = _bundle(payload)
    if action in {"load-sample", "run-all"}:
        return _result(_workspace(), _sample_records(), action)
    if action in {"search", "search-live"}:
        return _live_search(workspace, records, sources, payload)
    if action == "import-records":
        return _import_records(payload, workspace, records, sources)
    if action == "dedupe":
        records, duplicates = _dedupe(records)
        return _result(workspace, records, action, sources, duplicates)
    if action == "update-library":
        record_id = _clean(payload.get("recordId")); record = next((item for item in records if item["id"] == record_id), None)
        if not record: raise ToolError("文献记录不存在")
        library = workspace.setdefault("library", [])
        item = next((entry for entry in library if entry["recordId"] == record_id), None)
        values = {"recordId": record_id, "collectionId": _clean(payload.get("collectionId")) or "inbox", "status": _clean(payload.get("status")) or "maybe", "priority": _clean(payload.get("priority")) or "medium", "tags": payload.get("tags") if isinstance(payload.get("tags"), list) else [], "note": _clean(payload.get("note"))}
        if item: item.update(values)
        else: library.insert(0, values)
        workspace["updatedAt"] = _now()
        return _result(workspace, records, action, sources)
    if action == "update-evidence":
        notes = workspace.setdefault("evidenceNotes", {})
        notes.update({"use": _clean(payload.get("use")) or notes.get("use", ""), "limitations": _clean(payload.get("limitations")) or notes.get("limitations", "")})
        for item in records:
            if item["id"] == payload.get("recordId") and _clean(payload.get("evidenceGrade")) in {"A", "B", "C", "D"}: item["evidenceGrade"] = _clean(payload.get("evidenceGrade"))
        return _result(workspace, records, action, sources)
    if action == "run-monitor":
        monitor_id = _clean(payload.get("monitorId")); monitor = next((item for item in workspace.setdefault("monitors", []) if item["id"] == monitor_id), None)
        if not monitor: raise ToolError("监测任务不存在")
        current_ids = [item["id"] for item in records[:8]]
        baseline = set(monitor.get("baselineIds", [])); new_ids = [item for item in current_ids if item not in baseline]
        monitor.update({"lastRunAt": _now(), "lastStatus": "succeeded", "newIds": new_ids, "baselineIds": current_ids, "nextRunAt": None})
        workspace.setdefault("monitorRuns", []).insert(0, {"id": f"monitor-run-{uuid.uuid4()}", "monitorId": monitor_id, "status": "succeeded", "startedAt": monitor["lastRunAt"], "finishedAt": monitor["lastRunAt"], "newIds": new_ids, "notificationStatus": "recorded", "deduplicationKey": f"{monitor_id}:{','.join(new_ids)}"})
        result = _result(workspace, records, action, sources); result["monitorRun"] = workspace["monitorRuns"][0]; return result
    if action == "transfer":
        ids = [str(item) for item in payload.get("recordIds", []) if any(record["id"] == str(item) for record in records)]
        destination = _clean(payload.get("destination")) or "knowledge-system"
        workspace.setdefault("transfer", {})["selectedIds"] = ids
        workspace["transfer"].setdefault("history", []).insert(0, {"id": f"transfer-{uuid.uuid4()}", "destination": destination, "recordIds": ids, "createdAt": _now(), "status": "packaged"})
        return _result(workspace, records, action, sources)
    if action == "export":
        return _result(workspace, records, action, sources)
    raise ToolError("不支持的科研雷达操作")
