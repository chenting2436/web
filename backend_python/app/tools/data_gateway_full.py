from __future__ import annotations

import copy
import csv
import io
import json
import math
import re
import time
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


CATALOG_ROWS = [
    ("ListenHTTP", "接入", "通过 HTTP 接收 FlowFile", ["http", "ingest", "listen"], ["success", "failure"]),
    ("GetFile", "接入", "从受控目录读取文件", ["file", "local", "batch"], ["success"]),
    ("ConsumeKafka", "接入", "消费 Kafka 主题记录", ["kafka", "stream", "message"], ["success"]),
    ("QueryDatabaseTableRecord", "接入", "增量查询数据库记录", ["sql", "database", "record"], ["success", "failure", "retry"]),
    ("CaptureChangeMySQL", "接入", "捕获 MySQL CDC 变更", ["cdc", "mysql", "database"], ["success", "failure"]),
    ("ConsumeMQTT", "接入", "消费 MQTT 消息", ["mqtt", "iot", "stream"], ["success"]),
    ("FetchSFTP", "接入", "提取 SFTP 远程内容", ["sftp", "file", "secure"], ["success", "not.found", "permission.denied", "failure"]),
    ("GenerateFlowFile", "接入", "生成测试 FlowFile", ["test", "generate"], ["success"]),
    ("ConvertRecord", "转换", "使用 Record Reader/Writer 转换记录", ["record", "schema", "convert"], ["success", "failure"]),
    ("UpdateRecord", "转换", "按字段路径更新记录", ["record", "field", "update"], ["success", "failure"]),
    ("JoltTransformJSON", "转换", "按 Jolt 规范转换 JSON", ["json", "jolt", "transform"], ["success", "failure"]),
    ("QueryRecord", "转换", "使用 SQL 查询并拆分记录集", ["record", "sql", "query"], ["matched", "unmatched", "failure"]),
    ("EvaluateJsonPath", "转换", "提取 JSONPath 为 FlowFile 属性", ["json", "attribute", "extract"], ["matched", "unmatched", "failure"]),
    ("ValidateRecord", "质量", "按 Schema 与显式规则校验记录", ["record", "schema", "quality"], ["valid", "invalid", "failure"]),
    ("DetectDuplicate", "质量", "检测重复记录或内容", ["duplicate", "cache", "quality"], ["non-duplicate", "duplicate", "failure"]),
    ("MonitorActivity", "质量", "监测数据流静默与恢复", ["monitor", "alert", "quality"], ["success", "inactive"]),
    ("RouteOnAttribute", "路由", "按 FlowFile 属性表达式路由", ["route", "attribute", "condition"], ["high", "medium", "unmatched"]),
    ("RouteOnContent", "路由", "按内容正则表达式路由", ["route", "content", "regex"], ["matched", "unmatched"]),
    ("SplitRecord", "路由", "将记录集拆分为多个 FlowFile", ["split", "record", "fork"], ["splits", "original", "failure"]),
    ("MergeRecord", "路由", "合并具有相关性的记录", ["merge", "record", "join"], ["merged", "original", "failure"]),
    ("PutDatabaseRecord", "交付", "通过受控连接池写入数据库", ["database", "sql", "record"], ["success", "retry", "failure"]),
    ("PublishKafka", "交付", "发布到 Kafka 主题", ["kafka", "publish", "stream"], ["success", "failure"]),
    ("PutS3Object", "交付", "写入兼容 S3 的对象存储", ["s3", "object", "cloud"], ["success", "failure"]),
    ("PutFile", "交付", "写入受控文件目录", ["file", "archive", "dead-letter"], ["success", "failure"]),
    ("InvokeHTTP", "交付", "调用远程 HTTP 服务", ["http", "api", "request"], ["response", "retry", "no.retry", "failure"]),
    ("LogAttribute", "交付", "记录 FlowFile 属性用于审查", ["log", "debug", "attribute"], ["success"]),
]

PROCESSOR_CATALOG = [
    {"type": row[0], "group": row[1], "description": row[2], "tags": row[3], "relationships": row[4]}
    for row in CATALOG_ROWS
]
SOURCE_TYPES = {"ListenHTTP", "GetFile", "ConsumeKafka", "QueryDatabaseTableRecord", "CaptureChangeMySQL", "ConsumeMQTT", "FetchSFTP", "GenerateFlowFile"}
TERMINAL_TYPES = {"PutDatabaseRecord", "PublishKafka", "PutS3Object", "PutFile", "InvokeHTTP", "LogAttribute"}


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def stable_hash(value: Any) -> str:
    result = 2166136261
    for byte in str(value if value is not None else "").encode("utf-8"):
        result ^= byte
        result = (result * 16777619) & 0xFFFFFFFF
    return f"{result:08x}"


