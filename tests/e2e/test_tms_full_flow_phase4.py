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
EXPECTED_PIECES = {"ftl": 2, "ltl1": 3, "ltl2": 4, "ltl3": 5}
TRACKING_NODES = [
    "border_arrived",
    "exported",
    "foreign_entered",
    "customs_cleared",
]


def cargo_codes(key: str) -> list[str]:
    return [
        f"OUL-{key.upper()}-{index:03d}"
        for index in range(1, EXPECTED_PIECES[key] + 1)
    ]


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8-sig")


def load_phase3_payload(handoff: dict[str, object]) -> Phase3Handoff:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "summary.json"
        write_json(
            path,
            {
                "status": "passed",
                "run_id": "phase3-contract-test",
                "metrics": {
                    "steps_failed": 0,
                    "steps_blocked": 0,
                    "gates_failed": 0,
                },
                "handoff": handoff,
            },
        )
        return load_phase3_handoff(path)


def phase3_handoff_payload(*, ready: bool = True, orders: dict[str, str] | None = None) -> dict[str, object]:
    selected = orders or ORDERS
    return {
        "schema": PHASE3_HANDOFF_SCHEMA,
        "source_phase2_run_id": "phase2-a001-test",
        "source_phase1_run_id": "phase1-a001-test",
        "source_phase1_entity_prefix": "UIE2E-20260905-A001-ABCDEF01",
        "customer": {"name": "Phase4验收客户"},
        "orders": {
            key: {
                "order_number": value,
                "business_type": "ftl" if key == "ftl" else "ltl",
                "expected_pieces": EXPECTED_PIECES[key],
                "cargo_codes": cargo_codes(key),
            }
            for key, value in selected.items()
        },
        "transport_batch": {
            "batch_number": "PZ-20260905-009",
            "order_keys": ["ltl1", "ltl2", "ltl3"],
            "order_numbers": [selected[key] for key in ("ltl1", "ltl2", "ltl3")],
        },
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
        "oul_numbers": {key: cargo_codes(key) for key in ORDER_KEYS},
        "customs_declarations": {key: f"CD-{key}" for key in ORDER_KEYS},
        "tracking_nodes": {
            "ftl": list(TRACKING_NODES),
            "ltl_batch": list(TRACKING_NODES),
        },
        "overseas_inbound": [code for key in ORDER_KEYS for code in cargo_codes(key)],
        "appointed_order": selected["ftl"],
        "pickup_cargo_codes": [
            code for key in ORDER_KEYS for code in cargo_codes(key)
        ],
        "pickup_signed_orders": list(selected.values()),
        "completed_stages": list(PHASE3_STAGE_ORDER),
        "ready_for_phase4": ready,
    }


