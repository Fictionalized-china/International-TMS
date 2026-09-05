from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_full_flow_phase4 import (
    HANDOFF_SCHEMA,
    ORDER_KEYS,
    PHASE3_HANDOFF_SCHEMA,
    PHASE3_STAGE_ORDER,
    PHASE4_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    Phase3Handoff,
    Phase3Order,
    Phase4Artifacts,
    ReconciliationArtifact,
    WorkflowFieldObservation,
    _public_preflight,
    augment_summary,
    build_handoff_payload,
    build_parser,
    load_phase3_handoff,
    workflow_action_required,
)
from tms_ui_credentials import CredentialRecord, CredentialVault
from ui_only_guard import scan_path


ORDERS = {
    "ftl": "SO2026090502001",
    "ltl1": "SO2026090502002",
    "ltl2": "SO2026090502003",
    "ltl3": "SO2026090502004",
}


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8-sig")


def phase3_handoff_payload(*, ready: bool = True, orders: dict[str, str] | None = None) -> dict[str, object]:
    selected = orders or ORDERS
    return {
        "schema": PHASE3_HANDOFF_SCHEMA,
        "source_phase2_run_id": "phase2-a001-test",
        "source_phase1_run_id": "phase1-a001-test",
        "customer": {"name": "Phase4验收客户"},
        "orders": {
            key: {
                "order_number": value,
                "business_type": "ftl" if key == "ftl" else "ltl",
                "cargo_codes": [f"OUL-{key.upper()}-001"],
            }
            for key, value in selected.items()
        },
        "transport_batch": {"batch_number": "PZ-20260905-009"},
        "dispatches": {
            "ftl": "OUT-260905-FTL09",
            "ltl_batch": "OUT-260905-LTL09",
        },
        "certification_lineage": {
            "mode": "fresh-from-phase1",
            "root_phase1_run_id": "phase1-a001-test",
            "root_entity_prefix": "UIE2E-20260905-A001-ABCDEF01",
            "fresh_phase1_attempt": True,
            "recovery_branches_used": False,
            "source_phase2_run_id": "phase2-a001-test",
        },
        "oul_numbers": [f"OUL-{key.upper()}-001" for key in ORDER_KEYS],
        "customs_declarations": {key: f"CD-{key}" for key in ORDER_KEYS},
        "tracking_nodes": {"ftl": ["目的仓到达"], "ltl_batch": ["目的仓到达"]},
        "overseas_inbound": [f"OUL-{key.upper()}-001" for key in ORDER_KEYS],
        "appointed_order": selected["ftl"],
        "pickup_signed_orders": list(selected.values()),
        "completed_stages": list(PHASE3_STAGE_ORDER),
        "ready_for_phase4": ready,
    }


def phase3_source() -> Phase3Handoff:
    return Phase3Handoff(
        source_run_id="phase3-a001-test",
        source_phase2_run_id="phase2-a001-test",
        source_phase1_run_id="phase1-a001-test",
        customer_name="Phase4验收客户",
        orders={
            key: Phase3Order(
                order_number=number,
                business_type="ftl" if key == "ftl" else "ltl",
                cargo_codes=(f"OUL-{key.upper()}-001",),
            )
            for key, number in ORDERS.items()
        },
        transport_batch_number="PZ-20260905-009",
        dispatches={"ftl": "OUT-260905-FTL09", "ltl_batch": "OUT-260905-LTL09"},
        oul_numbers={key: (f"OUL-{key.upper()}-001",) for key in ORDER_KEYS},
        certification_lineage={
            "mode": "fresh-from-phase1",
            "root_phase1_run_id": "phase1-a001-test",
            "root_entity_prefix": "UIE2E-20260905-A001-ABCDEF01",
            "fresh_phase1_attempt": True,
            "recovery_branches_used": False,
            "source_phase2_run_id": "phase2-a001-test",
        },
    )


def credential_vault() -> CredentialVault:
    records = []
    for alias in REQUIRED_ACCOUNT_ALIASES:
        records.append(
            CredentialRecord(
                alias=alias,
                site="admin",
                department="测试部门",
                role=alias,
                email=f"{alias}@secret.test",
                password=f"Secret-{alias}-123A",
            )
        )
    records.append(
        CredentialRecord(
            alias="domestic_warehouse",
            site="warehouse",
            department="仓库",
            role="国内仓",
            email="warehouse@secret.test",
            password="Secret-warehouse-123A",
        )
    )
    return CredentialVault(records)


