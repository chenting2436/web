from __future__ import annotations

import csv
import io
import json
import re
import uuid
from collections import Counter
from copy import deepcopy
from typing import Any

from app.tools.common import ToolError
from app.tools import research_radar_full as radar


SCHEMA = "skyview-mine-safety-radar-results"
TAXONOMY: dict[str, list[tuple[str, str, list[str]]]] = {
    "hazards": [
        ("slope", "边坡与滑坡", ["slope", "landslide", "rock slope", "open-pit slope", "边坡", "滑坡", "崩塌", "变形"]),
        ("rockburst", "岩爆与冲击地压", ["rockburst", "rock burst", "coal burst", "strain burst", "岩爆", "冲击地压", "矿震"]),
        ("gas", "瓦斯与通风", ["gas", "methane", "ventilation", "coal and gas outburst", "瓦斯", "甲烷", "通风", "突出"]),
        ("water", "矿井水害", ["mine water", "water inrush", "groundwater", "inundation", "突水", "水害", "地下水", "涌水"]),
        ("fire", "火灾与自燃", ["mine fire", "spontaneous combustion", "coal fire", "thermal anomaly", "矿井火灾", "煤火", "自燃", "热异常"]),
        ("dust", "粉尘与职业健康", ["coal dust", "mine dust", "silica", "pneumoconiosis", "粉尘", "矽尘", "职业健康", "尘肺"]),
        ("tailings", "尾矿库安全", ["tailings", "tailings dam", "dam failure", "debris flow", "尾矿", "尾矿库", "溃坝", "泥石流"]),
        ("equipment", "设备与人员安全", ["mine equipment", "worker safety", "collision", "unsafe behavior", "设备故障", "人员安全", "设备安全", "违章", "碰撞"]),
    ],
    "methods": [
        ("remote", "遥感 / InSAR / UAV", ["remote sensing", "insar", "sar", "satellite", "uav", "drone", "photogrammetry", "遥感", "无人机", "卫星"]),
        ("geophysics", "微震与地球物理", ["microseismic", "seismic", "geophysical", "acoustic emission", "微震", "地震", "声发射", "地球物理"]),
        ("vision", "机器视觉", ["computer vision", "image segmentation", "object detection", "yolo", "视觉", "目标检测", "图像分割", "裂缝识别"]),
        ("timeseries", "时序预测", ["time series", "forecast", "lstm", "transformer", "temporal", "时序", "预测", "位移序列"]),
        ("fusion", "多源融合", ["data fusion", "multi-source", "multimodal", "sensor fusion", "多源", "多模态", "融合"]),
        ("digitaltwin", "数字孪生", ["digital twin", "cyber physical", "virtual mine", "数字孪生", "虚拟矿山"]),
        ("knowledge", "知识图谱 / 大模型", ["knowledge graph", "large language model", "llm", "ontology", "知识图谱", "大语言模型", "基础模型", "本体"]),
        ("physics", "物理与数值模拟", ["finite element", "discrete element", "numerical simulation", "physics-informed", "有限元", "离散元", "数值模拟", "物理约束"]),
    ],
    "data": [
        ("image", "影像", ["image", "imagery", "optical", "multispectral", "hyperspectral", "影像", "图像", "多光谱", "高光谱", "热红外"]),
        ("waveform", "波形信号", ["waveform", "seismic signal", "acoustic", "vibration", "波形", "微震信号", "声发射", "振动"]),
        ("displacement", "位移监测", ["displacement", "gnss", "gps", "inclinometer", "位移", "测斜", "形变"]),
        ("environment", "环境传感", ["rainfall", "temperature", "humidity", "gas concentration", "降雨", "温度", "湿度", "气体浓度", "传感器"]),
        ("pointcloud", "点云 / 三维", ["point cloud", "lidar", "3d", "laser scanning", "点云", "激光雷达", "三维"]),
        ("text", "文本与规程", ["text mining", "incident report", "safety regulation", "文本", "事故报告", "安全规程", "规程问答"]),
    ],
}


