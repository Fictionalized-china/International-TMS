from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_full_flow_phase2 import (
    HANDOFF_SCHEMA,
    LTL_KEYS,
    ORDER_KEYS,
    PHASE2_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    Phase1Handoff,
    Phase2Artifacts,
    _public_preflight,
    augment_summary,
    build_handoff_payload,
    build_parser,
    load_phase1_handoff,
)
from tms_ui_credentials import CredentialRecord, CredentialVault
from ui_only_guard import scan_path


ORDERS = {
    "ftl": "SO2026090501001",
    "ltl1": "SO2026090501002",
    "ltl2": "SO2026090501003",
    "ltl3": "SO2026090501004",
}


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8-sig")


def credential_vault() -> CredentialVault:
    records = []
    for alias in REQUIRED_ACCOUNT_ALIASES:
        records.append(
            CredentialRecord(
                alias=alias,
                site="warehouse" if alias == "domestic_warehouse" else "admin",
                department="测试部门",
                role=alias,
                email=f"{alias}@secret.test",
                password=f"Secret-{alias}-123A",
            )
        )
    return CredentialVault(records)


class Phase1HandoffTests(unittest.TestCase):
    def test_reads_harness_summary_and_non_sensitive_entity_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {
                    "status": "passed",
                    "run_id": "phase1-a001-test",
                    "scenario": {
                        "attempt": {"entity_prefix": "UIE2E-20260905-A001-ABCDEF01"}
                    },
                    "entities": {
                        "order": ORDERS,
                        "customer": {"primary": "UI全流程验收客户"},
                    },
                },
            )
            result = load_phase1_handoff(path)
        self.assertEqual(result.source_run_id, "phase1-a001-test")
        self.assertEqual(result.source_entity_prefix, "UIE2E-20260905-A001-ABCDEF01")
        self.assertEqual(result.customer_name, "UI全流程验收客户")
        self.assertEqual(result.orders, ORDERS)

    def test_reads_phase1_cli_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "phase1-result.json"
            write_json(
                path,
                {
                    "status": "PASSED",
                    "run_id": "phase1-a002-test",
                    "entities": {"orders": ORDERS, "customer": "客户甲"},
                },
            )
            result = load_phase1_handoff(path)
        self.assertEqual(result.orders, ORDERS)
        self.assertEqual(result.customer_name, "客户甲")
        self.assertEqual(result.source_entity_prefix, "")

    def test_rejects_failed_phase1(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {"status": "blocked", "run_id": "phase1-a003", "entities": {"order": ORDERS}},
            )
            with self.assertRaisesRegex(ValueError, "必须为 passed"):
                load_phase1_handoff(path)

    def test_rejects_reused_order_numbers(self) -> None:
        duplicated = dict(ORDERS)
        duplicated["ltl3"] = duplicated["ltl2"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(
                path,
                {"status": "passed", "run_id": "phase1-a004", "entities": {"order": duplicated}},
            )
            with self.assertRaisesRegex(ValueError, "互不相同"):
                load_phase1_handoff(path)


class Phase2HandoffTests(unittest.TestCase):
    def test_handoff_has_stable_phase3_contract(self) -> None:
        phase1 = Phase1Handoff(
            source_run_id="phase1-a001-test",
            orders=dict(ORDERS),
            customer_name="客户甲",
            source_entity_prefix="UIE2E-20260905-A001-ABCDEF01",
        )
        artifacts = Phase2Artifacts(
            cargo_codes={
                "ftl": ["OUL-FTL-1"],
                "ltl1": ["OUL-LTL-1"],
                "ltl2": ["OUL-LTL-2"],
                "ltl3": ["OUL-LTL-3"],
            },
            batch_number="PZ-20260905-001",
            ftl_dispatch_number="OUT-260905-FTL01",
            ltl_dispatch_number="OUT-260905-LTL01",
            operation_assignee="操作员甲",
            document_assignee="单证员甲",
        )
        payload = build_handoff_payload(phase1, artifacts, ready_for_phase3=True)
        self.assertEqual(payload["schema"], HANDOFF_SCHEMA)
        self.assertEqual(
            payload["source_phase1_entity_prefix"],
            "UIE2E-20260905-A001-ABCDEF01",
        )
        self.assertEqual(payload["transport_batch"]["order_keys"], list(LTL_KEYS))
        self.assertEqual(
            payload["transport_batch"]["order_numbers"],
            [ORDERS[key] for key in LTL_KEYS],
        )
        self.assertEqual(payload["orders"]["ftl"]["business_type"], "ftl")
        self.assertEqual(payload["orders"]["ltl2"]["cargo_codes"], ["OUL-LTL-2"])
        self.assertEqual(
            payload["dispatches"]["ltl_batch"]["dispatch_number"],
            "OUT-260905-LTL01",
        )
        self.assertEqual(payload["completed_stages"], list(PHASE2_STAGE_ORDER))
        self.assertTrue(payload["ready_for_phase3"])

    def test_incomplete_handoff_never_claims_phase3_ready(self) -> None:
        phase1 = Phase1Handoff("phase1-a001", dict(ORDERS))
        payload = build_handoff_payload(
            phase1,
            Phase2Artifacts(),
            ready_for_phase3=False,
        )
        self.assertFalse(payload["ready_for_phase3"])
        self.assertEqual(payload["completed_stages"], [])
        self.assertEqual(payload["transport_batch"]["batch_number"], "")

    def test_augment_summary_preserves_harness_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(path, {"schema": "harness/v2", "status": "passed", "entities": {}})
            augment_summary(path, {"schema": HANDOFF_SCHEMA, "ready_for_phase3": True})
            result = json.loads(path.read_text(encoding="utf-8-sig"))
        self.assertEqual(result["schema"], "harness/v2")
        self.assertTrue(result["handoff"]["ready_for_phase3"])


class Phase2SafetyTests(unittest.TestCase):
    def test_execute_is_opt_in_and_phase1_summary_is_required(self) -> None:
        args = build_parser().parse_args(["--phase1-summary", "phase1.json"])
        self.assertFalse(args.execute)
        with self.assertRaises(SystemExit):
            build_parser().parse_args([])

    def test_preflight_has_no_business_writes_or_credentials(self) -> None:
        vault = credential_vault()
        phase1 = Phase1Handoff("phase1-a001", dict(ORDERS), "客户甲")
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fixture.pdf"
            fixture.write_bytes(b"%PDF-1.1\n%%EOF\n")
            payload = _public_preflight(
                vault,
                phase1,
                base_url="http://127.0.0.1:5189/",
                fixture_file=fixture,
            )
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["status"], "READY_NOT_EXECUTED")
        self.assertFalse(payload["business_writes"])
        self.assertNotIn("@secret.test", rendered)
        self.assertNotIn("Secret-", rendered)
        self.assertEqual(payload["orders"], ORDERS)
        self.assertEqual(payload["stage_order"], list(PHASE2_STAGE_ORDER))

    def test_stage_order_has_one_closed_batch_path(self) -> None:
        self.assertEqual(tuple(ORDER_KEYS), ("ftl", "ltl1", "ltl2", "ltl3"))
        self.assertLess(
            PHASE2_STAGE_ORDER.index("batch_assignment"),
            PHASE2_STAGE_ORDER.index("batch_loading_outbound"),
        )
        self.assertEqual(
            PHASE2_STAGE_ORDER[-1],
            "batch_sync_and_drawer_assertions",
        )

    def test_certification_scenario_passes_ui_only_static_guard(self) -> None:
        violations = scan_path(HERE / "tms_full_flow_phase2.py")
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
