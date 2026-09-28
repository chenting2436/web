from __future__ import annotations

import json
import time
import unittest
import uuid
from dataclasses import replace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.security import replay_guard, sign_request


TEST_SECRET = "test-only-hmac-secret-that-is-at-least-32-bytes"
TEST_SETTINGS = replace(
    settings,
    app_environment="production",
    trusted_service_id="go-control-plane",
    service_hmac_secret=TEST_SECRET,
    allow_unsigned_dev_requests=False,
    allow_unsafe_local_code_execution=False,
)


class ComputeApiSecurityTests(unittest.TestCase):
    def setUp(self):
        replay_guard.clear()
        self.client = TestClient(app)

    def _body(self, value: object) -> bytes:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _signed_headers(
        self,
        body: bytes,
        *,
        path: str = "/tools/data-lab/run",
        timestamp: int | None = None,
        nonce: str | None = None,
        actor: str = "user-42",
        tenant: str = "tenant-7",
        job: str = "job-99",
        secret: str = TEST_SECRET,
    ) -> dict[str, str]:
        signed_at = str(timestamp if timestamp is not None else int(time.time()))
        nonce_value = nonce or uuid.uuid4().hex
        signature = sign_request(
            secret=secret,
            method="POST",
            path=path,
            timestamp=signed_at,
            nonce=nonce_value,
            service_id="go-control-plane",
            actor_id=actor,
            tenant_id=tenant,
            job_id=job,
            body=body,
        )
        return {
            "Content-Type": "application/json",
            "X-Request-ID": "request-123",
            "X-Skyview-Service": "go-control-plane",
            "X-Skyview-Timestamp": signed_at,
            "X-Skyview-Nonce": nonce_value,
            "X-Skyview-Actor": actor,
            "X-Skyview-Tenant": tenant,
            "X-Skyview-Job": job,
            "X-Skyview-Signature": signature,
        }

    def _post_signed(self, payload: object, **header_overrides):
        body = self._body(payload)
        headers = self._signed_headers(body, **header_overrides)
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
            patch("app.tools.teaching.settings", TEST_SETTINGS),
        ):
            return self.client.post(
                "/tools/data-lab/run",
                content=body,
                headers=headers,
            )

    def _post_analysis_signed(self, payload: object, **header_overrides):
        body = self._body(payload)
        headers = self._signed_headers(body, path="/analysis/text", **header_overrides)
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            return self.client.post(
                "/analysis/text",
                content=body,
                headers=headers,
            )

    def test_cross_language_hmac_vector(self):
        body = b'{"action":"clean","payload":{"csv":"id,1"}}'
        signature = sign_request(
            secret="0123456789abcdef0123456789abcdef",
            method="POST",
            path="/tools/data-lab/run",
            timestamp="1788796800",
            nonce="nonce-001",
            service_id="go-control-plane",
            actor_id="user-42",
            tenant_id="tenant-7",
            job_id="job-99",
            body=body,
        )
        self.assertEqual(
            signature,
            "f137b59b93b20942e2c48c5ab012cec98ea1de30492b9ac2547ce0608aae29c0",
        )

    def test_live_is_independent_and_ready_checks_required_configuration(self):
        not_configured = replace(
            TEST_SETTINGS,
            service_hmac_secret="",
            allow_unsigned_dev_requests=False,
        )
        with patch("app.main.settings", not_configured):
            self.assertEqual(self.client.get("/live").status_code, 200)
            response = self.client.get("/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["data"]["status"], "not-ready")
        self.assertFalse(response.json()["data"]["checks"]["configuration"]["ok"])

        with patch("app.main.settings", TEST_SETTINGS):
            response = self.client.get("/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["status"], "ready")

    def test_unsigned_tool_request_is_rejected(self):
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            response = self.client.post(
                "/tools/data-lab/run",
                json={"action": "clean", "payload": {"csv": "id\n1"}},
            )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "SERVICE_AUTH_REQUIRED")
        self.assertIn("requestId", response.json())

    def test_text_analysis_requires_service_identity_and_carries_job_context(self):
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            unsigned = self.client.post("/analysis/text", json={"text": "hello"})
        self.assertEqual(unsigned.status_code, 401)
        self.assertEqual(unsigned.json()["error"]["code"], "SERVICE_AUTH_REQUIRED")

        replay_guard.clear()
        signed = self._post_analysis_signed({"text": "hello world", "limit": 4})
        self.assertEqual(signed.status_code, 200)
        self.assertEqual(signed.json()["jobId"], "job-99")
        self.assertEqual(signed.json()["data"]["englishWordCount"], 2)

    def test_chunked_body_without_content_length_is_stopped_at_the_limit(self):
        constrained = replace(TEST_SETTINGS, max_request_bytes=64)

        def chunks():
            yield b'{"text":"'
            yield b"x" * 80
            yield b'"}'

        with patch("app.main.settings", constrained):
            response = self.client.post(
                "/analysis/text",
                content=chunks(),
                headers={"Content-Type": "application/json"},
            )
        self.assertNotIn("content-length", response.request.headers)
        self.assertEqual(response.request.headers.get("transfer-encoding"), "chunked")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "REQUEST_BODY_TOO_LARGE")

    def test_openapi_documents_the_service_identity_headers(self):
        operation = app.openapi()["paths"]["/tools/{slug}/run"]["post"]
        header_names = {
            parameter["name"].casefold()
            for parameter in operation["parameters"]
            if parameter["in"] == "header"
        }
        self.assertEqual(
            header_names,
            {
                "x-skyview-service",
                "x-skyview-timestamp",
                "x-skyview-nonce",
                "x-skyview-actor",
                "x-skyview-tenant",
                "x-skyview-job",
                "x-skyview-signature",
            },
        )

    def test_valid_signature_carries_job_context_and_emits_structured_log(self):
        payload = {"action": "clean", "payload": {"csv": "id,name\n1,A"}}
        with self.assertLogs("skyviewlab.compute", level="INFO") as captured:
            response = self._post_signed(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["jobId"], "job-99")
        combined = "\n".join(captured.output)
        self.assertIn('"actorId":"user-42"', combined)
        self.assertIn('"tenantId":"tenant-7"', combined)
        self.assertIn('"jobId":"job-99"', combined)

    def test_signature_cannot_be_replayed(self):
        payload = {"action": "clean", "payload": {"csv": "id\n1"}}
        body = self._body(payload)
        headers = self._signed_headers(body, nonce="one-use-nonce")
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            first = self.client.post("/tools/data-lab/run", content=body, headers=headers)
            second = self.client.post("/tools/data-lab/run", content=body, headers=headers)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["error"]["code"], "SERVICE_AUTH_REPLAYED")

    def test_tampered_body_and_expired_timestamp_are_rejected(self):
        original = self._body({"action": "clean", "payload": {"csv": "id\n1"}})
        tampered = self._body({"action": "clean", "payload": {"csv": "id\n2"}})
        headers = self._signed_headers(original)
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            response = self.client.post("/tools/data-lab/run", content=tampered, headers=headers)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "SERVICE_AUTH_INVALID")

        expired = int(time.time()) - TEST_SETTINGS.service_signature_max_age_seconds - 1
        response = self._post_signed(
            {"action": "clean", "payload": {"csv": "id\n1"}},
            timestamp=expired,
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "SERVICE_AUTH_EXPIRED")

    def test_request_and_json_complexity_limits_have_stable_codes(self):
        constrained = replace(
            TEST_SETTINGS,
            max_request_bytes=128,
            max_json_depth=4,
            max_json_array_items=2,
            max_json_string_length=10,
        )
        cases = (
            ({"payload": "x" * 200}, "REQUEST_BODY_TOO_LARGE"),
            ({"a": {"b": {"c": {"d": 1}}}}, "JSON_DEPTH_EXCEEDED"),
            ({"items": [1, 2, 3]}, "JSON_ARRAY_TOO_LARGE"),
            ({"value": "x" * 11}, "JSON_STRING_TOO_LONG"),
        )
        for payload, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with patch("app.main.settings", constrained):
                    response = self.client.post("/analysis/text", json=payload)
                self.assertEqual(response.status_code, 413)
                self.assertEqual(response.json()["error"]["code"], expected_code)

        with patch("app.main.settings", TEST_SETTINGS):
            non_finite = self.client.post("/analysis/text", content=b'{"text":NaN}', headers={"Content-Type": "application/json"})
        self.assertEqual(non_finite.status_code, 400)
        self.assertEqual(non_finite.json()["error"]["code"], "INVALID_JSON")

    def test_invalid_json_and_schema_errors_share_the_error_envelope(self):
        with patch("app.main.settings", TEST_SETTINGS):
            malformed = self.client.post(
                "/analysis/text",
                content=b'{"text":',
                headers={"Content-Type": "application/json"},
            )
        self.assertEqual(malformed.status_code, 400)
        self.assertEqual(malformed.json()["error"]["code"], "INVALID_JSON")

        body = self._body({"action": "", "payload": {}})
        headers = self._signed_headers(body)
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
        ):
            invalid = self.client.post("/tools/data-lab/run", content=body, headers=headers)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(invalid.json()["error"]["code"], "REQUEST_VALIDATION_FAILED")

        missing = self.client.get("/missing-route")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "ROUTE_NOT_FOUND")

    def test_local_subprocess_is_disabled_by_default_and_never_claims_sandboxing(self):
        path = "/tools/python-lab/run"
        payload = {"action": "run", "payload": {"code": "print(1)"}}
        body = self._body(payload)
        headers = self._signed_headers(body, path=path)
        with (
            patch("app.main.settings", TEST_SETTINGS),
            patch("app.security.settings", TEST_SETTINGS),
            patch("app.tools.teaching.settings", TEST_SETTINGS),
        ):
            disabled = self.client.post(path, content=body, headers=headers)
        self.assertEqual(disabled.status_code, 503)
        self.assertEqual(disabled.json()["error"]["code"], "UNSAFE_LOCAL_RUNTIME_DISABLED")

        replay_guard.clear()
        development = replace(
            TEST_SETTINGS,
            app_environment="development",
            allow_unsafe_local_code_execution=True,
        )
        body = self._body(payload)
        headers = self._signed_headers(body, path=path)
        with (
            patch("app.main.settings", development),
            patch("app.security.settings", development),
            patch("app.tools.teaching.settings", development),
        ):
            enabled = self.client.post(path, content=body, headers=headers)
        self.assertEqual(enabled.status_code, 200)
        result = enabled.json()["data"]
        self.assertTrue(result["prototype"])
        self.assertFalse(result["productionSandbox"])
        self.assertEqual(result["executionMode"], "unsafe-development-prototype")

    def test_development_bypass_must_be_explicit_and_environment_scoped(self):
        invalid_bypass = replace(
            TEST_SETTINGS,
            app_environment="production",
            allow_unsigned_dev_requests=True,
        )
        self.assertTrue(invalid_bypass.readiness_issues())

        explicit_development = replace(
            TEST_SETTINGS,
            app_environment="development",
            service_hmac_secret="",
            allow_unsigned_dev_requests=True,
        )
        with (
            patch("app.main.settings", explicit_development),
            patch("app.security.settings", explicit_development),
        ):
            response = self.client.post(
                "/tools/data-lab/run",
                json={"action": "clean", "payload": {"csv": "id\n1"}},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["jobId"], response.json()["requestId"])


if __name__ == "__main__":
    unittest.main()