def _classify(record: dict[str, Any]) -> dict[str, Any]:
    text = radar._clean(" ".join([record.get("title", ""), record.get("abstract", ""), *record.get("topics", [])])).lower()
    title = radar._clean(record.get("title")).lower()
    output: dict[str, list[dict[str, str]]] = {}
    for group, entries in TAXONOMY.items():
        output[group] = [{"id": item_id, "label": label} for item_id, label, terms in entries if any(term.lower() in text for term in terms)]
    title_hits = sum(1 for _, _, terms in [*TAXONOMY["hazards"], *TAXONOMY["methods"]] for term in terms if term.lower() in title)
    score = min(100, len(output["hazards"]) * 16 + len(output["methods"]) * 9 + len(output["data"]) * 6 + title_hits * 7 + (5 if record.get("abstract") else 0))
    return {**output, "score": score, "primaryHazard": output["hazards"][0]["label"] if output["hazards"] else "未分类", "primaryMethod": output["methods"][0]["label"] if output["methods"] else "未识别"}


def _readiness(record: dict[str, Any]) -> dict[str, Any]:
    text = radar._clean(" ".join([record.get("title", ""), record.get("abstract", ""), *record.get("topics", [])])).lower()
    mine = record["mine"]
    checks = {
        "realWorld": bool(re.search(r"field|site|mine|现场|矿区|工程|部署", text)),
        "validation": bool(re.search(r"validat|experiment|benchmark|case study|验证|实验|案例|复核|评测", text)),
        "sensor": bool(mine["data"]), "method": bool(mine["methods"]),
        "reproducibility": bool(re.search(r"open|code|dataset|reproduc|开源|数据集|复现", text)),
        "uncertainty": bool(re.search(r"uncertaint|confidence|误差|不确定|置信|校准", text)),
    }
    weights = {"realWorld": 20, "validation": 20, "sensor": 15, "method": 15, "reproducibility": 15, "uncertainty": 10}
    score = sum(weights[key] for key, present in checks.items() if present) + round(float(record.get("relevance", 0)) * 5)
    score = min(100, score)
    return {"score": score, "level": "可进入工程复核" if score >= 75 else "具备试验依据" if score >= 55 else "需要补充工程证据", "checks": checks}


