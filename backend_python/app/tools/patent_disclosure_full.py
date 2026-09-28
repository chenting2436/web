from __future__ import annotations

import base64
import io
import json
import re
import unicodedata
import uuid
import zipfile
from datetime import UTC, datetime
from typing import Any
from xml.sax.saxutils import escape as xml_escape

from app.tools.common import ToolError


CHAPTERS: list[dict[str, Any]] = [
    {"order": 1, "name": "发明名称", "key": "title", "mandatory": True, "description": "准确反映技术主题，一般不超过25个字"},
    {"order": 2, "name": "技术领域", "key": "technical_field", "mandatory": True, "description": "明确所属或直接应用的具体技术领域"},
    {"order": 3, "name": "背景技术", "key": "background_art", "mandatory": True, "description": "说明现有方案及其直接相关不足"},
    {"order": 4, "name": "发明目的", "key": "purpose", "mandatory": True, "description": "明确需要解决的技术问题"},
    {"order": 5, "name": "技术方案", "key": "technical_solution", "mandatory": True, "description": "描述要素、关系、机制、步骤与参数"},
    {"order": 6, "name": "有益效果", "key": "beneficial_effects", "mandatory": True, "description": "建立技术特征与效果的因果关系"},
    {"order": 7, "name": "附图说明", "key": "drawing_description", "mandatory": True, "description": "列出图号、图名和建议位置"},
    {"order": 8, "name": "具体实施方式", "key": "detailed_embodiments", "mandatory": True, "description": "提供完整、可复现的实施例"},
    {"order": 9, "name": "替代方案", "key": "alternative_embodiments", "mandatory": False, "description": "描述关键特征的变体或替代实现"},
    {"order": 10, "name": "关键点与保护点", "key": "key_points", "mandatory": True, "description": "区分必要特征、可选特征和子方案"},
]

STOP_WORDS = set("本发明 技术 方案 系统 方法 装置 进行 实现 可以 通过 以及 其中 所述 一个 一种 核心 问题 现有 预期 包括 具有 用于".split())


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def _normalize(value: Any) -> str:
    return re.sub(r"[ \t]+", " ", unicodedata.normalize("NFKC", str(value or "")).replace("\x00", "")).strip()


def _sentences(text: str) -> list[str]:
    return [item.strip() for item in re.split(r"(?<=[。！？!?；;])\s*|\n+", _normalize(text)) if item.strip()]


def _keywords(text: str, limit: int = 12) -> list[str]:
    words = re.findall(r"[\u3400-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9._+-]{2,}", _normalize(text))
    counts: dict[str, int] = {}
    for word in words:
        if word not in STOP_WORDS:
            counts[word] = counts.get(word, 0) + 1
    return [item[0] for item in sorted(counts.items(), key=lambda item: (-item[1], -len(item[0]), item[0]))[:limit]]


def create_project(patent_type: str, concept: str, title: str = "") -> dict[str, Any]:
    concept = _normalize(concept)
    if len(concept) < 20:
        raise ToolError("核心技术构思至少需要20个字符")
    now = _now()
    project_title = _normalize(title) or "未命名专利草稿"
    return {
        "schema": "skyview-patent-assistant",
        "version": 1,
        "upstream": {"repository": "Dyp130/Patent-assistant", "commit": "7123187a1e071b402c4e87ff6d2ce8d1aff825e4", "license": "MIT"},
        "id": _uid("patent"),
        "patentType": _normalize(patent_type) or "发明专利",
        "title": project_title,
        "technicalConcept": concept,
        "status": "drafting",
        "conceptAnalysis": None,
        "chapters": [
            {
                **chapter,
                "id": _uid("chapter"),
                "content": project_title if chapter["key"] == "title" and project_title != "未命名专利草稿" else "",
                "status": "user_edited" if chapter["key"] == "title" and project_title != "未命名专利草稿" else "pending",
                "generationMode": "",
                "versions": [],
                "updatedAt": now,
            }
            for chapter in CHAPTERS
        ],
        "figures": [],
        "createdAt": now,
        "updatedAt": now,
    }


