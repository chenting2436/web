from __future__ import annotations

import base64
import csv
import hashlib
import html
import io
import json
import re
import unicodedata
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

from app.tools.common import ToolError, tokenize


SCHEMA = "skyview-ai-report-results"
PROJECT_SCHEMA = "skyview-ai-report-project"
PACKAGE_SCHEMA = "skyview-ai-report-package"
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_EXPANDED_BYTES = 24 * 1024 * 1024
MAX_MATERIALS = 80
MAX_CHUNKS = 4_000
MAX_REPORT_CHARS = 180_000

REPORT_TYPES: dict[str, dict[str, Any]] = {
    "explain": {"name": "概念解释", "sections": ["任务与背景", "核心概念", "逐步解释", "材料例证", "易错点", "自测问题", "来源索引"]},
    "lab": {"name": "实验报告", "sections": ["摘要", "实验目标", "理论基础", "材料与环境", "实验方法", "结果与证据", "分析讨论", "误差与限制", "结论", "来源索引"]},
    "code": {"name": "代码解释", "sections": ["功能概览", "输入与输出", "执行流程", "关键函数与数据结构", "复杂度与性能", "风险与错误", "改进建议", "来源索引"]},
    "paper": {"name": "论文精读", "sections": ["文献信息", "研究问题", "方法与数据", "主要发现", "论证链", "局限性", "可复现检查", "课堂讨论", "来源索引"]},
    "lesson": {"name": "课程讲义", "sections": ["学习目标", "先修知识", "概念地图", "教学正文", "示例演练", "课堂活动", "形成性评价", "课后任务", "来源索引"]},
    "analysis": {"name": "数据分析报告", "sections": ["分析目标", "数据说明", "质量检查", "分析方法", "核心结果", "可视化解读", "不确定性", "结论与建议", "来源索引"]},
    "project": {"name": "项目复盘", "sections": ["项目摘要", "目标与范围", "实施过程", "关键决策", "成果证据", "问题与根因", "经验沉淀", "下一步行动", "来源索引"]},
    "custom": {"name": "自定义报告", "sections": ["执行摘要", "背景", "分析", "证据", "结论", "建议", "来源索引"]},
}

LOCAL_MODELS = [
    {"id": "Qwen3-0.6B-q4f16_1-MLC", "name": "Qwen3 0.6B · 快速", "memory": "约 1–2 GB 显存", "licenseStatus": "模型许可证需部署方核验"},
    {"id": "Qwen3-1.7B-q4f16_1-MLC", "name": "Qwen3 1.7B · 均衡", "memory": "约 2–4 GB 显存", "licenseStatus": "模型许可证需部署方核验"},
    {"id": "Llama-3.2-1B-Instruct-q4f16_1-MLC", "name": "Llama 3.2 1B · 英文", "memory": "约 2–3 GB 显存", "licenseStatus": "模型许可证需部署方核验"},
    {"id": "Phi-3.5-mini-instruct-q4f16_1-MLC", "name": "Phi 3.5 Mini · 推理", "memory": "约 4–6 GB 显存", "licenseStatus": "模型许可证需部署方核验"},
]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def _clean(value: Any, limit: int = 180_000) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).replace("\x00", "")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[\t\u00a0]+", " ", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip()
    if len(text) > limit:
        raise ToolError("文本超过允许长度")
    return text


def _hash(value: str | bytes) -> str:
    data = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _word_count(value: str) -> int:
    return len(re.findall(r"[\u3400-\u9fff]|[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", value))


