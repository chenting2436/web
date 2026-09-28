from __future__ import annotations

import base64
import csv
import hashlib
import html
import io
import json
import math
import re
import statistics
import unicodedata
import uuid
import zipfile
import zlib
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from xml.etree import ElementTree

from app.tools.common import ToolError


SCHEMA = "skyview-knowledge-system-results"
STOP_WORDS = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "into",
    "using", "used", "can", "not", "but", "our", "their", "about", "which", "will", "would", "should",
    "一个", "一种", "以及", "并且", "但是", "进行", "通过", "可以", "需要", "本文", "研究", "结果",
    "方法", "数据", "分析", "系统", "相关", "基于", "对于", "其中", "具有", "由于", "因此", "同时",
    "主要", "包括", "采用", "实现", "使用", "进一步", "提出", "表明", "显示",
}
SUPPORTED_EXTENSIONS = {
    "pdf", "docx", "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "html", "htm", "xml", "rtf",
    "log", "tex", "bib", "py", "js", "ts", "css", "yaml", "yml", "ini", "conf", "sql", "eml",
}


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4()}"


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lstrip("\ufeff").replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\t\f\v]+", " ", text)
    text = re.sub(r"[ \u00a0]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style"}:
            self.hidden += 1
        elif tag.lower() in {"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style"} and self.hidden:
            self.hidden -= 1
        elif tag.lower() in {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def _strip_html(value: str) -> str:
    parser = _TextExtractor()
    parser.feed(value)
    return _normalize("".join(parser.parts))


def _tokens(value: Any) -> list[str]:
    source = _normalize(value).lower()
    output: list[str] = []
    for token in re.findall(r"[a-z0-9][a-z0-9._+\-]{1,}", source):
        item = token.strip("._+-")
        if len(item) > 1 and item not in STOP_WORDS:
            output.append(item)
    for sequence in re.findall(r"[\u3400-\u9fff]{2,}", source):
        if len(sequence) <= 6 and sequence not in STOP_WORDS:
            output.append(sequence)
        for size in (2, 3):
            for index in range(max(0, len(sequence) - size + 1)):
                token = sequence[index:index + size]
                if token not in STOP_WORDS:
                    output.append(token)
    return output


def _sentences(value: Any) -> list[str]:
    return [item.strip() for item in re.findall(r"[^。！？.!?\n]+[。！？.!?]?|[^\n]+", _normalize(value)) if len(item.strip()) > 1]


def _heading(line: str) -> str:
    value = line.strip()
    if re.match(r"^#{1,6}\s+", value):
        return re.sub(r"^#{1,6}\s+", "", value)
    if re.match(r"^(第[一二三四五六七八九十百0-9]+[章节篇部]|\d+(?:\.\d+){0,3}[、.\s]|[一二三四五六七八九十]+[、.])", value) and len(value) <= 90:
        return value
    return ""


def _keywords(value: Any, limit: int = 12) -> list[str]:
    counts = Counter(_tokens(value))
    scored = sorted(counts.items(), key=lambda item: (-(item[1] * (1 + math.log(1 + len(item[0])))), item[0]))
    return [term for term, _ in scored[:limit]]


def _vector(value: Any, dimensions: int = 192) -> list[float]:
    vector = [0.0] * dimensions
    for token, count in Counter(_tokens(value)).items():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = -1 if digest[4] & 1 else 1
        vector[index] += sign * (1 + math.log(count))
    norm = math.sqrt(sum(item * item for item in vector))
    return [item / norm for item in vector] if norm else vector


def _cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=False))


def _chunk_text(value: Any, document: dict[str, Any], settings: dict[str, Any]) -> list[dict[str, Any]]:
    text = _normalize(value)
    if not text:
        return []
    maximum = int(_clamp(float(settings.get("chunkSize", 900)), 200, 6000))
    overlap = int(_clamp(float(settings.get("chunkOverlap", 120)), 0, maximum * 0.45))
    lines = text.splitlines()
    sections: list[dict[str, Any]] = []
    current = {"heading": "", "lines": [], "startLine": 1}
    for index, line in enumerate(lines, start=1):
        heading = _heading(line)
        if heading and any(str(item).strip() for item in current["lines"]):
            sections.append(current)
            current = {"heading": heading, "lines": [line], "startLine": index}
        else:
            if heading:
                current["heading"] = heading
            current["lines"].append(line)
    if any(str(item).strip() for item in current["lines"]):
        sections.append(current)
    chunks: list[dict[str, Any]] = []
    for section in sections:
        sentence_items = _sentences("\n".join(section["lines"]))
        buffer = ""
        sentence_start = 0

        def flush(end_index: int) -> None:
            nonlocal buffer, sentence_start
            content = buffer.strip()
            if not content:
                return
            order = len(chunks)
            chunks.append({
                "id": f"chunk-{document['id']}-{order + 1}", "workspaceId": document["workspaceId"],
                "documentId": document["id"], "documentName": document["name"], "order": order,
                "heading": section["heading"] or document["name"], "text": content,
                "charCount": len(content), "tokenCount": len(_tokens(content)),
                "sourceLocation": f"L{section['startLine']} · S{sentence_start + 1}-{max(sentence_start + 1, end_index)}",
                "page": int(document.get("pageCount", 0) > 0) or None, "keywords": _keywords(content, 10),
                "version": document["version"], "updatedAt": document["updatedAt"],
            })
            if overlap:
                tail = content[-overlap:]
                boundary = max(tail.rfind(mark) for mark in "。！？.!?\n")
                buffer = tail[boundary + 1:] if 0 <= boundary < len(tail) - 1 else tail
            else:
                buffer = ""
            sentence_start = end_index

        for index, sentence in enumerate(sentence_items):
            if len(sentence) > maximum:
                if buffer:
                    flush(index)
                step = max(1, maximum - overlap)
                for offset in range(0, len(sentence), step):
                    piece = sentence[offset:offset + maximum].strip()
                    if not piece:
                        continue
                    order = len(chunks)
                    chunks.append({
                        "id": f"chunk-{document['id']}-{order + 1}", "workspaceId": document["workspaceId"],
                        "documentId": document["id"], "documentName": document["name"], "order": order,
                        "heading": section["heading"] or document["name"], "text": piece,
                        "charCount": len(piece), "tokenCount": len(_tokens(piece)),
                        "sourceLocation": f"L{section['startLine']} · long-{offset + 1}", "page": None,
                        "keywords": _keywords(piece, 10), "version": document["version"], "updatedAt": document["updatedAt"],
                    })
                buffer = ""
                sentence_start = index + 1
                continue
            candidate = f"{buffer} {sentence}".strip()
            if len(candidate) > maximum and buffer:
                flush(index)
            buffer = f"{buffer} {sentence}".strip()
        if buffer:
            flush(len(sentence_items))
    return chunks