def phase3_source() -> Phase3Handoff:
    return Phase3Handoff(
        source_run_id="phase3-a001-test",
        source_phase2_run_id="phase2-a001-test",
        source_phase1_run_id="phase1-a001-test",
        source_phase1_entity_prefix="UIE2E-20260905-A001-ABCDEF01",
        customer_name="Phase4验收客户",
        orders={
            key: Phase3Order(
                order_number=number,
                business_type="ftl" if key == "ftl" else "ltl",
                expected_pieces=EXPECTED_PIECES[key],
                cargo_codes=tuple(cargo_codes(key)),
            )
            for key, number in ORDERS.items()
        },
        transport_batch_number="PZ-20260905-009",
        transport_batch_order_keys=("ltl1", "ltl2", "ltl3"),
        transport_batch_order_numbers=tuple(
            ORDERS[key] for key in ("ltl1", "ltl2", "ltl3")
        ),
        dispatches={"ftl": "OUT-260905-FTL09", "ltl_batch": "OUT-260905-LTL09"},
        oul_numbers={key: tuple(cargo_codes(key)) for key in ORDER_KEYS},
        customs_declarations={key: f"CD-{key}" for key in ORDER_KEYS},
        tracking_nodes={
            "ftl": tuple(TRACKING_NODES),
            "ltl_batch": tuple(TRACKING_NODES),
        },
        overseas_inbound=tuple(
            code for key in ORDER_KEYS for code in cargo_codes(key)
        ),
        pickup_cargo_codes=tuple(
            code for key in ORDER_KEYS for code in cargo_codes(key)
        ),
        appointed_order=ORDERS["ftl"],
        pickup_signed_orders=tuple(ORDERS.values()),
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
        self.assertEqual(result.orders["ltl2"].cargo_codes, tuple(cargo_codes("ltl2")))
        self.assertEqual(result.orders["ltl2"].expected_pieces, 4)
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

    def test_rejects_pz_membership_or_oul_contract_drift(self) -> None:
        cases = (
            ("pz_membership", "PZ 挂载订单号"),
            ("flat_oul", "handoff.oul_numbers.*JSON 对象"),
            ("oul_mismatch", "OUL 汇总.*cargo_codes"),
            ("cross_order_oul", "不同订单之间不能复用"),
        )
        for case, expected_error in cases:
            with self.subTest(case=case):
                handoff = phase3_handoff_payload()
                if case == "pz_membership":
                    handoff["transport_batch"]["order_numbers"][0] = ORDERS["ftl"]  # type: ignore[index]
                elif case == "flat_oul":
                    handoff["oul_numbers"] = [
                        code for key in ORDER_KEYS for code in cargo_codes(key)
                    ]
                elif case == "oul_mismatch":
                    handoff["oul_numbers"]["ltl3"].pop()  # type: ignore[index]
                else:
                    duplicate = cargo_codes("ltl1")[0]
                    handoff["orders"]["ltl3"]["cargo_codes"][0] = duplicate  # type: ignore[index]
                with self.assertRaisesRegex(ValueError, expected_error):
                    load_phase3_payload(handoff)

    def test_rejects_missing_phase3_business_evidence(self) -> None:
        cases = (
            ("customs", "报关单交接键"),
            ("tracking", "必经运踪节点"),
            ("inbound", "境外入库 OUL"),
            ("pickup", "自提扫码 OUL"),
            ("dispatch", "有效装车任务号"),
        )
        for case, expected_error in cases:
            with self.subTest(case=case):
                handoff = phase3_handoff_payload()
                if case == "customs":
                    handoff["customs_declarations"].pop("ltl3")  # type: ignore[union-attr]
                elif case == "tracking":
                    handoff["tracking_nodes"]["ftl"].pop()  # type: ignore[index]
                elif case == "inbound":
                    handoff["overseas_inbound"].pop()  # type: ignore[union-attr]
                elif case == "pickup":
                    handoff["pickup_cargo_codes"].pop()  # type: ignore[union-attr]
                else:
                    handoff["dispatches"]["ftl"] = ""  # type: ignore[index]
                with self.assertRaisesRegex(ValueError, expected_error):
                    load_phase3_payload(handoff)

    def test_rejects_empty_or_inconsistent_certification_lineage(self) -> None:
        cases = (
            ("phase1", "Phase 1/2 run_id"),
            ("phase2", "Phase 1/2 run_id"),
            ("prefix_missing", "fresh entity_prefix"),
            ("prefix_mismatch", "entity_prefix.*认证链路"),
        )
        for case, expected_error in cases:
            with self.subTest(case=case):
                handoff = phase3_handoff_payload()
                if case == "phase1":
                    handoff["source_phase1_run_id"] = ""
                    handoff["certification_lineage"]["root_phase1_run_id"] = ""  # type: ignore[index]
                elif case == "phase2":
                    handoff["source_phase2_run_id"] = ""
                    handoff["certification_lineage"]["source_phase2_run_id"] = ""  # type: ignore[index]
                elif case == "prefix_missing":
                    handoff["source_phase1_entity_prefix"] = ""
                    handoff["certification_lineage"]["root_entity_prefix"] = ""  # type: ignore[index]
                else:
                    handoff["source_phase1_entity_prefix"] = "UIE2E-MISMATCH"
                with self.assertRaisesRegex(ValueError, expected_error):
                    load_phase3_payload(handoff)

    def test_rejects_missing_short_long_or_invalid_expected_piece_contract(self) -> None:
        cases = (
            ("missing", "expected_pieces.*正整数"),
            ("short", "OUL 数量.*预计件数"),
            ("long", "OUL 数量.*预计件数"),
            ("invalid_mapping", "expected_pieces.*正整数"),
        )
        for case, expected_error in cases:
            with self.subTest(case=case):
                handoff = phase3_handoff_payload()
                order = handoff["orders"]["ftl"]  # type: ignore[index]
                if case == "missing":
                    order.pop("expected_pieces")
                elif case == "short":
                    order["cargo_codes"].pop()
                elif case == "long":
                    order["cargo_codes"].append("OUL-FTL-999")
                else:
                    order["expected_pieces"] = {"count": 2}
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "summary.json"
                    write_json(
                        path,
                        {
                            "status": "passed",
                            "run_id": f"phase3-{case}",
                            "metrics": {
                                "steps_failed": 0,
                                "steps_blocked": 0,
                                "gates_failed": 0,
                            },
                            "handoff": handoff,
                        },
                    )
                    with self.assertRaisesRegex(ValueError, expected_error):
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
        self.assertEqual(payload["orders"]["ltl3"]["expected_pieces"], 5)
        self.assertEqual(payload["transport_batch"]["batch_number"], "PZ-20260905-009")
        self.assertEqual(
            payload["transport_batch"]["order_numbers"],
            [ORDERS[key] for key in ("ltl1", "ltl2", "ltl3")],
        )
        self.assertEqual(
            payload["oul_numbers"],
            {key: cargo_codes(key) for key in ORDER_KEYS},
        )
        self.assertEqual(
            payload["pickup_cargo_codes"],
            [code for key in ORDER_KEYS for code in cargo_codes(key)],
        )
        self.assertEqual(
            payload["tracking_nodes"]["ftl"], list(TRACKING_NODES)
        )
        self.assertEqual(
            set(payload["customs_declarations"]), set(ORDER_KEYS)
        )
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
    def test_customer_service_confirmation_matches_the_visible_card_label(self) -> None:
        source = (HERE / "tms_full_flow_phase4.py").read_text(encoding="utf-8")
        start = source.index("    def _read_workflow_snapshot(")
        end = source.index("    def _remember_snapshot(", start)
        helper = source[start:end]

        self.assertIn('(\"customer_service_confirmation\", \"费用确认\")', helper)
        self.assertNotIn('(\"customer_service_confirmation\", \"客服费用确认\")', helper)
        run_start = source.index("    def run(self) -> Phase4Artifacts:")
        run_helper = source[run_start:]
        self.assertIn(
            '\"customer_service_confirmation\",\n                \"费用确认\"',
            run_helper,
        )

    def test_recovery_reuses_completed_signoffs_and_documents(self) -> None:
        source = (HERE / "tms_full_flow_phase4.py").read_text(encoding="utf-8")
        signoff_start = source.index("    def _perform_required_signoff(")
        signoff_end = source.index("    def _open_billing_tab(", signoff_start)
        signoff = source[signoff_start:signoff_end]
        upload_start = source.index("    def _upload_cost_document(")
        upload_end = source.index("    def _review_cost_document(", upload_start)
        upload = source[upload_start:upload_end]

        self.assertIn('recovery_branches_used") is True', signoff)
        self.assertIn("not clicked_in_this_direction and not recovery_mode", signoff)
        self.assertIn('recovery_branches_used") is True', upload)
        self.assertIn("document_evidence[order_key].append(label)", upload)
        self.assertIn("except Exception as original:", signoff)
        self.assertIn('self._open_costs(session, order.order_number, "费用")', signoff)
        self.assertIn('has_text="已完成并锁定"', signoff)
        self.assertIn("raise original", signoff)

    def test_required_upstream_expenses_are_reused_instead_of_rejected(self) -> None:
        source = (HERE / "tms_full_flow_phase4.py").read_text(encoding="utf-8")
        start = source.index("    def _ensure_required_expenses(")
        end = source.index("    def _perform_required_signoff(", start)
        helper = source[start:end]

        self.assertIn("上游业务已生成既有费用，未重复创建", helper)
        self.assertNotIn("在本轮到达前已有{FIELD_LABELS[field_key]}", helper)

    def test_order_navigation_waits_for_the_detail_heading(self) -> None:
        source = (HERE / "tms_full_flow_phase4.py").read_text(encoding="utf-8")
        start = source.index("    def _open_order(")
        end = source.index("    def _click_business_tab(", start)
        helper = source[start:end]

        self.assertIn("session.expect_visible(heading", helper)
        self.assertNotIn("if not self._is_visible(heading)", helper)
        self.assertIn('"普通订单筛选表单"', helper)
        self.assertIn('f"{session.role} 普通订单 {order_number}"', helper)
        self.assertIn('f"{order_number} 查看/办理入口"', helper)
        self.assertGreaterEqual(helper.count("self._expect_visible_or_block("), 3)
        self.assertIn("def _expect_visible_or_block(", source)
        self.assertGreater(
            helper.index("session.expect_visible(heading"),
            helper.index("session.click(action.first"),
        )

    def test_cost_navigation_reopens_the_completed_settlement_step(self) -> None:
        source = (HERE / "tms_full_flow_phase4.py").read_text(encoding="utf-8")
        start = source.index("    def _open_costs(")
        end = source.index("    def _read_workflow_snapshot(", start)
        helper = source[start:end]

        self.assertIn('name="订单工作流"', helper)
        self.assertIn('name=re.compile(r"对账结算$")', helper)
        self.assertIn('"打开已完成的对账结算节点"', helper)
        self.assertGreaterEqual(helper.count("self._click_business_tab(session, section)"), 3)

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
        self.assertEqual(payload["expected_pieces"], EXPECTED_PIECES)
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
