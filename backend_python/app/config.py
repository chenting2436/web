from __future__ import annotations

import os
from dataclasses import dataclass


def _split_origins(raw: str) -> tuple[str, ...]:
    return tuple(origin.strip() for origin in raw.split(",") if origin.strip())


def _boolean(raw: str | None, *, default: bool = False) -> bool:
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on"}


def _integer(raw: str | None, *, default: int, minimum: int) -> int:
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    allowed_origins: tuple[str, ...]
    app_environment: str
    trusted_service_id: str
    service_hmac_secret: str
    service_signature_max_age_seconds: int
    allow_unsigned_dev_requests: bool
    allow_unsafe_local_code_execution: bool
    max_request_bytes: int
    max_json_depth: int
    max_json_array_items: int
    max_json_string_length: int

    @property
    def is_development(self) -> bool:
        return self.app_environment.casefold() == "development"

    @property
    def unsigned_development_enabled(self) -> bool:
        return self.is_development and self.allow_unsigned_dev_requests

    @property
    def unsafe_local_code_execution_enabled(self) -> bool:
        return self.is_development and self.allow_unsafe_local_code_execution

    def readiness_issues(self) -> list[str]:
        issues: list[str] = []
        if not self.trusted_service_id.strip():
            issues.append("TRUSTED_SERVICE_ID is required")
        if self.allow_unsigned_dev_requests and not self.is_development:
            issues.append("ALLOW_UNSIGNED_DEV_REQUESTS is only valid when APP_ENV=development")
        if self.allow_unsafe_local_code_execution and not self.is_development:
            issues.append("ALLOW_UNSAFE_LOCAL_CODE_EXECUTION is only valid when APP_ENV=development")
        if not self.unsigned_development_enabled and len(self.service_hmac_secret.encode("utf-8")) < 32:
            issues.append("SERVICE_HMAC_SECRET must contain at least 32 UTF-8 bytes")
        return issues

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            host=os.getenv("PYTHON_HOST", "127.0.0.1"),
            port=_integer(os.getenv("PYTHON_PORT"), default=8000, minimum=1),
            allowed_origins=_split_origins(
                os.getenv(
                    "CORS_ORIGINS",
                    "http://localhost:4182,http://127.0.0.1:4182",
                )
            ),
            app_environment=os.getenv("APP_ENV", "production").strip() or "production",
            trusted_service_id=os.getenv("TRUSTED_SERVICE_ID", "go-control-plane").strip(),
            service_hmac_secret=os.getenv("SERVICE_HMAC_SECRET", ""),
            service_signature_max_age_seconds=_integer(
                os.getenv("SERVICE_SIGNATURE_MAX_AGE_SECONDS"),
                default=300,
                minimum=30,
            ),
            allow_unsigned_dev_requests=_boolean(os.getenv("ALLOW_UNSIGNED_DEV_REQUESTS")),
            allow_unsafe_local_code_execution=_boolean(
                os.getenv("ALLOW_UNSAFE_LOCAL_CODE_EXECUTION")
            ),
            max_request_bytes=_integer(
                os.getenv("MAX_REQUEST_BYTES"), default=1_048_576, minimum=1_024
            ),
            max_json_depth=_integer(os.getenv("MAX_JSON_DEPTH"), default=16, minimum=2),
            max_json_array_items=_integer(
                os.getenv("MAX_JSON_ARRAY_ITEMS"), default=5_000, minimum=1
            ),
            max_json_string_length=_integer(
                os.getenv("MAX_JSON_STRING_LENGTH"), default=200_000, minimum=1
            ),
        )


settings = Settings.from_environment()
