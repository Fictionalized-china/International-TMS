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
    PHASE1_STAGE_ORDER,
    REQUIRED_ACCOUNT_ALIASES,
    _public_preflight,
    build_fresh_identity,
    build_parser,
    phase1_records,
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
                site="portal" if alias == "customer" else "admin",
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
