from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from typing import Any


class ToolError(ValueError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "TOOL_INPUT_INVALID",
        status_code: int = 400,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def require_text(payload: dict[str, Any], key: str, *, max_length: int = 200_000) -> str:
    value = str(payload.get(key, "")).strip()
    if not value:
        raise ToolError(f"{key} 不能为空")
    if len(value) > max_length:
        raise ToolError(f"{key} 内容过长")
    return value


def optional_text(payload: dict[str, Any], key: str, *, max_length: int = 200_000) -> str:
    value = str(payload.get(key, "")).strip()
    if len(value) > max_length:
        raise ToolError(f"{key} 内容过长")
    return value


def number(payload: dict[str, Any], key: str, default: float = 0) -> float:
    value = payload.get(key, default)
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ToolError(f"{key} 必须是数字") from exc
    if not math.isfinite(result):
        raise ToolError(f"{key} 必须是有限数字")
    return result


def parse_json(value: Any, *, fallback: Any = None) -> Any:
    if value in (None, ""):
        return fallback
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise ToolError(f"JSON 格式错误：{exc.msg}") from exc
    return value


def parse_numbers(value: Any, *, key: str = "values", minimum: int = 1) -> list[float]:
    if isinstance(value, str):
        raw: Iterable[Any] = re.split(r"[\s,;]+", value.strip())
    elif isinstance(value, Iterable) and not isinstance(value, (bytes, dict)):
        raw = value
    else:
        raise ToolError(f"{key} 必须是数字列表")

    result: list[float] = []
    for item in raw:
        if item in (None, ""):
            continue
        try:
            parsed = float(item)
        except (TypeError, ValueError) as exc:
            raise ToolError(f"{key} 包含非数字内容") from exc
        if not math.isfinite(parsed):
            raise ToolError(f"{key} 包含无效数字")
        result.append(parsed)
    if len(result) < minimum:
        raise ToolError(f"{key} 至少需要 {minimum} 个数字")
    if len(result) > 100_000:
        raise ToolError(f"{key} 最多支持 100000 个数字")
    return result


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def standard_deviation(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    average = mean(values)
    return math.sqrt(sum((value - average) ** 2 for value in values) / len(values))


def tokenize(text: str) -> list[str]:
    english = re.findall(r"[a-z][a-z0-9_+-]{1,}", text.lower())
    chinese_sequences = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    chinese: list[str] = []
    for sequence in chinese_sequences:
        if len(sequence) <= 6:
            chinese.append(sequence)
        if len(sequence) > 2:
            chinese.extend(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return english + chinese