def _uid(prefix: str, seed: Any) -> str:
    return f"{prefix}-{stable_hash(seed)}-{stable_hash(f'{seed}-tail')[:4]}"


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _catalog(processor_type: str) -> dict[str, Any]:
    return next((item for item in PROCESSOR_CATALOG if item["type"] == processor_type), PROCESSOR_CATALOG[0])


def _processor(identifier: str, processor_type: str, name: str, x: int, y: int, *, state: str = "STOPPED", properties: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": identifier, "kind": "processor", "type": processor_type, "name": name,
        "x": x, "y": y, "width": 190, "height": 78, "state": state, "validation": "VALID",
        "scheduling": {"strategy": "TIMER_DRIVEN", "period": "1 sec", "concurrentTasks": 1, "penalty": "30 sec", "yield": "1 sec"},
        "properties": properties or {},
        "relationships": [{"name": relation, "autoTerminate": processor_type in TERMINAL_TYPES} for relation in _catalog(processor_type)["relationships"]],
        "comments": "", "stats": {"in": 0, "out": 0, "readBytes": 0, "writtenBytes": 0, "tasks": 0, "errors": 0},
    }


def _connection(identifier: str, source: str, target: str, relationships: str | list[str], name: str, threshold: int = 10_000) -> dict[str, Any]:
    return {
        "id": identifier, "sourceId": source, "destinationId": target,
        "relationships": relationships if isinstance(relationships, list) else [relationships],
        "name": name, "bends": [],
        "queue": {"flowFiles": [], "objectThreshold": threshold, "dataSizeThreshold": 1_073_741_824, "expiration": "0 sec", "prioritizers": ["FirstInFirstOutPrioritizer"]},
    }


def demo_records() -> list[dict[str, Any]]:
    records = []
    base = datetime(2026, 8, 9, 8, 0, tzinfo=UTC).timestamp()
    for index in range(24):
        observed = datetime.fromtimestamp(base + index * 300, UTC).isoformat().replace("+00:00", "Z")
        records.append({
            "sensor_id": f"MS-{index % 8 + 1:03d}", "observed_at": observed,
            "displacement_mm": "" if index == 17 else f"{2.4 + math.sin(index / 3) * 1.8 + index * 0.09:.3f}",
            "velocity_mm_h": f"{0.18 + math.cos(index / 4) * 0.11:.3f}",
            "risk_level": "high" if index % 11 == 0 else "medium" if index % 5 == 0 else "low",
            "source": "edge-gateway-a" if index % 2 else "edge-gateway-b",
        })
    return records


def default_mappings() -> list[dict[str, Any]]:
    return [
        {"id": "map-1", "source": "sensor_id", "target": "sensor_id", "operation": "trim", "enabled": True},
        {"id": "map-2", "source": "observed_at", "target": "observed_at", "operation": "cast", "argument": "datetime", "enabled": True},
        {"id": "map-3", "source": "displacement_mm", "target": "displacement_mm", "operation": "cast", "argument": "number", "enabled": True},
        {"id": "map-4", "source": "velocity_mm_h", "target": "velocity_mm_h", "operation": "cast", "argument": "number", "enabled": True},
        {"id": "map-5", "source": "risk_level", "target": "risk_level", "operation": "lowercase", "enabled": True},
        {"id": "map-6", "source": "source", "target": "source", "operation": "trim", "enabled": True},
        {"id": "map-7", "source": "sensor_id", "target": "record_key", "operation": "hash", "enabled": True},
    ]


def default_rules() -> list[dict[str, Any]]:
    return [
        {"id": "rule-id", "name": "传感器编号完整", "type": "required", "field": "sensor_id", "severity": "error", "enabled": True},
        {"id": "rule-time", "name": "观测时间完整", "type": "required", "field": "observed_at", "severity": "error", "enabled": True},
        {"id": "rule-value", "name": "位移记录完整", "type": "required", "field": "displacement_mm", "severity": "error", "enabled": True},
        {"id": "rule-range", "name": "位移合理范围", "type": "range", "field": "displacement_mm", "min": -50, "max": 200, "severity": "error", "enabled": True},
        {"id": "rule-risk", "name": "风险等级枚举", "type": "enum", "field": "risk_level", "values": "low|medium|high", "severity": "warn", "enabled": True},
    ]


