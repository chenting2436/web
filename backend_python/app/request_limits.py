from __future__ import annotations

from typing import Any

from app.config import Settings
from app.errors import ApiError


def validate_json_shape(value: Any, settings: Settings) -> None:
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        if depth > settings.max_json_depth:
            raise ApiError(
                "JSON_DEPTH_EXCEEDED",
                f"JSON 嵌套深度不能超过 {settings.max_json_depth}",
                status_code=413,
            )
        if isinstance(current, str):
            if len(current) > settings.max_json_string_length:
                raise ApiError(
                    "JSON_STRING_TOO_LONG",
                    f"JSON 字符串不能超过 {settings.max_json_string_length} 个字符",
                    status_code=413,
                )
            continue
        if isinstance(current, list):
            if len(current) > settings.max_json_array_items:
                raise ApiError(
                    "JSON_ARRAY_TOO_LARGE",
                    f"JSON 数组不能超过 {settings.max_json_array_items} 个元素",
                    status_code=413,
                )
            stack.extend((item, depth + 1) for item in current)
            continue
        if isinstance(current, dict):
            for key, item in current.items():
                if len(str(key)) > settings.max_json_string_length:
                    raise ApiError(
                        "JSON_STRING_TOO_LONG",
                        f"JSON 键不能超过 {settings.max_json_string_length} 个字符",
                        status_code=413,
                    )
                stack.append((item, depth + 1))

