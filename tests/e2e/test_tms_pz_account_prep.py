from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_pz_account_prep import (
    SECONDARY_PZ_ACCOUNT_SPECS,
    build_parser,
    build_pz_runtime_credentials,
    public_preflight,
)
from tms_ui_credentials import CredentialRecord, CredentialVault
from ui_only_guard import scan_path


def source_vault(*, include_secondary: bool = False) -> CredentialVault:
    records = [
        CredentialRecord(
            alias="hr_admin",
            site="admin",
            department="人事行政部",
            role="人事行政岗账号",
            email="hr@secret.test",
            password="Secret-Hr-123A",
        ),
        CredentialRecord(
            alias="operation",
            site="admin",
            department="操作部",
            role="操作岗账号",
            email="operation@secret.test",
            password="Secret-Operation-123A",
        ),
        CredentialRecord(
            alias="document",
            site="admin",
            department="操作部",
            role="单证岗账号",
            email="document@secret.test",
            password="Secret-Document-123A",
        ),
    ]
    if include_secondary:
        records.append(
            CredentialRecord(
                alias="operation_2",
                site="admin",
                department="操作部",
                role="自带操作二号",
                email="provided-operation-2@secret.test",
                password="Provided-Operation-2-123A",
            )
        )
    return CredentialVault(records)


class RuntimeCredentialTests(unittest.TestCase):
    def test_derives_two_secondary_accounts_from_primary_passwords_in_memory(self) -> None:
        runtime = build_pz_runtime_credentials(source_vault())
        self.assertEqual(runtime["operation_2"].password, runtime["operation"].password)
        self.assertEqual(runtime["document_2"].password, runtime["document"].password)
        self.assertEqual(runtime["operation_2"].role, "PZ接管操作二号")
        self.assertEqual(runtime["document_2"].role, "PZ接管单证二号")
        self.assertEqual(
            {item.alias for item in SECONDARY_PZ_ACCOUNT_SPECS},
            {"operation_2", "document_2"},
        )

    def test_preserves_explicit_secondary_runtime_credential(self) -> None:
        runtime = build_pz_runtime_credentials(source_vault(include_secondary=True))
        self.assertEqual(runtime["operation_2"].role, "自带操作二号")
        self.assertEqual(runtime["operation_2"].password, "Provided-Operation-2-123A")

    def test_requires_hr_and_both_primary_accounts(self) -> None:
        only_hr = CredentialVault((source_vault().records[0],))
        with self.assertRaisesRegex(ValueError, "operation"):
            build_pz_runtime_credentials(only_hr)

        without_hr = CredentialVault(source_vault().records[1:])
        with self.assertRaisesRegex(ValueError, "hr_admin"):
            public_preflight(without_hr, base_url="http://127.0.0.1:5189")


class AccountPrepSafetyTests(unittest.TestCase):
    def test_preflight_is_opt_in_and_contains_no_login_identifiers_or_secrets(self) -> None:
        args = build_parser().parse_args([])
        self.assertFalse(args.execute)
        payload = public_preflight(source_vault(), base_url="http://127.0.0.1:5189/")
        rendered = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(payload["status"], "READY_NOT_EXECUTED")
        self.assertFalse(payload["business_writes"])
        self.assertNotIn("@secret.test", rendered)
        self.assertNotIn("Secret-", rendered)
        self.assertNotIn("pz-operation-2@", rendered)
        self.assertNotIn("pz-document-2@", rendered)

    def test_account_prep_passes_ui_only_static_guard(self) -> None:
        violations = scan_path(HERE / "tms_pz_account_prep.py")
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