def default_routes() -> list[dict[str, Any]]:
    return [
        {"id": "route-high", "name": "high", "field": "risk_level", "operator": "eq", "value": "high", "enabled": True},
        {"id": "route-medium", "name": "medium", "field": "risk_level", "operator": "eq", "value": "medium", "enabled": True},
    ]


def create_default_flow() -> dict[str, Any]:
    processors = [
        _processor("p-ingest", "ListenHTTP", "现场监测接入", 80, 115, state="RUNNING", properties={"Listening Port": "9443", "Base Path": "/monitoring", "SSL Context Service": "StandardSSLContextService"}),
        _processor("p-convert", "ConvertRecord", "统一字段与单位", 350, 115, state="RUNNING", properties={"Record Reader": "JsonTreeReader", "Record Writer": "JsonRecordSetWriter", "Schema Access Strategy": "Use Schema Name"}),
        _processor("p-validate", "ValidateRecord", "质量与 Schema 门禁", 620, 115, state="RUNNING", properties={"Record Reader": "JsonTreeReader", "Schema Registry": "MonitoringSchemaRegistry", "Allow Extra Fields": "false"}),
        _processor("p-route", "RouteOnAttribute", "风险条件路由", 890, 115, state="RUNNING", properties={"high": "${risk_level:equals('high')}", "medium": "${risk_level:equals('medium')}"}),
        _processor("p-publish", "PutDatabaseRecord", "标准数据发布", 1180, 55, state="RUNNING", properties={"Record Reader": "JsonTreeReader", "Database Connection Pooling Service": "MonitoringDBCP", "Table Name": "observation_standard"}),
        _processor("p-warning", "PublishKafka", "预警主题发布", 1180, 175, state="RUNNING", properties={"Kafka Brokers": "ref:gateway/kafka-brokers", "Topic Name": "monitoring-warning", "Delivery Guarantee": "Guarantee Replicated Delivery"}),
        _processor("p-reject", "PutFile", "脏数据隔离区", 890, 320, state="RUNNING", properties={"Directory": "ref:gateway/dead-letter-directory", "Conflict Resolution Strategy": "fail"}),
    ]
    connections = [
        _connection("c-ingest-convert", "p-ingest", "p-convert", "success", "raw-monitoring"),
        _connection("c-ingest-failure", "p-ingest", "p-reject", "failure", "ingest-failure", 2000),
        _connection("c-convert-validate", "p-convert", "p-validate", "success", "normalized"),
        _connection("c-convert-failure", "p-convert", "p-reject", "failure", "parse-failure", 2000),
        _connection("c-valid-route", "p-validate", "p-route", "valid", "quality-passed"),
        _connection("c-invalid-reject", "p-validate", "p-reject", ["invalid", "failure"], "quality-rejected", 2000),
        _connection("c-route-publish", "p-route", "p-publish", ["medium", "unmatched"], "standard-output"),
        _connection("c-route-warning", "p-route", "p-warning", "high", "warning-output", 1000),
    ]
    return {
        "schema": "skyview-nifi-flow", "version": 2, "flowId": "pg-root", "name": "矿山多源监测数据网关", "revision": 1,
        "processors": processors, "connections": connections, "processGroups": [], "ports": [], "funnels": [],
        "labels": [{"id": "label-1", "x": 76, "y": 35, "text": "MONITORING INGEST → STANDARDIZE → QUALITY → ROUTE → DELIVERY"}],
        "mappings": default_mappings(), "rules": default_rules(), "routes": default_routes(), "sourceRecords": demo_records(), "inputLoaded": False,
        "controllerServices": [
            {"id": "svc-json-reader", "name": "JsonTreeReader", "type": "JsonTreeReader", "state": "ENABLED", "properties": {"Schema Access Strategy": "Infer Schema"}},
            {"id": "svc-json-writer", "name": "JsonRecordSetWriter", "type": "JsonRecordSetWriter", "state": "ENABLED", "properties": {"Schema Write Strategy": "Set 'avro.schema' Attribute"}},
            {"id": "svc-schema", "name": "MonitoringSchemaRegistry", "type": "AvroSchemaRegistry", "state": "ENABLED", "properties": {"Schema Name": "monitoring-observation-v1"}},
            {"id": "svc-dbcp", "name": "MonitoringDBCP", "type": "DBCPConnectionPool", "state": "DISABLED", "properties": {"Database URL": "ref:gateway/monitoring-db", "Password": "ref:gateway/monitoring-db-password"}},
            {"id": "svc-ssl", "name": "StandardSSLContextService", "type": "StandardRestrictedSSLContextService", "state": "ENABLED", "properties": {"Keystore": "ref:gateway/tls-keystore", "Truststore": "ref:gateway/tls-truststore"}},
        ],
        "parameterContext": {"id": "params-review", "name": "review-environment", "parameters": [
            {"name": "kafka.topic.warning", "value": "monitoring-warning", "sensitive": False},
            {"name": "db.password", "value": "ref:gateway/monitoring-db-password", "sensitive": True},
            {"name": "dead.letter.path", "value": "ref:gateway/dead-letter-directory", "sensitive": False},
        ]},
        "policies": [
            {"id": "policy-view", "resource": "/process-groups/pg-root", "action": "view", "users": ["researcher", "operator", "administrator"]},
            {"id": "policy-modify", "resource": "/process-groups/pg-root", "action": "modify", "users": ["operator", "administrator"]},
            {"id": "policy-provenance", "resource": "/provenance-data", "action": "view_provenance", "users": ["auditor", "administrator"]},
            {"id": "policy-data", "resource": "/data/pg-root", "action": "view_data", "users": ["operator", "administrator"]},
        ],
        "provenance": [], "bulletins": [], "outputArchive": [], "runHistory": [], "selectedId": "p-validate", "selectedKind": "processor",
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "updatedAt": _now(),
    }


