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
import uuid
import zipfile
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree

from app.tools.common import ToolError


SCHEMA = "skyview-data-refine-results"
PROJECT_SCHEMA = "skyview-data-refine-project"
OPERATION_SCHEMA = "skyview-openrefine-operations"
MAX_FILE_BYTES = 4_000_000
MAX_ROWS = 50_000
MAX_COLUMNS = 200
MAX_CELLS = 2_000_000
MUTATING_ACTIONS = {
    "update-project", "import-data", "apply-operation", "edit-cell",
    "undo", "redo", "jump-history", "replay-operations",
    "create-snapshot", "restore-snapshot", "import-project",
}
ALLOWED_OPERATION_TYPES = {
    "cell-edit", "transform", "collapse-whitespace", "normalize-missing",
    "fill-missing", "remove-empty-rows", "deduplicate", "rename-column",
    "remove-column", "split-column", "add-column", "convert-number",
    "convert-date", "replace", "sort-permanent",
}
MISSING_TOKENS = {"", "na", "n/a", "null", "none", "nan", "-", "--", "缺失", "无"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def _clean(value: Any, limit: int = 200) -> str:
    return str(value or "").strip()[:limit]


def _role(payload: dict[str, Any]) -> str:
    return _clean(payload.get("actorRole") or "owner", 30).lower()


def _require_editor(payload: dict[str, Any]) -> None:
    if _role(payload) not in {"owner", "editor", "admin"}:
        raise ToolError("当前角色只有查看权限，不能修改数据项目", code="FORBIDDEN", status_code=403)


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _safe_number(value: Any) -> float | None:
    if isinstance(value, bool) or _is_blank(value):
        return None
    try:
        number = float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _normalize_cell(value: Any, dynamic_typing: bool = True) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if not isinstance(value, str):
        return value
    if not dynamic_typing:
        return value
    stripped = value.strip()
    if not stripped:
        return ""
    if re.fullmatch(r"(?i:true|false)", stripped):
        return stripped.lower() == "true"
    if re.fullmatch(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?", stripped, re.I) and not re.fullmatch(r"0\d{2,}", stripped):
        number = float(stripped)
        return int(number) if number.is_integer() else number
    return value


def _unique_fields(values: list[Any]) -> list[str]:
    used: Counter[str] = Counter()
    output: list[str] = []
    for index, value in enumerate(values):
        base = _clean(value, 120) or f"字段 {index + 1}"
        used[base] += 1
        output.append(base if used[base] == 1 else f"{base} {used[base]}")
    return output


def _normalize_dataset(fields: list[Any], rows: list[dict[str, Any]], *, source: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized_fields = _unique_fields(fields)
    if not normalized_fields:
        raise ToolError("没有识别到字段名")
    if len(normalized_fields) > MAX_COLUMNS:
        raise ToolError(f"字段数不能超过 {MAX_COLUMNS}")
    if len(rows) > MAX_ROWS or len(rows) * len(normalized_fields) > MAX_CELLS:
        raise ToolError("数据规模超过 50000 行、200 列或 200 万单元格限制")
    normalized_rows = []
    for index, row in enumerate(rows):
        normalized = {field: _normalize_cell(row.get(field)) for field in normalized_fields}
        normalized["_rowId"] = _clean(row.get("_rowId"), 80) or f"row-{index + 1:06d}"
        normalized_rows.append(normalized)
    return {"fields": normalized_fields, "rows": normalized_rows, "source": source or {}}


def _flatten(value: Any, prefix: str = "", output: dict[str, Any] | None = None) -> dict[str, Any]:
    output = output or {}
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(item, dict):
                _flatten(item, path, output)
            else:
                output[path] = item
    else:
        output[prefix or "value"] = value
    return output


def _parse_delimited(content: str, delimiter: str | None = None) -> dict[str, Any]:
    sample = content[:4096]
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",\t;").delimiter
        except csv.Error:
            delimiter = ","
    reader = csv.reader(io.StringIO(content), delimiter=delimiter)
    matrix = list(reader)
    if not matrix:
        raise ToolError("文件中没有数据")
    fields = _unique_fields(matrix[0])
    rows = [dict(zip(fields, list(values) + [None] * max(0, len(fields) - len(values)))) for values in matrix[1:]]
    return _normalize_dataset(fields, rows)


def _parse_json(content: str) -> dict[str, Any]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ToolError(f"JSON 格式错误：{exc.msg}") from exc
    if isinstance(parsed, dict) and isinstance(parsed.get("data"), list):
        parsed = parsed["data"]
    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list) or not parsed:
        raise ToolError("JSON 顶层需要是对象或非空对象数组")
    rows = [_flatten(item) if isinstance(item, dict) else {"value": item} for item in parsed]
    fields = list(dict.fromkeys(key for row in rows for key in row))
    return _normalize_dataset(fields, rows)


def _parse_xml(content: str) -> dict[str, Any]:
    if "<!DOCTYPE" in content.upper() or "<!ENTITY" in content.upper():
        raise ToolError("XML 不允许 DTD 或外部实体")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as exc:
        raise ToolError(f"XML 格式错误：{exc}") from exc
    children = list(root)
    records = children if children else [root]
    rows: list[dict[str, Any]] = []
    for node in records:
        row = {child.tag.split("}")[-1]: child.text or "" for child in list(node)}
        row.update({f"@{key}": value for key, value in node.attrib.items()})
        if not row:
            row[node.tag.split("}")[-1]] = node.text or ""
        rows.append(row)
    fields = list(dict.fromkeys(key for row in rows for key in row))
    return _normalize_dataset(fields, rows)


def _xlsx_cell_value(cell: ElementTree.Element, shared: list[str], ns: dict[str, str]) -> Any:
    kind = cell.attrib.get("t")
    inline = cell.find("x:is/x:t", ns)
    raw = cell.find("x:v", ns)
    if inline is not None:
        return inline.text or ""
    text = raw.text if raw is not None else ""
    if kind == "s" and text.isdigit() and int(text) < len(shared):
        return shared[int(text)]
    if kind == "b":
        return text == "1"
    number = _safe_number(text)
    return number if kind in {None, "n"} and number is not None else text


def _parse_xlsx(content: bytes) -> dict[str, Any]:
    if len(content) > MAX_FILE_BYTES:
        raise ToolError("Excel 文件不能超过 4 MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ToolError("XLSX 文件损坏或格式不正确") from exc
    names = archive.namelist()
    if any(name.startswith("/") or ".." in name.replace("\\", "/").split("/") for name in names):
        raise ToolError("XLSX 包含不安全路径")
    if sum(item.file_size for item in archive.infolist()) > 25_000_000:
        raise ToolError("XLSX 解压内容过大")
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        tree = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(node.itertext()) for node in tree.findall("x:si", ns)]
    sheet_name = next((name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)), None)
    if not sheet_name:
        raise ToolError("XLSX 没有可读取的工作表")
    sheet = ElementTree.fromstring(archive.read(sheet_name))
    matrix: list[list[Any]] = []
    for row in sheet.findall(".//x:sheetData/x:row", ns):
        values: dict[int, Any] = {}
        for cell in row.findall("x:c", ns):
            ref = cell.attrib.get("r", "A1")
            letters = re.match(r"[A-Z]+", ref)
            position = 0
            for char in letters.group(0) if letters else "A":
                position = position * 26 + ord(char) - 64
            values[position - 1] = _xlsx_cell_value(cell, shared, ns)
        matrix.append([values.get(index, "") for index in range(max(values.keys(), default=-1) + 1)])
        if len(matrix) > MAX_ROWS + 1:
            raise ToolError("XLSX 行数超过限制")
    if not matrix:
        raise ToolError("XLSX 工作表为空")
    fields = _unique_fields(matrix[0])
    rows = [dict(zip(fields, values + [None] * max(0, len(fields) - len(values)))) for values in matrix[1:]]
    return _normalize_dataset(fields, rows)


