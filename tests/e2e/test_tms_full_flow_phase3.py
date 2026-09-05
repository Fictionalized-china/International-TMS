from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_full_flow_phase3 import (
    LTL_KEYS,
    ORDER_KEYS,
    PHASE3_HANDOFF_SCHEMA,
    PHASE3_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    Phase3Artifacts,
    _public_preflight,
    build_handoff_payload,
    build_parser,
    derive_phase1_entity_prefix,
    load_phase2_handoff,
    portal_email_from_entity_prefix,
)
from tms_ui_credentials import CredentialRecord, CredentialVault
from ui_only_guard import scan_path


def valid_phase2_payload(*, include_prefix: bool = True) -> dict[str, object]:
    orders = {
        "ftl": {
            "order_number": "SO2026090500101",
            "business_type": "ftl",
            "cargo_codes": ["OUL-20260905-FTL01"],
        },
        "ltl1": {
            "order_number": "SO2026090500102",
            "business_type": "ltl",
            "cargo_codes": ["OUL-20260905-LTL01"],
        },
        "ltl2": {
            "order_number": "SO2026090500103",
            "business_type": "ltl",
            "cargo_codes": ["OUL-20260905-LTL02"],
        },
        "ltl3": {
            "order_number": "SO2026090500104",
            "business_type": "ltl",
            "cargo_codes": ["OUL-20260905-LTL03"],
        },
    }
    handoff: dict[str, object] = {
        "schema": "international-tms-full-flow-phase2-handoff/v1",
        "source_phase1_run_id": (
            "phase1-one-ftl-three-ltl-a003-20260905150000-abcdef12"
        ),
        "customer": {"name": "UI全流程验收客户-ABCDEF12"},
        "orders": orders,
        "transport_batch": {
            "batch_number": "PZ-20260905-001",
            "order_keys": list(LTL_KEYS),
            "order_numbers": [
                orders[key]["order_number"]  # type: ignore[index]
                for key in LTL_KEYS
            ],
        },
        "dispatches": {
            "ftl": {"dispatch_number": "OUT-20260905-FTL01"},
            "ltl_batch": {"dispatch_number": "OUT-20260905-PZ001"},
        },
        "assignees": {
            "operation": "PZ接管操作二号",
            "document": "PZ接管单证二号",
            "operation_alias": "operation_2",
            "document_alias": "document_2",
        },
        "completed_stages": ["domestic_transport", "batch_loading_outbound"],
        "ready_for_phase3": True,
    }
    if include_prefix:
        handoff["source_phase1_entity_prefix"] = (
            "UIE2E-20260905150000-A003-ABCDEF12"
        )
    return {
        "schema": "international-tms-ui-only-run/v2",
        "run_id": "phase2-source-20260905160000-12345678",
        "status": "passed",
        "handoff": handoff,
    }


def write_payload(root: Path, payload: dict[str, object]) -> Path:
    path = root / "phase2-summary.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8-sig")
    return path


def credential_vault() -> CredentialVault:
    records: list[CredentialRecord] = []
    for alias in REQUIRED_ACCOUNT_ALIASES:
        site = "portal" if alias == "customer" else (
            "warehouse" if alias == "overseas_warehouse" else "admin"
        )
        records.append(
            CredentialRecord(
                alias=alias,
                site=site,
                department="测试部门",
                role=alias,
                email=f"{alias}@secret.test",
                password=f"Secret-{alias}-123A",
            )
        )
    return CredentialVault(records)