def parse_dataset(text: str, format_name: str = "auto") -> list[dict[str, Any]]:
    source = text.lstrip("\ufeff").strip()
    if not source:
        return []
    resolved = format_name
    if resolved == "auto":
        resolved = "json" if source.startswith(("[", "{")) else "tsv" if "\t" in source.splitlines()[0] else "csv"
    if resolved == "json":
        try:
            parsed = json.loads(source)
        except json.JSONDecodeError as error:
            raise ToolError("JSON 数据格式无效") from error
        if isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
            parsed = parsed["records"]
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            raise ToolError("JSON 必须是对象数组或包含 records 数组")
        records = [item for item in parsed if isinstance(item, dict)]
    else:
        reader = csv.DictReader(io.StringIO(source), delimiter="\t" if resolved == "tsv" else ",")
        if not reader.fieldnames:
            raise ToolError("未识别到字段表头")
        records = [{str(key).strip(): value if value is not None else "" for key, value in row.items() if key is not None} for row in reader]
    if not records:
        raise ToolError("数据文件没有有效记录")
    if len(records) > 10_000:
        raise ToolError("本地预览一次最多处理 10000 行")
    return records


def _detect_type(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or str(value).lower() in {"true", "false"}:
        return "boolean"
    if isinstance(value, int) or re.fullmatch(r"[-+]?\d+", str(value).strip()):
        return "integer"
    try:
        float(value)
        return "number"
    except (TypeError, ValueError):
        pass
    if re.match(r"^\d{4}-\d{2}-\d{2}", str(value).strip()):
        return "datetime"
    return "string"


def infer_schema(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = list(dict.fromkeys(key for record in records for key in record))
    order = ["boolean", "integer", "number", "datetime", "string"]
    result = []
    for name in names:
        values = [record.get(name) for record in records]
        types = [_detect_type(value) for value in values]
        nonempty_types = [value for value in types if value]
        inferred = max(nonempty_types, key=order.index) if nonempty_types else "string"
        nonempty = [value for value in values if value not in (None, "")]
        result.append({"name": name, "type": inferred, "nullable": len(nonempty) != len(values), "completeness": len(nonempty) / len(values), "unique": len({str(value) for value in nonempty}), "sample": nonempty[:3]})
    return result


def _cast(value: Any, value_type: str) -> Any:
    if value in (None, ""):
        return value
    if value_type == "integer":
        return int(float(value))
    if value_type == "number":
        return float(value)
    if value_type == "boolean":
        return value is True or str(value).lower() in {"true", "1"}
    if value_type == "datetime":
        return str(value).replace(" ", "T")
    return str(value)


def apply_mappings(records: list[dict[str, Any]], mappings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active = [item for item in mappings if item.get("enabled", True) and item.get("target")]
    if not active:
        return copy.deepcopy(records)
    output = []
    for record in records:
        mapped: dict[str, Any] = {}
        for item in active:
            operation = item.get("operation", "copy")
            value = None if operation == "constant" else record.get(item.get("source"))
            if operation == "trim": value = str(value or "").strip()
            elif operation == "uppercase": value = str(value or "").upper()
            elif operation == "lowercase": value = str(value or "").lower()
            elif operation == "cast": value = _cast(value, str(item.get("argument") or "string"))
            elif operation == "multiply": value = float(value or 0) * float(item.get("argument") or 1)
            elif operation == "hash": value = stable_hash(value)
            elif operation == "constant": value = item.get("argument", "")
            mapped[str(item["target"])] = value
        output.append(mapped)
    return output


def evaluate_quality(records: list[dict[str, Any]], rules: list[dict[str, Any]]) -> dict[str, Any]:
    active = [item for item in rules if item.get("enabled", True)]
    violations = []
    rows = []
    for index, record in enumerate(records):
        failures = []
        for rule in active:
            value = record.get(rule.get("field"))
            rule_type = rule.get("type")
            passed = True
            if rule_type == "required": passed = value is not None and str(value).strip() != ""
            elif rule_type == "range":
                try: passed = value != "" and float(rule.get("min")) <= float(value) <= float(rule.get("max"))
                except (TypeError, ValueError): passed = False
            elif rule_type == "enum": passed = str(value) in [item.strip() for item in str(rule.get("values", "")).split("|")]
            elif rule_type == "regex":
                try: passed = re.search(str(rule.get("pattern") or ".*"), str(value or "")) is not None
                except re.error: passed = False
            elif rule_type == "unique": passed = next((position for position, item in enumerate(records) if str(item.get(rule.get("field"))) == str(value)), index) == index
            if not passed:
                failures.append(rule)
                violations.append({"row": index + 1, "ruleId": rule.get("id"), "field": rule.get("field"), "severity": rule.get("severity", "error"), "value": value})
        rows.append({"index": index, "passed": not any(item.get("severity", "error") == "error" for item in failures), "failures": [item.get("id") for item in failures]})
    checks = max(1, len(records) * max(1, len(active)))
    return {"score": max(0, 1 - len(violations) / checks), "passedRows": sum(item["passed"] for item in rows), "failedRows": sum(not item["passed"] for item in rows), "violations": violations, "rowResults": rows}


def validate_flow(flow: dict[str, Any]) -> list[dict[str, Any]]:
    issues = []
    processors = flow.get("processors") or []
    connections = flow.get("connections") or []
    processor_ids = {item.get("id") for item in processors}
    for item in processors:
        if item.get("type") not in {entry["type"] for entry in PROCESSOR_CATALOG}:
            issues.append({"level": "error", "componentId": item.get("id"), "code": "UNKNOWN_PROCESSOR", "message": "Processor type is not in the deterministic allowlist"})
        for name, value in (item.get("properties") or {}).items():
            if re.search(r"password|secret|token|key", str(name), re.I) and value and not str(value).startswith("ref:"):
                issues.append({"level": "error", "componentId": item.get("id"), "code": "PLAINTEXT_SECRET", "message": f"{name} must use a ref: reference"})
    for item in connections:
        if item.get("sourceId") not in processor_ids or item.get("destinationId") not in processor_ids:
            issues.append({"level": "error", "componentId": item.get("id"), "code": "BROKEN_CONNECTION", "message": "Connection source or destination does not exist"})
        queue = item.get("queue") or {}
        if len(queue.get("flowFiles") or []) >= int(queue.get("objectThreshold") or 10_000):
            issues.append({"level": "warning", "componentId": item.get("id"), "code": "BACK_PRESSURE", "message": "Connection reached its back-pressure threshold"})
    for service in flow.get("controllerServices") or []:
        for name, value in (service.get("properties") or {}).items():
            if re.search(r"password|secret|token|key", str(name), re.I) and value and not str(value).startswith("ref:"):
                issues.append({"level": "error", "componentId": service.get("id"), "code": "PLAINTEXT_SECRET", "message": f"{name} must use a ref: reference"})
    return issues


def _flow_file(record: dict[str, Any], index: int, started: int) -> dict[str, Any]:
    identifier = _uid("ff", f"{started + index}-{json.dumps(record, ensure_ascii=False, sort_keys=True)}")
    return {"uuid": identifier, "content": record, "attributes": {"uuid": identifier, "filename": f"{identifier}.json", "path": "./", "mime.type": "application/json", "source.type": "preview", "source.index": str(index + 1)}, "size": _size(record), "lineageStartDate": datetime.fromtimestamp((started + index) / 1000, UTC).isoformat().replace("+00:00", "Z"), "parentUuids": []}


def run_flow(flow_value: dict[str, Any], started: int | None = None) -> dict[str, Any]:
    flow = copy.deepcopy(flow_value)
    issues = [item for item in validate_flow(flow) if item["level"] == "error"]
    if issues:
        raise ToolError(f"数据流校验失败：{issues[0]['message']}")
    timestamp = int(started or time.time() * 1000)
    records = copy.deepcopy(flow.get("sourceRecords") or demo_records())
    if len(records) > 10_000:
        raise ToolError("预览运行一次最多处理 10000 行")
    mapped = apply_mappings(records, flow.get("mappings") or [])
    quality = evaluate_quality(mapped, flow.get("rules") or [])
    archive = []
    provenance = []

    def event(event_type: str, component_id: str, component_name: str, file_value: dict[str, Any], relation: str, offset: int) -> None:
        provenance.insert(0, {"id": _uid("evt", f"{timestamp}-{event_type}-{file_value['uuid']}-{offset}"), "eventType": event_type, "timestamp": datetime.fromtimestamp((timestamp + offset) / 1000, UTC).isoformat().replace("+00:00", "Z"), "componentId": component_id, "componentName": component_name, "componentType": next((item["type"] for item in flow["processors"] if item["id"] == component_id), "Connection"), "flowFileUuid": file_value["uuid"], "fileSize": file_value["size"], "attributes": copy.deepcopy(file_value["attributes"]), "parentUuids": copy.deepcopy(file_value["parentUuids"]), "details": f"{event_type} during controlled local preview", "relationship": relation, "connectionId": "c-ingest-convert" if event_type in {"RECEIVE", "REPLAY"} else "", "durationMs": 1, "flowFileSnapshot": copy.deepcopy(file_value)})

    for index, (raw, normalized) in enumerate(zip(records, mapped, strict=True)):
        flow_file = _flow_file(raw, index, timestamp)
        event("RECEIVE", "p-ingest", "现场监测接入", flow_file, "success", index * 5)
        flow_file["content"] = normalized
        flow_file["size"] = _size(normalized)
        flow_file["attributes"]["record.schema"] = "monitoring-observation-v1"
        event("CONTENT_MODIFIED", "p-convert", "统一字段与单位", flow_file, "success", index * 5 + 1)
        row = quality["rowResults"][index]
        relation = "valid" if row["passed"] else "invalid"
        event("VALIDATE", "p-validate", "质量与 Schema 门禁", flow_file, relation, index * 5 + 2)
        if row["passed"]:
            risk = str(normalized.get("risk_level") or "low")
            route = "high" if risk == "high" else "medium" if risk == "medium" else "unmatched"
            event("ROUTE", "p-route", "风险条件路由", flow_file, route, index * 5 + 3)
            target_id, target_name, target_type = ("p-warning", "预警主题发布", "PublishKafka") if route == "high" else ("p-publish", "标准数据发布", "PutDatabaseRecord")
        else:
            target_id, target_name, target_type = "p-reject", "脏数据隔离区", "PutFile"
        event("SEND", target_id, target_name, flow_file, "success", index * 5 + 4)
        archive.insert(0, {"processorId": target_id, "processorName": target_name, "type": target_type, "relationship": "success", "flowFileUuid": flow_file["uuid"], "content": copy.deepcopy(normalized), "attributes": copy.deepcopy(flow_file["attributes"]), "checksum": stable_hash(json.dumps(normalized, ensure_ascii=False, sort_keys=True)), "at": _now()})

    rejected = quality["failedRows"]
    published = len(records) - rejected
    summary = {"id": _uid("run", f"{timestamp}-{len(records)}-{published}"), "startedAt": datetime.fromtimestamp(timestamp / 1000, UTC).isoformat().replace("+00:00", "Z"), "completedAt": _now(), "processed": len(records) * 4 - rejected, "cycles": 5, "queued": 0, "published": published, "rejected": rejected, "highRisk": sum(item.get("risk_level") == "high" for item, row in zip(mapped, quality["rowResults"], strict=True) if row["passed"]), "provenanceEvents": len(provenance), "qualityScore": quality["score"]}
    flow["provenance"] = (provenance + (flow.get("provenance") or []))[:2000]
    flow["outputArchive"] = (archive + (flow.get("outputArchive") or []))[:500]
    flow["runHistory"] = [summary] + (flow.get("runHistory") or [])[:49]
    for connection in flow.get("connections") or []:
        connection.setdefault("queue", {})["flowFiles"] = []
    for processor in flow.get("processors") or []:
        stats = processor.setdefault("stats", {})
        if processor["id"] == "p-ingest": stats.update({"in": 0, "out": len(records), "writtenBytes": _size(records), "tasks": len(records), "errors": 0})
        if processor["id"] == "p-warning": stats.update({"in": summary["highRisk"], "out": summary["highRisk"], "tasks": summary["highRisk"], "errors": 0})
        if processor["id"] == "p-reject": stats.update({"in": rejected, "out": rejected, "tasks": rejected, "errors": 0})
    flow["inputLoaded"] = True
    flow["revision"] = int(flow.get("revision") or 0) + 1
    flow["updatedAt"] = _now()
    return {"flow": flow, "summary": summary, "quality": quality, "schema": infer_schema(mapped), "preview": mapped[:100]}


def replay(flow_value: dict[str, Any], event_id: str, connection_id: str) -> dict[str, Any]:
    flow = copy.deepcopy(flow_value)
    found = next((item for item in flow.get("provenance") or [] if item.get("id") == event_id), None)
    connection = next((item for item in flow.get("connections") or [] if item.get("id") == connection_id), None)
    if not found or not found.get("flowFileSnapshot"):
        raise ToolError("该事件没有可 replay 的内容快照")
    if not connection:
        raise ToolError("目标连接不存在")
    queued = connection.setdefault("queue", {}).setdefault("flowFiles", [])
    threshold = int(connection["queue"].get("objectThreshold") or 10_000)
    if len(queued) >= threshold:
        raise ToolError("目标队列已达到反压阈值")
    flow_file = copy.deepcopy(found["flowFileSnapshot"])
    parent = flow_file["uuid"]
    flow_file["uuid"] = _uid("ff", f"{parent}-replay-{time.time_ns()}")
    flow_file.setdefault("parentUuids", []).append(parent)
    flow_file.setdefault("attributes", {})["uuid"] = flow_file["uuid"]
    flow_file["attributes"]["replay.parent.uuid"] = parent
    queued.append(flow_file)
    event = {"id": _uid("evt", f"replay-{flow_file['uuid']}"), "eventType": "REPLAY", "timestamp": _now(), "componentId": connection["sourceId"], "componentName": connection["name"], "componentType": "Connection", "flowFileUuid": flow_file["uuid"], "fileSize": flow_file["size"], "attributes": flow_file["attributes"], "parentUuids": flow_file["parentUuids"], "details": f"Replay of {event_id}", "relationship": "replay", "connectionId": connection_id, "durationMs": 0, "flowFileSnapshot": copy.deepcopy(flow_file)}
    flow["provenance"] = [event] + (flow.get("provenance") or [])[:1999]
    flow["revision"] = int(flow.get("revision") or 0) + 1
    flow["updatedAt"] = _now()
    return {"flow": flow, "ok": True, "flowFileUuid": flow_file["uuid"], "parentUuid": parent}


def _flow_from_payload(payload: dict[str, Any], *, optional: bool = False) -> dict[str, Any] | None:
    value = payload.get("flow")
    if isinstance(value, str):
        try: value = json.loads(value)
        except json.JSONDecodeError as error: raise ToolError("flow 不是有效 JSON") from error
    if value is None and optional:
        return None
    if not isinstance(value, dict) or value.get("schema") != "skyview-nifi-flow" or int(value.get("version") or 0) != 2:
        raise ToolError("flow 必须是 skyview-nifi-flow v2")
    return value


def run_data_gateway(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "catalog":
        return {"catalog": PROCESSOR_CATALOG, "flow": create_default_flow()}
    if action == "preview":
        flow = _flow_from_payload(payload, optional=True) or create_default_flow()
        records = parse_dataset(str(payload.get("content") or ""), str(payload.get("format") or "auto"))
        flow = copy.deepcopy(flow)
        flow["sourceRecords"] = records
        flow["inputLoaded"] = False
        flow["revision"] = int(flow.get("revision") or 0) + 1
        flow["updatedAt"] = _now()
        return {"flow": flow, "rows": len(records), "schema": infer_schema(records), "preview": records[:100], "mode": "local-preview"}
    if action == "validate-flow":
        flow = _flow_from_payload(payload, optional=True)
        if flow is None:
            nodes = payload.get("nodes")
            connections = payload.get("connections")
            if isinstance(nodes, str): nodes = json.loads(nodes)
            if isinstance(connections, str): connections = json.loads(connections)
            allowed = {item["type"] for item in PROCESSOR_CATALOG}
            issues = []
            for node in nodes or []:
                if node.get("type") and node.get("type") not in allowed: issues.append({"level": "error", "componentId": node.get("id"), "code": "UNKNOWN_PROCESSOR", "message": "Processor type is not in the deterministic allowlist"})
                for name, value in (node.get("properties") or {}).items():
                    if re.search(r"password|secret|token|key", str(name), re.I) and value and not str(value).startswith("ref:"): issues.append({"level": "error", "componentId": node.get("id"), "code": "PLAINTEXT_SECRET", "message": f"{name} must use a ref: reference"})
            identifiers = {item.get("id") for item in nodes or []}
            for connection in connections or []:
                if connection.get("source") not in identifiers or connection.get("target") not in identifiers: issues.append({"level": "error", "componentId": "connection", "code": "BROKEN_CONNECTION", "message": "Connection source or destination does not exist"})
            return {"valid": not any(item["level"] == "error" for item in issues), "issues": issues, "processors": len(nodes or []), "connections": len(connections or [])}
        issues = validate_flow(flow)
        return {"valid": not any(item["level"] == "error" for item in issues), "issues": issues, "processors": len(flow["processors"]), "connections": len(flow["connections"]), "flow": flow}
    if action in {"run", "run-flow"}:
        return run_flow(_flow_from_payload(payload), int(payload.get("timestamp") or 0) or None)
    if action == "replay":
        return replay(_flow_from_payload(payload), str(payload.get("eventId") or ""), str(payload.get("connectionId") or "c-ingest-convert"))
    if action == "export":
        flow = _flow_from_payload(payload)
        safe_name = re.sub(r'[^\w\u4e00-\u9fff-]+', "-", str(flow.get("name") or "dataflow")).strip("-") or "dataflow"
        return {"flowJson": json.dumps(flow, ensure_ascii=False, indent=2), "provenanceJson": json.dumps({"schema": "skyview-nifi-provenance", "version": 1, "flowId": flow.get("flowId"), "exportedAt": _now(), "events": flow.get("provenance") or []}, ensure_ascii=False, indent=2), "files": {"flow": f"{safe_name}-flow.json", "provenance": f"{safe_name}-provenance.json"}}
    if action == "process":
        source = str(payload.get("csv") or payload.get("content") or "")
        records = parse_dataset(source, str(payload.get("format") or "auto"))
        mappings_value = payload.get("mappings") or {}
        required_value = payload.get("requiredFields") or []
        if isinstance(mappings_value, str): mappings_value = json.loads(mappings_value)
        if isinstance(required_value, str): required_value = json.loads(required_value)
        if isinstance(mappings_value, dict):
            mappings = [{"source": key, "target": value, "operation": "copy", "enabled": True} for key, value in mappings_value.items()]
            mapped = [{str(mappings_value.get(key, key)): value for key, value in row.items()} for row in records]
        else:
            mappings = mappings_value if isinstance(mappings_value, list) else []
            mapped = apply_mappings(records, mappings)
        rejected = [{"line": index + 2, "missing": [str(field) for field in required_value if str(row.get(str(field), "")).strip() == ""]} for index, row in enumerate(mapped)]
        rejected = [item for item in rejected if item["missing"]]
        accepted = [row for index, row in enumerate(mapped) if not any(item["line"] == index + 2 for item in rejected)]
        return {"received": len(records), "published": len(accepted), "rejected": len(rejected), "qualityScore": len(accepted) / len(records), "inputFields": list(records[0]), "schema": infer_schema(accepted), "violations": rejected[:200], "output": accepted[:500]}
    raise ToolError("不支持的数据网关操作")
