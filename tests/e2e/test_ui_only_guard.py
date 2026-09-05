from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_ui_harness import (
    RoleBrowserSession,
    RunJournal,
    login_path_for_site,
    safe_artifact_name,
)
from ui_only_guard import scan_path, scan_source


class UIOnlyGuardTests(unittest.TestCase):
    def codes(self, source: str) -> set[str]:
        return {item.code for item in scan_source(source, Path("scenario.py"))}

    def test_allows_harness_login_and_recorded_human_actions(self) -> None:
        source = """
def run(ui, customer_link):
    ui.open_login("admin")
    ui.click(customer_link, "客户管理")
    ui.fill(ui.locator('input[name="name"]'), "UI-E2E-客户", "客户名称")
    ui.goto_for_negative_gate(
        "/admin/orders/not-in-scope",
        reason="验证非当前负责人无法绕过订单范围门禁",
        expected_status=(403, 404),
    )
"""
        self.assertEqual(self.codes(source), set())

    def test_rejects_database_and_process_shortcuts(self) -> None:
        source = """
import sqlite3
import subprocess
connection = sqlite3.connect(".wrangler/state/db.sqlite")
connection.execute("UPDATE transport_orders SET status='completed'")
"""
        self.assertTrue(
            {"IMPORT_DB", "PROCESS_SHORTCUT", "SQL_TEXT", "DB_CALL"}
            <= self.codes(source)
        )

    def test_rejects_http_and_playwright_request_shortcuts(self) -> None:
        source = """
import requests
page.request.post("/admin/orders/1", data={"intent": "advance"})
fetch("/admin/orders/1")
"""
        self.assertTrue({"IMPORT_HTTP", "PW_REQUEST", "HTTP_CALL"} <= self.codes(source))

    def test_rejects_dom_injection_and_direct_file_assignment(self) -> None:
        source = """
page.evaluate("document.querySelector('form').submit()")
locator.dispatch_event("click")
locator.set_input_files("proof.pdf")
context.add_init_script("localStorage.clear()")
"""
        self.assertTrue(
            {"DOM_INJECTION", "SYNTHETIC_EVENT", "DIRECT_FILE_SET", "STORAGE_INJECTION"}
            <= self.codes(source)
        )

    def test_only_literal_login_pages_may_use_raw_goto(self) -> None:
        allowed = """
page.goto("http://127.0.0.1:5189/login")
portal.goto("/portal/login?portalContext=11111111-1111-4111-8111-111111111111")
warehouse.goto("/warehouse/login")
"""
        rejected = """
page.goto("/admin/orders/123")
page.goto(base_url + route)
"""
        self.assertNotIn("DIRECT_DEEP_LINK", self.codes(allowed))
        self.assertIn("DIRECT_DEEP_LINK", self.codes(rejected))

    def test_negative_gate_navigation_requires_a_meaningful_reason(self) -> None:
        source = """
ui.goto_for_negative_gate("/admin/orders/123")
ui.goto_for_negative_gate("/admin/orders/123", reason="short")
"""
        violations = scan_source(source, Path("scenario.py"))
        self.assertEqual(
            [item.code for item in violations].count("NEGATIVE_GOTO_REASON"),
            2,
        )
        self.assertEqual(
            [item.code for item in violations].count("NEGATIVE_GOTO_STATUS"),
            2,
        )

    def test_rejects_locator_aliases_and_nested_locator_actions(self) -> None:
        source = """
button = page.get_by_role("button", name="提交")
button.click()
row = page.locator("tbody tr").first
row.locator("button").click()
field = row.locator("input")
field.fill("business value")
checkbox: Locator = page.locator("input[type=checkbox]")
checkbox.check()
element = page.locator("select")
element.select_option("approved")
"""
        violations = scan_source(source, Path("scenario.py"))
        self.assertEqual(
            [item.code for item in violations].count("RAW_PLAYWRIGHT_ACTION"),
            5,
        )

    def test_allows_role_session_helpers_and_harness_internal_actions(self) -> None:
        source = """
class RoleBrowserSession:
    def click(self, locator):
        locator.click()

def run(session, button):
    session.click(button, "提交业务")
    session.set_checked(button, True, "确认")

class Flow:
    def run(self):
        self.operation.click(self.button, "提交业务")
"""
        self.assertNotIn("RAW_PLAYWRIGHT_ACTION", self.codes(source))

    def test_directory_scan_skips_guard_infrastructure_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "ui_only_guard.py").write_text(
                'page.goto("/admin/internal")\n', encoding="utf-8"
            )
            (root / "scenario.py").write_text(
                'page.goto("/admin/orders/1")\n', encoding="utf-8"
            )
            violations = scan_path(root)
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0].path.name, "scenario.py")


class HarnessJournalTests(unittest.TestCase):
    def test_journal_redacts_sensitive_values_and_counts_actions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("run-1", Path(directory))
            journal.record_action(
                role="sales",
                kind="fill",
                target="密码",
                status="passed",
                started_at="2026-09-05T00:00:00+00:00",
                ended_at="2026-09-05T00:00:01+00:00",
                duration_ms=1000,
                url_before="http://127.0.0.1:5189/login",
                url_after="http://127.0.0.1:5189/login",
                detail={"value": "NeverWriteThisSecret", "sensitive": True},
            )
            summary_path = journal.flush(status="running")
            payload = json.loads(summary_path.read_text(encoding="utf-8-sig"))

        self.assertEqual(payload["metrics"]["actions_total"], 1)
        detail = payload["actions"][0]["detail"]
        self.assertNotIn("value", detail)
        self.assertEqual(detail["value_length"], len("NeverWriteThisSecret"))

    def test_login_paths_and_artifact_names_are_strict(self) -> None:
        self.assertEqual(login_path_for_site("admin"), "/login")
        self.assertEqual(login_path_for_site("portal"), "/portal/login")
        self.assertEqual(login_path_for_site("warehouse"), "/warehouse/login")
        with self.assertRaises(ValueError):
            login_path_for_site("unknown")  # type: ignore[arg-type]
        self.assertEqual(safe_artifact_name("finance / 核销 #1"), "finance-1")

    def test_trace_cannot_start_before_authentication(self) -> None:
        class TracingStub:
            def start(self, **_options: object) -> None:
                raise AssertionError("未登录时不应启动 trace")

        class ContextStub:
            tracing = TracingStub()

        class PageStub:
            url = "http://127.0.0.1:5189/login"

        with tempfile.TemporaryDirectory() as directory:
            session = RoleBrowserSession(
                role="sales",
                email="sales@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=ContextStub(),
                page=PageStub(),
                journal=RunJournal("run-trace", Path(directory)),
            )
            with self.assertRaisesRegex(RuntimeError, "先完成登录"):
                session.start_trace("整车全流程")


if __name__ == "__main__":
    unittest.main()