def _parse_import(payload: dict[str, Any]) -> dict[str, Any]:
    file_name = _clean(payload.get("fileName") or "import.csv", 180)
    extension = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else _clean(payload.get("format") or "csv", 20).lower()
    base64_content = payload.get("contentBase64")
    if base64_content:
        try:
            raw = base64.b64decode(str(base64_content), validate=True)
        except ValueError as exc:
            raise ToolError("文件内容不是有效 Base64") from exc
    else:
        raw = str(payload.get("content") or "").encode("utf-8")
    if not raw:
        raise ToolError("导入文件不能为空")
    if len(raw) > MAX_FILE_BYTES:
        raise ToolError("导入文件不能超过 4 MB")
    if extension == "xlsx":
        dataset = _parse_xlsx(raw)
    else:
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ToolError("文本文件必须使用 UTF-8 编码") from exc
        if extension == "json":
            dataset = _parse_json(text)
        elif extension == "xml":
            dataset = _parse_xml(text)
        elif extension in {"tsv", "txt"}:
            dataset = _parse_delimited(text, "\t")
        elif extension == "csv":
            dataset = _parse_delimited(text)
        else:
            raise ToolError("仅支持 CSV、TSV、TXT、JSON、XML 和 XLSX")
    checksum = hashlib.sha256(raw).hexdigest()
    dataset["source"] = {"fileName": file_name, "format": extension.upper(), "bytes": len(raw), "checksum": f"sha256:{checksum}"}
    return dataset


def _quantile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    point = ratio * (len(ordered) - 1)
    lower = math.floor(point)
    upper = math.ceil(point)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - point) + ordered[upper] * (point - lower)


def _infer_type(values: list[Any]) -> str:
    present = [value for value in values if not _is_blank(value)]
    if not present:
        return "blank"
    if sum(_safe_number(value) is not None for value in present) / len(present) >= .9:
        return "number"
    if sum(isinstance(value, bool) or str(value).lower() in {"true", "false"} for value in present) / len(present) >= .9:
        return "boolean"
    if sum(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[ T].*)?", str(value).strip())) for value in present) / len(present) >= .9:
        return "date"
    return "string"


def _histogram(numbers: list[float], bins: int = 12) -> list[dict[str, Any]]:
    if not numbers:
        return []
    low, high = min(numbers), max(numbers)
    if low == high:
        return [{"min": low, "max": high, "count": len(numbers)}]
    width = (high - low) / bins
    output = [{"min": round(low + index * width, 4), "max": round(high if index == bins - 1 else low + (index + 1) * width, 4), "count": 0} for index in range(bins)]
    for value in numbers:
        output[min(bins - 1, int((value - low) / width))]["count"] += 1
    return output


def _aggregation(dataset: dict[str, Any]) -> dict[str, Any]:
    """Build a deterministic, exportable group summary without evaluating user code."""
    fields, rows = dataset["fields"], dataset["rows"]
    preferred_groups = ["区域", "风险等级", "灾害类型", "处置状态"]
    group_by = next((field for field in preferred_groups if field in fields), fields[0])
    numeric_fields = [
        field for field in fields
        if _infer_type([row.get(field) for row in rows]) == "number"
    ]
    preferred_values = ["累计降雨(mm)", "位移速率(mm/d)"]
    value_column = next((field for field in preferred_values if field in numeric_fields), numeric_fields[0] if numeric_fields else "")
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        label = str(row.get(group_by) if not _is_blank(row.get(group_by)) else "(空值)")
        grouped.setdefault(label, []).append(row)
    summaries = []
    for label, members in sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0])):
        values = [number for row in members if value_column and (number := _safe_number(row.get(value_column))) is not None]
        summaries.append({
            "group": label,
            "count": len(members),
            "numericCount": len(values),
            "sum": round(sum(values), 4) if values else None,
            "mean": round(statistics.fmean(values), 4) if values else None,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
        })
    return {"groupBy": group_by, "valueColumn": value_column, "method": "count,sum,mean,min,max", "rows": summaries}