def _search(chunks: list[dict[str, Any]], query: str, settings: dict[str, Any], document_id: str = "all", tag: str = "", documents: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    query = _normalize(query)
    query_tokens = _tokens(query)
    if not query_tokens:
        return []
    allowed_ids = None
    if documents is not None:
        allowed_ids = {item["id"] for item in documents if (document_id == "all" or item["id"] == document_id) and (not tag or tag in item.get("tags", []))}
    records = [item for item in chunks if item.get("text") and (allowed_ids is None or item["documentId"] in allowed_ids)]
    if not records:
        return []
    query_counts = Counter(query_tokens)
    prepared: list[tuple[dict[str, Any], list[str], Counter[str]]] = []
    frequencies: Counter[str] = Counter()
    for chunk in records:
        tokens = _tokens(f"{chunk.get('heading', '')} {chunk['text']}")
        counts = Counter(tokens)
        for token in query_counts:
            if counts[token]:
                frequencies[token] += 1
        prepared.append((chunk, tokens, counts))
    average_length = statistics.fmean(len(tokens) for _, tokens, _ in prepared) or 1
    query_vector = _vector(query)
    raw: list[dict[str, Any]] = []
    for chunk, tokens, counts in prepared:
        bm25 = 0.0
        for token, query_count in query_counts.items():
            frequency = counts[token]
            if not frequency:
                continue
            document_frequency = frequencies[token]
            inverse = math.log(1 + (len(records) - document_frequency + 0.5) / (document_frequency + 0.5))
            bm25 += inverse * ((frequency * 2.35) / (frequency + 1.35 * (0.28 + 0.72 * len(tokens) / average_length))) * (1 + math.log(query_count))
        vector_score = max(0.0, _cosine(query_vector, _vector(f"{chunk.get('heading', '')} {chunk['text']}")))
        phrase = int(query.lower() in str(chunk["text"]).lower())
        heading_matches = sum(token in set(_tokens(chunk.get("heading", ""))) for token in query_counts)
        raw.append({"chunk": chunk, "counts": counts, "bm25": bm25, "vector": vector_score, "phrase": phrase, "heading": heading_matches})
    max_bm25 = max(1e-9, *(item["bm25"] for item in raw))
    bm25_weight = float(_clamp(float(settings.get("bm25Weight", 0.72)), 0, 1))
    threshold = float(_clamp(float(settings.get("threshold", 0.08)), 0, 1))
    output = []
    for item in raw:
        normalized_bm25 = item["bm25"] / max_bm25
        score = normalized_bm25 * bm25_weight + item["vector"] * (1 - bm25_weight) + item["phrase"] * 0.15 + min(0.12, item["heading"] * 0.04)
        if score < threshold:
            continue
        output.append({
            **deepcopy(item["chunk"]), "score": round(score, 6), "bm25Score": round(normalized_bm25, 6),
            "vectorScore": round(item["vector"], 6), "phraseMatch": bool(item["phrase"]),
            "matchedTerms": [token for token in query_counts if item["counts"][token]][:12],
        })
    output.sort(key=lambda item: (-item["score"], item["order"]))
    return output[:int(_clamp(float(settings.get("topK", 8)), 1, 50))]


def _answer(query: str, results: list[dict[str, Any]], settings: dict[str, Any]) -> dict[str, Any]:
    if not results:
        return {"answer": "当前知识库中没有检索到足以支持回答的内容。", "citations": [], "confidence": 0, "evidenceCount": 0, "sourceCount": 0, "mode": "extractive"}
    query_terms = set(_tokens(query))
    candidates: list[dict[str, Any]] = []
    for result_index, result in enumerate(results):
        for sentence_index, sentence in enumerate(_sentences(result["text"])):
            tokens = _tokens(sentence)
            overlap = len(query_terms.intersection(tokens)) / math.sqrt(max(1, len(tokens)))
            score = overlap + result["score"] * 0.55 + (0.12 if 25 <= len(sentence) <= 240 else 0) - sentence_index * 0.01
            candidates.append({"sentence": sentence, "score": score, "result": result, "citationIndex": result_index + 1})
    selected: list[dict[str, Any]] = []
    fingerprints: set[str] = set()
    limit = int(_clamp(float(settings.get("maxAnswerSentences", 5)), 1, 10))
    for candidate in sorted(candidates, key=lambda item: -item["score"]):
        fingerprint = "|".join(_tokens(candidate["sentence"])[:12])
        if candidate["score"] <= 0 or fingerprint in fingerprints:
            continue
        fingerprints.add(fingerprint)
        selected.append(candidate)
        if len(selected) >= limit:
            break
    citations = [{
        "index": index + 1, "chunkId": item["id"], "documentId": item["documentId"],
        "documentName": item["documentName"], "heading": item["heading"], "sourceLocation": item["sourceLocation"],
        "page": item.get("page"), "score": item["score"], "excerpt": item["text"][:360],
    } for index, item in enumerate(results)]
    source_count = len({item["result"]["documentId"] for item in selected})
    confidence = _clamp(results[0]["score"] * 0.6 + min(0.25, len(selected) * 0.05) + min(0.15, source_count * 0.05), 0, 1)
    return {
        "answer": "\n".join(f"- {item['sentence']} [{item['citationIndex']}]" for item in selected),
        "citations": citations, "confidence": round(confidence, 6), "evidenceCount": len(selected),
        "sourceCount": source_count, "mode": "extractive",
    }


def _concepts(chunks: list[dict[str, Any]], limit: int = 36) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str], dict[str, Any]] = {}
    for chunk in chunks:
        terms = _keywords(f"{chunk.get('heading', '')} {chunk['text']}", 8)
        for term in terms:
            node = nodes.setdefault(term, {"id": term, "name": term, "count": 0, "documentIds": set(), "chunkIds": set()})
            node["count"] += 1
            node["documentIds"].add(chunk["documentId"])
            node["chunkIds"].add(chunk["id"])
        for left_index, left in enumerate(terms):
            for right in terms[left_index + 1:]:
                pair = tuple(sorted((left, right)))
                edge = edges.setdefault(pair, {"id": "::".join(pair), "source": pair[0], "target": pair[1], "weight": 0, "chunkIds": set()})
                edge["weight"] += 1
                edge["chunkIds"].add(chunk["id"])
    selected = sorted(nodes.values(), key=lambda item: (-item["count"], item["name"]))[:limit]
    allowed = {item["id"] for item in selected}
    return {
        "nodes": [{**item, "documentIds": sorted(item["documentIds"]), "chunkIds": sorted(item["chunkIds"])} for item in selected],
        "edges": [{**item, "chunkIds": sorted(item["chunkIds"])} for item in sorted(edges.values(), key=lambda item: (-item["weight"], item["id"])) if item["source"] in allowed and item["target"] in allowed][:limit * 2],
    }


