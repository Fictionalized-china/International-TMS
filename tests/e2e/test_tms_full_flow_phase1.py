from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_full_flow_phase1 import (
    EXPECTED_ACCOUNT_SITES,
    PHASE1_NEGATIVE_GATE_CASES,
    PHASE1_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    _public_preflight,
    build_fresh_identity,
    build_parser,
    phase1_records,
    validate_full_flow_credentials,
)
from tms_ui_credentials import CredentialRecord, CredentialVault
from tms_ui_harness import AttemptIdentity
from ui_only_guard import scan_path


def attempt(number: int, suffix: str) -> AttemptIdentity:
    return AttemptIdentity(
        series_id="phase1",
        attempt=number,
        run_id=f"phase1-a{number:03d}-{suffix}",
        entity_prefix=f"UIE2E-20260905150000-A{number:03d}-{suffix}",
        output_dir=Path("output") / suffix,
    )


class Phase1IdentityTests(unittest.TestCase):
    def test_retry_always_uses_fresh_customer_email_and_cargo_markers(self) -> None:
        first = attempt(1, "ABCDEF01")
        second = attempt(2, "ABCDEF02")
        first_identity = build_fresh_identity(first)
        second_identity = build_fresh_identity(second)
        self.assertNotEqual(first_identity.customer_name, second_identity.customer_name)
        self.assertNotEqual(first_identity.portal_email, second_identity.portal_email)
        self.assertEqual(
            [item.business_type for item in phase1_records(first)],
            ["ftl", "ltl", "ltl", "ltl"],
        )
        self.assertEqual(len({item.cargo_marker for item in phase1_records(first)}), 4)

    def test_stage_order_stops_at_ordinary_order_assignment(self) -> None:
        self.assertEqual(
            PHASE1_STAGE_ORDER,
            (
                "customer_binding",
                "quotation_creation",
                "portal_acceptance",
                "consignment_submission",
                "business_approval",
                "ordinary_order_assignment",
            ),
        )


class Phase1SafetyTests(unittest.TestCase):
    def test_formal_flow_executes_missing_required_negative_gate(self) -> None:
        self.assertEqual(
            PHASE1_NEGATIVE_GATE_CASES,
            ("P1-NEG-CONSIGN-REQUIRED",),
        )

    def test_execute_is_opt_in(self) -> None:
        args = build_parser().parse_args([])
        self.assertFalse(args.execute)
        self.assertEqual(
            (args.destination_country, args.destination_state, args.destination_city),
            ("乌兹别克斯坦", "塔什干市", "塔什干"),
        )

    def test_preflight_never_serializes_email_or_password(self) -> None:
        records = [
            CredentialRecord(
                alias=alias,
                site=EXPECTED_ACCOUNT_SITES.get(alias, "admin"),
                department="测试部门",
                role=alias,
                email=f"{alias}@secret.test",
                password=f"Secret-{alias}-123A",
            )
            for alias in REQUIRED_ACCOUNT_ALIASES
        ]
        payload = _public_preflight(
            CredentialVault(records), base_url="http://127.0.0.1:5189"
        )
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["status"], "READY_NOT_EXECUTED")
        self.assertFalse(payload["business_writes"])
        self.assertNotIn("@secret.test", rendered)
        self.assertNotIn("Secret-", rendered)

    def test_preflight_requires_every_full_flow_actor_before_business_writes(self) -> None:
        self.assertEqual(
            set(REQUIRED_ACCOUNT_ALIASES),
            {
                "hr_admin",
                "sales",
                "business_supervisor",
                "operation_supervisor",
                "operation",
                "document",
                "customer_service",
                "finance",
                "cashier",
                "domestic_warehouse",
                "overseas_warehouse",
                "customer",
            },
        )

        def records(*, missing: str = "", blank: str = "", wrong_site: str = "") -> list[CredentialRecord]:
            return [
                CredentialRecord(
                    alias=alias,
                    site=(
                        "admin"
                        if alias == wrong_site
                        else EXPECTED_ACCOUNT_SITES.get(alias, "admin")
                    ),
                    department="测试部门",
                    role=alias,
                    email="" if alias == blank else f"{alias}@secret.test",
                    password="" if alias == blank else f"Secret-{alias}-123A",
                )
                for alias in REQUIRED_ACCOUNT_ALIASES
                if alias != missing
            ]

        selected = validate_full_flow_credentials(CredentialVault(records()))
        self.assertEqual(tuple(item.alias for item in selected), REQUIRED_ACCOUNT_ALIASES)
        with self.assertRaises(ValueError):
            validate_full_flow_credentials(
                CredentialVault(records(missing="customer_service"))
            )
        with self.assertRaises(ValueError):
            validate_full_flow_credentials(
                CredentialVault(records(blank="finance"))
            )
        with self.assertRaises(ValueError):
            validate_full_flow_credentials(
                CredentialVault(records(wrong_site="domestic_warehouse"))
            )

    def test_certification_scenario_passes_ui_only_static_guard(self) -> None:
        violations = scan_path(HERE / "tms_full_flow_phase1.py")
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
