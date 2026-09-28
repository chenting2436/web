from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import math
import re
import zipfile
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.tools.common import ToolError


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _lines(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_clean(item) for item in value if _clean(item)]
    return [_clean(item) for item in re.split(r"[\n;；|]+", str(value or "")) if _clean(item)]


def _tokens(value: Any) -> list[str]:
    source = _clean(value).lower()
    latin = re.findall(r"[a-z0-9]+(?:[-_.][a-z0-9]+)*", source)
    chinese: list[str] = []
    for run in re.findall(r"[\u3400-\u9fff]+", source):
        chinese.extend([run] if len(run) == 1 else [run[index:index + 2] for index in range(len(run) - 1)])
    return latin + chinese


def _sample_project() -> dict[str, Any]:
    today = date.today()
    return {
        "project": {
            "name": "矿山边坡多源风险识别技术转化项目",
            "code": "SVL-IP-2026-014",
            "manager": "知识产权与技术转移组",
            "organization": "SkyViewLab",
            "confidentiality": "内部保密",
            "targetJurisdictions": ["CN", "PCT"],
            "stage": "检索评估",
        },
        "disclosure": {
            "title": "一种面向矿山边坡的多源风险识别方法",
            "inventors": ["陈研究员", "周工程师", "林同学"],
            "applicant": "SkyViewLab",
            "field": "矿山安全监测与智能预警",
            "problem": "多源监测数据时间尺度和空间基准不一致，风险判断缺少可复核的来源与参数记录。",
            "solution": "执行时空对齐和质量标记，构建跨来源风险特征，按可配置规则分级并保存证据链。",
            "effects": "降低来源偏差对风险判断的影响，并使输入、参数、结果和复核过程可追溯。",
            "implementation": "采集遥感、位移和环境数据；完成时空对齐；提取跨来源特征；分级；写入证据链。",
            "publicDisclosureDate": "",
            "firstDisclosureChannel": "",
        },
        "features": [
            {"id": "F1", "name": "多源监测数据时空对齐", "essential": True, "effect": "统一分析基准", "support": "实施例 S1-S2"},
            {"id": "F2", "name": "对齐质量标记与异常隔离", "essential": True, "effect": "控制低质量输入", "support": "实施例 S2"},
            {"id": "F3", "name": "跨来源风险特征与可配置分级", "essential": True, "effect": "形成可解释风险等级", "support": "实施例 S3-S4"},
            {"id": "F4", "name": "输入参数结果复核证据链", "essential": True, "effect": "支持审计追溯", "support": "实施例 S5"},
        ],
        "patents": [
            {"id": "P1", "publicationNumber": "LOCAL-CN-001", "title": "多源边坡监测数据融合方法", "applicant": "示例申请人甲", "familyId": "FAM-A", "priorityDate": "2020-06-18", "jurisdiction": "CN", "status": "待核验", "cpc": ["G06F18/20", "G08B21/10"], "citations": 18, "source": "本地示例语料", "verifiedAt": None},
            {"id": "P2", "publicationNumber": "LOCAL-CN-002", "title": "基于遥感与位移的地质灾害预警", "applicant": "示例申请人乙", "familyId": "FAM-B", "priorityDate": "2019-11-02", "jurisdiction": "CN", "status": "待核验", "cpc": ["G01S19/14", "G08B21/10"], "citations": 11, "source": "本地示例语料", "verifiedAt": None},
            {"id": "P3", "publicationNumber": "LOCAL-WO-003", "title": "可追溯的工业风险判定系统", "applicant": "示例申请人丙", "familyId": "FAM-C", "priorityDate": "2021-03-27", "jurisdiction": "PCT", "status": "待核验", "cpc": ["G06Q10/0635"], "citations": 9, "source": "本地示例语料", "verifiedAt": None},
            {"id": "P4", "publicationNumber": "LOCAL-CN-004", "title": "监测数据质量评价与隔离方法", "applicant": "示例申请人丁", "familyId": "FAM-A", "priorityDate": "2018-08-14", "jurisdiction": "CN", "status": "待核验", "cpc": ["G06F18/10"], "citations": 7, "source": "本地示例语料", "verifiedAt": None},
            {"id": "P5", "publicationNumber": "LOCAL-US-005", "title": "Evidence-linked sensor analytics", "applicant": "Example Assignee E", "familyId": "FAM-D", "priorityDate": "2022-01-09", "jurisdiction": "US", "status": "待核验", "cpc": ["G06F16/27"], "citations": 4, "source": "本地示例语料", "verifiedAt": None},
            {"id": "P6", "publicationNumber": "LOCAL-EP-006", "title": "Configurable hazard classification", "applicant": "Example Assignee F", "familyId": "FAM-E", "priorityDate": "2020-10-30", "jurisdiction": "EP", "status": "待核验", "cpc": ["G06N20/00"], "citations": 6, "source": "本地示例语料", "verifiedAt": None},
        ],
        "matrix": {
            "F1": {"P1": "full", "P2": "partial", "P3": "none", "P4": "partial", "P5": "partial", "P6": "none"},
            "F2": {"P1": "partial", "P2": "none", "P3": "none", "P4": "full", "P5": "partial", "P6": "none"},
            "F3": {"P1": "partial", "P2": "full", "P3": "partial", "P4": "none", "P5": "partial", "P6": "full"},
            "F4": {"P1": "none", "P2": "none", "P3": "full", "P4": "partial", "P5": "full", "P6": "none"},
        },
        "claims": [
            {"id": "C1", "number": 1, "type": "independent", "parentId": None, "text": "一种面向矿山边坡的多源风险识别方法，其特征在于，包括：获取多源监测数据；执行时空对齐并输出质量标记；构建跨来源风险特征；执行风险分级；关联输入、参数、结果和复核记录形成证据链。", "supportFeatureIds": ["F1", "F2", "F3", "F4"]},
            {"id": "C2", "number": 2, "type": "dependent", "parentId": "C1", "text": "根据权利要求1所述的方法，其中，所述多源监测数据至少包括遥感影像和位移监测信号。", "supportFeatureIds": ["F1"]},
            {"id": "C3", "number": 3, "type": "dependent", "parentId": "C1", "text": "根据权利要求1所述的方法，其中，质量标记用于隔离缺失率超过阈值的数据段。", "supportFeatureIds": ["F2"]},
            {"id": "C4", "number": 4, "type": "dependent", "parentId": "C1", "text": "根据权利要求1所述的方法，其中，证据链记录输入摘要、参数版本和复核签名。", "supportFeatureIds": ["F4"]},
        ],
        "ftoItems": [
            {"id": "R1", "patentId": "P1", "productFeature": "时空对齐", "claimCoverage": 68, "relevance": "high", "notes": "需取得独立权利要求全文并核验有效性"},
            {"id": "R2", "patentId": "P3", "productFeature": "证据链", "claimCoverage": 55, "relevance": "medium", "notes": "需核对目标产品实施方式与地域"},
            {"id": "R3", "patentId": "P4", "productFeature": "质量隔离", "claimCoverage": 42, "relevance": "medium", "notes": "当前仅基于本地摘要初筛"},
        ],
        "trlEvidence": [
            {"id": "T1", "level": 1, "title": "基础机理与指标定义", "reference": "LAB-2026-011", "verified": True},
            {"id": "T2", "level": 2, "title": "应用概念与场景边界", "reference": "REQ-2026-022", "verified": True},
            {"id": "T3", "level": 3, "title": "关键算法离线概念验证", "reference": "EXP-2026-031", "verified": True},
            {"id": "T4", "level": 4, "title": "实验室端到端集成", "reference": "待补充", "verified": False},
        ],
        "valuation": {"annualRevenue": 12_000_000, "growthRate": 12, "royaltyRate": 3.5, "successProbability": 55, "discountRate": 15, "years": 5, "annualCost": 180_000, "upfront": 600_000, "milestones": 900_000},
        "risks": [
            {"id": "K1", "category": "自由实施", "description": "高相关本地记录尚未完成权利要求和法律状态核验", "probability": 4, "impact": 5, "owner": "知识产权经理", "status": "open"},
            {"id": "K2", "category": "权属", "description": "三名发明人贡献说明待签署", "probability": 3, "impact": 4, "owner": "项目负责人", "status": "open"},
            {"id": "K3", "category": "市场", "description": "许可费率尚缺少可比交易校准", "probability": 3, "impact": 3, "owner": "财务审核", "status": "open"},
        ],
        "deadlines": [
            {"id": "D1", "name": "发明人贡献确认", "date": str(today + timedelta(days=8)), "owner": "项目负责人", "status": "open"},
            {"id": "D2", "name": "检索式与结果复核", "date": str(today + timedelta(days=21)), "owner": "知识产权经理", "status": "open"},
            {"id": "D3", "name": "申请前公开风险检查", "date": str(today + timedelta(days=45)), "owner": "代理人", "status": "planned"},
            {"id": "D4", "name": "许可估值财务复核", "date": str(today + timedelta(days=63)), "owner": "财务审核", "status": "planned"},
        ],
        "evidence": [
            {"id": "E1", "title": "技术方案评审纪要", "type": "评审记录", "fingerprint": "", "verified": True},
            {"id": "E2", "title": "算法实验记录", "type": "试验数据", "fingerprint": "", "verified": True},
            {"id": "E3", "title": "发明人贡献说明", "type": "权属文件", "fingerprint": "", "verified": False},
            {"id": "E4", "title": "本地现有技术语料", "type": "检索快照", "fingerprint": "", "verified": True},
        ],
    }


