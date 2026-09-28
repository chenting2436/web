from __future__ import annotations

import json
import unittest

from app.tools import data_gateway_full as gateway


class DataGatewayParityTests(unittest.TestCase):
    def test_catalog_and_default_flow_preserve_card_version_structure(self) -> None:
        flow = gateway.create_default_flow()
        self.assertEqual(len(gateway.PROCESSOR_CATALOG), 26)
        self.assertEqual(flow["schema"], "skyview-nifi-flow")
        self.assertEqual(flow["version"], 2)
        for processor_type in ["ListenHTTP", "ConvertRecord", "ValidateRecord", "RouteOnAttribute", "PutDatabaseRecord", "PublishKafka", "PutFile"]:
            self.assertTrue(any(item["type"] == processor_type for item in flow["processors"]))
        self.assertFalse([item for item in gateway.validate_flow(flow) if item["level"] == "error"])

    def test_golden_preview_routes_records_and_drains_queues(self) -> None:
        output = gateway.run_flow(gateway.create_default_flow(), 1_700_000_000_000)
        self.assertEqual(output["summary"]["published"], 23)
        self.assertEqual(output["summary"]["rejected"], 1)
        self.assertEqual(output["summary"]["highRisk"], 3)
        self.assertEqual(output["summary"]["queued"], 0)
        self.assertTrue(all(not item["queue"]["flowFiles"] for item in output["flow"]["connections"]))
        self.assertTrue({"RECEIVE", "CONTENT_MODIFIED", "VALIDATE", "ROUTE", "SEND"}.issubset({item["eventType"] for item in output["flow"]["provenance"]}))

    def test_csv_preview_replay_and_exports_roundtrip(self) -> None:
        preview = gateway.run_data_gateway("preview", {"content": "id\tvalue\nA\t1\nB\t2", "format": "tsv"})
        self.assertEqual(preview["rows"], 2)
        run = gateway.run_flow(gateway.create_default_flow(), 1_700_000_000_000)
        source_event = next(item for item in run["flow"]["provenance"] if item["eventType"] == "SEND")
        replayed = gateway.replay(run["flow"], source_event["id"], "c-ingest-convert")
        self.assertTrue(replayed["ok"])
        self.assertNotEqual(replayed["flowFileUuid"], replayed["parentUuid"])
        self.assertEqual(replayed["flow"]["provenance"][0]["eventType"], "REPLAY")
        exported = gateway.run_data_gateway("export", {"flow": replayed["flow"]})
        restored = json.loads(exported["flowJson"])
        self.assertEqual(restored["schema"], "skyview-nifi-flow")
        self.assertEqual(json.loads(exported["provenanceJson"])["schema"], "skyview-nifi-provenance")

    def test_plaintext_connector_secrets_are_rejected(self) -> None:
        flow = gateway.create_default_flow()
        flow["processors"][0]["properties"]["Password"] = "plain-secret"
        issues = gateway.validate_flow(flow)
        self.assertTrue(any(item["code"] == "PLAINTEXT_SECRET" for item in issues))


if __name__ == "__main__":
    unittest.main()