class Phase3HandoffTests(unittest.TestCase):
    def test_reads_phase3_harness_summary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase3-a001-test",
                    "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
                    "entities": {"order": ORDERS},
                    "handoff": phase3_handoff_payload(),
                },
            )
            result = load_phase3_handoff(path)
        self.assertEqual(result.source_run_id, "phase3-a001-test")
        self.assertEqual(result.source_phase2_run_id, "phase2-a001-test")
        self.assertEqual(result.customer_name, "Phase4验收客户")
        self.assertEqual(result.orders["ftl"].business_type, "ftl")
        self.assertEqual(result.orders["ltl2"].cargo_codes, ("OUL-LTL2-001",))
        self.assertEqual(result.transport_batch_number, "PZ-20260905-009")

    def test_reads_phase3_cli_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "phase3-result.json"
            summary = Path(directory) / "some-summary.json"
            write_json(
                summary,
                {
                    "status": "passed",
                    "run_id": "phase3-a002-test",
                    "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
                    "handoff": phase3_handoff_payload(),
                },
            )
            write_json(
                path,
                {
                    "status": "PASSED",
                    "run_id": "phase3-a002-test",
                    "summary": "some-summary.json",
                    "handoff": phase3_handoff_payload(),
                },
            )
            result = load_phase3_handoff(path)
        self.assertEqual(
            {key: item.order_number for key, item in result.orders.items()}, ORDERS
        )
        self.assertEqual(result.dispatches["ltl_batch"], "OUT-260905-LTL09")

    def test_rejects_not_ready_phase3(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase3-a003",
                    "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
                    "handoff": phase3_handoff_payload(ready=False),
                },
            )
            with self.assertRaisesRegex(ValueError, "ready_for_phase4"):
                load_phase3_handoff(path)

    def test_rejects_incomplete_pickup_signoff(self) -> None:
        payload = phase3_handoff_payload()
        payload["pickup_signed_orders"] = list(ORDERS.values())[:3]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {"status": "passed", "run_id": "phase3-a004", "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0}, "handoff": payload},
            )
            with self.assertRaisesRegex(ValueError, "四票境外仓扫码自提签收"):
                load_phase3_handoff(path)

    def test_rejects_reused_order_number(self) -> None:
        duplicated = dict(ORDERS)
        duplicated["ltl3"] = duplicated["ltl2"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase3-a005",
                    "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
                    "handoff": phase3_handoff_payload(orders=duplicated),
                },
            )
            with self.assertRaisesRegex(ValueError, "互不相同"):
                load_phase3_handoff(path)

    def test_rejects_nominal_pass_with_failed_phase3_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase3-a006",
                    "metrics": {"steps_failed": 0, "steps_blocked": 1, "gates_failed": 0},
                    "handoff": phase3_handoff_payload(),
                },
            )
            with self.assertRaisesRegex(ValueError, "失败证据"):
                load_phase3_handoff(path)

    def test_rejects_phase3_recovery_lineage(self) -> None:
        handoff = phase3_handoff_payload()
        handoff["certification_lineage"]["recovery_branches_used"] = True  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase3-a007",
                    "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
                    "handoff": handoff,
                },
            )
            with self.assertRaisesRegex(ValueError, "fresh attempt"):
                load_phase3_handoff(path)


class WorkflowGateTests(unittest.TestCase):
    def test_required_visible_field_requests_action(self) -> None:
        snapshot = {
            "cash_records": WorkflowFieldObservation(
                "cash_records", "收付款流水", True, True, False
            )
        }
        self.assertTrue(workflow_action_required(snapshot, "cash_records"))
        self.assertEqual(snapshot["cash_records"].configured_mode, "required")

    def test_optional_and_hidden_fields_do_not_request_action(self) -> None:
        snapshot = {
            "invoice_records": WorkflowFieldObservation(
                "invoice_records", "开票/收票记录", True, False, False
            )
        }
        self.assertFalse(workflow_action_required(snapshot, "invoice_records"))
        self.assertFalse(workflow_action_required(snapshot, "writeoff_records"))
        self.assertEqual(snapshot["invoice_records"].configured_mode, "optional")