def _enrich(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for item in records:
        record = deepcopy(item)
        record["mine"] = _classify(record)
        record["readiness"] = _readiness(record)
        record["riskSignal"] = round(min(100, record["mine"]["score"] * .58 + record["readiness"]["score"] * .27 + float(record.get("novelty", 0)) * 15), 1)
        output.append(record)
    return output


def _sample_records() -> list[dict[str, Any]]:
    rows = [
        ("露天矿边坡 InSAR 与 GNSS 形变融合", 2026, "演示遥感形变、GNSS 位移和降雨证据融合字段，不代表真实论文。", ["边坡", "InSAR", "GNSS", "多源融合"], 12, True),
        ("矿山边坡无人机裂缝识别与现场复核", 2025, "演示 UAV 影像、裂缝分割、量测误差和现场验证。", ["边坡", "UAV", "机器视觉"], 26, True),
        ("地下矿微震事件检测与岩爆风险研判", 2025, "演示微震波形、震相、事件定位和岩爆风险标签。", ["岩爆", "微震", "事件检测"], 34, False),
        ("矿井瓦斯浓度时序预测与校准", 2024, "演示瓦斯传感、时序模型、提前量与校准误差。", ["瓦斯", "时序预测", "传感器"], 71, True),
        ("矿井突水多场耦合风险识别", 2023, "演示地下水、地质构造与监测信号的物理约束分析。", ["水害", "物理约束", "多源融合"], 83, False),
        ("煤火热红外遥感监测", 2022, "演示热红外异常、地表验证和时间变化分析。", ["火灾", "遥感", "热红外"], 96, True),
        ("矿尘视觉监测与职业暴露评估", 2024, "演示视觉浓度估计、环境传感与暴露评价。", ["粉尘", "机器视觉", "职业健康"], 28, False),
        ("尾矿坝点云变形与数字孪生", 2025, "演示 LiDAR 点云、三维变形和数字孪生更新。", ["尾矿库", "点云", "数字孪生"], 19, True),
        ("冲击地压声发射与微震联合预警", 2021, "演示声发射、微震和物理指标的证据一致性。", ["冲击地压", "声发射", "微震"], 126, False),
        ("矿山安全知识图谱与规程问答", 2025, "演示事故报告、规程文本、知识图谱和引用回答。", ["知识图谱", "安全规程", "大语言模型"], 17, True),
        ("尾矿库溃坝数值模拟与应急推演", 2020, "演示数值模拟、参数敏感性和应急场景。", ["尾矿库", "数值模拟", "应急"], 183, False),
        ("矿山设备人员接近检测", 2023, "演示目标检测、定位误差和现场部署指标。", ["设备安全", "目标检测", "人员定位"], 57, True),
        ("矿山多灾种风险数字孪生", 2026, "演示边坡、瓦斯与水害数据在数字孪生中的统一组织。", ["多灾种", "数字孪生", "多源融合"], 7, True),
        ("边坡位移 Transformer 预测与不确定性", 2024, "演示位移时间序列、预测区间和外部矿区验证。", ["边坡", "时序预测", "不确定性"], 64, False),
        ("矿井通风异常检测与可解释诊断", 2022, "演示通风网络、气体浓度和异常根因。", ["瓦斯", "通风", "异常检测"], 91, True),
        ("矿山灾害多模态基础模型评测", 2026, "演示影像、波形与文本的任务定义、数据隔离和安全评测。", ["多模态", "基础模型", "安全评测"], 3, True),
    ]
    records = []
    for index, (title, year, abstract, topics, citations, oa) in enumerate(rows, start=1):
        record = radar._record(index, title, year, topics[0], citations=citations, oa=oa, grade="A" if index in {2, 4, 14, 16} else "B" if index not in {11} else "C", authors=["SkyViewLab 离线基准"], abstract=abstract)
        record.update({"id": f"mine-{index:02d}", "doi": f"10.9000/skyview.mine.{index:02d}", "url": f"https://doi.org/10.9000/skyview.mine.{index:02d}", "topics": topics, "source": "矿山安全离线基准"})
        record["relevance"] = round(max(.58, .96 - index * .018), 3)
        records.append(record)
    return _enrich(records)


def _workspace() -> dict[str, Any]:
    now = "2026-09-09T00:00:00Z"
    return {
        "id": "mine-radar-frontier", "name": "矿山安全前沿证据", "mode": "mine", "namespace": "mine-safety", "version": 2,
        "query": {"main": "mine safety monitoring AI remote sensing microseismic risk", "must": "monitoring risk", "exact": "", "exclude": "", "startYear": 2020, "endYear": 2026, "sort": "relevance", "oaOnly": False, "providers": ["crossref", "openalex"], "page": 1, "perPage": 16, "minMineScore": 12},
        "collections": [{"id": "inbox", "name": "待筛选"}, {"id": "core", "name": "核心安全证据"}, {"id": "methods", "name": "监测与算法"}, {"id": "field", "name": "工程验证"}],
        "library": [
            {"recordId": "mine-01", "collectionId": "core", "status": "included", "priority": "high", "tags": ["边坡", "多源融合"], "note": "重点核查形变与降雨时间对齐。"},
            {"recordId": "mine-02", "collectionId": "field", "status": "included", "priority": "high", "tags": ["现场复核", "裂缝"], "note": "核验现场样本规模。"},
            {"recordId": "mine-03", "collectionId": "core", "status": "included", "priority": "high", "tags": ["岩爆", "微震"], "note": "检查定位误差与误报。"},
            {"recordId": "mine-04", "collectionId": "methods", "status": "maybe", "priority": "medium", "tags": ["瓦斯", "预测"], "note": "需要独立矿区验证。"},
            {"recordId": "mine-08", "collectionId": "field", "status": "included", "priority": "medium", "tags": ["尾矿库", "数字孪生"], "note": "关注点云更新频率。"},
            {"recordId": "mine-14", "collectionId": "methods", "status": "maybe", "priority": "medium", "tags": ["不确定性"], "note": "需要预测区间覆盖率。"},
        ],
        "evidenceNotes": {"use": "矿山相关度只用于初筛，优先复核具备现场、传感、验证和不确定性信息的记录。", "limitations": "离线基准不是真实论文；公开元数据也不能替代原文阅读和矿山安全专家判断。"},
        "monitors": [{"id": "mine-monitor-weekly", "name": "矿山安全 AI 新研究", "query": "mine safety monitoring AI remote sensing microseismic risk", "frequency": "weekly", "enabled": True, "lastRunAt": now, "lastStatus": "succeeded", "baselineIds": ["mine-01", "mine-03", "mine-04"], "newIds": ["mine-01"], "delivery": "矿山空间站内记录", "nextRunAt": None}],
        "transfer": {"selectedIds": ["mine-01", "mine-02", "mine-03", "mine-08"], "history": []},
        "createdAt": now, "updatedAt": now,
    }


def _coverage(records: list[dict[str, Any]], group: str) -> list[dict[str, Any]]:
    return [{"id": item_id, "label": label, "count": sum(any(hit["id"] == item_id for hit in record["mine"][group]) for record in records)} for item_id, label, _ in TAXONOMY[group]]


def _analysis(records: list[dict[str, Any]], duplicate_count: int = 0) -> dict[str, Any]:
    trend = Counter(int(item.get("year") or 0) for item in records if item.get("year"))
    hazards, methods, data = _coverage(records, "hazards"), _coverage(records, "methods"), _coverage(records, "data")
    matrix = []
    for hazard in hazards:
        for method in methods:
            count = sum(any(item["id"] == hazard["id"] for item in record["mine"]["hazards"]) and any(item["id"] == method["id"] for item in record["mine"]["methods"]) for record in records)
            matrix.append({"hazardId": hazard["id"], "methodId": method["id"], "count": count})
    readiness = [{"label": label, "count": sum((item["readiness"]["score"] >= low and item["readiness"]["score"] < high) for item in records)} for label, low, high in [("低于 40", 0, 40), ("40–54", 40, 55), ("55–74", 55, 75), ("75 以上", 75, 101)]]
    nodes = [{"id": item["id"], "label": item["label"], "type": "hazard", "weight": item["count"]} for item in hazards if item["count"]] + [{"id": item["id"], "label": item["label"], "type": "method", "weight": item["count"]} for item in methods if item["count"]] + [{"id": item["id"], "label": item["label"], "type": "data", "weight": item["count"]} for item in data if item["count"]]
    edges = [{"id": f"{item['hazardId']}:{item['methodId']}", "source": item["hazardId"], "target": item["methodId"], "weight": item["count"]} for item in matrix if item["count"]]
    signals = [{"recordId": item["id"], "title": item["title"], "hazard": item["mine"]["primaryHazard"], "method": item["mine"]["primaryMethod"], "mineScore": item["mine"]["score"], "readiness": item["readiness"]["score"], "riskSignal": item["riskSignal"], "boundary": "筛选信号，不是风险预警"} for item in sorted(records, key=lambda row: (-row["riskSignal"], -row["mine"]["score"]))[:10]]
    return {"yearlyTrend": [{"year": year, "count": trend[year]} for year in sorted(trend)], "hazards": hazards, "methods": methods, "data": data, "hazardMethodMatrix": matrix, "readinessDistribution": readiness, "graph": {"nodes": nodes, "edges": edges}, "riskSignals": signals, "duplicateCount": duplicate_count, "averageMineScore": round(sum(item["mine"]["score"] for item in records) / len(records), 1) if records else 0, "averageReadiness": round(sum(item["readiness"]["score"] for item in records) / len(records), 1) if records else 0, "fieldEvidence": sum(item["readiness"]["checks"]["realWorld"] for item in records), "reproducibleEvidence": sum(item["readiness"]["checks"]["reproducibility"] for item in records)}


def _csv(records: list[dict[str, Any]], workspace: dict[str, Any]) -> str:
    memberships = {item["recordId"]: item for item in workspace.get("library", [])}
    stream = io.StringIO(); writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["记录ID", "标题", "年份", "DOI", "灾种", "方法", "数据", "矿山相关度", "工程就绪度", "证据等级", "筛选状态", "备注"])
    for item in records:
        member = memberships.get(item["id"], {})
        writer.writerow([item["id"], radar._csv_safe(item["title"]), item.get("year", ""), item.get("doi", ""), "; ".join(value["label"] for value in item["mine"]["hazards"]), "; ".join(value["label"] for value in item["mine"]["methods"]), "; ".join(value["label"] for value in item["mine"]["data"]), item["mine"]["score"], item["readiness"]["score"], item["evidenceGrade"], member.get("status", ""), radar._csv_safe(member.get("note", ""))])
    return stream.getvalue()