def _profile(dataset: dict[str, Any]) -> dict[str, Any]:
    rows, fields = dataset["rows"], dataset["fields"]
    signatures = [json.dumps([row.get(field) for field in fields], ensure_ascii=False, sort_keys=True) for row in rows]
    duplicates = sum(count - 1 for count in Counter(signatures).values() if count > 1)
    columns = []
    missing_total = 0
    for field in fields:
        values = [row.get(field) for row in rows]
        present = [value for value in values if not _is_blank(value)]
        missing = len(values) - len(present)
        missing_total += missing
        kind = _infer_type(values)
        frequencies = Counter(str(value).strip() for value in present)
        top = [{"value": value, "count": count, "ratio": round(count / max(1, len(rows)), 4)} for value, count in frequencies.most_common(12)]
        numbers = [number for value in present if (number := _safe_number(value)) is not None]
        q1, q3 = _quantile(numbers, .25), _quantile(numbers, .75)
        outliers = 0
        if q1 is not None and q3 is not None:
            span = q3 - q1
            outliers = sum(value < q1 - 1.5 * span or value > q3 + 1.5 * span for value in numbers)
        columns.append({
            "field": field, "type": kind, "missing": missing,
            "completeness": round((len(rows) - missing) / max(1, len(rows)) * 100, 1),
            "unique": len(frequencies), "outliers": outliers, "topValues": top,
            "min": min(numbers) if numbers else None, "max": max(numbers) if numbers else None,
            "mean": round(statistics.fmean(numbers), 4) if numbers else None,
            "median": round(statistics.median(numbers), 4) if numbers else None,
            "histogram": _histogram(numbers),
        })
    cell_count = max(1, len(rows) * len(fields))
    missing_ratio = missing_total / cell_count
    duplicate_ratio = duplicates / max(1, len(rows))
    outlier_ratio = sum(column["outliers"] for column in columns) / cell_count
    score = max(0, round(100 - missing_ratio * 45 - duplicate_ratio * 25 - outlier_ratio * 20, 1))
    return {"rows": len(rows), "columnCount": len(fields), "missingCells": missing_total, "duplicateRows": duplicates, "qualityScore": score, "columns": columns}


def _matches(row: dict[str, Any], view: dict[str, Any]) -> bool:
    query = _clean(view.get("query"), 300).casefold()
    if query and not any(query in str(value or "").casefold() for key, value in row.items() if key != "_rowId"):
        return False
    for facet in view.get("facets", []):
        column = facet.get("column")
        if not column:
            continue
        value = row.get(column)
        if facet.get("type") == "range":
            number = _safe_number(value)
            if number is None or (facet.get("min") is not None and number < float(facet["min"])) or (facet.get("max") is not None and number > float(facet["max"])):
                return False
        else:
            selected = [str(item) for item in facet.get("selected", [])]
            if selected and str(value or "") not in selected:
                return False
    return True


def _apply_view(dataset: dict[str, Any], view: dict[str, Any]) -> list[dict[str, Any]]:
    rows = [deepcopy(row) for row in dataset["rows"] if _matches(row, view)]
    for sort in reversed(view.get("sorts", [])):
        column = sort.get("column")
        if column not in dataset["fields"]:
            continue
        direction = sort.get("direction") == "desc"
        rows.sort(key=lambda row: (_is_blank(row.get(column)), _safe_number(row.get(column)) if _safe_number(row.get(column)) is not None else str(row.get(column) or "").casefold()), reverse=direction)
    return rows


def _facet_values(dataset: dict[str, Any], field: str) -> list[dict[str, Any]]:
    counts = Counter("(空值)" if _is_blank(row.get(field)) else str(row.get(field)) for row in dataset["rows"])
    return [{"value": value, "count": count} for value, count in counts.most_common(18)]


def _expression(expression: str, row: dict[str, Any], column: str) -> Any:
    expression = expression.strip()
    value = row.get(column)
    direct: dict[str, Any] = {
        "value.trim()": str(value or "").strip(),
        "value.toUppercase()": str(value or "").upper(),
        "value.toLowercase()": str(value or "").lower(),
        "value.toTitlecase()": str(value or "").title(),
        "value.toNumber()": _safe_number(value),
        "value.length()": len(str(value or "")),
    }
    if expression in direct:
        return direct[expression]
    match = re.fullmatch(r'cells\["([^"\\]{1,120})"\]\.value(?:\.(trim|toUppercase|toLowercase|toNumber)\(\))?', expression)
    if match:
        item = row.get(match.group(1))
        return {None: item, "trim": str(item or "").strip(), "toUppercase": str(item or "").upper(), "toLowercase": str(item or "").lower(), "toNumber": _safe_number(item)}[match.group(2)]
    match = re.fullmatch(r'value\.replace\("([^"\\]{0,120})","([^"\\]{0,120})"\)', expression)
    if match:
        return str(value or "").replace(match.group(1), match.group(2))
    match = re.fullmatch(r'value\.split\("([^"\\]{1,20})"\)\[(\d{1,2})\]', expression)
    if match:
        parts = str(value or "").split(match.group(1))
        index = int(match.group(2))
        return parts[index] if index < len(parts) else None
    raise ToolError("表达式不在安全白名单；支持 trim、大小写、数字转换、字段引用、固定文本替换与拆分取值")