class Phase4HandoffTests(unittest.TestCase):
    def test_handoff_has_stable_final_acceptance_contract(self) -> None:
        artifacts = Phase4Artifacts(
            workflow_gates={
                "ftl": {
                    "cash_records": {
                        "field_key": "cash_records",
                        "label": "收付款流水",
                        "active": True,
                        "required": True,
                        "present": True,
                        "configured_mode": "required",
                    }
                }
            },
            reconciliations={
                "REC20260905ABCDEF": ReconciliationArtifact(
                    document_number="REC20260905ABCDEF",
                    direction="receivable",
                    order_keys=["ftl"],
                    invoice_record_number="TAX20260905ABCDEF",
                    invoice_number="P4INV0905ABCDEF",
                    cash_transaction_number="CASH20260905ABCDEF",
                    settled=True,
                )
            },
            document_evidence={
                "ftl": ["账单", "收款凭证"],
                "ltl1": [],
                "ltl2": [],
                "ltl3": [],
            },
            closed_exceptions=["EX-260905-ABCDE"],
            archived_orders=list(ORDERS.values()),
        )
        payload = build_handoff_payload(
            phase3_source(), artifacts, ready_for_final_acceptance=True
        )
        self.assertEqual(payload["schema"], HANDOFF_SCHEMA)
        self.assertEqual(payload["source_phase3_run_id"], "phase3-a001-test")
        self.assertEqual(payload["orders"]["ltl3"]["business_type"], "ltl")
        self.assertEqual(payload["transport_batch"]["batch_number"], "PZ-20260905-009")
        self.assertTrue(payload["reconciliations"][0]["settled"])
        self.assertEqual(payload["archived_orders"], list(ORDERS.values()))
        self.assertEqual(payload["completed_stages"], list(PHASE4_STAGE_ORDER))
        self.assertTrue(payload["ready_for_final_acceptance"])
        self.assertEqual(
            payload["certification_lineage"]["source_phase3_run_id"],
            "phase3-a001-test",
        )

    def test_incomplete_handoff_never_claims_final_acceptance(self) -> None:
        payload = build_handoff_payload(
            phase3_source(), Phase4Artifacts(), ready_for_final_acceptance=False
        )
        self.assertFalse(payload["ready_for_final_acceptance"])
        self.assertEqual(payload["completed_stages"], [])
        self.assertEqual(payload["archived_orders"], [])

    def test_augment_summary_preserves_harness_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(path, {"schema": "harness/v2", "status": "passed", "entities": {}})
            augment_summary(
                path,
                {"schema": HANDOFF_SCHEMA, "ready_for_final_acceptance": True},
            )
            result = json.loads(path.read_text(encoding="utf-8-sig"))
        self.assertEqual(result["schema"], "harness/v2")
        self.assertTrue(result["handoff"]["ready_for_final_acceptance"])


class Phase4SafetyTests(unittest.TestCase):
    def test_execute_is_opt_in_and_phase3_summary_is_required(self) -> None:
        args = build_parser().parse_args(["--phase3-summary", "phase3.json"])
        self.assertFalse(args.execute)
        with self.assertRaises(SystemExit):
            build_parser().parse_args([])

    def test_preflight_has_no_business_writes_or_credentials(self) -> None:
        vault = credential_vault()
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fixture.pdf"
            fixture.write_bytes(b"%PDF-1.1\n%%EOF\n")
            payload = _public_preflight(
                vault,
                phase3_source(),
                base_url="http://127.0.0.1:5189/",
                fixture_file=fixture,
            )
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["status"], "READY_NOT_EXECUTED")
        self.assertFalse(payload["business_writes"])
        self.assertNotIn("@secret.test", rendered)
        self.assertNotIn("Secret-", rendered)
        self.assertEqual(payload["stage_order"], list(PHASE4_STAGE_ORDER))
        self.assertIn("隐藏项", payload["workflow_gate_policy"])

    def test_stage_order_preserves_financial_and_review_dependencies(self) -> None:
        self.assertLess(
            PHASE4_STAGE_ORDER.index("finance_expense_review"),
            PHASE4_STAGE_ORDER.index("reconciliation_and_invoice"),
        )
        self.assertLess(
            PHASE4_STAGE_ORDER.index("cash_and_writeoff"),
            PHASE4_STAGE_ORDER.index("completion_review_and_archive"),
        )
        self.assertEqual(
            PHASE4_STAGE_ORDER[-1], "completion_review_and_archive"
        )

    def test_certification_scenario_passes_ui_only_static_guard(self) -> None:
        violations = scan_path(HERE / "tms_full_flow_phase4.py")
        self.assertEqual(
            violations,
            [],
            "\n".join(
                f"{item.line}:{item.column} [{item.code}] {item.message}"
                for item in violations
            ),
        )


if __name__ == "__main__":
    unittest.main()
