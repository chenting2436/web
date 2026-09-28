from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


STAGES = [
    {"id": "research", "code": "1", "name": "研究", "mandatory": False},
    {"id": "write", "code": "2", "name": "写作", "mandatory": False},
    {"id": "integrity_pre", "code": "2.5", "name": "完整性核验", "mandatory": True},
    {"id": "review", "code": "3", "name": "审稿", "mandatory": True},
    {"id": "revise", "code": "4", "name": "修订", "mandatory": False},
    {"id": "re_review", "code": "3′", "name": "复审", "mandatory": True},
    {"id": "re_revise", "code": "4′", "name": "再修订", "mandatory": False},
    {"id": "integrity_final", "code": "4.5", "name": "最终核验", "mandatory": True},
    {"id": "finalize", "code": "5", "name": "定稿", "mandatory": True},
    {"id": "process", "code": "6", "name": "过程总结", "mandatory": False},
]

PAPER_TYPES: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "empirical": ("实证研究", [("abstract", "摘要"), ("introduction", "1 引言"), ("literature", "2 相关研究"), ("materials", "3 数据与研究对象"), ("methods", "4 研究方法"), ("results", "5 结果"), ("discussion", "6 讨论"), ("conclusion", "7 结论"), ("declarations", "声明")]),
    "review": ("主题文献综述", [("abstract", "摘要"), ("introduction", "1 引言"), ("review_method", "2 综述方法"), ("themes", "3 主题综合"), ("gaps", "4 证据缺口"), ("discussion", "5 讨论"), ("conclusion", "6 结论"), ("declarations", "声明")]),
    "theoretical": ("理论分析", [("abstract", "摘要"), ("introduction", "1 引言"), ("concepts", "2 核心概念"), ("framework", "3 理论框架"), ("propositions", "4 命题与论证"), ("implications", "5 理论与实践意义"), ("conclusion", "6 结论"), ("declarations", "声明")]),
    "case": ("案例研究", [("abstract", "摘要"), ("introduction", "1 引言"), ("case_context", "2 案例背景"), ("methods", "3 研究设计"), ("findings", "4 案例发现"), ("discussion", "5 讨论"), ("conclusion", "6 结论"), ("declarations", "声明")]),
    "policy": ("政策简报", [("executive", "执行摘要"), ("problem", "1 问题界定"), ("evidence", "2 证据基础"), ("options", "3 政策选项"), ("recommendation", "4 建议"), ("implementation", "5 实施与评估"), ("references", "参考文献")]),
    "conference": ("会议论文", [("abstract", "摘要"), ("introduction", "1 引言"), ("methods", "2 方法"), ("results", "3 结果"), ("discussion", "4 讨论"), ("conclusion", "5 结论"), ("declarations", "声明")]),
}

FAILURE_MODES = [
    ("fabricated_evidence", "虚构文献或证据"),
    ("unsupported_claim", "论断超出证据"),
    ("data_method_mismatch", "数据与方法不匹配"),
    ("citation_drift", "引文与陈述错位"),
    ("hidden_uncertainty", "掩盖不确定性"),
    ("automation_bias", "将自动判断冒充专家结论"),
    ("undeclared_ai", "AI 使用未披露"),
]
CITATION_STYLES = ["APA 7", "Chicago Author-Date", "MLA 9", "IEEE", "Vancouver"]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4()}"


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _words(value: Any) -> int:
    text = _clean(value)
    chinese = len(re.findall(r"[\u3400-\u9fff]", text))
    western = len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", re.sub(r"[\u3400-\u9fff]", " ", text)))
    return chinese + western


def _hash(value: Any) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()[:16]


def _sections(paper_type: str = "empirical") -> list[dict[str, Any]]:
    selected = paper_type if paper_type in PAPER_TYPES else "empirical"
    return [{"id": item_id, "name": name, "content": "", "status": "empty", "updatedAt": _now()} for item_id, name in PAPER_TYPES[selected][1]]


def _stage_records() -> list[dict[str, Any]]:
    return [{"id": stage["id"], "status": "in_progress" if index == 0 else "pending", "attempts": 0, "completedAt": None, "confirmedAt": None, "note": "", "deliverables": []} for index, stage in enumerate(STAGES)]


def create_project(title: str = "", paper_type: str = "empirical") -> dict[str, Any]:
    selected = paper_type if paper_type in PAPER_TYPES else "empirical"
    sections = _sections(selected)
    now = _now()
    return {
        "id": _uid("paper"), "schema": "skyview-ars-paper", "schemaVersion": 1,
        "title": _clean(title) or "未命名研究论文", "status": "active", "createdAt": now, "updatedAt": now,
        "currentStage": "research", "stageRecords": _stage_records(), "activeSection": sections[0]["id"],
        "config": {"mode": "plan", "paperType": selected, "language": "zh-CN", "citationStyle": "APA 7", "wordTarget": 6000, "discipline": "", "targetJournal": "", "authors": "", "affiliations": "", "correspondingAuthor": "", "keywords": ""},
        "framing": {"topic": "", "problem": "", "significance": "", "gap": "", "question": "", "hypothesis": "", "objectives": "", "contribution": "", "theory": "", "scope": "", "exclusions": ""},
        "methodology": {"design": "", "studyArea": "", "population": "", "sampling": "", "sampleSize": "", "period": "", "dataSources": "", "variables": "", "preprocessing": "", "analysis": "", "validation": "", "software": "", "ethics": "", "dataAvailability": "", "limitations": ""},
        "outline": [{"sectionId": item["id"], "heading": item["name"], "purpose": "", "evidenceKeys": [], "status": "planned"} for item in sections],
        "sections": sections, "references": [], "claims": [], "experiments": [], "assets": [], "integrityRuns": [], "reviews": [], "revisionItems": [], "snapshots": [], "decisions": [], "activities": [],
        "disclosure": {"usedAI": False, "tools": "", "purpose": "", "humanVerification": "", "text": ""},
        "finalization": {"selectedStyle": "APA 7", "formats": [], "finalizedAt": None, "coverLetter": "", "processRecord": ""},
    }