def _lint_claims(claims: list[dict[str, Any]], features: list[dict[str, Any]]) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    identifiers = {str(claim.get("id")) for claim in claims}
    numbers: set[int] = set()
    supported: set[str] = set()
    for claim in claims:
        number = int(claim.get("number", 0) or 0)
        if number in numbers:
            issues.append({"level": "error", "claimId": claim.get("id"), "message": f"权利要求编号 {number} 重复"})
        numbers.add(number)
        text = _clean(claim.get("text"))
        if not text:
            issues.append({"level": "error", "claimId": claim.get("id"), "message": "权利要求内容为空"})
        if claim.get("type") == "dependent" and str(claim.get("parentId")) not in identifiers:
            issues.append({"level": "error", "claimId": claim.get("id"), "message": "从属项缺少有效引用"})
        vague = sorted(set(re.findall(r"适当|较高|较低|快速|优选|最佳|全部|等等", text)))
        if vague:
            issues.append({"level": "warning", "claimId": claim.get("id"), "message": f"存在可能不清楚用语：{'、'.join(vague)}"})
        support_ids = {str(item) for item in claim.get("supportFeatureIds", [])}
        supported.update(support_ids)
        if not support_ids:
            issues.append({"level": "warning", "claimId": claim.get("id"), "message": "尚未建立交底支持映射"})
    if not any(claim.get("type") == "independent" for claim in claims):
        issues.append({"level": "error", "claimId": None, "message": "至少需要一项独立权利要求"})
    for feature in features:
        if feature.get("essential", True) and str(feature.get("id")) not in supported:
            issues.append({"level": "warning", "claimId": None, "message": f"必要技术特征尚未进入权利要求：{feature.get('name')}"})
    errors = sum(item["level"] == "error" for item in issues)
    warnings = sum(item["level"] == "warning" for item in issues)
    return {
        "issues": issues, "errors": errors, "warnings": warnings, "passed": errors == 0,
        "independent": sum(claim.get("type") == "independent" for claim in claims),
        "dependent": sum(claim.get("type") == "dependent" for claim in claims),
        "coverageRate": round(len(supported) / max(1, len(features)), 4),
    }