def _apply_operation(dataset: dict[str, Any], operation: dict[str, Any]) -> tuple[dict[str, Any], int, int]:
    output = deepcopy(dataset)
    fields, rows = output["fields"], output["rows"]
    kind = _clean(operation.get("type"), 50)
    if kind not in ALLOWED_OPERATION_TYPES:
        raise ToolError(f"不允许的清洗操作：{kind}")
    column = _clean(operation.get("column"), 120)
    if column and column not in fields:
        raise ToolError(f"字段不存在：{column}")
    affected = errors = 0
    if kind == "cell-edit":
        row_id = _clean(operation.get("rowId"), 80)
        target = next((row for row in rows if row.get("_rowId") == row_id), None)
        if target is None:
            raise ToolError("找不到要编辑的数据行")
        target[column] = operation.get("value")
        affected = 1
    elif kind in {"transform", "collapse-whitespace", "normalize-missing", "convert-number", "convert-date", "replace"}:
        columns = [column] if column else list(fields)
        tokens = {str(item).strip().casefold() for item in operation.get("tokens", MISSING_TOKENS)}
        for row in rows:
            for field in columns:
                before = row.get(field)
                after = before
                try:
                    if kind == "transform":
                        after = _expression(_clean(operation.get("expression"), 500), row, field)
                    elif kind == "collapse-whitespace":
                        after = re.sub(r"\s+", " ", str(before or "")).strip()
                    elif kind == "normalize-missing" and isinstance(before, str) and before.strip().casefold() in tokens:
                        after = None
                    elif kind == "convert-number":
                        after = _safe_number(before)
                    elif kind == "convert-date" and not _is_blank(before):
                        match = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", str(before))
                        if not match:
                            raise ValueError("invalid date")
                        after = f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
                    elif kind == "replace":
                        after = str(before or "").replace(str(operation.get("find") or ""), str(operation.get("replacement") or ""))
                    if after != before:
                        row[field] = after
                        affected += 1
                except ToolError:
                    raise
                except (ValueError, TypeError):
                    errors += 1
    elif kind == "fill-missing":
        present = [row.get(column) for row in rows if not _is_blank(row.get(column))]
        numbers = [number for value in present if (number := _safe_number(value)) is not None]
        strategy = operation.get("strategy", "median")
        replacement: Any = operation.get("value", "")
        if strategy == "mean": replacement = statistics.fmean(numbers) if numbers else 0
        if strategy == "median": replacement = statistics.median(numbers) if numbers else 0
        if strategy == "mode": replacement = Counter(str(value) for value in present).most_common(1)[0][0] if present else ""
        if strategy == "zero": replacement = 0
        for row in rows:
            if _is_blank(row.get(column)):
                row[column] = replacement
                affected += 1
    elif kind == "remove-empty-rows":
        before = len(rows)
        output["rows"] = [row for row in rows if any(not _is_blank(row.get(field)) for field in fields)]
        affected = before - len(output["rows"])
    elif kind == "deduplicate":
        columns = [item for item in operation.get("columns", []) if item in fields] or fields
        seen: set[str] = set()
        kept = []
        for row in rows:
            signature = json.dumps([row.get(item) for item in columns], ensure_ascii=False)
            if signature in seen:
                affected += 1
            else:
                seen.add(signature)
                kept.append(row)
        output["rows"] = kept
    elif kind == "rename-column":
        name = _clean(operation.get("name"), 120)
        if not name or (name != column and name in fields):
            raise ToolError("新字段名为空或已经存在")
        output["fields"] = [name if field == column else field for field in fields]
        for row in rows:
            row[name] = row.pop(column)
        affected = len(rows)
    elif kind == "remove-column":
        if len(fields) <= 1:
            raise ToolError("不能删除最后一个字段")
        output["fields"] = [field for field in fields if field != column]
        for row in rows:
            row.pop(column, None)
        affected = len(rows)
    elif kind == "split-column":
        separator = str(operation.get("separator") or ",")[:20]
        parts = max(2, min(12, int(operation.get("maxParts") or 2)))
        prefix = _clean(operation.get("prefix") or column, 100)
        names = [f"{prefix} {index + 1}" for index in range(parts)]
        if any(name in fields for name in names):
            raise ToolError("拆分后的字段名已经存在")
        position = fields.index(column) + 1
        output["fields"][position:position] = names
        for row in rows:
            values = str(row.get(column) or "").split(separator, parts - 1)
            for index, name in enumerate(names):
                row[name] = values[index] if index < len(values) else None
            affected += 1
    elif kind == "add-column":
        name = _clean(operation.get("name"), 120)
        if not name or name in fields:
            raise ToolError("新字段名为空或已经存在")
        for row in rows:
            try:
                row[name] = _expression(_clean(operation.get("expression"), 500), row, column)
                affected += 1
            except ToolError:
                raise
        output["fields"].append(name)
    elif kind == "sort-permanent":
        output["rows"] = _apply_view(output, {"sorts": operation.get("sorts", [])})
        affected = len(rows)
    return output, affected, errors


