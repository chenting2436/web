from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.analysis import analyze_text
from app.config import settings
from app.errors import ApiError
from app.request_limits import validate_json_shape
from app.schemas import TextAnalysisRequest, TextAnalysisResult, ToolRunRequest
from app.security import ServiceContext, require_service_context
from app.tools.common import ToolError
from app.tools.dispatcher import catalog, run_tool


logger = logging.getLogger("skyviewlab.compute")
logger.setLevel(logging.INFO)
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

app = FastAPI(
    title="SkyViewLab Python Compute API",
    version="0.2.0",
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Request-ID",
        "X-Skyview-Service",
        "X-Skyview-Timestamp",
        "X-Skyview-Nonce",
        "X-Skyview-Actor",
        "X-Skyview-Tenant",
        "X-Skyview-Job",
        "X-Skyview-Signature",
    ],
)


def _reject_non_finite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


async def _read_limited_body(request: Request) -> bytes:
    """Read and cache the request body without ever buffering past the limit."""

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > settings.max_request_bytes:
            raise ApiError(
                "REQUEST_BODY_TOO_LARGE",
                f"请求体不能超过 {settings.max_request_bytes} 字节",
                status_code=413,
            )
        chunks.append(chunk)

    body = b"".join(chunks)
    # Starlette exposes no public rewind API. Caching the validated bytes is the
    # same contract used by Request.body(), and lets FastAPI/Pydantic consume the
    # body again without another read from the client connection.
    request._body = body  # type: ignore[attr-defined]
    return body


def _context_fields(request: Request) -> dict[str, str | bool]:
    context = getattr(request.state, "service_context", None)
    if not isinstance(context, ServiceContext):
        return {}
    return {
        "serviceId": context.service_id,
        "actorId": context.actor_id,
        "tenantId": context.tenant_id,
        "jobId": context.job_id,
        "serviceRequestSigned": context.signed,
    }


def _log(level: int, event: str, request: Request, **fields: Any) -> None:
    record = {
        "event": event,
        "requestId": _request_id(request),
        "method": request.method,
        "path": request.url.path,
        **_context_fields(request),
        **fields,
    }
    logger.log(level, json.dumps(record, ensure_ascii=False, separators=(",", ":")))


def _error_response(
    request: Request,
    *,
    status_code: int,
    code: str,
    message: str,
    details: Any | None = None,
) -> JSONResponse:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return JSONResponse(
        status_code=status_code,
        content={
            "error": error,
            # Transitional alias for the current React client; remove in the next API major version.
            "message": message,
            "requestId": _request_id(request),
        },
    )


@app.middleware("http")
async def request_context_limits_and_logging(request: Request, call_next):
    supplied_request_id = request.headers.get("X-Request-ID", "").strip()
    request.state.request_id = (
        supplied_request_id
        if _REQUEST_ID_PATTERN.fullmatch(supplied_request_id)
        else uuid.uuid4().hex
    )
    started = time.perf_counter()
    status_code = 500
    try:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_size = int(content_length)
            except ValueError as exc:
                raise ApiError(
                    "INVALID_CONTENT_LENGTH",
                    "Content-Length 请求头无效",
                    status_code=400,
                ) from exc
            if declared_size < 0:
                raise ApiError(
                    "INVALID_CONTENT_LENGTH",
                    "Content-Length 请求头无效",
                    status_code=400,
                )
            if declared_size > settings.max_request_bytes:
                raise ApiError(
                    "REQUEST_BODY_TOO_LARGE",
                    f"请求体不能超过 {settings.max_request_bytes} 字节",
                    status_code=413,
                )

        if request.method in {"POST", "PUT", "PATCH"}:
            body = await _read_limited_body(request)
            content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
            if body and (content_type == "application/json" or content_type.endswith("+json")):
                try:
                    decoded = json.loads(body, parse_constant=_reject_non_finite_json)
                except RecursionError as exc:
                    raise ApiError(
                        "JSON_DEPTH_EXCEEDED",
                        f"JSON 嵌套深度不能超过 {settings.max_json_depth}",
                        status_code=413,
                    ) from exc
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                    raise ApiError("INVALID_JSON", "请求体不是有效 JSON", status_code=400) from exc
                validate_json_shape(decoded, settings)

        response = await call_next(request)
        status_code = response.status_code
        return response
    except ApiError as exc:
        status_code = exc.status_code
        return _error_response(
            request,
            status_code=exc.status_code,
            code=exc.code,
            message=exc.message,
            details=exc.details,
        )
    finally:
        duration_ms = round((time.perf_counter() - started) * 1_000, 2)
        _log(
            logging.INFO if status_code < 500 else logging.ERROR,
            "http.request.completed",
            request,
            status=status_code,
            durationMs=duration_ms,
        )