def _project(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ToolError("project 不是有效 JSON") from error
    if not isinstance(value, dict):
        raise ToolError("project 必须是对象")
    base = create_project(value.get("title", ""), (value.get("config") or {}).get("paperType", "empirical"))
    result = deepcopy(base)
    result.update(deepcopy(value))
    for key in ("config", "framing", "methodology", "disclosure", "finalization"):
        result[key] = {**base[key], **(deepcopy(value.get(key)) if isinstance(value.get(key), dict) else {})}
    for key in ("sections", "outline", "references", "claims", "experiments", "assets", "integrityRuns", "reviews", "revisionItems", "snapshots", "decisions", "activities"):
        result[key] = deepcopy(value.get(key)) if isinstance(value.get(key), list) else deepcopy(base[key])
    records = value.get("stageRecords") if isinstance(value.get("stageRecords"), list) else []
    result["stageRecords"] = [{**base["stageRecords"][index], **next((deepcopy(row) for row in records if row.get("id") == stage["id"]), {})} for index, stage in enumerate(STAGES)]
    if result.get("currentStage") not in {stage["id"] for stage in STAGES}:
        result["currentStage"] = "research"
    if not any(section.get("id") == result.get("activeSection") for section in result["sections"]):
        result["activeSection"] = result["sections"][0]["id"] if result["sections"] else "abstract"
    return result


def normalize_doi(value: Any) -> str:
    return re.sub(r"[\s.,;]+$", "", re.sub(r"^doi:\s*", "", re.sub(r"^https?://(?:dx\.)?doi\.org/", "", _clean(value).lower())))


def parse_bibtex(source: str) -> list[dict[str, Any]]:
    matches = list(re.finditer(r"@(article|book|inproceedings|proceedings|techreport|misc|phdthesis|mastersthesis)\s*\{\s*([^,]+),", source, re.I))
    records: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        chunk = source[match.start():matches[index + 1].start() if index + 1 < len(matches) else len(source)]
        def field(name: str) -> str:
            found = re.search(rf"\b{name}\s*=\s*(?:\{{([^}}]*)\}}|\"([^\"]*)\")", chunk, re.I)
            return re.sub(r"[{}]", "", _clean((found.group(1) or found.group(2)) if found else ""))
        key = re.sub(r"[^A-Za-z0-9:_-]", "", _clean(match.group(2)))
        record = {"id": _uid("ref"), "key": key, "type": match.group(1).lower(), "title": field("title"), "authors": field("author"), "year": field("year"), "venue": field("journal") or field("booktitle"), "volume": field("volume"), "issue": field("number"), "pages": field("pages"), "doi": normalize_doi(field("doi")), "url": field("url"), "abstract": field("abstract"), "status": "candidate", "verification": "unverified", "locator": "", "notes": "BibTeX import", "addedAt": _now(), "source": "BibTeX"}
        if record["key"] and record["title"]:
            records.append(record)
    return records


def dedupe_references(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    dois: set[str] = set()
    titles: set[str] = set()
    kept: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for source in items:
        item = deepcopy(source)
        doi = normalize_doi(item.get("doi"))
        title = re.sub(r"\s+", " ", _clean(item.get("title")).lower())
        item["doi"] = doi
        if (doi and doi in dois) or (not doi and title and title in titles):
            duplicates.append(item)
        else:
            kept.append(item)
            if doi:
                dois.add(doi)
            if title:
                titles.add(title)
    return kept, duplicates


def _manuscript(project: dict[str, Any]) -> str:
    return "\n\n".join(_clean(item.get("content")) for item in project["sections"])


def _citations(value: str) -> list[str]:
    keys: list[str] = []
    for group in re.findall(r"\[@([^\]]+)\]", value):
        keys.extend(re.sub(r"^@", "", item.strip()) for item in re.split(r"[;,]", group) if item.strip())
    return list(dict.fromkeys(keys))


def _add_issue(issues: list[dict[str, Any]], severity: str, category: str, message: str, action: str, evidence: str = "") -> None:
    issues.append({"id": _uid("audit"), "severity": severity, "category": category, "message": message, "action": action, "evidence": evidence})


def audit_integrity(project_value: Any, phase: str = "pre") -> dict[str, Any]:
    project = _project(project_value)
    issues: list[dict[str, Any]] = []
    text = _manuscript(project)
    references = [item for item in project["references"] if item.get("status") != "excluded"]
    keys = {str(item.get("key") or "") for item in references}
    cited = _citations(text)
    unresolved = [key for key in cited if key not in keys]
    required = [item[0] for item in PAPER_TYPES[project["config"]["paperType"]][1]]
    completed = [item for item in project["sections"] if _words(item.get("content")) >= 20]
    _, duplicates = dedupe_references(references)
    if not _clean(project["title"]) or project["title"] == "未命名研究论文": _add_issue(issues, "high", "framing", "论文题目尚未确定", "填写能说明对象、关系或方法的具体题目")
    if not _clean(project["framing"]["question"]): _add_issue(issues, "critical", "framing", "缺少研究问题", "由作者确认研究问题")
    if not _clean(project["framing"]["gap"]): _add_issue(issues, "high", "framing", "研究缺口尚未由作者界定", "根据已核对文献说明现有知识不足")
    if not _clean(project["framing"]["contribution"]): _add_issue(issues, "medium", "framing", "预期贡献尚不明确", "区分理论、方法、实证或实践贡献")
    for key, severity, message in (("design", "critical", "缺少研究设计"), ("dataSources", "high", "数据来源未记录"), ("analysis", "high", "分析方法未记录"), ("limitations", "medium", "局限性尚未记录"), ("ethics", "medium", "伦理与合规状态未声明")):
        if not _clean(project["methodology"][key]): _add_issue(issues, severity, "ethics" if key == "ethics" else "methodology", message, "补充并核验相应研究记录")
    missing = [section_id for section_id in required if not any(item.get("id") == section_id and _words(item.get("content")) >= 20 for item in project["sections"])]
    if missing: _add_issue(issues, "high" if phase == "final" else "medium", "manuscript", f"缺失或过短章节：{'、'.join(missing)}", "完成目标结构中的全部章节")
    if re.search(r"【[^】]*(?:待|核验|补充)|\[(?:TODO|VERIFY|SOURCE|RESULTS? REQUIRED|AUTHOR VERIFICATION)[^\]]*\]", text, re.I): _add_issue(issues, "high", "integrity", "正文仍含待补充或待核验标记", "用可追溯事实替换占位内容，或明确保留为局限")
    if not references: _add_issue(issues, "critical", "citation", "参考文献库为空", "导入并人工核对真实来源")
    if unresolved: _add_issue(issues, "critical", "citation", f"无法解析引文键：{'、'.join(unresolved)}", "修复引文键或补充对应文献")
    if duplicates: _add_issue(issues, "medium", "citation", f"检测到 {len(duplicates)} 条重复文献", "按 DOI 或规范化题名合并")
    unverified = [item for item in references if item.get("key") in cited and item.get("verification") != "verified"]
    if unverified: _add_issue(issues, "high", "citation", f"{len(unverified)} 条已引用来源尚未核验原文", "阅读原文并填写页码、章节或段落", ", ".join(str(item.get("key")) for item in unverified))
    unsupported = [claim for claim in project["claims"] if claim.get("status") != "withdrawn" and not any(key in keys for key in claim.get("referenceKeys", [])) and not any(experiment.get("id") in claim.get("experimentIds", []) and experiment.get("status") == "verified" for experiment in project["experiments"])]
    if unsupported: _add_issue(issues, "high", "claims", f"{len(unsupported)} 条登记论断没有可用证据", "关联已核验文献或实验，无法支持时收缩或撤回")
    result_numbers = len(re.findall(r"(?:\d+(?:\.\d+)?\s*(?:%|±|CI)|p\s*[<=>]\s*\.?\d+)", text, re.I))
    if result_numbers and not any(item.get("status") == "verified" for item in project["experiments"]): _add_issue(issues, "critical", "data", f"正文含 {result_numbers} 处结果型数值，但没有已核验实验来源", "登记数据版本、脚本、指标和核验人")
    if any(item.get("status") != "verified" for item in project["experiments"]): _add_issue(issues, "medium", "data", "存在尚未核验的实验记录", "核对数据版本、参数、输出与正文陈述")
    if any(not _clean(item.get("source")) or item.get("verified") is not True for item in project["assets"]): _add_issue(issues, "medium", "assets", "部分图表缺少来源或内容核验", "记录图表来源、生成方法和正文对应关系")
    if project["disclosure"]["usedAI"] and not _clean(project["disclosure"]["text"]): _add_issue(issues, "high", "disclosure", "记录了 AI 使用但尚未形成披露声明", "按照目标期刊政策形成并确认披露")
    if phase == "final" and _words(text) < max(800, int(project["config"].get("wordTarget") or 6000) * 0.7): _add_issue(issues, "medium", "manuscript", f"稿件字数 {_words(text)}，低于目标的 70%", "核对目标期刊篇幅并补足必要论证")
    penalty = sum({"critical": 24, "high": 13, "medium": 5, "low": 2}.get(item["severity"], 0) for item in issues)
    flags = {
        "fabricated_evidence": any(item["category"] == "citation" and item["severity"] == "critical" for item in issues),
        "unsupported_claim": any(item["category"] == "claims" for item in issues),
        "data_method_mismatch": any(item["category"] in {"data", "methodology"} and item["severity"] in {"critical", "high"} for item in issues),
        "citation_drift": any(item["category"] == "citation" for item in issues),
        "hidden_uncertainty": any("局限" in item["message"] or "不确定" in item["message"] for item in issues),
        "automation_bias": bool(re.search(r"自动|模型|AI", text, re.I) and not re.search(r"人工|专家|复核|human", text, re.I)),
        "undeclared_ai": bool(project["disclosure"]["usedAI"] and not _clean(project["disclosure"]["text"])),
    }
    blocking = [item for item in issues if item["severity"] in {"critical", "high"}]
    return {"id": _uid("integrity"), "phase": phase, "createdAt": _now(), "pass": not issues if phase == "final" else not blocking, "score": max(0, 100 - min(100, penalty)), "issues": issues, "stats": {"words": _words(text), "sections": len(project["sections"]), "completedSections": len(completed), "references": len(references), "cited": len(cited), "claims": len(project["claims"]), "verifiedExperiments": len([item for item in project["experiments"] if item.get("status") == "verified"])}, "failureModes": [{"id": item_id, "name": name, "status": "suspected" if flags[item_id] else "clear"} for item_id, name in FAILURE_MODES], "manuscriptHash": _hash(text)}


def _placeholder(value: Any, label: str) -> str:
    return _clean(value) or f"【待作者核验：{label}】"


def _citation_group(project: dict[str, Any], start: int = 0) -> str:
    items = [item for item in project["references"] if item.get("status") == "included" and item.get("verification") == "verified" and item.get("key")][start:start + 2]
    return f" [{'; '.join('@' + item['key'] for item in items)}]" if items else "【待作者补充已核验来源】"


def generate_draft(project_value: Any) -> dict[str, Any]:
    project = _project(project_value)
    framing, method = project["framing"], project["methodology"]
    verified_claims = "；".join(_clean(item.get("text")) for item in project["claims"] if item.get("status") == "verified" and _clean(item.get("text"))) or "【待作者基于真实分析结果填写主要发现】"
    c1, c2 = _citation_group(project), _citation_group(project, 2)
    content = {
        "abstract": f"目的：围绕{_placeholder(framing['problem'], '研究问题背景')}，回答“{_placeholder(framing['question'], '研究问题')}”。方法：采用{_placeholder(method['design'], '研究设计')}，数据来源包括{_placeholder(method['dataSources'], '数据来源')}。结果：{verified_claims}。结论：本研究的贡献为{_placeholder(framing['contribution'], '研究贡献')}。所有结果必须与登记证据逐项复核。",
        "introduction": f"{_placeholder(framing['problem'], '研究背景与问题')}。该问题的重要性在于{_placeholder(framing['significance'], '研究意义')}{c1}。\n\n现有研究的不足为{_placeholder(framing['gap'], '现有研究缺口')}{c2}。\n\n本文提出研究问题：{_placeholder(framing['question'], '研究问题')}。研究目标包括：{_placeholder(framing['objectives'], '研究目标')}。预期贡献为：{_placeholder(framing['contribution'], '原创贡献')}。",
        "literature": f"文献分析围绕研究对象、理论解释、数据与方法、主要发现及适用边界展开{c1}。每项核心论断应绑定引文键和定位信息{c2}。\n\n研究缺口为：{_placeholder(framing['gap'], '研究缺口')}。这一判断仍需作者根据检索式、纳排标准和原文阅读记录确认。",
        "materials": f"研究对象与范围为{_placeholder(method['studyArea'] or framing['scope'], '研究区、样本或对象')}，时间为{_placeholder(method['period'], '研究时间')}。数据来源包括{_placeholder(method['dataSources'], '来源、版本与访问时间')}。主要变量为{_placeholder(method['variables'], '变量定义')}。",
        "methods": f"研究采用{_placeholder(method['design'], '研究设计')}。预处理包括{_placeholder(method['preprocessing'], '预处理和质量控制')}。核心分析为{_placeholder(method['analysis'], '分析流程')}。\n\n验证设计为{_placeholder(method['validation'], '验证与不确定性分析')}。软件环境为{_placeholder(method['software'], '软件、版本与参数')}。伦理与合规：{_placeholder(method['ethics'], '审批、豁免或不适用理由')}。",
        "results": f"依据当前登记并标记为已核验的论断，主要结果为：{verified_claims}。\n\n【待作者将每项结果与实验记录、数据版本、分析输出、图表和不确定性逐项对应。】",
        "discussion": f"结果需要在{_placeholder(framing['theory'], '理论或概念框架')}下解释，并说明与现有研究的一致、差异及原因{c1}。解释范围受到以下限制：{_placeholder(method['limitations'], '样本、测量、方法和外推限制')}。",
        "conclusion": f"本文围绕“{_placeholder(framing['question'], '研究问题')}”开展研究。当前证据支持的结论为：{verified_claims}。主要贡献是{_placeholder(framing['contribution'], '研究贡献')}。",
        "declarations": f"数据可用性：{_placeholder(method['dataAvailability'], '数据可用性声明')}\n\n伦理与合规：{_placeholder(method['ethics'], '伦理声明')}\n\n作者贡献：【待全体作者确认】\n\n利益冲突：【待全体作者确认】\n\nAI 使用披露：{_placeholder(project['disclosure']['text'], 'AI 工具、用途和人工核验') if project['disclosure']['usedAI'] else '当前记录为未使用生成式 AI；投稿前请再次确认。'}",
    }
    aliases = {"review_method": f"综述问题为{_placeholder(framing['question'], '综述问题')}。数据库、日期、检索式、去重、纳排和质量评价均需作者登记。", "themes": content["literature"], "gaps": content["discussion"], "concepts": content["literature"], "framework": content["methods"], "propositions": content["results"], "implications": content["discussion"], "case_context": content["materials"], "findings": content["results"], "executive": content["abstract"], "problem": content["introduction"], "evidence": content["literature"], "options": "【待作者比较政策选项的目标、机制、资源、收益、风险与证据强度】", "recommendation": "【待作者确认政策建议、价值权衡和证据依据】", "implementation": "【待作者填写责任主体、时间表、资源、风险和评估指标】", "references": f"参考文献按 {project['config']['citationStyle']} 输出并逐条核对。"}
    now = _now()
    project["sections"] = [{**item, "content": content.get(item["id"], aliases.get(item["id"], "【待作者根据研究证据完成本节】")), "status": "draft", "updatedAt": now} for item in project["sections"]]
    project["activeSection"] = project["sections"][0]["id"]
    project["activities"].insert(0, {"id": _uid("activity"), "type": "draft", "message": "基于作者登记材料生成完整结构稿；未核验内容保持明确标记", "createdAt": now})
    project["updatedAt"] = now
    return project


def reviewer_panel(project_value: Any, rereview: bool = False) -> dict[str, Any]:
    project = _project(project_value)
    if rereview:
        findings = [{"id": _uid("finding"), "severity": item.get("severity", "medium"), "issue": f"未解决：{item.get('issue', '')}", "recommendation": item.get("action", "完成修订响应"), "status": "open"} for item in project["revisionItems"] if item.get("status") != "resolved"]
        for item in project["revisionItems"]:
            if item.get("status") == "resolved" and (not _clean(item.get("response")) or not _clean(item.get("evidence"))):
                findings.append({"id": _uid("finding"), "severity": "medium", "issue": f"缺少修订响应或证据：{item.get('issue', '')}", "recommendation": "补充改动位置和核验依据", "status": "open"})
        high = len([item for item in findings if item["severity"] in {"critical", "high"}])
        report = {"id": _uid("report"), "roleId": "revision_verifier", "role": "修订核验审稿人", "score": max(0, 100 - high * 18 - (len(findings) - high) * 6), "findings": findings or [{"id": _uid("finding"), "severity": "pass", "issue": "修订项均有响应和证据，未发现阻断项", "recommendation": "进入最终核验前仍需作者确认", "status": "noted"}]}
        return {"id": _uid("review"), "round": len(project["reviews"]) + 1, "type": "re-review", "decision": "major" if high >= 2 else "minor" if findings else "accept", "reports": [report], "roadmap": [_revision(item, index) for index, item in enumerate(findings)], "createdAt": _now(), "manuscriptHash": _hash(_manuscript(project))}
    audit = audit_integrity(project, "pre")
    text = _manuscript(project)
    role_defs = [("journal_fit", "期刊适配审稿人", {"manuscript", "framing"}), ("theory", "理论与论证审稿人", {"framing", "claims"}), ("methodology", "方法学审稿人", {"methodology", "data", "ethics"}), ("evidence", "证据与引文审稿人", {"citation", "claims", "assets"}), ("devils_advocate", "反方挑战审稿人", {"claims", "integrity", "disclosure"})]
    reports = []
    for role_id, role, categories in role_defs:
        findings = [{"id": _uid("finding"), "severity": item["severity"], "sectionId": "", "issue": item["message"], "recommendation": item["action"], "evidence": item["evidence"], "status": "open"} for item in audit["issues"] if item["category"] in categories]
        if role_id == "journal_fit" and not _clean(project["config"]["targetJournal"]): findings.append({"id": _uid("finding"), "severity": "medium", "sectionId": "", "issue": "尚未指定目标期刊或会议", "recommendation": "核对范围、体例、篇幅、数据和 AI 披露政策", "evidence": "", "status": "open"})
        if role_id == "theory" and not _clean(project["framing"]["theory"]): findings.append({"id": _uid("finding"), "severity": "medium", "sectionId": "literature", "issue": "理论或概念框架未明确", "recommendation": "说明框架如何连接问题、变量与解释", "evidence": "", "status": "open"})
        if role_id == "devils_advocate" and not re.search(r"替代|反例|失败|局限|alternative|limitation", text, re.I): findings.append({"id": _uid("finding"), "severity": "high", "sectionId": "discussion", "issue": "没有充分处理替代解释或失败条件", "recommendation": "列出替代解释、反例和结论不成立的条件", "evidence": "", "status": "open"})
        if not findings: findings = [{"id": _uid("finding"), "severity": "pass", "sectionId": "", "issue": "规则检查未发现该角色范围内的阻断项", "recommendation": "仍需真实同行阅读全文", "evidence": "", "status": "noted"}]
        penalty = sum({"critical": 30, "high": 15, "medium": 6, "low": 2}.get(item["severity"], 0) for item in findings)
        reports.append({"id": _uid("report"), "roleId": role_id, "role": role, "score": max(0, 100 - penalty), "findings": findings, "createdAt": _now()})
    findings = [item for report in reports for item in report["findings"] if item["severity"] != "pass"]
    critical = len([item for item in findings if item["severity"] == "critical"])
    high = len([item for item in findings if item["severity"] == "high"])
    medium = len([item for item in findings if item["severity"] == "medium"])
    decision = "reject" if critical or high >= 4 else "major" if high >= 2 else "minor" if high or medium else "accept"
    return {"id": _uid("review"), "round": len(project["reviews"]) + 1, "type": "full", "reports": reports, "decision": decision, "roadmap": [_revision(item, index) for index, item in enumerate(findings)], "createdAt": _now(), "manuscriptHash": _hash(text)}


def _revision(item: dict[str, Any], index: int) -> dict[str, Any]:
    return {"id": _uid("revision"), "order": index + 1, "sourceFindingId": item.get("id", ""), "severity": item.get("severity", "medium"), "issue": item.get("issue", ""), "action": item.get("recommendation", ""), "sectionId": item.get("sectionId", ""), "response": "", "status": "open", "evidence": ""}


def _prepare_stage(project: dict[str, Any], stage_id: str) -> tuple[bool, str, list[str]]:
    requirements: dict[str, tuple[bool, str, list[str]]] = {
        "research": (all(_clean(item) for item in (project["framing"]["question"], project["framing"]["gap"], project["methodology"]["design"], project["methodology"]["dataSources"])), "请先完成研究问题、研究缺口、研究设计和数据来源。", ["研究问题", "研究缺口", "方法与数据边界"]),
        "write": (bool(_clean(_manuscript(project))), "请先形成论文结构稿。", [f"{len(project['sections'])} 个章节", f"{_words(_manuscript(project))} 字稿件"]),
        "integrity_pre": (any(item.get("phase") == "pre" and item.get("pass") for item in project["integrityRuns"]), "预审完整性核验尚未通过。", ["预审完整性报告"]),
        "review": (any(item.get("type") == "full" for item in project["reviews"]), "尚未形成五角色审稿决定。", ["五角色审稿报告", "编辑决定", "修订路线图"]),
        "revise": (not project["revisionItems"] or all(_clean(item.get("response")) for item in project["revisionItems"]), "请完成全部修订响应。", [f"{len(project['revisionItems'])} 条修订响应"]),
        "re_review": (any(item.get("type") == "re-review" for item in project["reviews"]), "尚未完成修订复审。", ["修订复审报告"]),
        "re_revise": (not project["revisionItems"] or all(_clean(item.get("response")) for item in project["revisionItems"]), "请完成全部再修订响应。", [f"{len(project['revisionItems'])} 条再修订响应"]),
        "integrity_final": (any(item.get("phase") == "final" and item.get("pass") for item in project["integrityRuns"]), "最终完整性核验必须无未解决问题。", ["最终完整性报告"]),
        "finalize": (any(item.get("phase") == "final" and item.get("pass") for item in project["integrityRuns"]), "最终完整性核验尚未通过。", ["最终完整性报告", "投稿声明", "稿件哈希"]),
        "process": (True, "", ["十阶段过程记录", "材料护照"]),
    }
    return requirements.get(stage_id, (False, "未知阶段。", []))


def _snapshot(project: dict[str, Any], label: str) -> dict[str, Any]:
    snap = {"id": _uid("snapshot"), "label": label or "手动快照", "createdAt": _now(), "words": _words(_manuscript(project)), "hash": _hash(_manuscript(project)), "sections": deepcopy(project["sections"]), "references": deepcopy(project["references"]), "claims": deepcopy(project["claims"])}
    project["snapshots"] = [snap, *project["snapshots"]][:30]
    return snap


def _reference_text(item: dict[str, Any], style: str, index: int) -> str:
    authors, year, title, venue = _clean(item.get("authors")) or "Unknown author", _clean(item.get("year")) or "n.d.", _clean(item.get("title")) or "Untitled", _clean(item.get("venue"))
    doi = normalize_doi(item.get("doi")); link = f"https://doi.org/{doi}" if doi else _clean(item.get("url"))
    if style == "IEEE": return f"[{index}] {authors}, “{title},” {venue}, {year}{f', {link}' if link else ''}."
    if style == "Vancouver": return f"{index}. {authors}. {title}. {venue}. {year}.{f' doi:{doi}.' if doi else ''}"
    if style == "MLA 9": return f"{authors}. “{title}.” {venue}, {year}.{f' {link}.' if link else ''}"
    if style == "Chicago Author-Date": return f"{authors}. {year}. “{title}.” {venue}.{f' {link}.' if link else ''}"
    return f"{authors}. ({year}). {title}. {venue}.{f' {link}' if link else ''}"


def manuscript_markdown(project_value: Any) -> str:
    project = _project(project_value); config = project["config"]
    refs = [item for item in project["references"] if item.get("status") == "included"]
    sections = "\n\n".join(f"## {item['name']}\n\n{item.get('content', '')}" for item in project["sections"])
    bibliography = "\n\n".join(_reference_text(item, config["citationStyle"], index + 1) for index, item in enumerate(refs))
    return f"---\ntitle: \"{project['title'].replace(chr(34), chr(39))}\"\nauthor: \"{_clean(config['authors']).replace(chr(34), chr(39))}\"\ncitation-style: \"{config['citationStyle']}\"\n---\n\n# {project['title']}\n\n**作者：** {_clean(config['authors']) or '【待补充】'}\n\n**单位：** {_clean(config['affiliations']) or '【待补充】'}\n\n**关键词：** {_clean(config['keywords']) or '【待补充】'}\n\n{sections}\n\n## 参考文献\n\n{bibliography}\n"


def bibliography_bibtex(project_value: Any) -> str:
    project = _project(project_value)
    return "\n\n".join(f"@{item.get('type') or 'article'}{{{item.get('key', '')},\n  title={{{item.get('title', '')}}},\n  author={{{item.get('authors', '')}}},\n  year={{{item.get('year', '')}}},\n  journal={{{item.get('venue', '')}}},\n  doi={{{normalize_doi(item.get('doi'))}}},\n  url={{{item.get('url', '')}}}\n}}" for item in project["references"] if item.get("status") != "excluded")


def material_passport(project_value: Any) -> dict[str, Any]:
    project = _project(project_value)
    return {"schema": "skyview-material-passport", "version": 1, "projectId": project["id"], "title": project["title"], "currentStage": project["currentStage"], "manuscriptHash": _hash(_manuscript(project)), "counts": {"sections": len(project["sections"]), "references": len(project["references"]), "claims": len(project["claims"]), "experiments": len(project["experiments"]), "reviews": len(project["reviews"])}, "stages": [{"id": item["id"], "status": item["status"], "completedAt": item.get("completedAt"), "confirmedAt": item.get("confirmedAt")} for item in project["stageRecords"]], "generatedAt": _now()}


def process_record(project_value: Any) -> str:
    project = _project(project_value)
    stages = "\n".join(f"- Stage {stage['code']} {stage['name']}: {next(item for item in project['stageRecords'] if item['id'] == stage['id'])['status']}" for stage in STAGES)
    resolved = len([item for item in project["revisionItems"] if item.get("status") == "resolved"])
    return f"# 论文创建过程记录\n\n## 论文信息\n\n- 题目：{project['title']}\n- 作者：{_clean(project['config']['authors']) or '未填写'}\n- 稿件哈希：{_hash(_manuscript(project))}\n\n## 阶段记录\n\n{stages}\n\n## 质量门禁\n\n- 完成阶段：{len([item for item in project['stageRecords'] if item['status'] == 'completed'])}/{len(STAGES)}\n- 完整性核验：{len(project['integrityRuns'])} 次\n- 审稿轮次：{len(project['reviews'])} 次\n- 修订项：{resolved}/{len(project['revisionItems'])} 已解决\n- 最终字数：{_words(_manuscript(project))}\n- 已核验文献：{len([item for item in project['references'] if item.get('verification') == 'verified'])}/{len(project['references'])}\n\n## 作者确认与系统活动\n\n" + "\n".join(f"- {item.get('createdAt', '')} {item.get('message') or item.get('note') or item.get('action', '')}" for item in [*project["decisions"], *project["activities"]])


def _html(project: dict[str, Any]) -> str:
    sections = "".join(f"<h2>{html.escape(item['name'])}</h2>" + "".join(f"<p>{html.escape(part).replace(chr(10), '<br>')}</p>" for part in re.split(r"\n{2,}", item.get("content", ""))) for item in project["sections"])
    refs = "".join(f"<li>{html.escape(_reference_text(item, project['config']['citationStyle'], index + 1))}</li>" for index, item in enumerate(project["references"]) if item.get("status") == "included")
    return f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{html.escape(project["title"])}</title><style>body{{max-width:850px;margin:48px auto;padding:0 28px;color:#222;font:16px/1.75 Georgia,serif}}h1{{text-align:center}}h2{{margin-top:2em;border-bottom:1px solid #ccc}}</style></head><body><h1>{html.escape(project["title"])}</h1>{sections}<h2>参考文献</h2><ol>{refs}</ol></body></html>'


def _latex(project: dict[str, Any]) -> str:
    def esc(value: Any) -> str: return re.sub(r"([#$%&_{}])", r"\\\1", _clean(value)).replace("~", r"\textasciitilde{}").replace("^", r"\textasciicircum{}")
    sections = "\n".join(f"\\section{{{esc(item['name'])}}}\n{esc(item.get('content'))}" for item in project["sections"])
    refs = "\n".join(f"\\item {esc(_reference_text(item, project['config']['citationStyle'], index + 1))}" for index, item in enumerate(project["references"]) if item.get("status") == "included")
    return f"\\documentclass[12pt]{{article}}\n\\usepackage[UTF8]{{ctex}}\n\\usepackage{{geometry}}\n\\geometry{{a4paper,margin=2.5cm}}\n\\title{{{esc(project['title'])}}}\n\\author{{{esc(project['config']['authors'])}}}\n\\begin{{document}}\n\\maketitle\n{sections}\n\\section*{{参考文献}}\n\\begin{{enumerate}}\n{refs}\n\\end{{enumerate}}\n\\end{{document}}\n"


def _docx(project: dict[str, Any]) -> bytes:
    def paragraph(value: Any, style: str = "") -> str:
        p_style = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        return f'<w:p>{p_style}<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">{html.escape(_clean(value)) or " "}</w:t></w:r></w:p>'
    body = paragraph(project["title"], "Title") + paragraph(f"作者：{_clean(project['config']['authors']) or '待补充'}")
    body += "".join(paragraph(item["name"], "Heading1") + "".join(paragraph(line) for line in item.get("content", "").splitlines()) for item in project["sections"])
    body += paragraph("参考文献", "Heading1") + "".join(paragraph(_reference_text(item, project["config"]["citationStyle"], index + 1)) for index, item in enumerate(project["references"]) if item.get("status") == "included")
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'
    styles = '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document); archive.writestr("word/styles.xml", styles)
        archive.writestr("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    return output.getvalue()


def _exports(project: dict[str, Any]) -> dict[str, Any]:
    safe = re.sub(r'[\\/:*?"<>|]', "-", project["title"])[:80] or "paper"
    markdown, html_text, latex, bibtex = manuscript_markdown(project), _html(project), _latex(project), bibliography_bibtex(project)
    passport = json.dumps(material_passport(project), ensure_ascii=False, indent=2); process = process_record(project)
    docx = _docx(project)
    package_io = io.BytesIO()
    with zipfile.ZipFile(package_io, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("manuscript.md", markdown); package.writestr("manuscript.html", html_text); package.writestr("manuscript.tex", latex); package.writestr("references.bib", bibtex); package.writestr("material-passport.json", passport); package.writestr("process-record.md", process); package.writestr("project-record.json", json.dumps(project, ensure_ascii=False, indent=2)); package.writestr("README.txt", "SkyViewLab 投稿材料包\r\n\r\n请在投稿前核验作者、事实、数据、实验、引文、声明和目标期刊要求。\r\n")
    return {"markdown": markdown, "html": html_text, "latex": latex, "bibtex": bibtex, "passportJson": passport, "processMarkdown": process, "docxBase64": base64.b64encode(docx).decode("ascii"), "packageBase64": base64.b64encode(package_io.getvalue()).decode("ascii"), "projectJson": json.dumps(project, ensure_ascii=False, indent=2), "files": {"markdown": f"{safe}.md", "html": f"{safe}.html", "latex": f"{safe}.tex", "bibtex": f"{safe}.bib", "passport": f"{safe}-material-passport.json", "process": f"{safe}-process-record.md", "docx": f"{safe}.docx", "package": f"{safe}-submission-package.zip", "project": f"{safe}-project.json"}}


def _crossref(query: str) -> list[dict[str, Any]]:
    url = "https://api.crossref.org/works?rows=20&select=DOI,title,author,published,container-title,URL,type&query.bibliographic=" + urllib.parse.quote(query)
    request = urllib.request.Request(url, headers={"User-Agent": "SkyViewLab/1.0 (mailto:admin@skyview.local)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ToolError("Crossref 当前不可访问，请稍后重试或使用 BibTeX 导入") from error
    rows = []
    for item in data.get("message", {}).get("items", []):
        authors = "; ".join(" ".join(part for part in (author.get("given", ""), author.get("family", "")) if part) for author in item.get("author", []))
        date_parts = (item.get("published") or {}).get("date-parts") or [[]]
        doi = normalize_doi(item.get("DOI")); title = _clean((item.get("title") or [""])[0])
        rows.append({"id": _uid("ref"), "key": re.sub(r"\W+", "", (authors.split(";")[0].split(" ")[-1] if authors else "ref") + str(date_parts[0][0] if date_parts[0] else "nd"))[:26], "type": item.get("type") or "article", "title": title, "authors": authors, "year": str(date_parts[0][0]) if date_parts[0] else "", "venue": _clean((item.get("container-title") or [""])[0]), "doi": doi, "url": item.get("URL") or (f"https://doi.org/{doi}" if doi else ""), "abstract": "", "status": "candidate", "verification": "unverified", "locator": "", "notes": "Crossref metadata; original text not yet verified", "addedAt": _now(), "source": "Crossref", "retrievedAt": _now()})
    return [item for item in rows if item["title"]]


def run_paper_writing(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "create": return {"project": create_project(_clean(payload.get("title")), _clean(payload.get("paperType")) or "empirical"), "stages": STAGES, "paperTypes": [{"id": key, "name": value[0]} for key, value in PAPER_TYPES.items()]}
    if action == "outline" and not payload.get("project"):
        topic, question = _clean(payload.get("topic")), _clean(payload.get("question"))
        return {"title": topic or "研究提纲", "question": question, "sections": [name for _, name in PAPER_TYPES["empirical"][1]]}
    if action == "audit" and not payload.get("project"):
        from app.tools import research
        return research.paper_writing("audit", payload)
    if action == "generate-draft" and not payload.get("project"):
        temporary = create_project(_clean(payload.get("title")))
        temporary["framing"].update({"question": _clean(payload.get("question")), "problem": _clean(payload.get("question")), "gap": "【待作者界定研究缺口】", "contribution": "【待作者确认研究贡献】"})
        temporary["methodology"].update({"design": _clean(payload.get("design")), "dataSources": _clean(payload.get("sources")), "analysis": _clean(payload.get("design"))})
        findings = [line.strip() for line in _clean(payload.get("findings")).splitlines() if line.strip()]
        temporary["claims"] = [{"id": _uid("claim"), "text": item, "type": "factual", "sectionId": "results", "referenceKeys": [], "experimentIds": [], "locator": "", "status": "verified", "notes": "", "createdAt": _now()} for item in findings]
        generated = generate_draft(temporary)
        return {"project": generated, "manuscript": manuscript_markdown(generated), "sections": generated["sections"], "verificationRequired": True}
    if action == "bibtex-import" and not payload.get("project"):
        records = parse_bibtex(_clean(payload.get("bibtex")))
        if not records: raise ToolError("没有识别到 BibTeX 条目")
        kept, duplicates = dedupe_references(records)
        return {"records": kept, "duplicates": duplicates, "imported": len(kept)}
    project = _project(payload.get("project"))
    if action == "generate-draft":
        generated = generate_draft(project); return {"project": generated, "manuscript": manuscript_markdown(generated), "sections": generated["sections"], "verificationRequired": True}
    if action == "bibtex-import":
        records = parse_bibtex(_clean(payload.get("bibtex")))
        if not records: raise ToolError("没有识别到 BibTeX 条目")
        kept, duplicates = dedupe_references([*project["references"], *records]); project["references"] = kept; project["updatedAt"] = _now()
        return {"project": project, "records": records, "duplicates": duplicates, "imported": len(records) - len(duplicates)}
    if action == "crossref-search": return {"query": _clean(payload.get("query")), "provider": "Crossref", "retrievedAt": _now(), "records": _crossref(_clean(payload.get("query")))}
    if action in {"integrity", "audit"}:
        phase = "final" if payload.get("phase") == "final" else "pre"; audit = audit_integrity(project, phase); project["integrityRuns"].insert(0, audit); project["updatedAt"] = _now(); return {"project": project, "audit": audit}
    if action in {"review", "peer-review"}:
        review = reviewer_panel(project); project["reviews"].insert(0, review); project["updatedAt"] = _now(); return {"project": project, "review": review, **review}
    if action == "rereview":
        review = reviewer_panel(project, True); project["reviews"].insert(0, review); project["updatedAt"] = _now(); return {"project": project, "review": review}
    if action == "adopt-roadmap":
        review = next((item for item in project["reviews"] if item.get("id") == payload.get("reviewId")), project["reviews"][0] if project["reviews"] else None)
        if not review: raise ToolError("尚无可采用的审稿路线图")
        project["revisionItems"] = deepcopy(review.get("roadmap", [])); project["updatedAt"] = _now(); return {"project": project, "revisionItems": project["revisionItems"]}
    if action == "prepare-stage":
        stage_id = _clean(payload.get("stageId")) or project["currentStage"]
        if stage_id != project["currentStage"]: raise ToolError("只能提交当前活动阶段")
        eligible, reason, deliverables = _prepare_stage(project, stage_id)
        if not eligible: raise ToolError(reason)
        record = next(item for item in project["stageRecords"] if item["id"] == stage_id); record.update({"status": "awaiting_confirmation", "deliverables": deliverables, "completedAt": _now(), "attempts": int(record.get("attempts") or 0) + 1}); project["updatedAt"] = _now()
        return {"project": project, "record": record}
    if action == "confirm-stage":
        stage_id = _clean(payload.get("stageId")) or project["currentStage"]; index = next((index for index, stage in enumerate(STAGES) if stage["id"] == stage_id), -1)
        if index < 0 or project["currentStage"] != stage_id: raise ToolError("只能确认当前活动阶段")
        record = project["stageRecords"][index]
        if record["status"] != "awaiting_confirmation": raise ToolError("阶段尚未提交确认")
        if stage_id == "review":
            review = next((item for item in project["reviews"] if item.get("type") == "full"), None)
            if review and review.get("decision") == "reject" and not payload.get("override"): raise ToolError("拒稿决定必须返回写作，或由作者明确记录覆盖理由")
        record.update({"status": "completed", "confirmedAt": _now(), "note": _clean(payload.get("note"))})
        if index + 1 < len(STAGES): project["stageRecords"][index + 1]["status"] = "in_progress"; project["currentStage"] = STAGES[index + 1]["id"]
        else: project["status"] = "completed"
        project["decisions"].insert(0, {"id": _uid("decision"), "stageId": stage_id, "action": "confirmed", "note": _clean(payload.get("note")), "createdAt": _now(), "override": bool(payload.get("override"))}); project["updatedAt"] = _now()
        return {"project": project, "nextStage": project["currentStage"]}
    if action == "snapshot":
        snap = _snapshot(project, _clean(payload.get("label")) or "手动快照"); project["updatedAt"] = _now(); return {"project": project, "snapshot": snap}
    if action == "restore":
        snapshot_id = _clean(payload.get("snapshotId")); snap = next((item for item in project["snapshots"] if item.get("id") == snapshot_id), None)
        if not snap: raise ToolError("找不到指定快照")
        _snapshot(project, "恢复前自动快照"); project["sections"] = deepcopy(snap["sections"]); project["references"] = deepcopy(snap["references"]); project["claims"] = deepcopy(snap["claims"]); project["activeSection"] = project["sections"][0]["id"]; project["updatedAt"] = _now(); return {"project": project, "restored": snapshot_id}
    if action == "finalize":
        final_audit = next((item for item in project["integrityRuns"] if item.get("phase") == "final" and item.get("pass")), None)
        if not final_audit: raise ToolError("最终完整性核验尚未通过")
        project["finalization"].update({"selectedStyle": project["config"]["citationStyle"], "formats": ["markdown", "html", "latex", "docx", "bibtex", "passport", "process", "package"], "finalizedAt": _now(), "processRecord": process_record(project)}); project["updatedAt"] = _now(); return {"project": project, "passport": material_passport(project)}
    if action == "export": return _exports(project)
    raise ToolError("不支持的论文写作操作")
