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
    PHASE2_NEGATIVE_GATE_CASES,
    PHASE2_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    Phase1Handoff,
    Phase2Artifacts,
    _public_preflight,
    acceptance_rejection_message,
    augment_summary,
    build_handoff_payload,
    build_parser,
    certify_oul_label_counts,
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
EXPECTED_PIECES = {"ftl": 2, "ltl1": 3, "ltl2": 4, "ltl3": 5}


def certified_phase1_payload(
    *,
    run_id: str = "phase1-a001-test",
    orders: dict[str, str] | None = None,
) -> dict[str, object]:
    return {
        "status": "passed",
        "run_id": run_id,
        "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 0},
        "scenario": {
            "attempt": {
                "attempt": 1,
                "run_id": run_id,
                "entity_prefix": "UIE2E-20260905-A001-ABCDEF01",
            }
        },
        "certification_constraints": {"failure_requires_fresh_entities": True},
        "entities": {
            "order": orders or ORDERS,
            "expected_pieces": {
                key: str(value) for key, value in EXPECTED_PIECES.items()
            },
            "customer": {"primary": "UI全流程验收客户"},
        },
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
                certified_phase1_payload(),
            )
            result = load_phase1_handoff(path)
        self.assertEqual(result.source_run_id, "phase1-a001-test")
        self.assertEqual(result.source_entity_prefix, "UIE2E-20260905-A001-ABCDEF01")
        self.assertEqual(result.customer_name, "UI全流程验收客户")
        self.assertEqual(result.orders, ORDERS)
        self.assertEqual(result.expected_pieces, EXPECTED_PIECES)
        self.assertTrue(result.fresh_attempt_verified)

    def test_reads_phase1_cli_envelope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "phase1-result.json"
            summary = Path(directory) / "phase1-summary.json"
            write_json(summary, certified_phase1_payload(run_id="phase1-a002-test"))
            write_json(
                path,
                {
                    "status": "PASSED",
                    "run_id": "phase1-a002-test",
                    "summary": summary.name,
                },
            )
            result = load_phase1_handoff(path)
        self.assertEqual(result.orders, ORDERS)
        self.assertEqual(result.customer_name, "UI全流程验收客户")
        self.assertEqual(result.source_entity_prefix, "UIE2E-20260905-A001-ABCDEF01")

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
                certified_phase1_payload(run_id="phase1-a004", orders=duplicated),
            )
            with self.assertRaisesRegex(ValueError, "互不相同"):
                load_phase1_handoff(path)

    def test_rejects_nominal_pass_with_failed_metrics(self) -> None:
        payload = certified_phase1_payload()
        payload["metrics"]["gates_failed"] = 1  # type: ignore[index]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(path, payload)
            with self.assertRaisesRegex(ValueError, "失败证据"):
                load_phase1_handoff(path)

    def test_rejects_pass_without_fresh_attempt_lineage(self) -> None:
        payload = certified_phase1_payload()
        payload["scenario"] = {"attempt": None}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(path, payload)
            with self.assertRaisesRegex(ValueError, "fresh attempt"):
                load_phase1_handoff(path)

    def test_rejects_old_summary_without_expected_pieces(self) -> None:
        payload = certified_phase1_payload()
        payload["entities"].pop("expected_pieces")  # type: ignore[union-attr]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.json"
            write_json(path, payload)
            with self.assertRaisesRegex(ValueError, "entities.expected_pieces"):
                load_phase1_handoff(path)

    def test_rejects_missing_or_invalid_expected_piece_values(self) -> None:
        invalid_values = {
            "missing": None,
            "zero": 0,
            "boolean": True,
            "float": 2.0,
            "fraction": "2.5",
        }
        for label, invalid in invalid_values.items():
            with self.subTest(label=label):
                payload = certified_phase1_payload()
                expected = payload["entities"]["expected_pieces"]  # type: ignore[index]
                if label == "missing":
                    expected.pop("ftl")
                else:
                    expected["ftl"] = invalid
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "summary.json"
                    write_json(path, payload)
                    with self.assertRaisesRegex(ValueError, "ftl.*正整数"):
                        load_phase1_handoff(path)