@app.exception_handler(ApiError)
async def api_error(request: Request, exc: ApiError):
    _log(logging.WARNING, "api.request.rejected", request, code=exc.code)
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=exc.message,
        details=exc.details,
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return _error_response(
        request,
        status_code=422,
        code="REQUEST_VALIDATION_FAILED",
        message="请求参数无效",
        details=jsonable_encoder(exc.errors()),
    )


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    code = {
        404: "ROUTE_NOT_FOUND",
        405: "METHOD_NOT_ALLOWED",
    }.get(exc.status_code, "HTTP_ERROR")
    return _error_response(
        request,
        status_code=exc.status_code,
        code=code,
        message=str(exc.detail),
    )


@app.exception_handler(ToolError)
async def tool_error(request: Request, exc: ToolError):
    return _error_response(
        request,
        status_code=exc.status_code,
        code=exc.code,
        message=str(exc),
    )


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    _log(logging.ERROR, "api.request.failed", request, errorType=type(exc).__name__)
    return _error_response(
        request,
        status_code=500,
        code="INTERNAL_ERROR",
        message="服务内部错误",
    )


@app.get("/live")
async def live(request: Request):
    return {
        "data": {"service": "python-compute", "status": "live"},
        "requestId": request.state.request_id,
    }


@app.get("/health", deprecated=True)
async def legacy_health(request: Request):
    return await live(request)


@app.get("/ready")
async def ready(request: Request):
    issues = settings.readiness_issues()
    payload = {
        "data": {
            "service": "python-compute",
            "status": "ready" if not issues else "not-ready",
            "checks": {
                "configuration": {"ok": not issues, "issues": issues},
                "serviceAuthentication": {
                    "mode": (
                        "unsafe-development-bypass"
                        if settings.unsigned_development_enabled
                        else "hmac-sha256"
                    )
                },
                "localCodeExecution": {
                    "enabled": settings.unsafe_local_code_execution_enabled,
                    "productionSandbox": False,
                },
            },
        },
        "requestId": request.state.request_id,
    }
    return JSONResponse(status_code=200 if not issues else 503, content=payload)


@app.post("/analysis/text")
async def text_analysis(
    payload: TextAnalysisRequest,
    request: Request,
    context: ServiceContext = Depends(require_service_context),
) -> dict[str, TextAnalysisResult | str]:
    return {
        "data": analyze_text(payload.text, payload.limit),
        "requestId": request.state.request_id,
        "jobId": context.job_id,
    }


@app.get("/tools/catalog")
async def tool_catalog(request: Request):
    return {"data": catalog(), "requestId": request.state.request_id}


@app.post("/tools/{slug}/run")
async def execute_tool(
    slug: str,
    payload: ToolRunRequest,
    request: Request,
    context: ServiceContext = Depends(require_service_context),
):
    _log(logging.INFO, "tool.run.started", request, toolSlug=slug, action=payload.action)
    result = run_tool(slug, payload.action, payload.payload)
    _log(logging.INFO, "tool.run.completed", request, toolSlug=slug, action=payload.action)
    return {
        "data": result,
        "requestId": request.state.request_id,
        "jobId": context.job_id,
    }