def _keywords(value: str, limit: int = 16) -> list[str]:
    stop = set("的 了 和 与 或 是 在 对 将 中 为 及 由 从 以 并 其 这 那 一个 我们 研究 结果 进行 报告 材料 数据 分析".split())
    counts: dict[str, int] = {}
    for token in tokenize(value):
        token = token.casefold()
        if token not in stop and len(token) > 1:
            counts[token] = counts.get(token, 0) + 1
    return [item[0] for item in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def _chunk_text(text: str, material_id: str, sequence: int, max_chars: int = 1_200, overlap: int = 120) -> list[dict[str, Any]]:
    source = _clean(text)
    if not source:
        return []
    paragraphs = []
    for paragraph in re.split(r"\n{2,}", source):
        if len(paragraph) <= max_chars:
            paragraphs.append(paragraph)
        else:
            paragraphs.extend(paragraph[index:index + max_chars] for index in range(0, len(paragraph), max_chars))
    chunks: list[dict[str, Any]] = []
    buffer = ""

    def push() -> None:
        nonlocal buffer
        value = buffer.strip()
        if not value:
            return
        index = len(chunks) + 1
        chunks.append({
            "id": f"{material_id}-chunk-{index}", "materialId": material_id, "index": index,
            "label": f"S{sequence}.{index}", "text": value, "words": _word_count(value),
            "keywords": _keywords(value, 10), "checksum": _hash(value),
            "locator": f"文本片段 {index}", "enabled": True,
        })
        buffer = value[-overlap:]

    for paragraph in paragraphs:
        if buffer and len(buffer) + len(paragraph) + 2 > max_chars:
            push()
        buffer = f"{buffer}{'\n\n' if buffer else ''}{paragraph}"
    push()
    return chunks


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        value = data.strip()
        if value:
            self.parts.append(value)


def _safe_zip(data: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ToolError("压缩文档结构无效") from exc
    infos = archive.infolist()
    if len(infos) > 1_000:
        archive.close()
        raise ToolError("压缩文档包含过多文件")
    expanded = 0
    for info in infos:
        path = PurePosixPath(info.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts:
            archive.close()
            raise ToolError("压缩文档包含不安全路径")
        expanded += info.file_size
        if expanded > MAX_EXPANDED_BYTES:
            archive.close()
            raise ToolError("压缩文档解压后超过安全限制")
    return archive


def _xml_text(raw: bytes, *, allow_root: bool = True) -> str:
    preview = raw[:100_000].upper()
    if b"<!DOCTYPE" in preview or b"<!ENTITY" in preview:
        raise ToolError("XML 外部实体和 DTD 已禁用")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ToolError(f"XML 解析失败：{exc}") from exc
    lines = [value.strip() for value in root.itertext() if value.strip()]
    if not allow_root and not lines:
        raise ToolError("文档没有可提取文本")
    return "\n".join(lines)


def _extract_ooxml(data: bytes, extension: str) -> tuple[str, list[str]]:
    archive = _safe_zip(data)
    warnings: list[str] = []
    try:
        names = set(archive.namelist())
        if extension == ".docx":
            targets = sorted(name for name in names if re.fullmatch(r"word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml", name))
        elif extension == ".pptx":
            targets = sorted((name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=lambda name: int(re.search(r"(\d+)", name).group(1)))
        else:
            from app.tools.data_lab_full import _read_xlsx

            dataset = _read_xlsx(data)
            fields = dataset["fields"][:80]
            lines = ["\t".join(fields)]
            for row in dataset["rows"][:2_000]:
                lines.append("\t".join(str(row.get(field) if row.get(field) is not None else "") for field in fields))
            if len(dataset["rows"]) > 2_000:
                warnings.append("表格材料仅提取前 2,000 行用于证据索引")
            return "\n".join(lines), warnings
        if not targets:
            raise ToolError("Office 文档中没有找到可读取正文")
        parts = []
        for target in targets:
            try:
                root = ET.fromstring(archive.read(target))
            except ET.ParseError as exc:
                raise ToolError("Office 文档 XML 损坏") from exc
            text_nodes = [node.text.strip() for node in root.iter() if node.tag.rsplit("}", 1)[-1] in {"t", "tab", "br"} and node.text and node.text.strip()]
            if text_nodes:
                prefix = f"[幻灯片 {len(parts) + 1}]\n" if extension == ".pptx" else ""
                parts.append(prefix + "\n".join(text_nodes))
        return "\n\n".join(parts), warnings
    finally:
        archive.close()


def _extract_pdf(data: bytes) -> tuple[str, list[str], str]:
    if not data.startswith(b"%PDF-"):
        raise ToolError("PDF 文件签名无效")
    source = data.decode("latin-1", errors="ignore")
    fragments: list[str] = []
    for raw in re.findall(r"\((.{2,800}?)\)\s*Tj|\[(.{2,2000}?)\]\s*TJ", source, re.S):
        value = next((item for item in raw if item), "")
        value = re.sub(r"\\([()\\])", r"\1", value)
        value = re.sub(r"\\[nrtbf]", " ", value)
        value = re.sub(r"[^\x20-\x7e\u00a0-\u024f]", " ", value)
        value = re.sub(r"\s+", " ", value).strip()
        if len(value) >= 2:
            fragments.append(value)
    text = "\n".join(fragments)
    if len(text) < 20:
        return "", ["未提取到可靠文本，需要配置 OCR/版面解析运行时"], "ocr-required"
    return text, ["PDF 使用受限文本层提取；复杂版面需由正式解析运行时复核"], "ready"


def _extract_material(file_name: str, data: bytes) -> tuple[str, str, list[str], str]:
    if not file_name or len(file_name) > 180:
        raise ToolError("文件名无效")
    if len(data) > MAX_FILE_BYTES:
        raise ToolError("单个材料最大 4 MB")
    extension = PurePosixPath(file_name.lower().replace("\\", "/")).suffix
    warnings: list[str] = []
    status = "ready"
    mime = {
        ".md": "text/markdown", ".txt": "text/plain", ".py": "text/x-python", ".js": "text/javascript",
        ".ts": "text/typescript", ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
        ".html": "text/html", ".htm": "text/html", ".xml": "application/xml", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pdf": "application/pdf",
    }.get(extension, "application/octet-stream")
    if extension in {".docx", ".xlsx", ".pptx"}:
        text, warnings = _extract_ooxml(data, extension)
    elif extension == ".pdf":
        text, warnings, status = _extract_pdf(data)
    else:
        try:
            decoded = data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ToolError("文本材料必须使用 UTF-8；二进制格式请使用 PDF、DOCX、XLSX 或 PPTX") from exc
        if extension == ".json":
            try:
                parsed = json.loads(decoded)
            except json.JSONDecodeError as exc:
                raise ToolError(f"JSON 解析失败：{exc.msg}") from exc
            text = json.dumps(parsed, ensure_ascii=False, indent=2)
        elif extension in {".html", ".htm"}:
            parser = _TextExtractor()
            parser.feed(decoded)
            text = "\n".join(parser.parts)
        elif extension == ".xml":
            text = _xml_text(data)
        elif extension in {".csv", ".tsv"}:
            delimiter = "\t" if extension == ".tsv" else ","
            rows = list(csv.reader(io.StringIO(decoded), delimiter=delimiter))
            if len(rows) > 2_000:
                rows = rows[:2_000]
                warnings.append("表格材料仅提取前 2,000 行用于证据索引")
            text = "\n".join("\t".join(cell.strip() for cell in row[:80]) for row in rows)
        elif extension in {".md", ".txt", ".py", ".js", ".ts"}:
            text = decoded
        else:
            raise ToolError("支持 PDF、DOCX、XLSX、PPTX、HTML、XML、JSON、CSV、TSV、MD、TXT 和代码文本")
    return _clean(text), mime, warnings, status


def _material(sequence: int, name: str, text: str, mime: str = "text/markdown", *, source_url: str = "", warnings: list[str] | None = None, status: str = "ready") -> dict[str, Any]:
    material_id = _id("material")
    chunks = _chunk_text(text, material_id, sequence) if text else []
    return {
        "id": material_id, "sequence": sequence, "name": _clean(name, 180), "type": mime,
        "bytes": len(text.encode("utf-8")), "text": text, "sourceUrl": source_url,
        "status": status, "warnings": warnings or [], "checksum": _hash(text),
        "chunks": chunks, "addedAt": _now(), "selected": status == "ready",
    }


def _sample_project() -> dict[str, Any]:
    now = _now()
    project: dict[str, Any] = {
        "schema": PROJECT_SCHEMA, "version": 3, "id": "report-project-slope-monitoring",
        "title": "边坡监测证据解释与课程报告", "course": "工程地质与灾害监测",
        "status": "active", "owner": "课程教师", "members": [{"name": "课程教师", "role": "owner"}, {"name": "助教", "role": "editor"}],
        "config": {
            "reportType": "analysis", "audience": "工程地质课程学生", "tone": "严谨、清晰、证据优先",
            "language": "zh-CN", "length": "detailed", "objective": "解释连续降雨、位移加速与现场排水条件之间的证据关系",
            "instruction": "区分材料事实与分析推断；数值、时序和因果陈述必须给出片段引用。",
            "sections": deepcopy(REPORT_TYPES["analysis"]["sections"]), "retrievalLimit": 12, "chunkChars": 1200,
        },
        "settings": {"mode": "extractive", "localModel": LOCAL_MODELS[1]["id"], "temperature": 0.2, "topP": 0.9, "maxTokens": 2048, "systemStyle": "evidence-first"},
        "materials": [], "selectedMaterialIds": [], "activeMaterialId": "", "chats": [],
        "report": {"content": "", "status": "empty", "model": "", "mode": "", "generatedAt": None, "editedAt": None, "evidenceChunkIds": [], "promptChecksum": "", "evidenceChecksum": ""},
        "audits": [], "versions": [], "activities": [], "createdAt": now, "updatedAt": now,
    }
    samples = [
        ("现场巡查记录.md", "2026年8月18日，北区边坡排水沟局部淤堵，坡脚可见持续渗水。\n\n裂缝测点 F-03 宽度为 18 mm，较上次巡查增加 3 mm。\n\n巡查组建议先疏通排水沟，并对坡脚渗水点连续复核。"),
        ("监测摘要.csv", "日期,累计降雨(mm),测点,位移速率(mm/d)\n2026-08-16,42,F-03,0.8\n2026-08-17,76,F-03,1.6\n2026-08-18,112,F-03,3.4\n2026-08-19,126,F-03,3.1"),
        ("分析方法说明.md", "位移速率采用24小时滑动差分计算；累计降雨窗口为72小时。\n\n本课程阈值仅用于教学：位移速率超过 3.0 mm/d 时进入人工复核，不直接触发工程安全决策。\n\n缺测、仪器漂移和现场施工扰动均可能造成表观加速，需要与巡查记录交叉核验。"),
        ("教师核验记录.txt", "教师已核对监测摘要中的日期与数值。当前材料支持“降雨与位移加速同期出现”，但不足以证明单一因果关系。\n\n处置建议必须标注为教学研判，并保留现场工程师复核入口。"),
    ]
    for index, (name, text) in enumerate(samples, 1):
        item = _material(index, name, text, "text/csv" if name.endswith(".csv") else "text/markdown")
        project["materials"].append(item)
        project["selectedMaterialIds"].append(item["id"])
    project["activeMaterialId"] = project["materials"][0]["id"]
    draft = _generate_report(project)
    project["report"].update(draft)
    project["report"].update({"status": "ready", "generatedAt": now})
    project["chats"] = [
        {"id": "chat-question-1", "role": "user", "content": "材料是否能证明降雨导致边坡失稳？", "createdAt": now, "evidenceChunkIds": []},
        {"id": "chat-answer-1", "role": "assistant", "content": "材料只能支持降雨与位移加速同期出现；教师核验明确指出当前证据不足以证明单一因果关系。应继续核对排水、渗水、施工扰动与仪器状态。 [S4.1]", "createdAt": now, "evidenceChunkIds": [project["materials"][3]["chunks"][0]["id"]], "mode": "extractive-server", "model": "证据整理引擎"},
    ]
    _snapshot(project, "首轮证据报告", "generation")
    project["activities"] = [
        {"id": _id("activity"), "type": "generation", "message": "生成首轮证据报告", "actor": "课程教师", "createdAt": now},
        {"id": _id("activity"), "type": "material", "message": "4 份课程材料完成索引", "actor": "课程教师", "createdAt": now},
    ]
    project["audits"] = [_audit_report(project)]
    return project


def _state(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("state")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ToolError(f"项目状态 JSON 无效：{exc.msg}") from exc
    if isinstance(value, dict) and value.get("schema") == SCHEMA:
        value = value.get("project")
    if isinstance(value, dict) and isinstance(value.get("result"), dict):
        nested = value["result"]
        value = nested.get("project") if nested.get("schema") == SCHEMA else nested
    if not isinstance(value, dict) or value.get("schema") != PROJECT_SCHEMA:
        raise ToolError("AI 报告项目状态不存在或版本不兼容")
    project = deepcopy(value)
    if len(project.get("materials", [])) > MAX_MATERIALS:
        raise ToolError("项目材料数量超过安全限制")
    return project


def _selected_chunks(project: dict[str, Any]) -> list[dict[str, Any]]:
    selected = set(project.get("selectedMaterialIds", []))
    output = []
    for material in project.get("materials", []):
        if material.get("id") not in selected or material.get("status") != "ready":
            continue
        for chunk in material.get("chunks", []):
            if chunk.get("enabled", True):
                output.append({**chunk, "materialName": material.get("name", ""), "materialChecksum": material.get("checksum", "")})
    if len(output) > MAX_CHUNKS:
        raise ToolError("证据片段数量超过安全限制")
    return output


def _rank_evidence(project: dict[str, Any], query: str, limit: int | None = None) -> list[dict[str, Any]]:
    query_terms = set(_keywords(f"{query} {project.get('title', '')} {project.get('config', {}).get('objective', '')}", 36))
    ranked = []
    for chunk in _selected_chunks(project):
        haystack = chunk["text"].casefold()
        overlap = sum(1 for term in query_terms if term in haystack or term in chunk.get("keywords", []))
        numeric = 2 if re.search(r"\d", chunk["text"]) else 0
        ranked.append({**chunk, "score": round(overlap * 12 + numeric + min(6, chunk.get("words", 0) / 80), 3)})
    size = max(1, min(30, int(limit or project.get("config", {}).get("retrievalLimit", 12))))
    return sorted(ranked, key=lambda item: (-item["score"], item["label"]))[:size]


def _local_prompt(project: dict[str, Any]) -> dict[str, Any]:
    evidence = _rank_evidence(project, f"{project['config'].get('objective', '')} {project['config'].get('instruction', '')}")
    source = "\n\n---\n\n".join(f"[{item['label']}] {item['materialName']} · {item['locator']}\n{item['text']}" for item in evidence)
    system = """你是证据优先的教学解释与报告助手。只能根据提供的证据片段陈述项目事实；数值、时序、比较、因果和技术定义必须引用真实片段编号。材料不足时明确说明材料未提供。区分材料事实、分析推断和教学建议，不得虚构来源。输出简体中文 Markdown。"""
    sections = "\n".join(f"{index}. {name}" for index, name in enumerate(project["config"]["sections"], 1))
    user = f"""生成完整《{project['title']}》。\n报告类型：{REPORT_TYPES[project['config']['reportType']]['name']}\n目标读者：{project['config']['audience']}\n教学目标：{project['config']['objective']}\n特别要求：{project['config']['instruction']}\n必须包含以下一级章节：\n{sections}\n\n证据材料：\n{source or '没有可用证据；不得生成事实性结论。'}"""
    return {"system": system, "user": user, "evidence": evidence, "promptChecksum": _hash(f"{system}\n{user}"), "evidenceChecksum": _hash(source)}


def _generate_report(project: dict[str, Any]) -> dict[str, Any]:
    prompt = _local_prompt(project)
    evidence = prompt["evidence"]
    lines = [f"# {project['title']}", "", f"报告类型：{REPORT_TYPES[project['config']['reportType']]['name']}", ""]
    content_sections = [item for item in project["config"]["sections"] if "来源索引" not in item]
    for section_index, section in enumerate(project["config"]["sections"]):
        lines.extend([f"## {section}", ""])
        if "来源索引" in section:
            if evidence:
                lines.extend(f"- [{item['label']}] {item['materialName']} · {item['locator']} · SHA-256 {item['checksum'][:12]}" for item in evidence)
            else:
                lines.append("当前没有可用证据片段。")
            lines.append("")
            continue
        selected = [item for offset, item in enumerate(evidence) if offset % max(1, len(content_sections)) == section_index % max(1, len(content_sections))][:2]
        if not selected:
            lines.extend(["材料未提供该部分所需信息。", ""])
        else:
            for item in selected:
                sentence = re.sub(r"\s+", " ", item["text"])[:420].rstrip()
                lines.extend([f"- {sentence}{'…' if len(item['text']) > 420 else ''} [{item['label']}]", ""])
    return {
        "content": "\n".join(lines).strip(), "model": "证据整理引擎", "mode": "extractive-server",
        "evidenceChunkIds": [item["id"] for item in evidence], "promptChecksum": prompt["promptChecksum"], "evidenceChecksum": prompt["evidenceChecksum"],
    }


def _citation_labels(value: str) -> list[str]:
    return list(dict.fromkeys(re.findall(r"\[(S\d+\.\d+)\]", value)))


def _audit_report(project: dict[str, Any]) -> dict[str, Any]:
    report = _clean(project.get("report", {}).get("content", ""))
    chunks = _selected_chunks(project)
    valid = {item["label"]: item for item in chunks}
    used = _citation_labels(report)
    invalid = [label for label in used if label not in valid]
    missing_sections = [section for section in project["config"]["sections"] if not re.search(rf"^##\s+.*{re.escape(section)}", report, re.M)]
    numeric_lines = [line.strip() for line in report.splitlines() if re.search(r"\d+(?:\.\d+)?\s*(?:%|mm|cm|m\b|km|小时|天|次|个|GB|MB|Hz)", line, re.I)]
    uncited_numeric = [line for line in numeric_lines if not re.search(r"\[S\d+\.\d+\]", line)]
    issues: list[dict[str, Any]] = []

    def add(severity: str, category: str, message: str, action: str, evidence: str = "") -> None:
        issues.append({"id": _id("issue"), "severity": severity, "category": category, "message": message, "action": action, "evidence": evidence})

    if not report:
        add("critical", "content", "报告正文为空", "先生成或编写报告")
    if missing_sections:
        add("high", "structure", f"缺少 {len(missing_sections)} 个目标章节", "补全报告结构", "、".join(missing_sections))
    if report and not used:
        add("critical", "citation", "报告没有证据片段引用", "为事实和数值补充 [Sx.y] 引用")
    if invalid:
        add("critical", "citation", f"存在 {len(invalid)} 个无效片段编号", "改用当前证据库中的编号", "、".join(invalid))
    if uncited_numeric:
        add("high", "numbers", f"{len(uncited_numeric)} 行数值陈述没有引用", "逐条核对并补充片段引用", " | ".join(uncited_numeric[:3]))
    if report and not re.search(r"局限|限制|不确定|不足以|材料未提供", report, re.I):
        add("medium", "limitations", "没有说明局限或不确定性", "增加适用边界和人工复核项")
    used_chunks = {valid[label]["id"] for label in used if label in valid}
    coverage = round(len(used_chunks) / max(1, len(chunks)) * 100, 1)
    critical = sum(item["severity"] == "critical" for item in issues)
    high = sum(item["severity"] == "high" for item in issues)
    score = max(0, round(100 - critical * 28 - high * 14 - sum(item["severity"] == "medium" for item in issues) * 6 - max(0, 45 - coverage) * .25, 1))
    return {
        "id": _id("audit"), "createdAt": _now(), "reportChecksum": _hash(report), "passed": critical == 0 and high == 0,
        "score": score, "issues": issues,
        "stats": {"words": _word_count(report), "citations": len(used), "validCitations": len(used) - len(invalid), "invalidCitations": len(invalid), "coverage": coverage, "missingSections": len(missing_sections), "uncitedNumericLines": len(uncited_numeric)},
    }


def _source_index(project: dict[str, Any]) -> list[dict[str, Any]]:
    report = project.get("report", {}).get("content", "")
    used = set(_citation_labels(report))
    output = []
    for material in project.get("materials", []):
        for chunk in material.get("chunks", []):
            output.append({
                "label": chunk["label"], "chunkId": chunk["id"], "materialId": material["id"], "materialName": material["name"],
                "locator": chunk.get("locator", ""), "checksum": chunk.get("checksum", ""), "used": chunk["label"] in used,
                "excerpt": chunk.get("text", "")[:360],
            })
    return output


def _snapshot(project: dict[str, Any], label: str, kind: str = "manual", actor: str = "当前用户") -> dict[str, Any]:
    report = project.get("report", {})
    version = {
        "id": _id("version"), "number": len(project.get("versions", [])) + 1, "label": _clean(label, 100) or "报告版本",
        "kind": kind, "actor": _clean(actor, 80), "createdAt": _now(), "content": report.get("content", ""),
        "reportChecksum": _hash(report.get("content", "")), "model": report.get("model", ""), "mode": report.get("mode", ""),
        "evidenceChunkIds": deepcopy(report.get("evidenceChunkIds", [])), "evidenceChecksum": report.get("evidenceChecksum", ""),
    }
    project.setdefault("versions", []).append(version)
    return version


def _activity(project: dict[str, Any], message: str, kind: str, actor: str) -> None:
    project.setdefault("activities", []).insert(0, {"id": _id("activity"), "type": kind, "message": message, "actor": actor, "createdAt": _now()})
    project["activities"] = project["activities"][:80]
    project["updatedAt"] = _now()


def _markdown_html(project: dict[str, Any]) -> str:
    lines = []
    in_list = False
    for raw in project["report"]["content"].splitlines():
        value = html.escape(raw)
        if value.startswith("# "):
            if in_list:
                lines.append("</ul>"); in_list = False
            lines.append(f"<h1>{value[2:]}</h1>")
        elif value.startswith("## "):
            if in_list:
                lines.append("</ul>"); in_list = False
            lines.append(f"<h2>{value[3:]}</h2>")
        elif value.startswith("- "):
            if not in_list:
                lines.append("<ul>"); in_list = True
            lines.append(f"<li>{value[2:]}</li>")
        elif value.strip():
            if in_list:
                lines.append("</ul>"); in_list = False
            lines.append(f"<p>{value}</p>")
    if in_list:
        lines.append("</ul>")
    return f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{html.escape(project["title"])}</title><style>body{{max-width:920px;margin:40px auto;padding:0 24px;color:#152b49;font:16px/1.75 system-ui}}h1,h2{{color:#0d315d}}li{{margin:.45em 0}}code{{background:#eef3f8}}</style><body>{"".join(lines)}</body></html>'


def _docx(project: dict[str, Any]) -> bytes:
    paragraphs = []
    for line in project["report"]["content"].splitlines():
        style = ""
        value = line
        if line.startswith("# "):
            style, value = "Title", line[2:]
        elif line.startswith("## "):
            style, value = "Heading1", line[3:]
        paragraph_style = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        paragraphs.append(f'<w:p>{paragraph_style}<w:r><w:t xml:space="preserve">{xml_escape(value or " ")}</w:t></w:r></w:p>')
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + "".join(paragraphs) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200"/></w:sectPr></w:body></w:document>'
    styles = '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document)
        archive.writestr("word/styles.xml", styles)
    return output.getvalue()


def _exports(project: dict[str, Any], audit: dict[str, Any]) -> dict[str, str]:
    source_index = _source_index(project)
    source_json = json.dumps({"schema": "skyview-ai-report-source-index", "version": 2, "projectId": project["id"], "sources": source_index}, ensure_ascii=False, indent=2)
    project_json = json.dumps(project, ensure_ascii=False, indent=2)
    report = project["report"]["content"]
    docx = _docx(project)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", f'# {project["title"]}\n\n本项目包包含报告、证据片段、版本和审计记录。模型或规则输出仍需结合原始材料复核。\n')
        archive.writestr("manifest.json", json.dumps({"schema": PACKAGE_SCHEMA, "version": 2, "projectId": project["id"], "reportChecksum": _hash(report), "materials": [{"name": item["name"], "checksum": item["checksum"], "chunks": len(item["chunks"])} for item in project["materials"]], "createdAt": _now()}, ensure_ascii=False, indent=2))
        archive.writestr("project.json", project_json)
        archive.writestr("report/report.md", report)
        archive.writestr("report/report.html", _markdown_html(project))
        archive.writestr("report/report.docx", docx)
        archive.writestr("evidence/source-index.json", source_json)
        archive.writestr("audit/latest-audit.json", json.dumps(audit, ensure_ascii=False, indent=2))
        archive.writestr("versions/versions.json", json.dumps(project.get("versions", []), ensure_ascii=False, indent=2))
        for index, material in enumerate(project["materials"], 1):
            safe_name = re.sub(r'[\\/:*?"<>|]', "-", material["name"])
            archive.writestr(f"materials/{index:02d}-{safe_name}.txt", material.get("text", ""))
    return {
        "markdown": report, "html": _markdown_html(project), "text": re.sub(r"^#{1,6}\s*|^-\s*", "", report, flags=re.M),
        "sourceIndexJson": source_json, "auditJson": json.dumps(audit, ensure_ascii=False, indent=2), "projectJson": project_json,
        "docxBase64": base64.b64encode(docx).decode("ascii"), "packageBase64": base64.b64encode(package.getvalue()).decode("ascii"),
    }


def _analysis(project: dict[str, Any]) -> dict[str, Any]:
    audit = _audit_report(project)
    selected_chunks = _selected_chunks(project)
    used_ids = set(project.get("report", {}).get("evidenceChunkIds", []))
    coverage_by_material = []
    for material in project.get("materials", []):
        chunks = material.get("chunks", [])
        used = sum(chunk["id"] in used_ids for chunk in chunks)
        coverage_by_material.append({"materialId": material["id"], "name": material["name"], "chunks": len(chunks), "used": used, "coverage": round(used / max(1, len(chunks)) * 100, 1)})
    quality_checks = [
        {"label": "已选择至少一份可用材料", "passed": bool(selected_chunks)},
        {"label": "报告正文已形成", "passed": bool(project.get("report", {}).get("content"))},
        {"label": "所有片段引用均可解析", "passed": audit["stats"]["invalidCitations"] == 0 and audit["stats"]["citations"] > 0},
        {"label": "数值陈述均有片段引用", "passed": audit["stats"]["uncitedNumericLines"] == 0},
        {"label": "目标章节结构完整", "passed": audit["stats"]["missingSections"] == 0},
        {"label": "报告包含局限与不确定性", "passed": bool(re.search(r"局限|限制|不确定|不足以|材料未提供", project.get("report", {}).get("content", ""), re.I))},
        {"label": "至少保留一个不可变报告版本", "passed": bool(project.get("versions"))},
    ]
    prompt = _local_prompt(project)
    return {
        "metrics": {"materials": len(project["materials"]), "selectedMaterials": len(project.get("selectedMaterialIds", [])), "chunks": len(selected_chunks), "reportWords": _word_count(project["report"]["content"]), "citations": audit["stats"]["citations"], "coverage": audit["stats"]["coverage"], "versions": len(project["versions"]), "qualityScore": audit["score"]},
        "audit": audit, "qualityChecks": quality_checks, "coverageByMaterial": coverage_by_material,
        "sourceIndex": _source_index(project), "evidence": prompt["evidence"],
        "localPrompt": {"system": prompt["system"], "user": prompt["user"], "evidenceChunkIds": [item["id"] for item in prompt["evidence"]], "promptChecksum": prompt["promptChecksum"], "evidenceChecksum": prompt["evidenceChecksum"]},
        "reportTypes": [{"id": key, **value} for key, value in REPORT_TYPES.items()], "localModels": LOCAL_MODELS,
    }


def _runtime() -> dict[str, Any]:
    return {
        "serverEvidenceEngine": {"status": "enabled", "engine": "Python deterministic evidence retrieval and audit"},
        "goControlPlane": {"status": "enabled", "engine": "Go projects, jobs, versions and audit boundary"},
        "browserWebLLM": {"status": "browser-opt-in", "engine": "WebLLM 0.2.85 Web Worker / WebGPU", "downloadsModelOnConsent": True},
        "enterpriseAiGateway": {"status": "not-configured", "engine": "server-side provider credentials only"},
        "ocrLayoutParser": {"status": "not-configured", "engine": "scanned PDF and complex layout extraction"},
        "objectStorage": {"status": "not-configured", "engine": "S3-compatible source and artifact persistence"},
        "arbitraryCodeExecution": False,
    }


def _result(project: dict[str, Any], stage: str) -> dict[str, Any]:
    analysis = _analysis(project)
    return {"schema": SCHEMA, "version": 3, "stage": stage, "project": project, "analysis": analysis, "runtime": _runtime(), "exports": _exports(project, analysis["audit"])}


def _actor(payload: dict[str, Any]) -> tuple[str, str]:
    return _clean(payload.get("actor") or "当前用户", 80), _clean(payload.get("actorRole") or "owner", 30).casefold()


MUTATING = {
    "update-project", "update-config", "import-material", "import-text", "register-url", "toggle-material", "toggle-chunk",
    "delete-material", "set-active-material", "generate-extractive", "record-local-generation", "ask-extractive", "record-local-chat",
    "update-report", "audit-report", "create-version", "restore-version", "clear-chat", "import-project",
}


def run_ai_report(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    # Keep the original compact API contract for integrations created before the
    # stateful report workspace was introduced. Dedicated React actions below use
    # the full project schema and never depend on this compatibility branch.
    if action in {"draft", "audit"} and not payload.get("state"):
        from app.tools.teaching import ai_report as run_legacy_ai_report

        return run_legacy_ai_report(action, payload)
    if action in {"load-sample", "run-all"} and not payload.get("state"):
        return _result(_sample_project(), "load-sample")
    project = _state(payload)
    actor, role = _actor(payload)
    if action in MUTATING and role == "viewer":
        raise ToolError("只读成员不能修改报告项目", code="TOOL_FORBIDDEN", status_code=403)

    if action == "update-project":
        project["title"] = _clean(payload.get("title") or project["title"], 180)
        project["course"] = _clean(payload.get("course") if "course" in payload else project.get("course", ""), 120)
        _activity(project, "更新项目基本信息", "project", actor)
    elif action == "update-config":
        config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
        report_type = _clean(config.get("reportType") or project["config"]["reportType"], 30)
        if report_type not in REPORT_TYPES:
            raise ToolError("报告类型无效")
        if report_type != project["config"]["reportType"]:
            project["config"]["sections"] = deepcopy(REPORT_TYPES[report_type]["sections"])
        project["config"]["reportType"] = report_type
        for key, limit in {"audience": 120, "tone": 120, "language": 20, "length": 20, "objective": 1_200, "instruction": 2_000}.items():
            if key in config:
                project["config"][key] = _clean(config[key], limit)
        settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
        local_ids = {item["id"] for item in LOCAL_MODELS}
        if settings.get("localModel") in local_ids:
            project["settings"]["localModel"] = settings["localModel"]
        for key, lower, upper in (("temperature", 0, 1.5), ("topP", .1, 1), ("maxTokens", 256, 8192)):
            if key in settings:
                try:
                    value = max(lower, min(upper, float(settings[key])))
                    project["settings"][key] = int(value) if key == "maxTokens" else value
                except (TypeError, ValueError) as exc:
                    raise ToolError(f"{key} 必须是数字") from exc
        _activity(project, "更新报告模板和运行参数", "settings", actor)
    elif action in {"import-material", "import-text"}:
        if len(project["materials"]) >= MAX_MATERIALS:
            raise ToolError("项目最多允许 80 份材料")
        if action == "import-text":
            file_name = _clean(payload.get("fileName") or "粘贴材料.md", 180)
            text = _clean(payload.get("content"))
            if not text:
                raise ToolError("材料内容不能为空")
            mime, warnings, status = "text/markdown", [], "ready"
        else:
            file_name = _clean(payload.get("fileName"), 180)
            encoded = str(payload.get("contentBase64") or "")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise ToolError("材料 Base64 无效") from exc
            text, mime, warnings, status = _extract_material(file_name, raw)
        item = _material(len(project["materials"]) + 1, file_name, text, mime, warnings=warnings, status=status)
        project["materials"].append(item)
        if item["selected"]:
            project["selectedMaterialIds"].append(item["id"])
        project["activeMaterialId"] = item["id"]
        _activity(project, f"导入材料：{item['name']}（{len(item['chunks'])} 个片段）", "material", actor)
    elif action == "register-url":
        if len(project["materials"]) >= MAX_MATERIALS:
            raise ToolError("项目最多允许 80 份材料")
        raw_url = _clean(payload.get("url"), 2_000)
        parsed = urlparse(raw_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ToolError("仅允许登记不含凭据的 HTTPS 地址")
        item = _material(len(project["materials"]) + 1, _clean(payload.get("name") or parsed.hostname, 180), "", "text/uri-list", source_url=raw_url, warnings=["URL 已登记；安全抓取服务尚未配置"], status="fetch-pending")
        project["materials"].append(item)
        project["activeMaterialId"] = item["id"]
        _activity(project, f"登记外部材料地址：{item['name']}", "material", actor)
    elif action == "toggle-material":
        material_id = _clean(payload.get("materialId"), 80)
        item = next((item for item in project["materials"] if item["id"] == material_id), None)
        if not item:
            raise ToolError("材料不存在")
        selected = set(project.get("selectedMaterialIds", []))
        if material_id in selected:
            selected.remove(material_id)
        elif item.get("status") == "ready":
            selected.add(material_id)
        project["selectedMaterialIds"] = [item["id"] for item in project["materials"] if item["id"] in selected]
        _activity(project, f"{'选择' if material_id in selected else '取消选择'}材料：{item['name']}", "material", actor)
    elif action == "toggle-chunk":
        chunk_id = _clean(payload.get("chunkId"), 120)
        found = None
        for material in project["materials"]:
            found = next((item for item in material.get("chunks", []) if item["id"] == chunk_id), None)
            if found:
                break
        if not found:
            raise ToolError("证据片段不存在")
        found["enabled"] = not found.get("enabled", True)
        _activity(project, f"{'启用' if found['enabled'] else '停用'}证据片段 {found['label']}", "evidence", actor)
    elif action == "delete-material":
        material_id = _clean(payload.get("materialId"), 80)
        before = len(project["materials"])
        project["materials"] = [item for item in project["materials"] if item["id"] != material_id]
        if len(project["materials"]) == before:
            raise ToolError("材料不存在")
        project["selectedMaterialIds"] = [item for item in project["selectedMaterialIds"] if item != material_id]
        project["activeMaterialId"] = project["materials"][0]["id"] if project["materials"] else ""
        _activity(project, "删除材料并重建证据范围", "material", actor)
    elif action == "set-active-material":
        material_id = _clean(payload.get("materialId"), 80)
        if not any(item["id"] == material_id for item in project["materials"]):
            raise ToolError("材料不存在")
        project["activeMaterialId"] = material_id
    elif action in {"generate-extractive", "run-all"}:
        if not _selected_chunks(project):
            raise ToolError("请先选择至少一份可用材料")
        if project["report"].get("content"):
            _snapshot(project, "重新生成前", "automatic", actor)
        project["report"].update(_generate_report(project))
        project["report"].update({"status": "ready", "generatedAt": _now(), "editedAt": None})
        _snapshot(project, "证据整理稿", "generation", actor)
        _activity(project, "生成完整证据整理报告", "generation", actor)
    elif action == "record-local-generation":
        content = _clean(payload.get("content"), MAX_REPORT_CHARS)
        if not content:
            raise ToolError("本地模型没有返回报告正文")
        model = _clean(payload.get("model"), 100)
        if model not in {item["id"] for item in LOCAL_MODELS}:
            raise ToolError("本地模型不在允许清单中")
        evidence_ids = [str(item) for item in payload.get("evidenceChunkIds", []) if isinstance(item, str)]
        valid_ids = {item["id"] for item in _selected_chunks(project)}
        if not set(evidence_ids).issubset(valid_ids):
            raise ToolError("本地生成记录包含无效证据片段")
        if project["report"].get("content"):
            _snapshot(project, "本地模型生成前", "automatic", actor)
        project["report"].update({"content": content, "status": "ready", "model": model, "mode": "local-webllm", "generatedAt": _now(), "editedAt": None, "evidenceChunkIds": evidence_ids, "promptChecksum": _clean(payload.get("promptChecksum"), 80), "evidenceChecksum": _clean(payload.get("evidenceChecksum"), 80)})
        _snapshot(project, "浏览器本地模型生成稿", "generation", actor)
        _activity(project, f"记录浏览器本地模型生成：{model}", "generation", actor)
    elif action == "ask-extractive":
        question = _clean(payload.get("question"), 2_000)
        if not question:
            raise ToolError("问题不能为空")
        evidence = _rank_evidence(project, question, 6)
        answer = "\n".join(f"- {item['text'][:360]}{'…' if len(item['text']) > 360 else ''} [{item['label']}]" for item in evidence[:3]) or "当前材料没有足够证据回答这个问题。"
        ids = [item["id"] for item in evidence]
        project["chats"].extend([
            {"id": _id("chat"), "role": "user", "content": question, "createdAt": _now(), "evidenceChunkIds": []},
            {"id": _id("chat"), "role": "assistant", "content": answer, "createdAt": _now(), "evidenceChunkIds": ids, "mode": "extractive-server", "model": "证据整理引擎"},
        ])
        project["chats"] = project["chats"][-80:]
        _activity(project, f"完成材料问答：{question[:36]}", "chat", actor)
    elif action == "record-local-chat":
        question, answer = _clean(payload.get("question"), 2_000), _clean(payload.get("answer"), 24_000)
        model = _clean(payload.get("model"), 100)
        if not question or not answer or model not in {item["id"] for item in LOCAL_MODELS}:
            raise ToolError("本地问答记录无效")
        evidence_ids = [str(item) for item in payload.get("evidenceChunkIds", []) if isinstance(item, str)]
        valid_ids = {item["id"] for item in _selected_chunks(project)}
        if not set(evidence_ids).issubset(valid_ids):
            raise ToolError("本地问答记录包含无效证据片段")
        project["chats"].extend([
            {"id": _id("chat"), "role": "user", "content": question, "createdAt": _now(), "evidenceChunkIds": []},
            {"id": _id("chat"), "role": "assistant", "content": answer, "createdAt": _now(), "evidenceChunkIds": evidence_ids, "mode": "local-webllm", "model": model},
        ])
        project["chats"] = project["chats"][-80:]
        _activity(project, f"记录浏览器本地模型问答：{question[:36]}", "chat", actor)
    elif action == "update-report":
        content = _clean(payload.get("content"), MAX_REPORT_CHARS)
        if not content:
            raise ToolError("报告正文不能为空")
        project["report"].update({"content": content, "status": "edited", "editedAt": _now()})
        _activity(project, "保存人工修订报告", "editing", actor)
    elif action == "audit-report":
        audit = _audit_report(project)
        project["audits"].insert(0, audit)
        project["audits"] = project["audits"][:40]
        _activity(project, f"完成报告核验：{audit['score']} 分", "audit", actor)
    elif action == "create-version":
        version = _snapshot(project, _clean(payload.get("label"), 100) or f"报告版本 {len(project['versions']) + 1}", "manual", actor)
        _activity(project, f"固化版本：{version['label']}", "version", actor)
    elif action == "restore-version":
        version_id = _clean(payload.get("versionId"), 80)
        version = next((item for item in project["versions"] if item["id"] == version_id), None)
        if not version:
            raise ToolError("报告版本不存在")
        _snapshot(project, "恢复版本前", "automatic", actor)
        project["report"].update({"content": version["content"], "status": "restored", "model": version.get("model", ""), "mode": version.get("mode", ""), "evidenceChunkIds": deepcopy(version.get("evidenceChunkIds", [])), "evidenceChecksum": version.get("evidenceChecksum", ""), "editedAt": _now()})
        _snapshot(project, f"恢复自 {version['label']}", "restore", actor)
        _activity(project, f"恢复报告版本：{version['label']}", "version", actor)
    elif action == "clear-chat":
        project["chats"] = []
        _activity(project, "清空当前解释会话", "chat", actor)
    elif action == "import-project":
        raw = payload.get("project")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ToolError(f"项目 JSON 无效：{exc.msg}") from exc
        if not isinstance(raw, dict) or raw.get("schema") != PROJECT_SCHEMA:
            raise ToolError("项目文件结构不兼容")
        imported = deepcopy(raw)
        imported["id"] = _id("report-project")
        imported["title"] = f"{_clean(imported.get('title'), 160) or '导入报告'}（导入副本）"
        imported["activities"] = []
        imported["audits"] = []
        imported["createdAt"] = imported["updatedAt"] = _now()
        project = imported
        _activity(project, "从 JSON 导入项目副本；来源审计未被信任", "import", actor)
    elif action in {"runtime-status", "validate", "export"}:
        pass
    else:
        raise ToolError(f"不支持的 AI 报告操作：{action}")
    return _result(project, action)