def analyze_concept(concept: str) -> dict[str, Any]:
    text = _normalize(concept)
    if len(text) < 20:
        raise ToolError("核心技术构思至少需要20个字符")
    sentences = _sentences(text)
    keywords = _keywords(text)
    while len(keywords) < 3:
        keywords.append(["输入单元", "处理单元", "输出单元"][len(keywords)])
    problem = next((item for item in sentences if re.search(r"问题|不足|缺陷|痛点|困难|导致|不一致", item)), sentences[0])
    effects = [item for item in sentences if re.search(r"提高|降低|减少|增强|改善|实现|效果|精度|效率|可靠|缩短", item)][:4]
    innovations = [item for item in sentences if re.search(r"创新|区别|相比|首次|采用|引入|结合|融合|自适应", item)][:5]
    return {
        "coreInventiveConcept": " ".join(sentences[:2]) or "【待补充核心发明构思】",
        "technicalProblem": problem,
        "keyComponents": keywords[:7],
        "connectionTypes": [item for item in sentences if re.search(r"连接|耦合|传输|输入|输出|数据流|信号|交互|协同|同步", item)][:5],
        "novelFeatures": innovations or [f"围绕“{item}”形成的技术特征【待确认创新性】" for item in keywords[:4]],
        "priorArtGaps": [item for item in sentences if re.search(r"现有|传统|不足|缺陷|难以|无法|依赖", item)][:4],
        "technicalEffects": effects or ["【待实验验证：与核心技术特征对应的技术效果】"],
        "suggestedTerminology": {item: item for item in keywords[:6]},
        "mode": "local-structured",
    }