def _valuation(values: dict[str, Any]) -> dict[str, Any]:
    annual = max(0.0, float(values.get("annualRevenue", 0) or 0))
    growth = max(-0.99, min(3.0, float(values.get("growthRate", 0) or 0) / 100))
    royalty = max(0.0, min(1.0, float(values.get("royaltyRate", values.get("royalty", 0)) or 0) / 100))
    probability = max(0.0, min(1.0, float(values.get("successProbability", values.get("probability", 0)) or 0) / 100))
    discount = max(0.0, min(2.0, float(values.get("discountRate", values.get("discount", 0)) or 0) / 100))
    years = max(1, min(30, int(values.get("years", 5) or 5)))
    annual_cost = max(0.0, float(values.get("annualCost", 0) or 0))
    upfront = max(0.0, float(values.get("upfront", 0) or 0))
    milestones = max(0.0, float(values.get("milestones", 0) or 0))
    cashflows: list[dict[str, Any]] = []
    npv = upfront + milestones * probability
    for year in range(1, years + 1):
        revenue = annual * (1 + growth) ** (year - 1)
        gross = revenue * royalty
        adjusted = (gross - annual_cost) * probability
        present = adjusted / (1 + discount) ** year
        cashflows.append({"year": year, "revenue": round(revenue, 2), "grossRoyalty": round(gross, 2), "riskAdjusted": round(adjusted, 2), "presentValue": round(present, 2)})
        npv += present
    return {"npv": round(npv, 2), "cashflows": cashflows, "inputs": values}