def _exports(result: dict[str, Any]) -> dict[str, str]:
    records, workspace = result["records"], result["workspace"]
    selected = [item for item in records if item["id"] in workspace.get("transfer", {}).get("selectedIds", [])] or records
    markdown = "# AI+矿山安全研究雷达资料包\n\n> 数据空间：mine-safety（与通用研究雷达隔离）\n\n" + "\n\n".join(f"## {item['title']}\n\n- 灾种：{'; '.join(value['label'] for value in item['mine']['hazards']) or '未识别'}\n- 方法：{'; '.join(value['label'] for value in item['mine']['methods']) or '未识别'}\n- 数据：{'; '.join(value['label'] for value in item['mine']['data']) or '未识别'}\n- 矿山相关度：{item['mine']['score']}\n- 工程就绪度：{item['readiness']['score']}\n- DOI：{item.get('doi') or '缺失'}\n- 来源：{', '.join(item.get('providers', []))}\n\n{item.get('abstract', '')}" for item in selected)
    alerts = "# 矿山安全前沿监测记录\n\n" + "\n".join(f"- {item['name']}：{item['lastStatus']}，新增 {len(item.get('newIds', []))} 条" for item in workspace.get("monitors", []))
    transfer = {"schema": "skyview-mine-evidence-transfer", "version": 2, "namespace": "mine-safety", "records": selected, "evidenceNotes": workspace.get("evidenceNotes", {})}
    backup = {"schema": "skyview-mine-safety-radar-backup", "version": 2, "workspace": workspace, "records": records, "sources": result["sources"], "analysis": result["analysis"]}
    return {"bibtex": radar._bibtex(records), "ris": radar._ris(records), "libraryCsv": _csv(records, workspace), "alertsMarkdown": alerts, "knowledgeMarkdown": markdown, "transferJson": json.dumps(transfer, ensure_ascii=False, indent=2), "backupJson": json.dumps(backup, ensure_ascii=False, indent=2)}