def _validated_project(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ToolError("project 必须是项目对象")
    concept = _normalize(value.get("technicalConcept") or value.get("technical_concept"))
    if len(concept) < 20:
        raise ToolError("项目缺少有效的核心技术构思")
    project = dict(value)
    project["technicalConcept"] = concept
    project["title"] = _normalize(project.get("title")) or "未命名专利草稿"
    project["patentType"] = _normalize(project.get("patentType") or project.get("patent_type")) or "发明专利"
    existing = {str(item.get("key")): item for item in project.get("chapters", []) if isinstance(item, dict)}
    now = _now()
    project["chapters"] = [
        {
            **chapter,
            "id": existing.get(chapter["key"], {}).get("id") or _uid("chapter"),
            "content": _normalize(existing.get(chapter["key"], {}).get("content")),
            "status": existing.get(chapter["key"], {}).get("status") or "pending",
            "generationMode": existing.get(chapter["key"], {}).get("generationMode") or "",
            "versions": list(existing.get(chapter["key"], {}).get("versions") or [])[:20],
            "updatedAt": existing.get(chapter["key"], {}).get("updatedAt") or now,
        }
        for chapter in CHAPTERS
    ]
    project["conceptAnalysis"] = project.get("conceptAnalysis") or project.get("concept_analysis")
    return project


def generate_chapter(project_value: Any, chapter_key: str) -> str:
    project = _validated_project(project_value)
    analysis = project.get("conceptAnalysis") or analyze_concept(project["technicalConcept"])
    title_entry = next(item for item in project["chapters"] if item["key"] == "title")
    title = _normalize(title_entry.get("content")) or project["title"]
    if title == "未命名专利草稿":
        title = f"一种基于{'与'.join(analysis['keyComponents'][:2])}的技术系统及方法"
    terms = "、".join(analysis["keyComponents"]) or "关键组成要素"
    problem = _normalize(analysis["technicalProblem"]).rstrip("。；")
    solutions = [item for item in _sentences(project["technicalConcept"]) if not re.search(r"问题|不足|效果", item)][:6]
    contents = {
        "title": title,
        "technical_field": f"本发明涉及{'、'.join(analysis['keyComponents'][:3])}领域，具体涉及一种围绕{title}的实现系统及工作方法。其直接应用场景由发明人结合实际项目确认。",
        "background_art": f"现有技术在处理“{problem}”时，通常采用通用采集、处理和人工判读流程。根据当前交底构思，现有方案可能存在信息链条不完整、关键要素协同不足或结果难以追溯等问题。\n\n当前项目尚未导入经过核验的专利或论文证据，因此本章节不虚构现有技术名称、公开号或申请人。【待补充现有技术检索：至少列出2至3项最接近方案，并逐项核验公开文本和法律状态。】\n\n[插入图1: 现有技术流程及其问题位置示意图]",
        "purpose": f"本发明的目的在于提供{title}，以解决{problem}。进一步通过明确关键组成要素、要素间关系及工作流程，使技术方案具备可实施、可验证和可追溯的工程表达。",
        "technical_solution": f"## 总体构成\n\n本发明提供{title}。该方案至少包括{terms}。上述要素按照核心技术构思形成协同关系，用于解决“{problem}”。\n\n## 要素及关系\n\n" + "\n".join(f"{index + 1}. **{item}**：承担对应技术功能；其输入、输出、结构参数及接口条件为【待补充】。" for index, item in enumerate(analysis["keyComponents"])) + "\n\n## 工作过程\n\n" + ("\n".join(f"{index + 1}. {item}" for index, item in enumerate(solutions)) or "1. 获取输入；\n2. 执行核心处理；\n3. 输出结果并记录验证证据。") + "\n\n关键参数、阈值、材料、尺寸、采样条件及异常处理规则应来源于实际设计。\n\n[插入图2: 本发明总体结构框图]\n\n[插入图3: 本发明工作流程图]",
        "beneficial_effects": ("\n".join(f"{index + 1}. 由相关技术特征产生的预期效果：{item}【需以对比试验、仿真或工程记录验证】。" for index, item in enumerate(analysis["technicalEffects"])) or "1. 【待实验验证：明确技术特征、对照方案、指标、样本与结果】") + "\n\n除非已有可追溯测试数据，本章节不填写具体提升百分比、精度、成本或效率数值。",
        "drawing_description": "图1为现有技术流程及问题位置示意图。\n\n图2为本发明总体结构框图。\n\n图3为本发明工作流程图。\n\n图4为关键组成要素之间连接或数据关系示意图。\n\n图5为具体实施例的部署或结构示意图。",
        "detailed_embodiments": f"## 实施例一\n\n本实施例以{title}为对象。实施前，准备{terms}以及与真实项目一致的数据、设备、材料和接口条件。未给出的型号、数量、尺寸、阈值和环境条件均为【待补充】。\n\n### 实施步骤\n\n" + ("\n\n".join(f"步骤S{index + 1}：{item}" for index, item in enumerate(solutions)) or "步骤S1：完成组成要素配置。\n\n步骤S2：执行处理流程。\n\n步骤S3：记录输入、过程状态、输出和异常信息。") + "\n\n实施结果应通过【待补充：测试方法、对照组、评价指标和验收阈值】进行验证。",
        "alternative_embodiments": "\n".join(f"{index + 1}. 对于{item}，可在不改变核心发明构思的前提下采用等效结构、材料、接口或处理方式；具体范围由发明人确认。" for index, item in enumerate(analysis["keyComponents"][:5])) + "\n\n替代方案不得删除解决核心技术问题所必需的技术特征。",
        "key_points": "## 必要技术特征\n\n" + "\n".join(f"{index + 1}. {item}及其为解决核心技术问题所形成的具体技术关系。" for index, item in enumerate(analysis["keyComponents"][:5])) + "\n\n## 创新点候选\n\n" + "\n".join(f"{index + 1}. {item}【须经现有技术检索验证新颖性和创造性】。" for index, item in enumerate(analysis["novelFeatures"])) + "\n\n## 可选或从属特征\n\n参数范围、材料、接口、部署方式和异常处理可作为从属方案候选。",
    }
    if chapter_key not in contents:
        raise ToolError("未知章节")
    return _normalize(contents[chapter_key]).replace("\n ", "\n")


def extract_figures(chapters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    figures: dict[int, dict[str, Any]] = {}
    pattern = re.compile(r"\[(?:插入)?图\s*(\d+)\s*[：:]\s*([^\]]+)\]|图\s*(\d+)\s*(?:为|：|:)\s*([^。\n]+)")
    for chapter in chapters:
        for match in pattern.finditer(str(chapter.get("content") or "")):
            number = int(match.group(1) or match.group(3))
            description = _normalize(match.group(2) or match.group(4))
            if not description or number in figures:
                continue
            figure_type = "流程图" if re.search(r"流程|步骤", description) else "时序图" if "时序" in description else "结构图" if re.search(r"结构|框图|组成", description) else "示意图"
            figures[number] = {"id": f"figure-{number}", "number": number, "positionLabel": f"图{number}", "description": description, "chapter": chapter["name"], "contentType": figure_type}
    return [figures[number] for number in sorted(figures)]


def quality_report(project_value: Any) -> dict[str, Any]:
    project = _validated_project(project_value)
    issues = []
    if len(project["technicalConcept"]) < 80:
        issues.append({"level": "error", "text": "核心技术构思少于80字，难以支撑完整交底书。"})
    for chapter in project["chapters"]:
        minimum = 4 if chapter["key"] == "title" else 80
        if chapter["mandatory"] and len(_normalize(chapter["content"])) < minimum:
            issues.append({"level": "error", "text": f"{chapter['name']}尚未形成有效内容。"})
        if re.search(r"提高\s*\d+%|降低\s*\d+%|精度\s*\d+", chapter["content"]) and not re.search(r"实验|测试|数据|待.*验证", chapter["content"]):
            issues.append({"level": "warn", "text": f"{chapter['name']}包含定量效果，但附近未说明证据或验证状态。"})
        if re.search(r"CN\d{7,}", chapter["content"], re.I):
            issues.append({"level": "warn", "text": f"{chapter['name']}包含专利公开号，请核验原文与法律状态。"})
    if not project.get("conceptAnalysis"):
        issues.append({"level": "warn", "text": "尚未完成技术特征分析。"})
    completed = sum(len(_normalize(item["content"])) >= (4 if item["key"] == "title" else 80) for item in project["chapters"])
    figures = project.get("figures") or extract_figures(project["chapters"])
    score = round(completed / len(CHAPTERS) * 75 + (10 if project.get("conceptAnalysis") else 0) + (5 if figures else 0) + (10 if len(project["technicalConcept"]) >= 160 else 0) - sum(item["level"] == "warn" for item in issues) * 2)
    return {"completed": completed, "score": max(0, min(100, score)), "issues": issues}


def generate_all(project_value: Any) -> dict[str, Any]:
    project = _validated_project(project_value)
    project["conceptAnalysis"] = project.get("conceptAnalysis") or analyze_concept(project["technicalConcept"])
    now = _now()
    for chapter in project["chapters"]:
        previous = _normalize(chapter["content"])
        if previous:
            versions = list(chapter.get("versions") or [])
            if not versions or versions[0].get("content") != previous:
                versions.insert(0, {"id": _uid("version"), "number": (versions[0].get("number", 0) if versions else 0) + 1, "content": previous, "status": chapter["status"], "createdAt": now})
            chapter["versions"] = versions[:20]
        chapter["content"] = generate_chapter(project, chapter["key"])
        chapter["status"] = "local_generated"
        chapter["generationMode"] = "local-structured"
        chapter["updatedAt"] = now
    project["title"] = project["chapters"][0]["content"]
    project["figures"] = extract_figures(project["chapters"])
    project["updatedAt"] = now
    return {"project": project, "quality": quality_report(project)}


def markdown(project_value: Any) -> str:
    project = _validated_project(project_value)
    figures = project.get("figures") or extract_figures(project["chapters"])
    sections = [f"# {project['title']}", "", f"- 专利类型：{project['patentType']}", f"- 导出时间：{_now()}", ""]
    for chapter in project["chapters"]:
        sections.extend([f"## {chapter['order']}. {chapter['name']}", "", chapter["content"] or "【待撰写】", ""])
    sections.extend(["## 附图清单", ""])
    sections.extend([f"- {item['positionLabel']}：{item['description']}（{item['chapter']}）" for item in figures] or ["- 暂无附图"])
    sections.extend(["", "> 本文档为技术交底草稿，提交前必须核验现有技术、数据、术语、发明人和权利归属，并由专业人员复核。"])
    return "\n".join(sections)


def _docx(project_value: Any) -> bytes:
    project = _validated_project(project_value)
    figures = project.get("figures") or extract_figures(project["chapters"])

    def paragraph(value: str, style: str = "") -> str:
        style_xml = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        return f'<w:p>{style_xml}<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">{xml_escape(value)}</w:t></w:r></w:p>'

    body = [paragraph(project["title"], "Title"), paragraph(f"专利类型：{project['patentType']}")]
    for chapter in project["chapters"]:
        body.append(paragraph(f"{chapter['order']}. {chapter['name']}", "Heading1"))
        body.extend(paragraph(line) for line in re.split(r"\n+", chapter["content"] or "【待撰写】") if line)
    body.append(paragraph("附图清单", "Heading1"))
    body.extend(paragraph(f"{item['positionLabel']}：{item['description']}") for item in figures)
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + "".join(body) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
    styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="黑体"/><w:sz w:val="34"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:eastAsia="黑体"/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", document)
        archive.writestr("word/styles.xml", styles)
        archive.writestr("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    return output.getvalue()


def _payload_project(payload: dict[str, Any]) -> Any:
    project = payload.get("project")
    if isinstance(project, str):
        try:
            project = json.loads(project)
        except json.JSONDecodeError as error:
            raise ToolError("project 不是有效 JSON") from error
    return project


def run_patent_disclosure(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "create":
        return {"project": create_project(str(payload.get("patentType") or "发明专利"), str(payload.get("concept") or ""), str(payload.get("title") or ""))}
    if action in {"analyze", "structure"}:
        concept = _normalize(payload.get("concept") or (_payload_project(payload) or {}).get("technicalConcept"))
        return {"analysis": analyze_concept(concept), "chapters": CHAPTERS}
    if action == "generate-chapter":
        project = _validated_project(_payload_project(payload))
        key = str(payload.get("chapterKey") or "")
        content = generate_chapter(project, key)
        return {"chapterKey": key, "content": content, "figures": extract_figures([{**next(item for item in project["chapters"] if item["key"] == key), "content": content}])}
    if action == "generate":
        project = _payload_project(payload)
        if project is None:
            combined = "。".join(_normalize(payload.get(key)) for key in ("concept", "problem", "mechanism", "evidence") if _normalize(payload.get(key)))
            if len(combined) < 20:
                combined += "。【待发明人补充完整的技术问题、构成关系、工作机理与验证证据】"
            project = create_project(str(payload.get("patentType") or "发明专利"), combined, str(payload.get("title") or ""))
        generated = generate_all(project)
        return {
            **generated,
            "title": generated["project"]["title"],
            "chapters": [{"name": item["name"], "content": item["content"]} for item in generated["project"]["chapters"]],
            "verificationRequired": bool(generated["quality"]["issues"]),
        }
    if action == "generate-all":
        return generate_all(_payload_project(payload))
    if action == "audit":
        project = _payload_project(payload)
        if project is None:
            concept = str(payload.get("concept") or "")
            disclosure = str(payload.get("disclosure") or "")
            missing = [item["name"] for item in CHAPTERS if item["name"] not in disclosure]
            return {"passed": not missing and not re.search(r"待补充|待核验|TODO|XXX", disclosure, re.I), "missingChapters": missing, "placeholders": len(re.findall(r"待补充|待核验|TODO|XXX", disclosure, re.I)), "concept": concept}
        normalized = _validated_project(project)
        normalized["figures"] = extract_figures(normalized["chapters"])
        normalized["updatedAt"] = _now()
        return {"project": normalized, "quality": quality_report(normalized)}
    if action == "export":
        project = _validated_project(_payload_project(payload))
        safe_name = re.sub(r'[\\/:*?"<>|]', "-", project["title"])[:80] or "专利交底书"
        project_export = {"schema": "skyview-patent-assistant", "version": 1, "upstream": "Dyp130/Patent-assistant", "exportedAt": _now(), "project": project}
        return {
            "markdown": markdown(project),
            "docxBase64": base64.b64encode(_docx(project)).decode("ascii"),
            "projectJson": json.dumps(project_export, ensure_ascii=False, indent=2),
            "files": {"markdown": f"{safe_name}.md", "docx": f"{safe_name}.docx", "project": f"{safe_name}-project.json"},
        }
    raise ToolError("不支持的专利交底书操作")
