from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time
from dataclasses import dataclass
from typing import Annotated

from fastapi import Header, Request

from app.config import Settings, settings
from app.errors import ApiError


SERVICE_HEADER = "X-Skyview-Service"
TIMESTAMP_HEADER = "X-Skyview-Timestamp"
NONCE_HEADER = "X-Skyview-Nonce"
ACTOR_HEADER = "X-Skyview-Actor"
TENANT_HEADER = "X-Skyview-Tenant"
JOB_HEADER = "X-Skyview-Job"
SIGNATURE_HEADER = "X-Skyview-Signature"

_CONTEXT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_SIGNATURE_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True, slots=True)
class ServiceContext:
    service_id: str
    actor_id: str
    tenant_id: str
    job_id: str
    nonce: str
    signed: bool


class ReplayGuard:
    """Process-local first barrier; the durable control plane remains authoritative."""

    def __init__(self) -> None:
        self._seen: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def claim(self, service_id: str, nonce: str, *, now: float, ttl_seconds: int) -> bool:
        key = (service_id, nonce)
        with self._lock:
            expired = [found for found, expires_at in self._seen.items() if expires_at <= now]
            for found in expired:
                self._seen.pop(found, None)
            if key in self._seen:
                return False
            self._seen[key] = now + (ttl_seconds * 2)
            return True

    def clear(self) -> None:
        with self._lock:
            self._seen.clear()


replay_guard = ReplayGuard()


def canonical_signature_input(
    *,
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    service_id: str,
    actor_id: str,
    tenant_id: str,
    job_id: str,
    body: bytes,
) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    fields = (
        "skyview-hmac-v1",
        method.upper(),
        path,
        timestamp,
        nonce,
        service_id,
        actor_id,
        tenant_id,
        job_id,
        body_hash,
    )
    return "\n".join(fields).encode("utf-8")


def sign_request(
    *,
    secret: str,
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    service_id: str,
    actor_id: str,
    tenant_id: str,
    job_id: str,
    body: bytes,
) -> str:
    canonical = canonical_signature_input(
        method=method,
        path=path,
        timestamp=timestamp,
        nonce=nonce,
        service_id=service_id,
        actor_id=actor_id,
        tenant_id=tenant_id,
        job_id=job_id,
        body=body,
    )
    return hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()


def _required_header(request: Request, name: str) -> str:
    value = request.headers.get(name, "").strip()
    if not value:
        raise ApiError(
            "SERVICE_AUTH_REQUIRED",
            f"缺少服务身份请求头 {name}",
            status_code=401,
        )
    return value


def _valid_context(value: str, label: str) -> str:
    if not _CONTEXT_PATTERN.fullmatch(value):
        raise ApiError(
            "SERVICE_CONTEXT_INVALID",
            f"{label} 格式无效",
            status_code=401,
        )
    return value


async def verify_service_context(
    request: Request,
    *,
    current_settings: Settings | None = None,
    now: float | None = None,
) -> ServiceContext:
    configured = current_settings or settings
    if configured.readiness_issues():
        raise ApiError(
            "SERVICE_AUTH_NOT_CONFIGURED",
            "计算服务身份验证尚未正确配置",
            status_code=503,
        )

    signature_headers_present = any(
        request.headers.get(name)
        for name in (
            SERVICE_HEADER,
            TIMESTAMP_HEADER,
            NONCE_HEADER,
            ACTOR_HEADER,
            TENANT_HEADER,
            JOB_HEADER,
            SIGNATURE_HEADER,
        )
    )
    if configured.unsigned_development_enabled and not signature_headers_present:
        context = ServiceContext(
            service_id="unsafe-development-bypass",
            actor_id="development-actor",
            tenant_id="development-tenant",
            job_id=getattr(request.state, "request_id", "development-job"),
            nonce="unsigned",
            signed=False,
        )
        request.state.service_context = context
        return context

    service_id = _valid_context(_required_header(request, SERVICE_HEADER), "service")
    timestamp = _required_header(request, TIMESTAMP_HEADER)
    nonce = _valid_context(_required_header(request, NONCE_HEADER), "nonce")
    actor_id = _valid_context(_required_header(request, ACTOR_HEADER), "actor")
    tenant_id = _valid_context(_required_header(request, TENANT_HEADER), "tenant")
    job_id = _valid_context(_required_header(request, JOB_HEADER), "job")
    supplied_signature = _required_header(request, SIGNATURE_HEADER).casefold()

    if service_id != configured.trusted_service_id:
        raise ApiError("SERVICE_AUTH_INVALID", "服务身份无效", status_code=401)
    if not _SIGNATURE_PATTERN.fullmatch(supplied_signature):
        raise ApiError("SERVICE_AUTH_INVALID", "服务签名格式无效", status_code=401)
    try:
        signed_at = int(timestamp)
    except ValueError as exc:
        raise ApiError("SERVICE_AUTH_INVALID", "服务签名时间无效", status_code=401) from exc

    current_time = time.time() if now is None else now
    if abs(current_time - signed_at) > configured.service_signature_max_age_seconds:
        raise ApiError("SERVICE_AUTH_EXPIRED", "服务签名已过期", status_code=401)

    body = await request.body()
    expected_signature = sign_request(
        secret=configured.service_hmac_secret,
        method=request.method,
        path=request.url.path,
        timestamp=timestamp,
        nonce=nonce,
        service_id=service_id,
        actor_id=actor_id,
        tenant_id=tenant_id,
        job_id=job_id,
        body=body,
    )
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise ApiError("SERVICE_AUTH_INVALID", "服务签名无效", status_code=401)
    if not replay_guard.claim(
        service_id,
        nonce,
        now=current_time,
        ttl_seconds=configured.service_signature_max_age_seconds,
    ):
        raise ApiError("SERVICE_AUTH_REPLAYED", "服务请求已被使用", status_code=409)

    context = ServiceContext(
        service_id=service_id,
        actor_id=actor_id,
        tenant_id=tenant_id,
        job_id=job_id,
        nonce=nonce,
        signed=True,
    )
    request.state.service_context = context
    return context


async def require_service_context(
    request: Request,
    service_id: Annotated[str | None, Header(alias=SERVICE_HEADER)] = None,
    timestamp: Annotated[str | None, Header(alias=TIMESTAMP_HEADER)] = None,
    nonce: Annotated[str | None, Header(alias=NONCE_HEADER)] = None,
    actor_id: Annotated[str | None, Header(alias=ACTOR_HEADER)] = None,
    tenant_id: Annotated[str | None, Header(alias=TENANT_HEADER)] = None,
    job_id: Annotated[str | None, Header(alias=JOB_HEADER)] = None,
    signature: Annotated[str | None, Header(alias=SIGNATURE_HEADER)] = None,
) -> ServiceContext:
    """FastAPI dependency with no user-controllable verifier parameters."""

    # Parameters intentionally document the wire contract in OpenAPI. Verification uses
    # Request.headers so it signs exactly the values received on the wire.
    _ = (service_id, timestamp, nonce, actor_id, tenant_id, job_id, signature)
    return await verify_service_context(request)