def _result(workspace: dict[str, Any], records: list[dict[str, Any]], stage: str, sources: list[dict[str, Any]] | None = None, duplicate_count: int = 0) -> dict[str, Any]:
    records, merged = radar._dedupe(records)
    records = _enrich(records)
    result = {"schema": SCHEMA, "version": 2, "stage": stage, "namespace": "mine-safety", "workspace": workspace, "records": records, "analysis": _analysis(records, duplicate_count + merged), "sources": sources or radar._sources(), "runtime": {"controlPlane": "Go 项目、作业、版本、权限与审计", "computePlane": "Python 矿山分类、工程线索、来源适配与导出", "dataSpaceIsolated": True, "crossModeReuseRequiresTransfer": True, "defaultDataMode": "demo", "liveSearchRequiresExplicitAction": True, "backgroundSchedulerConfigured": False, "persistentNotificationConfigured": False, "safetyDecisionAutomation": False, "arbitraryCodeExecution": False}}
    result["exports"] = _exports(result)
    return result


def _state(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    state = payload.get("state") or payload.get("bundle") or {}
    if not isinstance(state, dict): raise ToolError("矿山安全雷达状态必须是对象")
    workspace = deepcopy(state.get("workspace") or payload.get("workspace") or _workspace())
    if workspace.get("namespace", "mine-safety") != "mine-safety": raise ToolError("拒绝载入其他雷达数据空间")
    return workspace, deepcopy(state.get("records") or payload.get("records") or _sample_records()), deepcopy(state.get("sources") or payload.get("sources") or radar._sources())


def _search_live(workspace: dict[str, Any], records: list[dict[str, Any]], sources: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any]:
    research = radar._live_search(workspace, records, sources, payload)
    if research.get("liveSearch", {}).get("fallbackUsed"):
        result = _result(workspace, records, "search-live-failed", research["sources"])
        result["liveSearch"] = research["liveSearch"]
        return result
    enriched = _enrich(research["records"])
    threshold = int(workspace.get("query", {}).get("minMineScore", 12))
    matched = [item for item in enriched if item["mine"]["score"] >= threshold]
    result = _result(workspace, matched, "search-live", research["sources"])
    result["liveSearch"] = {**research["liveSearch"], "returnedBeforeDomainFilter": len(enriched), "returned": len(matched), "minimumMineScore": threshold, "message": f"公开来源返回 {len(enriched)} 条，矿山规则筛选后保留 {len(matched)} 条；正式使用前必须核验原文。"}
    return result


def run_mine_safety_radar(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    workspace, records, sources = _state(payload)
    if action in {"load-sample", "run-all"}: return _result(_workspace(), _sample_records(), action)
    if action in {"search", "search-live"}: return _search_live(workspace, records, sources, payload)
    if action == "classify":
        text = radar._clean(payload.get("text"));
        if not text: raise ToolError("标题或摘要不能为空")
        record = radar._record(9000, text[:160], 0, "矿山安全", citations=0, oa=False, grade="C", provider="import", abstract=text)
        enriched = _enrich([record])[0]
        return {
            "schema": SCHEMA,
            "primary": enriched["mine"]["primaryHazard"],
            "categories": [item["label"] for item in enriched["mine"]["hazards"]],
            "classification": enriched["mine"],
            "readiness": enriched["readiness"],
            "riskSignal": enriched["riskSignal"],
            "boundary": "规则分类只用于文献初筛，不形成安全判断",
        }
    if action == "import-records":
        generic = radar._import_records(payload, workspace, records, sources)
        result = _result(workspace, generic["records"], action, sources, generic.get("analysis", {}).get("duplicateCount", 0)); result["importSummary"] = generic["importSummary"]; return result
    if action == "dedupe":
        merged, duplicates = radar._dedupe(records); return _result(workspace, merged, action, sources, duplicates)
    if action == "update-library":
        record_id = radar._clean(payload.get("recordId"));
        if not any(item["id"] == record_id for item in records): raise ToolError("矿山文献记录不存在")
        library = workspace.setdefault("library", []); item = next((entry for entry in library if entry["recordId"] == record_id), None)
        values = {"recordId": record_id, "collectionId": radar._clean(payload.get("collectionId")) or "inbox", "status": radar._clean(payload.get("status")) or "maybe", "priority": radar._clean(payload.get("priority")) or "medium", "tags": payload.get("tags") if isinstance(payload.get("tags"), list) else [], "note": radar._clean(payload.get("note"))}
        if item: item.update(values)
        else: library.insert(0, values)
        return _result(workspace, records, action, sources)
    if action == "update-evidence":
        workspace.setdefault("evidenceNotes", {}).update({"use": radar._clean(payload.get("use")), "limitations": radar._clean(payload.get("limitations"))})
        return _result(workspace, records, action, sources)
    if action == "run-monitor":
        monitor_id = radar._clean(payload.get("monitorId")); monitor = next((item for item in workspace.setdefault("monitors", []) if item["id"] == monitor_id), None)
        if not monitor: raise ToolError("矿山监测任务不存在")
        ids = [item["id"] for item in records[:10]]; baseline = set(monitor.get("baselineIds", [])); new_ids = [item for item in ids if item not in baseline]; now = radar._now()
        monitor.update({"lastRunAt": now, "lastStatus": "succeeded", "newIds": new_ids, "baselineIds": ids, "nextRunAt": None})
        workspace.setdefault("monitorRuns", []).insert(0, {"id": f"mine-run-{uuid.uuid4()}", "monitorId": monitor_id, "namespace": "mine-safety", "status": "succeeded", "startedAt": now, "finishedAt": now, "newIds": new_ids, "notificationStatus": "recorded", "deduplicationKey": f"mine-safety:{monitor_id}:{','.join(new_ids)}"})
        result = _result(workspace, records, action, sources); result["monitorRun"] = workspace["monitorRuns"][0]; return result
    if action == "transfer":
        ids = [str(item) for item in payload.get("recordIds", []) if any(record["id"] == str(item) for record in records)]; destination = radar._clean(payload.get("destination")) or "disaster-remote-sensing"
        workspace.setdefault("transfer", {})["selectedIds"] = ids; workspace["transfer"].setdefault("history", []).insert(0, {"id": f"mine-transfer-{uuid.uuid4()}", "sourceNamespace": "mine-safety", "destination": destination, "recordIds": ids, "createdAt": radar._now(), "status": "packaged", "requiresDestinationReview": True})
        return _result(workspace, records, action, sources)
    if action == "export": return _result(workspace, records, action, sources)
    raise ToolError("不支持的矿山安全雷达操作")