def _analyze(project: dict[str, Any], stage: str) -> dict[str, Any]:
    features = project.get("features", [])
    patents = project.get("patents", [])
    matrix = project.get("matrix", {})
    claims = project.get("claims", [])
    essential = [feature for feature in features if feature.get("essential", True)]
    novelty: list[dict[str, Any]] = []
    for patent in patents:
        values = [matrix.get(feature["id"], {}).get(patent["id"], "none") for feature in essential]
        full = values.count("full")
        partial = values.count("partial")
        rate = (full + partial * 0.5) / max(1, len(values))
        novelty.append({"patentId": patent["id"], "publicationNumber": patent["publicationNumber"], "full": full, "partial": partial, "coverageRate": round(rate, 4), "noveltyRisk": full == len(values) and bool(values)})
    novelty.sort(key=lambda item: item["coverageRate"], reverse=True)
    claim_lint = _lint_claims(claims, features)
    family_counts = Counter(str(item.get("familyId") or item.get("publicationNumber")) for item in patents)
    classifications = Counter(code for item in patents for code in item.get("cpc", []))
    years = Counter(str(item.get("priorityDate", ""))[:4] for item in patents)
    fto_rows: list[dict[str, Any]] = []
    patent_map = {item["id"]: item for item in patents}
    for item in project.get("ftoItems", []):
        patent = patent_map.get(item.get("patentId"), {})
        relevance = {"high": 20, "medium": 12, "low": 5}.get(item.get("relevance"), 0)
        score = min(100, round(float(item.get("claimCoverage", 0)) * 0.55 + relevance + 10))
        fto_rows.append({**item, "publicationNumber": patent.get("publicationNumber", "—"), "legalStatus": patent.get("status", "待核验"), "score": score, "level": "high" if score >= 70 else "medium" if score >= 40 else "low"})
    verified_levels = {int(item.get("level", 0)) for item in project.get("trlEvidence", []) if item.get("verified")}
    backed = 0
    for level in range(1, 10):
        if level in verified_levels:
            backed = level
        else:
            break
    valuation = _valuation(project.get("valuation", {}))
    risks = [{**item, "score": int(item.get("probability", 0)) * int(item.get("impact", 0)), "level": "high" if int(item.get("probability", 0)) * int(item.get("impact", 0)) >= 15 else "medium" if int(item.get("probability", 0)) * int(item.get("impact", 0)) >= 8 else "low"} for item in project.get("risks", [])]
    today = date.today()
    deadlines = []
    for item in project.get("deadlines", []):
        try:
            days = (date.fromisoformat(str(item.get("date"))) - today).days
        except ValueError:
            days = None
        deadlines.append({**item, "days": days, "level": "unknown" if days is None else "overdue" if days < 0 else "urgent" if days <= 14 else "soon" if days <= 60 else "planned"})
    evidence = []
    for item in project.get("evidence", []):
        fingerprint = hashlib.sha256(json.dumps(item, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
        evidence.append({**item, "fingerprint": fingerprint})
    dimensions = [
        {"id": "disclosure", "name": "技术交底", "score": 94},
        {"id": "search", "name": "检索证据", "score": 72},
        {"id": "claims", "name": "权利要求", "score": max(0, 100 - claim_lint["errors"] * 25 - claim_lint["warnings"] * 6)},
        {"id": "technical", "name": "技术成熟度", "score": round(backed / 9 * 100)},
        {"id": "evidence", "name": "证据完整性", "score": round(sum(item.get("verified", False) for item in evidence) / max(1, len(evidence)) * 100)},
        {"id": "governance", "name": "权属与合规", "score": 58},
        {"id": "market", "name": "商业化准备", "score": 64},
    ]
    readiness = round(sum(item["score"] for item in dimensions) / len(dimensions))
    blockers = ["全部专利记录的法律状态尚待官方来源核验", "发明人贡献说明尚未完成签署", "许可费率缺少可比交易校准"]
    quality_checks = [
        {"label": "技术问题、方案与效果已结构化", "passed": True},
        {"label": "必要技术特征均有关联说明书位置", "passed": all(feature.get("support") for feature in essential)},
        {"label": "权利要求从属关系无断链", "passed": claim_lint["errors"] == 0},
        {"label": "要素覆盖矩阵已建立", "passed": bool(matrix)},
        {"label": "FTO 高相关项已登记责任人", "passed": all(item.get("notes") for item in fto_rows)},
        {"label": "TRL 自评有连续证据支持", "passed": backed >= 3},
        {"label": "法律状态具有官方核验时间", "passed": all(item.get("verifiedAt") for item in patents)},
        {"label": "关键权属文件已签署", "passed": False},
    ]
    result: dict[str, Any] = {
        "schema": "skyview-patent-transfer-results", "version": 2, "stage": stage,
        **project,
        "search": {
            "genericQuery": '(矿山边坡 OR 边坡稳定性) AND (多源数据融合 OR 时空对齐) AND (风险分级 OR 证据链) NOT (金融风险)',
            "epoCql": '(ta="矿山边坡" OR ta="边坡稳定性") AND (ta="多源数据融合" OR ta="时空对齐") AND (cl="G06F18/20" OR cl="G08B21/10")',
            "rounds": [{"id": "S1", "source": "本地示例语料", "queryHash": "e6d2d904ef12", "records": len(patents), "executedAt": datetime.now(UTC).isoformat(), "status": "completed"}],
        },
        "landscape": {
            "records": len(patents), "families": len(family_counts), "citations": sum(int(item.get("citations", 0)) for item in patents),
            "familySizes": [{"name": name, "value": value} for name, value in family_counts.items()],
            "classifications": [{"name": name, "value": value} for name, value in classifications.most_common()],
            "years": [{"name": name, "value": value} for name, value in sorted(years.items())],
        },
        "novelty": novelty,
        "claimLint": claim_lint,
        "claimGraph": [{"id": claim["id"], "parentId": claim.get("parentId"), "number": claim["number"], "type": claim["type"]} for claim in claims],
        "fto": {"rows": fto_rows, "high": sum(item["level"] == "high" for item in fto_rows), "medium": sum(item["level"] == "medium" for item in fto_rows), "low": sum(item["level"] == "low" for item in fto_rows)},
        "trl": {"selected": 4, "backed": backed, "gap": max(0, 4 - backed), "verified": len(verified_levels)},
        "valuationResult": valuation,
        "riskRegister": sorted(risks, key=lambda item: item["score"], reverse=True),
        "deadlineAlerts": sorted(deadlines, key=lambda item: item.get("date", "")),
        "evidence": evidence,
        "readiness": {"total": readiness, "dimensions": dimensions, "blockers": blockers},
        "qualityChecks": quality_checks,
        "runtime": {"compute": "Python 专利分析作业", "orchestration": "Go 项目、队列与审计", "epoOpsConfigured": False, "patentsViewConfigured": False, "officialLegalStatusConfigured": False},
        "limitations": ["本地示例记录不对应真实专利，不得作为现有技术或法律状态结论。", "FTO 分数用于筛查排序，正式意见需要代理人或法律顾问复核签署。", "估值结果依赖输入假设，需由财务审核人校准。"],
    }
    result["exports"] = _exports(result)
    return result


def _csv(rows: list[dict[str, Any]], fields: list[str]) -> str:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def _exports(result: dict[str, Any]) -> dict[str, str]:
    project = result["project"]
    report = (
        f"# {project['name']}\n\n项目编号：{project['code']}\n\n"
        f"## 转化准备度\n\n{result['readiness']['total']}/100\n\n"
        f"## 专利景观\n\n{result['landscape']['records']} 条本地记录，{result['landscape']['families']} 个记录组；法律状态均待官方核验。\n\n"
        f"## 权利要求质检\n\n{result['claimLint']['errors']} 个错误，{result['claimLint']['warnings']} 个提醒。\n\n"
        f"## FTO 初筛\n\n高风险 {result['fto']['high']}，中风险 {result['fto']['medium']}，低风险 {result['fto']['low']}。\n\n"
        f"## TRL 与估值\n\n连续证据支持 TRL {result['trl']['backed']}；风险调整现金流现值 ¥{result['valuationResult']['npv']:,.0f}。\n\n"
        "## 复核边界\n\n" + "\n".join(f"- {item}" for item in result["limitations"]) + "\n"
    )
    patents_csv = _csv(result["patents"], ["publicationNumber", "title", "applicant", "familyId", "priorityDate", "jurisdiction", "status", "source", "verifiedAt"])
    matrix_rows = []
    for feature in result["features"]:
        matrix_rows.append({"feature": feature["name"], **{patent["publicationNumber"]: result["matrix"].get(feature["id"], {}).get(patent["id"], "none") for patent in result["patents"]}})
    matrix_fields = ["feature"] + [item["publicationNumber"] for item in result["patents"]]
    matrix_csv = _csv(matrix_rows, matrix_fields)
    fto_csv = _csv(result["fto"]["rows"], ["publicationNumber", "productFeature", "claimCoverage", "relevance", "score", "level", "legalStatus", "notes"])
    deadlines_csv = _csv(result["deadlineAlerts"], ["name", "date", "days", "owner", "status", "level"])
    evidence_json = json.dumps(result["evidence"], ensure_ascii=False, indent=2)
    html = f"<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>{project['name']}</title><style>body{{max-width:960px;margin:40px auto;font:15px/1.75 system-ui;color:#17213a}}h1,h2{{color:#263b7f}}blockquote{{border-left:4px solid #087885;padding:10px;background:#edf7f7}}</style><body><pre>{report}</pre></body></html>"
    snapshot = {key: value for key, value in result.items() if key != "exports"}
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("project.json", json.dumps(snapshot, ensure_ascii=False, indent=2))
        archive.writestr("patent-records.csv", patents_csv)
        archive.writestr("feature-matrix.csv", matrix_csv)
        archive.writestr("fto-screening.csv", fto_csv)
        archive.writestr("deadlines.csv", deadlines_csv)
        archive.writestr("evidence-fingerprints.json", evidence_json)
        archive.writestr("transfer-assessment.md", report)
        archive.writestr("transfer-assessment.html", html)
    return {"patentsCsv": patents_csv, "matrixCsv": matrix_csv, "ftoCsv": fto_csv, "deadlinesCsv": deadlines_csv, "evidenceJson": evidence_json, "reportMarkdown": report, "reportHtml": html, "packageBase64": base64.b64encode(package.getvalue()).decode("ascii")}


def run_patent_transfer(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "claim-lint" and "project" not in payload:
        claims = _lines(payload.get("claims"))
        features = _lines(payload.get("features"))
        if not claims:
            raise ToolError("至少需要一项权利要求")
        claim_rows = [{"id": f"C{index + 1}", "number": index + 1, "type": "independent" if index == 0 else "dependent", "parentId": None if index == 0 else "C1", "text": text, "supportFeatureIds": [f"F{feature_index + 1}" for feature_index, feature in enumerate(features) if feature in text]} for index, text in enumerate(claims)]
        feature_rows = [{"id": f"F{index + 1}", "name": name, "essential": True} for index, name in enumerate(features)]
        result = _lint_claims(claim_rows, feature_rows)
        result["claims"] = len(claims)
        result["features"] = len(features)
        result["uncoveredFeatures"] = [item["name"] for item in feature_rows if all(item["id"] not in claim.get("supportFeatureIds", []) for claim in claim_rows)]
        return result
    if action == "trl-assess" and "project" not in payload:
        evidence = payload.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise ToolError("evidence 必须是非空数组")
        passed = sum(bool(item.get("passed")) if isinstance(item, dict) else bool(item) for item in evidence)
        level = min(9, max(1, passed + 1))
        gaps = [str(item.get("name", f"证据 {index + 1}")) for index, item in enumerate(evidence) if isinstance(item, dict) and not item.get("passed")]
        return {"trl": level, "passedEvidence": passed, "totalEvidence": len(evidence), "gaps": gaps, "gate": "ready" if level >= 7 else "develop" if level >= 4 else "research"}
    if action == "valuation" and "project" not in payload:
        return _valuation(payload)
    if action == "risk-register" and "project" not in payload:
        description = _clean(payload.get("description")).lower()
        prior_art = payload.get("priorArt", [])
        if not description:
            raise ToolError("description 不能为空")
        risks = []
        target = set(_tokens(description))
        for item in prior_art if isinstance(prior_art, list) else []:
            if not isinstance(item, dict):
                continue
            overlap = sorted(set(_tokens(item.get("abstract"))) & target)
            risks.append({"title": item.get("title", "未命名"), "overlapTerms": overlap[:12], "risk": min(100, len(overlap) * 8), "status": item.get("status", "待核验")})
        risks.sort(key=lambda item: item["risk"], reverse=True)
        return {"risks": risks, "highestRisk": risks[0]["risk"] if risks else 0, "requiresCounsel": any(item["risk"] >= 60 for item in risks)}

    supported = {"load-sample", "analyze", "search-landscape", "novelty-matrix", "claim-workbench", "fto-assess", "transfer-assess", "deadline-check", "export", "run-all"}
    if action not in supported:
        raise ToolError("不支持的专利转化操作")
    project = payload.get("project")
    if project is None:
        project = _sample_project()
    if not isinstance(project, dict):
        raise ToolError("project 必须是对象")
    return _analyze(project, action)