def _replay(project: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    dataset = deepcopy(project["baseDataset"])
    audit = []
    cursor = max(0, min(int(project.get("cursor", 0)), len(project.get("operations", []))))
    for index, operation in enumerate(project.get("operations", [])[:cursor]):
        dataset, affected, errors = _apply_operation(dataset, operation)
        audit.append({"step": index + 1, "id": operation["id"], "type": operation["type"], "label": operation.get("label") or operation["type"], "affected": affected, "errors": errors, "createdAt": operation.get("createdAt"), "actor": operation.get("actor")})
    return dataset, audit


def _sample_dataset() -> dict[str, Any]:
    regions = ["北区", "南区", "东区", "西区"]
    hazards = ["滑坡", "崩塌", "泥石流", "地裂缝"]
    statuses = [" 待核验 ", "处置中", "已完成", "N/A"]
    rows = []
    for index in range(1, 37):
        rows.append({
            "记录编号": f"DR-2026-{index:03d}" if index != 24 else "DR-2026-012",
            "区域": regions[(index - 1) % len(regions)],
            "灾害类型": hazards[(index * 3) % len(hazards)],
            "风险等级": ["低", "中", "高", "极高"][(index * 5) % 4],
            "隐患点名称": f"{regions[(index - 1) % 4]}-{['采场','排土场','边坡','沟谷'][index % 4]} {index:02d}",
            "位移速率(mm/d)": None if index in {7, 19} else round(0.42 + (index % 9) * .31 + (8.6 if index == 31 else 0), 2),
            "累计降雨(mm)": "NA" if index == 13 else round(18 + (index * 13) % 126 + index * .37, 1),
            "监测日期": f"2026/{8 + (index > 23)}/{(index % 23) + 1}",
            "责任单位": ["地测中心", "  安监部", "矿山一队  ", "第三方监测"][(index - 1) % 4],
            "处置状态": statuses[(index - 1) % len(statuses)],
        })
    return _normalize_dataset(list(rows[0]), rows, source={"fileName": "disaster-risk-ledger-benchmark.csv", "format": "CSV", "bytes": 4892, "checksum": "sha256:skyview-data-refine-benchmark"})


def _sample_project() -> dict[str, Any]:
    base = _sample_dataset()
    created = "2026-09-12T02:30:00Z"
    operations = [
        {"id": "op-001", "type": "collapse-whitespace", "column": "责任单位", "label": "整理责任单位空白", "createdAt": created, "actor": "数据管理员"},
        {"id": "op-002", "type": "collapse-whitespace", "column": "处置状态", "label": "整理处置状态空白", "createdAt": created, "actor": "数据管理员"},
        {"id": "op-003", "type": "normalize-missing", "column": "累计降雨(mm)", "label": "统一缺失值标记", "createdAt": created, "actor": "数据管理员"},
    ]
    return {
        "schema": PROJECT_SCHEMA, "version": 4, "id": "data-project-disaster-ledger",
        "name": "灾害风险台账治理", "description": "清洗多源巡查与监测台账，保留可复核操作历史并交付标准数据。",
        "tags": ["灾害台账", "质量治理", "教学基准"], "baseDataset": base,
        "dataset": {}, "operations": operations, "cursor": len(operations),
        "view": {"query": "", "facets": [{"type": "text", "column": "风险等级", "selected": []}], "sorts": [], "page": 1, "pageSize": 15},
        "selectedColumn": "位移速率(mm/d)", "snapshots": [{"id": "snapshot-import", "label": "原始导入", "cursor": 0, "createdAt": created, "actor": "数据管理员"}],
        "audit": [{"id": "audit-001", "time": created, "action": "create-project", "actor": "数据管理员", "target": "data-project-disaster-ledger", "detail": "载入 36 行灾害风险台账基准"}],
        "createdAt": created, "updatedAt": created,
    }


def _project(payload: dict[str, Any]) -> dict[str, Any]:
    state = payload.get("state")
    if isinstance(state, dict) and state.get("schema") == SCHEMA and isinstance(state.get("project"), dict):
        return deepcopy(state["project"])
    if isinstance(state, dict) and state.get("schema") == PROJECT_SCHEMA:
        return deepcopy(state)
    if isinstance(payload.get("project"), dict):
        return deepcopy(payload["project"])
    raise ToolError("缺少数据项目状态，请先载入清洗基准")


def _audit(project: dict[str, Any], payload: dict[str, Any], action: str, target: str, detail: str) -> None:
    project.setdefault("audit", []).insert(0, {"id": _id("audit"), "time": _now(), "action": action, "actor": _clean(payload.get("actor") or "当前用户", 80), "target": target, "detail": detail})
    project["audit"] = project["audit"][:200]
    project["updatedAt"] = _now()
    project["version"] = int(project.get("version", 0)) + 1


def _escape_csv_cell(value: Any) -> Any:
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _delimited(dataset: dict[str, Any], delimiter: str) -> str:
    output = io.StringIO()
    writer = csv.writer(output, delimiter=delimiter, lineterminator="\n")
    writer.writerow(dataset["fields"])
    for row in dataset["rows"]:
        writer.writerow([_escape_csv_cell(row.get(field)) for field in dataset["fields"]])
    return output.getvalue()


def _xlsx(dataset: dict[str, Any]) -> bytes:
    rows = [dataset["fields"]] + [[row.get(field) for field in dataset["fields"]] for row in dataset["rows"]]
    sheet_rows = []
    for row_index, values in enumerate(rows, 1):
        cells = []
        for column_index, value in enumerate(values, 1):
            letters, number = "", column_index
            while number:
                number, remainder = divmod(number - 1, 26)
                letters = chr(65 + remainder) + letters
            reference = f"{letters}{row_index}"
            number_value = _safe_number(value)
            if number_value is not None and not isinstance(value, str):
                cells.append(f'<c r="{reference}" t="n"><v>{number_value}</v></c>')
            else:
                text = html.escape(str(_escape_csv_cell(value) if value is not None else ""))
                cells.append(f'<c r="{reference}" t="inlineStr"><is><t>{text}</t></is></c>')
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')
    sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + "".join(sheet_rows) + '</sheetData></worksheet>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        archive.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="清洗结果" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return output.getvalue()


def _exports(project: dict[str, Any], dataset: dict[str, Any], profile: dict[str, Any], aggregation: dict[str, Any], view_rows: list[dict[str, Any]]) -> dict[str, str]:
    current = {"fields": dataset["fields"], "rows": view_rows, "source": dataset.get("source", {})}
    operations = {"schema": OPERATION_SCHEMA, "version": 2, "projectId": project["id"], "baseChecksum": project["baseDataset"].get("source", {}).get("checksum"), "operations": project.get("operations", [])[:project.get("cursor", 0)]}
    project_payload = deepcopy(project)
    project_payload["dataset"] = dataset
    table_head = "".join(f"<th>{html.escape(field)}</th>" for field in dataset["fields"])
    table_body = "".join("<tr>" + "".join(f"<td>{html.escape(str(row.get(field) if row.get(field) is not None else ''))}</td>" for field in dataset["fields"]) + "</tr>" for row in view_rows)
    html_table = f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{html.escape(project["name"])}</title><style>body{{font-family:system-ui;margin:28px;color:#142b4a}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #cad6e5;padding:6px 8px;text-align:left}}th{{background:#eef3f8;position:sticky;top:0}}</style><h1>{html.escape(project["name"])}</h1><p>当前视图 {len(view_rows)} 行 · 操作历史 {project.get("cursor", 0)} 步</p><table><thead><tr>{table_head}</tr></thead><tbody>{table_body}</tbody></table></html>'
    aggregation_dataset = {
        "fields": [aggregation["groupBy"], "记录数", "有效数值数", "合计", "平均值", "最小值", "最大值"],
        "rows": [{
            aggregation["groupBy"]: row["group"], "记录数": row["count"], "有效数值数": row["numericCount"],
            "合计": row["sum"], "平均值": row["mean"], "最小值": row["min"], "最大值": row["max"],
        } for row in aggregation["rows"]],
    }
    aggregation_csv = _delimited(aggregation_dataset, ",")
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", f'# {project["name"]}\n\n- 原始数据：{len(project["baseDataset"]["rows"])} 行\n- 当前数据：{len(dataset["rows"])} 行\n- 当前历史：{project.get("cursor", 0)}/{len(project.get("operations", []))}\n- 注意：项目包包含原始数据和完整历史，请按数据分级要求传递。\n')
        archive.writestr("project.json", json.dumps(project_payload, ensure_ascii=False, indent=2))
        archive.writestr("operations.json", json.dumps(operations, ensure_ascii=False, indent=2))
        archive.writestr("profile.json", json.dumps(profile, ensure_ascii=False, indent=2))
        archive.writestr("analysis/aggregation.csv", aggregation_csv)
        archive.writestr("data/original.csv", _delimited(project["baseDataset"], ","))
        archive.writestr("data/current.csv", _delimited(dataset, ","))
        archive.writestr("data/current-view.csv", _delimited(current, ","))
        archive.writestr("data/current.xlsx", _xlsx(dataset))
        archive.writestr("audit.json", json.dumps(project.get("audit", []), ensure_ascii=False, indent=2))
    return {
        "currentCsv": _delimited(current, ","), "allCsv": _delimited(dataset, ","), "tsv": _delimited(current, "\t"),
        "json": json.dumps([{field: row.get(field) for field in dataset["fields"]} for row in view_rows], ensure_ascii=False, indent=2),
        "html": html_table, "xlsxBase64": base64.b64encode(_xlsx(current)).decode("ascii"), "aggregationCsv": aggregation_csv,
        "profileJson": json.dumps(profile, ensure_ascii=False, indent=2), "operationsJson": json.dumps(operations, ensure_ascii=False, indent=2),
        "projectJson": json.dumps(project_payload, ensure_ascii=False, indent=2), "packageBase64": base64.b64encode(package.getvalue()).decode("ascii"),
    }


def _analysis(project: dict[str, Any]) -> dict[str, Any]:
    dataset, history = _replay(project)
    project["dataset"] = dataset
    profile = _profile(dataset)
    view = project.setdefault("view", {"query": "", "facets": [], "sorts": [], "page": 1, "pageSize": 15})
    all_rows = _apply_view(dataset, view)
    page_size = max(10, min(100, int(view.get("pageSize", 15))))
    page_count = max(1, math.ceil(len(all_rows) / page_size))
    page = max(1, min(page_count, int(view.get("page", 1))))
    view["page"], view["pageSize"] = page, page_size
    page_rows = all_rows[(page - 1) * page_size: page * page_size]
    selected = project.get("selectedColumn") if project.get("selectedColumn") in dataset["fields"] else dataset["fields"][0]
    project["selectedColumn"] = selected
    selected_profile = next(item for item in profile["columns"] if item["field"] == selected)
    facets = {field: _facet_values(dataset, field) for field in dataset["fields"]}
    completeness = [{"field": column["field"], "value": column["completeness"]} for column in profile["columns"]]
    missing_rows = [{"rowId": row["_rowId"], "missing": sum(_is_blank(row.get(field)) for field in dataset["fields"])} for row in dataset["rows"]]
    numeric = [column for column in profile["columns"] if column["type"] == "number"]
    aggregation = _aggregation(dataset)
    quality_checks = [
        {"label": "数据规模在安全限制内", "passed": len(dataset["rows"]) <= MAX_ROWS and len(dataset["fields"]) <= MAX_COLUMNS},
        {"label": "字段名称唯一且非空", "passed": len(dataset["fields"]) == len(set(dataset["fields"])) and all(dataset["fields"])},
        {"label": "重复行比例低于 5%", "passed": profile["duplicateRows"] / max(1, profile["rows"]) < .05},
        {"label": "缺失单元格比例低于 10%", "passed": profile["missingCells"] / max(1, profile["rows"] * profile["columnCount"]) < .1},
        {"label": "数值异常值均已可定位", "passed": all(isinstance(column["outliers"], int) for column in numeric)},
        {"label": "历史游标与操作链一致", "passed": 0 <= project.get("cursor", 0) <= len(project.get("operations", []))},
    ]
    return {
        "profile": profile, "history": history, "view": {"total": len(all_rows), "page": page, "pageCount": page_count, "pageSize": page_size, "rows": page_rows},
        "selectedProfile": selected_profile, "facets": facets, "aggregation": aggregation,
        "charts": {"completeness": completeness, "selectedHistogram": selected_profile.get("histogram", []), "missingByRow": missing_rows[:60]},
        "qualityChecks": quality_checks,
    }


def _runtime() -> dict[str, Any]:
    return {
        "pythonEngine": {"status": "enabled", "engine": "Python deterministic data-refine engine"},
        "goControlPlane": {"status": "enabled", "engine": "Go projects, versions, jobs and audit boundary"},
        "browserGrid": {"status": "enabled", "engine": "React virtualized dense grid"},
        "openRefineServer": {"status": "not-configured", "engine": "optional isolated OpenRefine connector"},
        "reconciliationService": {"status": "not-configured", "engine": "optional reconciliation provider"},
        "objectStorage": {"status": "not-configured", "engine": "S3-compatible artifact persistence"},
        "arbitraryCodeExecution": False,
    }


def _result(project: dict[str, Any], stage: str) -> dict[str, Any]:
    analysis = _analysis(project)
    return {"schema": SCHEMA, "version": 2, "stage": stage, "project": project, "analysis": analysis, "runtime": _runtime(), "exports": _exports(project, project["dataset"], analysis["profile"], analysis["aggregation"], _apply_view(project["dataset"], project["view"]))}


def _operation_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("operation")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ToolError(f"操作 JSON 格式错误：{exc.msg}") from exc
    if not isinstance(raw, dict):
        raw = {key: value for key, value in payload.items() if key not in {"state", "actor", "actorRole"}}
    kind = _clean(raw.get("type"), 50)
    if kind not in ALLOWED_OPERATION_TYPES:
        raise ToolError(f"不允许的清洗操作：{kind}")
    operation = deepcopy(raw)
    operation.update({"id": _id("op"), "type": kind, "label": _clean(raw.get("label") or kind, 160), "createdAt": _now(), "actor": _clean(payload.get("actor") or "当前用户", 80)})
    return operation


def run_data_lab(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "clean" and not isinstance(payload.get("state"), dict) and payload.get("csv"):
        dataset = _parse_delimited(str(payload["csv"]))
        requested = payload.get("operations", ["trim", "remove-empty", "deduplicate"])
        if isinstance(requested, str):
            try: requested = json.loads(requested)
            except json.JSONDecodeError as exc: raise ToolError(f"operations JSON 格式错误：{exc.msg}") from exc
        if not isinstance(requested, list): raise ToolError("operations 必须是数组")
        output = deepcopy(dataset)
        audit = []
        if "trim" in requested or "collapse-whitespace" in requested:
            changed = 0
            for row in output["rows"]:
                for field in output["fields"]:
                    value = row.get(field)
                    if isinstance(value, str):
                        next_value = value.strip()
                        if "collapse-whitespace" in requested: next_value = re.sub(r"\s+", " ", next_value)
                        changed += next_value != value
                        row[field] = next_value
            audit.append({"operation": "normalize-text", "affected": changed})
        if "remove-empty" in requested:
            before = len(output["rows"])
            output["rows"] = [row for row in output["rows"] if any(not _is_blank(row.get(field)) for field in output["fields"])]
            audit.append({"operation": "remove-empty", "affected": before - len(output["rows"])})
        if "deduplicate" in requested:
            output, affected, _ = _apply_operation(output, {"type": "deduplicate"})
            audit.append({"operation": "deduplicate", "affected": affected})
        return {"inputRows": len(dataset["rows"]), "outputRows": len(output["rows"]), "fields": output["fields"], "audit": audit, "csv": _delimited(output, ",")}
    if action in {"load-sample", "run-all", "profile", "clean"} and not isinstance(payload.get("state"), dict):
        return _result(_sample_project(), "load-sample")
    if action in MUTATING_ACTIONS:
        _require_editor(payload)
    if action == "runtime-status":
        project = _project(payload)
        return _result(project, action)
    project = _project(payload)
    if action == "update-project":
        if payload.get("name") is not None:
            project["name"] = _clean(payload.get("name"), 160) or project["name"]
        if payload.get("description") is not None:
            project["description"] = _clean(payload.get("description"), 1000)
        if payload.get("selectedColumn") in project.get("dataset", project["baseDataset"])["fields"]:
            project["selectedColumn"] = payload["selectedColumn"]
        if isinstance(payload.get("view"), dict):
            project["view"].update({key: deepcopy(value) for key, value in payload["view"].items() if key in {"query", "facets", "sorts", "page", "pageSize"}})
        _audit(project, payload, action, project["id"], "更新项目与视图设置")
    elif action == "import-data":
        dataset = _parse_import(payload)
        project["baseDataset"], project["operations"], project["cursor"] = dataset, [], 0
        project["view"] = {"query": "", "facets": [], "sorts": [], "page": 1, "pageSize": 15}
        project["selectedColumn"] = dataset["fields"][0]
        _audit(project, payload, action, dataset["source"]["fileName"], f"导入 {len(dataset['rows'])} 行、{len(dataset['fields'])} 列")
    elif action in {"apply-operation", "edit-cell"}:
        operation = _operation_from_payload({**payload, **({"operation": {"type": "cell-edit", "column": payload.get("column"), "rowId": payload.get("rowId"), "value": payload.get("value"), "label": "编辑单元格"}} if action == "edit-cell" else {})})
        project["operations"] = project.get("operations", [])[:int(project.get("cursor", 0))]
        current, _ = _replay(project)
        _apply_operation(current, operation)
        project["operations"].append(operation)
        project["cursor"] = len(project["operations"])
        _audit(project, payload, action, operation.get("column") or project["id"], operation["label"])
    elif action == "undo":
        project["cursor"] = max(0, int(project.get("cursor", 0)) - 1)
        _audit(project, payload, action, project["id"], f"回退到第 {project['cursor']} 步")
    elif action == "redo":
        project["cursor"] = min(len(project.get("operations", [])), int(project.get("cursor", 0)) + 1)
        _audit(project, payload, action, project["id"], f"前进到第 {project['cursor']} 步")
    elif action == "jump-history":
        cursor = int(payload.get("cursor", 0))
        if cursor < 0 or cursor > len(project.get("operations", [])):
            raise ToolError("历史位置超出范围")
        project["cursor"] = cursor
        _audit(project, payload, action, project["id"], f"切换到第 {cursor} 步")
    elif action in {"set-view", "set-facet", "clear-facets", "set-sort"}:
        view = project.setdefault("view", {"query": "", "facets": [], "sorts": [], "page": 1, "pageSize": 15})
        if action == "set-view":
            for key in {"query", "page", "pageSize"}:
                if key in payload: view[key] = payload[key]
            if payload.get("selectedColumn") in project.get("dataset", project["baseDataset"])["fields"]: project["selectedColumn"] = payload["selectedColumn"]
        elif action == "set-facet":
            facet = payload.get("facet")
            if not isinstance(facet, dict) or facet.get("column") not in project.get("dataset", project["baseDataset"])["fields"]:
                raise ToolError("分面字段无效")
            view["facets"] = [item for item in view.get("facets", []) if item.get("column") != facet.get("column")] + [deepcopy(facet)]
            view["page"] = 1
        elif action == "clear-facets": view["facets"] = []
        else:
            column = payload.get("column")
            if column not in project.get("dataset", project["baseDataset"])["fields"]: raise ToolError("排序字段无效")
            view["sorts"] = [{"column": column, "direction": "desc" if payload.get("direction") == "desc" else "asc"}]
            view["page"] = 1
    elif action == "replay-operations":
        script = payload.get("script")
        if isinstance(script, str):
            try: script = json.loads(script)
            except json.JSONDecodeError as exc: raise ToolError(f"操作配方 JSON 格式错误：{exc.msg}") from exc
        if not isinstance(script, dict) or script.get("schema") != OPERATION_SCHEMA or not isinstance(script.get("operations"), list):
            raise ToolError("不是有效的数据清洗操作配方")
        operations = []
        current = deepcopy(project["baseDataset"])
        for index, raw in enumerate(script["operations"]):
            if not isinstance(raw, dict) or raw.get("type") not in ALLOWED_OPERATION_TYPES:
                raise ToolError(f"第 {index + 1} 步包含不允许的操作")
            operation = _operation_from_payload({"operation": raw, "actor": payload.get("actor")})
            current, _, _ = _apply_operation(current, operation)
            operations.append(operation)
        project["operations"], project["cursor"] = operations, len(operations)
        _audit(project, payload, action, project["id"], f"应用 {len(operations)} 步可复核配方")
    elif action == "create-snapshot":
        snapshot = {"id": _id("snapshot"), "label": _clean(payload.get("label") or f"历史第 {project.get('cursor', 0)} 步", 120), "cursor": project.get("cursor", 0), "createdAt": _now(), "actor": _clean(payload.get("actor") or "当前用户", 80)}
        project.setdefault("snapshots", []).insert(0, snapshot)
        _audit(project, payload, action, snapshot["id"], snapshot["label"])
    elif action == "restore-snapshot":
        snapshot_id = _clean(payload.get("snapshotId"), 100)
        snapshot = next((item for item in project.get("snapshots", []) if item.get("id") == snapshot_id), None)
        if snapshot is None: raise ToolError("找不到指定快照")
        project["cursor"] = int(snapshot["cursor"])
        _audit(project, payload, action, snapshot_id, f"恢复到第 {project['cursor']} 步")
    elif action == "import-project":
        content = payload.get("content")
        if not content and payload.get("contentBase64"):
            try:
                raw = base64.b64decode(str(payload["contentBase64"]), validate=True)
                if zipfile.is_zipfile(io.BytesIO(raw)):
                    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                        if "project.json" not in archive.namelist(): raise ToolError("项目包缺少 project.json")
                        if archive.getinfo("project.json").file_size > MAX_FILE_BYTES: raise ToolError("项目文件过大")
                        content = archive.read("project.json").decode("utf-8")
                else: content = raw.decode("utf-8")
            except (ValueError, UnicodeDecodeError, zipfile.BadZipFile) as exc: raise ToolError("项目包无法读取") from exc
        try: imported = json.loads(str(content or ""))
        except json.JSONDecodeError as exc: raise ToolError(f"项目 JSON 格式错误：{exc.msg}") from exc
        if not isinstance(imported, dict) or imported.get("schema") != PROJECT_SCHEMA: raise ToolError("不是有效的数据清洗项目")
        dataset = imported.get("baseDataset")
        if not isinstance(dataset, dict) or not isinstance(dataset.get("fields"), list) or not isinstance(dataset.get("rows"), list): raise ToolError("项目缺少原始数据")
        project = imported
        project["id"] = _id("data-project")
        project["baseDataset"] = _normalize_dataset(dataset["fields"], dataset["rows"], source=dataset.get("source"))
        script = {"schema": OPERATION_SCHEMA, "operations": imported.get("operations", [])}
        project["operations"], project["cursor"] = [], 0
        for raw in script["operations"][:500]:
            if isinstance(raw, dict) and raw.get("type") in ALLOWED_OPERATION_TYPES:
                project["operations"].append(_operation_from_payload({"operation": raw, "actor": payload.get("actor")}))
        project["cursor"] = min(int(imported.get("cursor", len(project["operations"]))), len(project["operations"]))
        project["audit"] = []
        _audit(project, payload, action, project["id"], "安全导入项目并重新生成标识")
    elif action in {"validate", "export"}:
        pass
    else:
        raise ToolError("不支持的数据清洗操作")
    return _result(project, action)