class Phase2HandoffTests(unittest.TestCase):
    def test_handoff_has_stable_phase3_contract(self) -> None:
        phase1 = Phase1Handoff(
            source_run_id="phase1-a001-test",
            orders=dict(ORDERS),
            customer_name="客户甲",
            source_entity_prefix="UIE2E-20260905-A001-ABCDEF01",
            expected_pieces=dict(EXPECTED_PIECES),
            fresh_attempt_verified=True,
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
        self.assertEqual(payload["orders"]["ftl"]["expected_pieces"], 2)
        self.assertEqual(payload["orders"]["ltl2"]["cargo_codes"], ["OUL-LTL-2"])
        self.assertEqual(
            payload["dispatches"]["ltl_batch"]["dispatch_number"],
            "OUT-260905-LTL01",
        )
        self.assertEqual(payload["assignees"]["operation_alias"], "operation_2")
        self.assertEqual(payload["assignees"]["document_alias"], "document_2")
        self.assertEqual(payload["completed_stages"], list(PHASE2_STAGE_ORDER))
        self.assertTrue(payload["ready_for_phase3"])
        self.assertTrue(payload["certification_lineage"]["fresh_phase1_attempt"])
        self.assertFalse(payload["certification_lineage"]["recovery_branches_used"])

    def test_incomplete_handoff_never_claims_phase3_ready(self) -> None:
        phase1 = Phase1Handoff(
            "phase1-a001",
            dict(ORDERS),
            expected_pieces=dict(EXPECTED_PIECES),
        )
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
    def test_formal_flow_executes_scan_and_old_owner_negative_gates(self) -> None:
        self.assertEqual(
            PHASE2_NEGATIVE_GATE_CASES,
            (
                "P2-NEG-SCAN-CROSS-ORDER",
                "P2-NEG-SCAN-DUPLICATE",
                "P2-NEG-PZ-OLD-OWNER-DEEP-LINK",
                "P2-NEG-CHILD-OLD-OPERATION",
            ),
        )

    def test_execute_is_opt_in_and_phase1_summary_is_required(self) -> None:
        args = build_parser().parse_args(["--phase1-summary", "phase1.json"])
        self.assertFalse(args.execute)
        with self.assertRaises(SystemExit):
            build_parser().parse_args([])

    def test_preflight_has_no_business_writes_or_credentials(self) -> None:
        vault = credential_vault()
        phase1 = Phase1Handoff(
            "phase1-a001",
            dict(ORDERS),
            "客户甲",
            expected_pieces=dict(EXPECTED_PIECES),
        )
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
        self.assertEqual(payload["expected_pieces"], EXPECTED_PIECES)
        self.assertEqual(payload["derived_runtime_roles"], ["operation_2", "document_2"])
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

    def test_phase2_uses_primary_for_ordinary_and_secondary_for_pz(self) -> None:
        source = (HERE / "tms_full_flow_phase2.py").read_text(encoding="utf-8")
        self.assertIn('self.operation = self._add_role("operation")', source)
        self.assertIn('self.batch_operation = self._add_role("operation_2")', source)
        self.assertIn('self.credentials["document_2"].role', source)
        self.assertNotIn(
            'self.credentials.get("operation_2", self.credentials["operation"])',
            source,
        )

    def test_acceptance_rejection_is_reported_as_business_blocker_detail(self) -> None:
        self.assertEqual(
            acceptance_rejection_message(
                "SO2026090501001",
                "累计实收与预录差异较大\n请选择异常入库",
            ),
            "SO2026090501001 验收入库被系统拒绝：累计实收与预录差异较大 请选择异常入库",
        )
        self.assertEqual(
            acceptance_rejection_message("SO2026090501001", "  "),
            "SO2026090501001 验收入库被系统拒绝：页面没有返回可读的错误详情",
        )

    def test_exact_label_and_unique_oul_counts_are_certified(self) -> None:
        self.assertEqual(
            certify_oul_label_counts(
                "SO2026090501001",
                expected_pieces=2,
                rendered_label_count=2,
                rendered_codes=["oul-a-1", "OUL-A-1", "OUL-B-2", "OUL-B-2"],
            ),
            ["OUL-A-1", "OUL-B-2"],
        )

    def test_missing_extra_or_duplicate_oul_labels_are_rejected(self) -> None:
        cases = (
            (1, ["OUL-A-1", "OUL-B-2"], "页面 1 张，唯一 OUL 2 个"),
            (3, ["OUL-A-1", "OUL-B-2"], "页面 3 张，唯一 OUL 2 个"),
            (2, ["OUL-A-1", "OUL-A-1"], "页面 2 张，唯一 OUL 1 个"),
        )
        for label_count, codes, expected_detail in cases:
            with self.subTest(label_count=label_count, codes=codes):
                with self.assertRaisesRegex(ValueError, expected_detail):
                    certify_oul_label_counts(
                        "SO2026090501001",
                        expected_pieces=2,
                        rendered_label_count=label_count,
                        rendered_codes=codes,
                    )


if __name__ == "__main__":
    unittest.main()