class Phase3HandoffInputTests(unittest.TestCase):
    def test_loads_phase2_handoff_with_all_identifiers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = load_phase2_handoff(
                write_payload(Path(directory), valid_phase2_payload())
            )
        self.assertEqual([item.key for item in source.orders], list(ORDER_KEYS))
        self.assertEqual(source.batch_number, "PZ-20260905-001")
        self.assertEqual(source.dispatches["ftl"], "OUT-20260905-FTL01")
        self.assertEqual(len(source.all_cargo_codes), 4)
        self.assertEqual(source.order("ltl3").business_type, "ltl")
        self.assertEqual(source.batch_operation_alias, "operation_2")
        self.assertEqual(source.batch_document_alias, "document_2")

    def test_derives_non_secret_prefix_from_phase1_run_id_for_old_envelope(self) -> None:
        payload = valid_phase2_payload(include_prefix=False)
        with tempfile.TemporaryDirectory() as directory:
            source = load_phase2_handoff(write_payload(Path(directory), payload))
        self.assertEqual(
            source.source_phase1_entity_prefix,
            "UIE2E-20260905150000-A003-ABCDEF12",
        )
        self.assertEqual(
            portal_email_from_entity_prefix(source.source_phase1_entity_prefix),
            "uie2e.phase1.uie2e20260905150000a003abcdef12@example.test",
        )

    def test_rejects_phase2_that_is_not_ready(self) -> None:
        payload = valid_phase2_payload()
        payload["handoff"]["ready_for_phase3"] = False  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            path = write_payload(Path(directory), payload)
            with self.assertRaisesRegex(ValueError, "ready_for_phase3"):
                load_phase2_handoff(path)

    def test_rejects_batch_order_mismatch(self) -> None:
        payload = valid_phase2_payload()
        payload["handoff"]["transport_batch"]["order_numbers"][0] = (  # type: ignore[index]
            "SO2026090599999"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = write_payload(Path(directory), payload)
            with self.assertRaisesRegex(ValueError, "挂载订单号"):
                load_phase2_handoff(path)

    def test_rejects_duplicate_oul_across_orders(self) -> None:
        payload = valid_phase2_payload()
        payload["handoff"]["orders"]["ltl3"]["cargo_codes"] = [  # type: ignore[index]
            "OUL-20260905-LTL01"
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = write_payload(Path(directory), payload)
            with self.assertRaisesRegex(ValueError, "不能复用"):
                load_phase2_handoff(path)

    def test_rejects_missing_customer_name(self) -> None:
        payload = valid_phase2_payload()
        payload["handoff"]["customer"] = {"name": ""}  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            path = write_payload(Path(directory), payload)
            with self.assertRaisesRegex(ValueError, "客户名称"):
                load_phase2_handoff(path)

    def test_rejects_pz_handoff_that_reuses_primary_accounts(self) -> None:
        payload = valid_phase2_payload()
        payload["handoff"]["assignees"]["operation_alias"] = "operation"  # type: ignore[index]
        payload["handoff"]["assignees"]["document_alias"] = "document"  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            path = write_payload(Path(directory), payload)
            with self.assertRaisesRegex(ValueError, "operation_2"):
                load_phase2_handoff(path)

    def test_run_id_derivation_rejects_unstructured_value(self) -> None:
        self.assertEqual(derive_phase1_entity_prefix("legacy-run"), "")


class Phase3SafetyAndOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = load_phase2_handoff(
            write_payload(self.root, valid_phase2_payload())
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_execute_is_opt_in(self) -> None:
        args = build_parser().parse_args(["--phase2-summary", "summary.json"])
        self.assertFalse(args.execute)

    def test_preflight_does_not_serialize_credentials_or_portal_email(self) -> None:
        fixture = HERE / "fixtures" / "tms-phase2-document.pdf"
        payload = _public_preflight(
            credential_vault(),
            self.source,
            base_url="http://127.0.0.1:5189",
            fixture_file=fixture,
        )
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["status"], "READY_NOT_EXECUTED")
        self.assertFalse(payload["business_writes"])
        self.assertTrue(payload["portal_identity_reconstructable"])
        self.assertEqual(payload["pz_runtime_roles"], ["operation_2", "document_2"])
        self.assertNotIn("@secret.test", rendered)
        self.assertNotIn("Secret-", rendered)
        self.assertNotIn("uie2e.phase1", rendered)

    def test_phase3_handoff_carries_business_evidence_without_login_identity(self) -> None:
        artifacts = Phase3Artifacts(
            customs_declarations={
                "ftl": "E2E-FTL-01",
                "ltl1": "E2E-LTL1-02",
                "ltl2": "E2E-LTL2-03",
                "ltl3": "E2E-LTL3-04",
            },
            completed_tracking_nodes={
                "ftl": [
                    "border_arrived",
                    "exported",
                    "foreign_entered",
                    "customs_cleared",
                ],
                "ltl_batch": [
                    "border_arrived",
                    "exported",
                    "foreign_entered",
                    "customs_cleared",
                ],
            },
            inbound_cargo_codes=list(self.source.all_cargo_codes),
            pickup_cargo_codes=list(self.source.all_cargo_codes),
            appointed_order=self.source.order("ftl").order_number,
            signed_orders=[item.order_number for item in self.source.orders],
        )
        payload = build_handoff_payload(
            self.source, artifacts, ready_for_phase4=True
        )
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["schema"], PHASE3_HANDOFF_SCHEMA)
        self.assertTrue(payload["ready_for_phase4"])
        self.assertEqual(payload["completed_stages"], list(PHASE3_STAGE_ORDER))
        self.assertEqual(len(payload["oul_numbers"]), 4)
        self.assertEqual(len(payload["pickup_signed_orders"]), 4)
        self.assertNotIn("entity_prefix", rendered)
        self.assertNotIn("@example.test", rendered)

    def test_stage_order_ends_at_pickup_signoff(self) -> None:
        self.assertEqual(
            PHASE3_STAGE_ORDER[-2:],
            (
                "customer_notification_and_optional_appointment",
                "overseas_pickup_scan_and_signoff",
            ),
        )

    def test_certification_scenario_passes_ui_only_static_guard(self) -> None:
        violations = scan_path(HERE / "tms_full_flow_phase3.py")
        self.assertEqual(
            violations,
            [],
            "\n".join(
                f"{item.line}:{item.column} [{item.code}] {item.message}"
                for item in violations
            ),
        )

    def test_phase3_separates_ftl_and_pz_responsibility_sessions(self) -> None:
        source = (HERE / "tms_full_flow_phase3.py").read_text(encoding="utf-8")
        self.assertIn('self.operation = self._add_role("operation")', source)
        self.assertIn('self.document = self._add_role("document")', source)
        self.assertIn('self.batch_operation = self._add_role(source.batch_operation_alias)', source)
        self.assertIn('self.batch_document = self._add_role(source.batch_document_alias)', source)
        self.assertIn("session = self.batch_operation", source)
        self.assertIn("session = self.batch_document", source)


if __name__ == "__main__":
    unittest.main()