def _quality(documents: list[dict[str, Any]], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    by_document: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for chunk in chunks:
        by_document[chunk["documentId"]].append(chunk)
    issues = []
    for document in documents:
        if document["status"] == "failed":
            issues.append({"severity": "error", "documentId": document["id"], "message": f"{document['name']} 解析失败"})
        elif not by_document[document["id"]]:
            issues.append({"severity": "error", "documentId": document["id"], "message": f"{document['name']} 没有可检索分块"})
        if document.get("textLength", 0) < 80:
            issues.append({"severity": "warning", "documentId": document["id"], "message": f"{document['name']} 可检索文本过短"})
        if not document.get("tags"):
            issues.append({"severity": "info", "documentId": document["id"], "message": f"{document['name']} 尚未设置标签"})
    fingerprints = Counter("|".join(_tokens(item["text"])[:60]) for item in chunks)
    duplicate_groups = sum(count > 1 for fingerprint, count in fingerprints.items() if fingerprint)
    if duplicate_groups:
        issues.append({"severity": "warning", "documentId": "", "message": f"发现 {duplicate_groups} 组高度相似分块"})
    indexed = sum(document["status"] == "ready" and bool(by_document[document["id"]]) for document in documents)
    tagged = sum(bool(document.get("tags")) for document in documents)
    average = statistics.fmean(item["charCount"] for item in chunks) if chunks else 0
    score = round(_clamp((indexed / len(documents) if documents else 0) * 55 + (tagged / len(documents) if documents else 0) * 15 + (20 if chunks else 0) + (0 if any(item["severity"] == "error" for item in issues) else 10) - min(20, duplicate_groups * 2), 0, 100))
    return {"score": score, "issues": issues, "indexedDocuments": indexed, "totalDocuments": len(documents), "chunkCount": len(chunks), "averageChunk": round(average), "taggedRate": tagged / len(documents) if documents else 0, "duplicateGroups": duplicate_groups}


def _evaluate(workspace: dict[str, Any], documents: list[dict[str, Any]], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    details = []
    for item in workspace.get("benchmarks", []):
        results = _search(chunks, item["query"], workspace["settings"], documents=documents)
        index = next((position for position, result in enumerate(results) if result["documentId"] == item["expectedDocumentId"]), -1)
        rank = index + 1 if index >= 0 else 0
        details.append({**deepcopy(item), "rank": rank, "hit": bool(rank), "reciprocalRank": round(1 / rank, 6) if rank else 0, "resultIds": [result["id"] for result in results]})
    hit = sum(item["hit"] for item in details) / len(details) if details else 0
    mrr = statistics.fmean(item["reciprocalRank"] for item in details) if details else 0
    return {"total": len(details), "hitAtK": round(hit, 6), "mrr": round(mrr, 6), "topK": workspace["settings"]["topK"], "details": details}


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _flatten_json(value: Any, path: str = "$", depth: int = 0, lines: list[str] | None = None) -> list[str]:
    output = lines if lines is not None else []
    if len(output) >= 100_000:
        return output
    if depth > 12:
        output.append(f"{path} = [嵌套深度超过 12，已截断]")
    elif isinstance(value, dict):
        for key, item in value.items():
            _flatten_json(item, f"{path}.{key}", depth + 1, output)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _flatten_json(item, f"{path}[{index}]", depth + 1, output)
    else:
        output.append(f"{path} = {value}")
    return output


def _parse_pdf(data: bytes) -> tuple[str, str, int, int, list[str]]:
    streams = re.findall(rb"stream\r?\n(.*?)\r?\nendstream", data, re.DOTALL)
    candidates = [data]
    for stream in streams[:500]:
        try:
            candidates.append(zlib.decompress(stream))
        except zlib.error:
            candidates.append(stream)
    parts = []
    for source in candidates:
        for literal in re.findall(rb"\((.{2,2000}?)\)\s*Tj", source, re.DOTALL):
            parts.append(_decode_text(literal.replace(rb"\(", b"(").replace(rb"\)", b")")))
        for array in re.findall(rb"\[(.*?)\]\s*TJ", source, re.DOTALL):
            parts.extend(_decode_text(item) for item in re.findall(rb"\((.*?)\)", array, re.DOTALL))
    text = _normalize(" ".join(parts))
    if not text:
        raise ToolError("PDF 没有提取到文本；扫描版文件需要接入 OCR 文档运行时")
    pages = max(1, len(re.findall(rb"/Type\s*/Page\b", data)))
    return text, "安全 PDF 文本提取器", pages, 0, ["复杂字体编码 PDF 需由正式文档运行时复核"]


def _parse_document(name: str, mime_type: str, data: bytes) -> dict[str, Any]:
    if len(data) > 30 * 1024 * 1024:
        raise ToolError("单个文件超过 30 MB 处理上限")
    extension = name.lower().rsplit(".", 1)[-1] if "." in name else "txt"
    if extension not in SUPPORTED_EXTENSIONS and not mime_type.startswith("text/"):
        raise ToolError(f"暂不支持 .{extension} 文件")
    warnings: list[str] = []
    page_count = 0
    record_count = 0
    if extension == "pdf":
        text, parser, page_count, record_count, warnings = _parse_pdf(data)
    elif extension == "docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                xml = archive.read("word/document.xml")
            root = ElementTree.fromstring(xml)
            paragraphs = []
            for paragraph in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
                paragraphs.append("".join(node.text or "" for node in paragraph.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")))
            text = _normalize("\n".join(paragraphs))
            parser = "隔离 DOCX XML 提取器"
        except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as exc:
            raise ToolError("DOCX 文件结构无效") from exc
    elif extension in {"csv", "tsv"}:
        source = _decode_text(data)
        reader = csv.DictReader(io.StringIO(source), delimiter="\t" if extension == "tsv" else ",")
        rows = list(reader)
        record_count = len(rows)
        fields = reader.fieldnames or []
        text = _normalize("字段：" + "、".join(fields) + "\n" + "\n".join(f"记录 {index + 1}：" + "；".join(f"{field}={row.get(field, '')}" for field in fields) for index, row in enumerate(rows)))
        parser = "结构化表格解析器"
    elif extension in {"json", "jsonl"}:
        source = _decode_text(data)
        try:
            value = [json.loads(line) for line in source.splitlines() if line.strip()] if extension == "jsonl" else json.loads(source)
        except json.JSONDecodeError as exc:
            raise ToolError(f"JSON 解析失败：{exc.msg}") from exc
        text = _normalize("\n".join(_flatten_json(value)))
        record_count = len(value) if isinstance(value, (list, dict)) else 1
        parser = "JSON 结构展平器"
    elif extension in {"html", "htm", "xml"}:
        text = _strip_html(_decode_text(data))
        parser = "安全 HTML/XML 文本提取器"
    elif extension == "rtf":
        source = _decode_text(data)
        text = _normalize(re.sub(r"[{}]", " ", re.sub(r"\\[a-z]+-?\d* ?|\\'[0-9a-fA-F]{2}", " ", source)).replace("\\par", "\n"))
        parser = "安全 RTF 文本提取器"
        warnings.append("仅提取纯文本，不保留版式")
    else:
        text = _normalize(_decode_text(data))
        parser = "安全文本解码器"
    if not text:
        raise ToolError("文件中没有提取到可检索文本")
    return {"text": text, "parser": parser, "pageCount": page_count, "recordCount": record_count, "warnings": warnings, "extension": extension}


def _new_document(workspace: dict[str, Any], name: str, mime_type: str, data: bytes, metadata: dict[str, Any] | None = None, existing: dict[str, Any] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    parsed = _parse_document(name, mime_type, data)
    now = _now()
    meta = metadata or {}
    document_id = existing["id"] if existing else _uid("doc")
    version = int(existing.get("version", 0)) + 1 if existing else 1
    document = {
        **(deepcopy(existing) if existing else {}), "id": document_id, "workspaceId": workspace["id"],
        "name": str(meta.get("name") or name), "originalName": name, "mimeType": mime_type or "application/octet-stream",
        "extension": parsed["extension"], "size": len(data), "hash": hashlib.sha256(data).hexdigest(), "status": "ready",
        "error": "", "parser": parsed["parser"], "pageCount": parsed["pageCount"], "recordCount": parsed["recordCount"],
        "textLength": len(parsed["text"]), "keywords": _keywords(parsed["text"], 15), "language": "中文/多语言" if re.search(r"[\u3400-\u9fff]", parsed["text"][:3000]) else "英文/其他",
        "warnings": parsed["warnings"], "tags": list(meta.get("tags") or existing.get("tags", []) if existing else meta.get("tags") or []),
        "category": str(meta.get("category") or (existing or {}).get("category") or "研究资料"),
        "source": str(meta.get("source") or (existing or {}).get("source") or "本地上传"),
        "license": str(meta.get("license") or (existing or {}).get("license") or "当前工作区内部使用"),
        "authors": str(meta.get("authors") or (existing or {}).get("authors") or ""), "year": str(meta.get("year") or (existing or {}).get("year") or ""),
        "createdAt": (existing or {}).get("createdAt", now), "updatedAt": now, "version": version,
        "contentBase64": base64.b64encode(data).decode("ascii"), "extractedText": parsed["text"],
    }
    return document, _chunk_text(parsed["text"], document, workspace["settings"])


def _sample_workspace() -> dict[str, Any]:
    now = "2026-09-09T00:00:00Z"
    workspace = {
        "id": "kb-research-evidence", "name": "地球科学研究知识库", "description": "多源监测、成像、工程判断与成果转化资料。",
        "version": 7, "createdAt": now, "updatedAt": now,
        "settings": {"chunkSize": 420, "chunkOverlap": 60, "bm25Weight": 0.72, "threshold": 0.08, "topK": 8, "maxAnswerSentences": 5},
        "savedQueries": [{"id": "query-1", "query": "哪些证据支持边坡风险升高", "documentId": "all", "tag": "边坡", "createdAt": now}],
        "ingestionHistory": [
            {"id": "activity-1", "name": "边坡多源监测记录.md", "message": "解析、分块和索引完成", "status": "success", "createdAt": now},
            {"id": "activity-2", "name": "台站环境噪声成像说明.txt", "message": "解析、分块和索引完成", "status": "success", "createdAt": now},
        ],
        "benchmarks": [
            {"id": "benchmark-1", "query": "哪些证据说明边坡风险升高", "expectedDocumentId": "doc-slope", "createdAt": now},
            {"id": "benchmark-2", "query": "背景噪声成像的有效频散点有多少", "expectedDocumentId": "doc-imaging", "createdAt": now},
            {"id": "benchmark-3", "query": "技术成果转化前需要核查什么", "expectedDocumentId": "doc-transfer", "createdAt": now},
        ],
    }
    sources = [
        ("doc-slope", "边坡多源监测记录.md", "text/markdown", "# 边坡风险证据\n遥感影像显示坡脚区域出现新增形变，形变范围较上期扩大。位移传感器连续三日记录到加速趋势。同期降雨量超过历史九十分位阈值，现场复核发现坡脚排水不畅。上述信号共同支持风险升高，但最终判断仍需现场工程师复核。", ["边坡", "监测", "风险"], "监测记录"),
        ("doc-imaging", "台站环境噪声成像说明.txt", "text/plain", "面波背景噪声成像采用九个有效台站和十八对台站组合。预处理包括去均值、去趋势、频带滤波和谱白化。系统获得九十六个有效频散点，并在四秒到十五秒周期范围进行层析反演。棋盘恢复用于检查路径覆盖和空间分辨率。", ["面波", "成像", "台站"], "方法说明"),
        ("doc-transfer", "成果转化核查清单.json", "application/json", json.dumps({"主题": "技术成果转化", "核查": ["权利要求支持", "现有技术与自由实施风险", "技术成熟度证据", "许可现金流假设", "法律状态与期限复核"], "结论": "发布前需要技术、法律和商业三类人工审批"}, ensure_ascii=False), ["专利", "转化", "核查"], "核查清单"),
        ("doc-stations", "台站质量观测.csv", "text/csv", "台站,可用率,采样率,质量状态\nSV01,99.2%,100 Hz,通过\nSV02,97.2%,100 Hz,通过\nSV03,95.2%,100 Hz,关注\n", ["台站", "质量", "观测"], "数据表"),
    ]
    documents: list[dict[str, Any]] = []
    chunks: list[dict[str, Any]] = []
    for document_id, name, mime_type, content, tags, category in sources:
        document, items = _new_document(workspace, name, mime_type, content.encode("utf-8"), {"tags": tags, "category": category, "source": "确定性合成基准"})
        document["id"] = document_id
        document["createdAt"] = now
        document["updatedAt"] = now
        for index, item in enumerate(items):
            item["id"] = f"chunk-{document_id}-{index + 1}"
            item["documentId"] = document_id
            item["updatedAt"] = now
        documents.append(document)
        chunks.extend(items)
    return {"workspace": workspace, "documents": documents, "chunks": chunks, "conversations": [], "revisions": []}


def _answer_markdown(answer: dict[str, Any]) -> str:
    citations = "\n\n".join(f"[{item['index']}] {item['documentName']} · {item['heading']} · {item['sourceLocation']}\n\n> {item['excerpt']}" for item in answer.get("citations", []))
    return f"# {answer.get('query', '知识库问答')}\n\n{answer.get('answer', '')}\n\n## 引用\n\n{citations}\n"


def _backup(bundle: dict[str, Any]) -> tuple[bytes, dict[str, str]]:
    serializable = deepcopy(bundle)
    files: dict[str, bytes] = {}
    for document in serializable["documents"]:
        encoded = document.pop("contentBase64", "")
        if encoded:
            safe_name = re.sub(r"[\\/:*?\"<>|]", "-", document["originalName"])
            path = f"files/{document['id']}/{safe_name}"
            files[path] = base64.b64decode(encoded)
            document["backupFilePath"] = path
    manifest = json.dumps({"schema": "skyview-personal-knowledge-database", "schemaVersion": 2, "exportedAt": _now(), **serializable}, ensure_ascii=False, indent=2).encode("utf-8")
    files["knowledge-base.json"] = manifest
    checksums = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        archive.writestr("checksums.json", json.dumps({"algorithm": "SHA-256", "generatedAt": _now(), "files": checksums}, ensure_ascii=False, indent=2))
        archive.writestr("README.txt", "SkyViewLab 个人知识数据库备份\n导入时重新绑定当前工作区，上传内容不会被执行。\n")
    return stream.getvalue(), checksums


def _exports(bundle: dict[str, Any], answer: dict[str, Any], graph: dict[str, Any], quality: dict[str, Any], evaluation: dict[str, Any]) -> dict[str, Any]:
    package, checksums = _backup(bundle)
    document_stream = io.StringIO()
    writer = csv.writer(document_stream)
    writer.writerow(["文档ID", "名称", "类型", "版本", "状态", "字符数", "分块数", "SHA-256", "标签"])
    counts = Counter(item["documentId"] for item in bundle["chunks"])
    for document in bundle["documents"]:
        writer.writerow([document["id"], document["name"], document["extension"], document["version"], document["status"], document["textLength"], counts[document["id"]], document["hash"], "|".join(document["tags"])])
    return {
        "answerMarkdown": _answer_markdown(answer), "documentsCsv": document_stream.getvalue(),
        "chunksJson": json.dumps({"schema": "skyview-knowledge-chunks", "version": 2, "chunks": bundle["chunks"]}, ensure_ascii=False, indent=2),
        "graphJson": json.dumps({"schema": "skyview-knowledge-concept-graph", "version": 2, **graph}, ensure_ascii=False, indent=2),
        "qualityJson": json.dumps({"schema": "skyview-knowledge-quality", "version": 2, "quality": quality, "evaluation": evaluation}, ensure_ascii=False, indent=2),
        "manifestJson": json.dumps({"schema": "skyview-personal-knowledge-database", "schemaVersion": 2, "workspace": bundle["workspace"], "documents": len(bundle["documents"]), "chunks": len(bundle["chunks"]), "checksums": checksums}, ensure_ascii=False, indent=2),
        "backupBase64": base64.b64encode(package).decode("ascii"), "backupBytes": len(package),
    }


def _result(bundle: dict[str, Any], stage: str, query: str = "哪些证据支持边坡风险升高", document_id: str = "all", tag: str = "") -> dict[str, Any]:
    workspace = bundle["workspace"]
    results = _search(bundle["chunks"], query, workspace["settings"], document_id=document_id, tag=tag, documents=bundle["documents"])
    answer = _answer(query, results, workspace["settings"])
    answer.update({"id": _uid("qa"), "query": query, "createdAt": _now(), "retrieval": {"settings": deepcopy(workspace["settings"]), "resultCount": len(results)}})
    graph = _concepts(bundle["chunks"])
    quality = _quality(bundle["documents"], bundle["chunks"])
    evaluation = _evaluate(workspace, bundle["documents"], bundle["chunks"])
    total_size = sum(document["size"] for document in bundle["documents"])
    output_bundle = deepcopy(bundle)
    return {
        "schema": SCHEMA, "version": 2, "stage": stage, "bundle": output_bundle,
        "search": {"query": query, "documentId": document_id, "tag": tag, "results": results, "executedAt": _now()},
        "answer": answer, "graph": graph, "quality": quality, "evaluation": evaluation,
        "storage": {"originalBytes": total_size, "documents": len(bundle["documents"]), "chunks": len(bundle["chunks"]), "persistence": "Go 项目状态与不可变版本"},
        "runtime": {
            "compute": "Python 确定性混合检索", "orchestration": "Go 项目、作业、版本与审计",
            "embedding": "192 维可解释字符哈希特征", "externalAi": False, "uploadedCodeExecution": False,
            "databaseAclPushdown": False, "objectStorageConfigured": False, "ocrConfigured": False,
            "supportedExtensions": sorted(SUPPORTED_EXTENSIONS), "singleFileLimitBytes": 30 * 1024 * 1024,
        },
        "exports": _exports(output_bundle, answer, graph, quality, evaluation),
    }


def _input_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("bundle")
    if isinstance(value, dict) and isinstance(value.get("workspace"), dict) and isinstance(value.get("documents"), list) and isinstance(value.get("chunks"), list):
        return deepcopy(value)
    return _sample_workspace()


def _import_backup(encoded: str) -> dict[str, Any]:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ToolError("备份不是有效 Base64") from exc
    if len(raw) > 35 * 1024 * 1024:
        raise ToolError("备份超过 35 MB 安全导入上限")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ToolError("备份不是有效 ZIP") from exc
    if len(archive.infolist()) > 600:
        raise ToolError("备份文件数量超过安全上限")
    for item in archive.infolist():
        normalized = item.filename.replace("\\", "/")
        if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized) or ".." in normalized.split("/"):
            raise ToolError("备份包含不安全路径")
        if item.file_size > 30 * 1024 * 1024 or (item.compress_size and item.file_size / item.compress_size > 200):
            raise ToolError("备份条目超过安全解压限制")
    try:
        payload = json.loads(archive.read("knowledge-base.json"))
        checksums = json.loads(archive.read("checksums.json"))["files"]
    except (KeyError, json.JSONDecodeError) as exc:
        raise ToolError("备份缺少有效清单或校验和") from exc
    if payload.get("schema") != "skyview-personal-knowledge-database" or not isinstance(payload.get("documents"), list) or not isinstance(payload.get("chunks"), list):
        raise ToolError("不是有效的知识数据库备份")
    for path, expected in checksums.items():
        try:
            actual = hashlib.sha256(archive.read(path)).hexdigest()
        except KeyError as exc:
            raise ToolError(f"备份缺少文件：{path}") from exc
        if actual != expected:
            raise ToolError(f"备份校验失败：{path}")
    workspace = payload["workspace"]
    old_workspace_id = workspace.get("id", "")
    workspace["id"] = _uid("kb")
    workspace["name"] = f"{workspace.get('name', '导入知识库')}（导入）"
    workspace["version"] = 1
    workspace["createdAt"] = _now()
    workspace["updatedAt"] = _now()
    document_map: dict[str, str] = {}
    chunk_map: dict[str, str] = {}
    for document in payload["documents"]:
        old_id = document["id"]
        document["id"] = _uid("doc")
        document_map[old_id] = document["id"]
        document["workspaceId"] = workspace["id"]
        path = document.pop("backupFilePath", "")
        document["contentBase64"] = base64.b64encode(archive.read(path)).decode("ascii") if path else ""
    for chunk in payload["chunks"]:
        old_id = chunk["id"]
        chunk["id"] = _uid("chunk")
        chunk_map[old_id] = chunk["id"]
        chunk["workspaceId"] = workspace["id"]
        chunk["documentId"] = document_map.get(chunk["documentId"], "")
    for conversation in payload.get("conversations", []):
        conversation["id"] = _uid("qa")
        for citation in conversation.get("citations", []):
            citation["documentId"] = document_map.get(citation.get("documentId", ""), "")
            citation["chunkId"] = chunk_map.get(citation.get("chunkId", ""), "")
    return {"workspace": workspace, "documents": payload["documents"], "chunks": payload["chunks"], "conversations": payload.get("conversations", []), "revisions": payload.get("revisions", [])}


def run_knowledge_system(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "index":
        material = _normalize(payload.get("material"))
        if not material:
            raise ToolError("material 不能为空")
        document = {"id": "doc-material", "workspaceId": "legacy", "name": "研究材料", "version": 1, "updatedAt": _now()}
        chunks = _chunk_text(material, document, {"chunkSize": 900, "chunkOverlap": 120})
        return {"chunks": len(chunks), "characters": len(material), "topTerms": [{"term": term, "count": count} for term, count in Counter(_tokens(material)).most_common(12)]}
    if action == "query" and "material" in payload:
        material = _normalize(payload.get("material"))
        query = _normalize(payload.get("query"))
        if not material or not query:
            raise ToolError("material 和 query 不能为空")
        document = {"id": "doc-material", "workspaceId": "legacy", "name": "研究材料", "version": 1, "updatedAt": _now()}
        chunks = _chunk_text(material, document, {"chunkSize": 900, "chunkOverlap": 120})
        results = _search(chunks, query, {"bm25Weight": 0.72, "threshold": 0, "topK": 5})
        return {"answer": "\n".join(f"[{item['id']}] {item['text']}" for item in results) or "没有找到足够相关的材料。", "citations": results, "evidenceCount": len(results)}
    if action in {"load-sample", "run-all"}:
        return _result(_sample_workspace(), action)
    if action == "import-backup":
        encoded = str(payload.get("backupBase64") or "")
        if not encoded:
            raise ToolError("backupBase64 不能为空")
        return _result(_import_backup(encoded), action)
    bundle = _input_bundle(payload)
    if action in {"search", "ask"}:
        query = _normalize(payload.get("query"))
        if not query:
            raise ToolError("query 不能为空")
        document_id = str(payload.get("documentId") or "all")
        tag = str(payload.get("tag") or "")
        result = _result(bundle, action, query, document_id, tag)
        if action == "ask":
            conversation = deepcopy(result["answer"])
            bundle["conversations"].insert(0, conversation)
            result = _result(bundle, action, query, document_id, tag)
            result["answer"] = conversation
            result["exports"] = _exports(bundle, conversation, result["graph"], result["quality"], result["evaluation"])
        return result
    if action in {"ingest-file", "ingest-text"}:
        if action == "ingest-text":
            name = str(payload.get("name") or "新建研究笔记.md")
            data = _normalize(payload.get("text")).encode("utf-8")
            mime_type = "text/markdown"
        else:
            file_value = payload.get("file")
            if not isinstance(file_value, dict):
                raise ToolError("file 必须是文件对象")
            name = str(file_value.get("name") or "")
            mime_type = str(file_value.get("mimeType") or "application/octet-stream")
            try:
                data = base64.b64decode(str(file_value.get("base64") or ""), validate=True)
            except (ValueError, TypeError) as exc:
                raise ToolError("文件内容不是有效 Base64") from exc
        if not name or not data:
            raise ToolError("文件名和内容不能为空")
        digest = hashlib.sha256(data).hexdigest()
        if any(document.get("hash") == digest for document in bundle["documents"]):
            raise ToolError("相同 SHA-256 文件已经入库")
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        document, chunks = _new_document(bundle["workspace"], name, mime_type, data, metadata)
        bundle["documents"].insert(0, document)
        bundle["chunks"] = chunks + bundle["chunks"]
        bundle["workspace"]["version"] += 1
        bundle["workspace"]["updatedAt"] = _now()
        bundle["workspace"]["ingestionHistory"].insert(0, {"id": _uid("activity"), "name": document["name"], "message": f"安全解析并建立 {len(chunks)} 个分块", "status": "success", "createdAt": _now()})
        return _result(bundle, action)
    if action == "update-chunk":
        chunk_id = str(payload.get("chunkId") or "")
        chunk = next((item for item in bundle["chunks"] if item["id"] == chunk_id), None)
        if chunk is None:
            raise ToolError("分块不存在")
        text = _normalize(payload.get("text"))
        if not text:
            raise ToolError("分块内容不能为空")
        before = deepcopy(chunk)
        chunk.update({"text": text, "charCount": len(text), "tokenCount": len(_tokens(text)), "keywords": _keywords(text, 10), "updatedAt": _now()})
        document = next(item for item in bundle["documents"] if item["id"] == chunk["documentId"])
        from_version = document["version"]
        document["version"] += 1
        document["updatedAt"] = _now()
        chunk["version"] = document["version"]
        bundle["revisions"].insert(0, {"id": _uid("revision"), "type": "chunk-edit", "documentId": document["id"], "documentName": document["name"], "note": "人工修改知识分块", "before": before, "fromVersion": from_version, "toVersion": document["version"], "createdAt": _now()})
        return _result(bundle, action)
    if action == "reindex-document":
        document_id = str(payload.get("documentId") or "")
        document = next((item for item in bundle["documents"] if item["id"] == document_id), None)
        if document is None:
            raise ToolError("文档不存在")
        old_chunks = [item for item in bundle["chunks"] if item["documentId"] == document_id]
        from_version = document["version"]
        document["version"] += 1
        document["updatedAt"] = _now()
        chunks = _chunk_text(document["extractedText"], document, bundle["workspace"]["settings"])
        bundle["chunks"] = [item for item in bundle["chunks"] if item["documentId"] != document_id] + chunks
        bundle["revisions"].insert(0, {"id": _uid("revision"), "type": "reindex", "documentId": document_id, "documentName": document["name"], "note": f"重建索引：{len(old_chunks)} 块 → {len(chunks)} 块", "fromVersion": from_version, "toVersion": document["version"], "createdAt": _now()})
        return _result(bundle, action)
    if action == "delete-document":
        document_id = str(payload.get("documentId") or "")
        if not any(item["id"] == document_id for item in bundle["documents"]):
            raise ToolError("文档不存在")
        bundle["documents"] = [item for item in bundle["documents"] if item["id"] != document_id]
        bundle["chunks"] = [item for item in bundle["chunks"] if item["documentId"] != document_id]
        bundle["conversations"] = [item for item in bundle["conversations"] if not any(citation.get("documentId") == document_id for citation in item.get("citations", []))]
        bundle["workspace"]["benchmarks"] = [item for item in bundle["workspace"].get("benchmarks", []) if item["expectedDocumentId"] != document_id]
        return _result(bundle, action)
    if action in {"evaluate", "concept-map", "export"}:
        return _result(bundle, action, _normalize(payload.get("query")) or "哪些证据支持边坡风险升高")
    raise ToolError("不支持的知识系统操作")
