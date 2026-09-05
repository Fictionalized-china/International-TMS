from __future__ import annotations

import json
import codecs
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_full_flow_blueprint import FULL_FLOW_CASES, planned_payload, validate_blueprint
from tms_multi_account_smoke import contract_for
from tms_ui_credentials import CredentialRecord, load_credentials, parse_markdown_credentials
from tms_ui_harness import (
    AttemptSeries,
    GateExpectation,
    RoleBrowserSession,
    RunJournal,
    TmsUIHarness,
    require_certified_summary,
    redact_evidence_text,
)
from ui_only_guard import scan_source


SYNTHETIC_CREDENTIALS = """# synthetic only

| 端 | 部门 | 岗位/客户 | 登录邮箱 | 密码 | 权限说明 |
| --- | --- | --- | --- | --- | --- |
| 管理后台 | 业务部 | 业务岗 | sales@example.test | Secret-sales-1 | 本人客户 |
| 管理后台 | 操作部 | 操作主管 | op-lead@example.test | Secret-op-2 | 配载审批 |
| 仓库端 | 操作部 | 境外仓库岗 | overseas@example.test | Secret-wh-3 | 境外仓 |
| 客户门户 | 客户 | 测试客户1 | client@example.test | Secret-client-4 | 本企业 |
| 客户门户 | 客户 | 测试客户2 | client2@example.test | Secret-client-5 | 本企业 |
"""


class CredentialLoaderTests(unittest.TestCase):
    def test_markdown_loader_assigns_stable_aliases_without_repr_secrets(self) -> None:
        vault = parse_markdown_credentials(SYNTHETIC_CREDENTIALS)
        self.assertEqual(
            vault.aliases,
            ("sales", "operation_supervisor", "overseas_warehouse", "customer", "customer_2"),
        )
        rendered = repr(vault.records)
        self.assertNotIn("Secret-", rendered)
        self.assertNotIn("@example.test", rendered)
        self.assertEqual(vault.select(["sales"])[0].site, "admin")

    def test_individual_environment_loader_never_requires_hardcoded_accounts(self) -> None:
        environment = {
            "TMS_E2E_ROLE_ALIASES": "finance",
            "TMS_E2E_FINANCE_SITE": "admin",
            "TMS_E2E_FINANCE_ROLE": "财务会计岗",
            "TMS_E2E_FINANCE_EMAIL": "finance@example.test",
            "TMS_E2E_FINANCE_PASSWORD": "Environment-only-secret",
        }
        record = load_credentials(environment=environment).records[0]
        self.assertEqual(record.alias, "finance")
        self.assertNotIn("Environment-only-secret", repr(record))
        self.assertNotIn("finance@example.test", repr(record))

    def test_missing_credentials_error_does_not_echo_secret_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "未提供凭据"):
            load_credentials(environment={})

    def test_failure_evidence_redacts_login_identifiers(self) -> None:
        rendered = redact_evidence_text(
            "当前账号 sales@example.test，备用 portal.user+1@corp.example.cn"
        )
        self.assertNotIn("@", rendered)
        self.assertEqual(rendered.count("<redacted-email>"), 2)


class AttemptSeriesTests(unittest.TestCase):
    def test_failed_attempt_forces_a_new_identity_and_entity_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            series = AttemptSeries("five-order-certification", directory)
            first = series.begin_attempt()
            series.finish_attempt(first, status="failed", reason="发现循环门禁，修复后重跑")
            second = series.begin_attempt()
            series.finish_attempt(second, status="passed")
            manifest = json.loads(series.manifest_path.read_text(encoding="utf-8-sig"))

        self.assertEqual(first.attempt, 1)
        self.assertEqual(second.attempt, 2)
        self.assertNotEqual(first.run_id, second.run_id)
        self.assertNotEqual(first.entity_prefix, second.entity_prefix)
        self.assertEqual([item["status"] for item in manifest["attempts"]], ["failed", "passed"])

    def test_running_attempt_cannot_be_silently_reused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            series = AttemptSeries("series", directory)
            series.begin_attempt()
            with self.assertRaisesRegex(RuntimeError, "仍为 running"):
                series.begin_attempt()


class _LocatorStub:
    first: "_LocatorStub"

    def __init__(self) -> None:
        self.first = self

    def count(self) -> int:
        return 0

    def is_visible(self) -> bool:
        return False


class _InteractiveLocatorStub:
    first: "_InteractiveLocatorStub"

    def __init__(self) -> None:
        self.first = self
        self.clicked = 0
        self.waits: list[tuple[str, int]] = []

    def count(self) -> int:
        return 1

    def is_visible(self) -> bool:
        return True

    def click(self, **_options: object) -> None:
        self.clicked += 1

    def wait_for(self, *, state: str, timeout: int) -> None:
        self.waits.append((state, timeout))


class _SegmentedInputStub:
    def __init__(self, final_value: str) -> None:
        self.final_value = final_value
        self.events: list[tuple[str, str]] = []

    def click(self, **_kwargs: object) -> None:
        self.events.append(("click", ""))

    def press(self, key: str, **_kwargs: object) -> None:
        self.events.append(("press", key))

    def type(self, value: str, **_kwargs: object) -> None:
        self.events.append(("type", value))

    def input_value(self, **_kwargs: object) -> str:
        return self.final_value


class _DelayedHiddenLocatorStub:
    first: "_DelayedHiddenLocatorStub"

    def __init__(self) -> None:
        self.first = self
        self.waits: list[tuple[str, int]] = []

    def count(self) -> int:
        return 1

    def wait_for(self, *, state: str, timeout: int) -> None:
        self.waits.append((state, timeout))


class _OptionStub:
    def __init__(self, value: str, label: str, *, disabled: bool = False) -> None:
        self.value = value
        self.label = label
        self.disabled = disabled

    def get_attribute(self, name: str) -> str | None:
        return self.value if name == "value" else None

    def text_content(self) -> str:
        return self.label

    def is_disabled(self) -> bool:
        return self.disabled


class _OptionListStub:
    def __init__(self, options: list[_OptionStub]) -> None:
        self.options = options

    def count(self) -> int:
        return len(self.options)

    def nth(self, index: int) -> _OptionStub:
        return self.options[index]


class _KeyboardSelectStub:
    def __init__(self) -> None:
        self.options = [
            _OptionStub("", "请选择", disabled=True),
            _OptionStub("first", "第一个岗位"),
            _OptionStub("target", "目标岗位"),
        ]
        self.current = 1
        self.highlighted = 1
        self.events: list[tuple[str, str]] = []

    def locator(self, selector: str) -> _OptionListStub:
        if selector != "option":
            raise AssertionError(selector)
        return _OptionListStub(self.options)

    def click(self, **_kwargs: object) -> None:
        self.events.append(("click", ""))

    def press(self, key: str, **_kwargs: object) -> None:
        self.events.append(("press", key))
        if key == "Home":
            self.highlighted = 1
        elif key == "ArrowDown":
            self.highlighted = min(len(self.options) - 1, self.highlighted + 1)
        elif key == "Enter":
            self.current = self.highlighted

    def input_value(self, **_kwargs: object) -> str:
        return self.options[self.current].value


class _PageStub:
    url = "http://127.0.0.1:5189/admin/orders"

    def title(self) -> str:
        return "运输订单"

    def locator(self, _selector: str) -> _LocatorStub:
        return _LocatorStub()

    def screenshot(self, *, path: str, **_options: object) -> None:
        Path(path).write_bytes(b"png")

    def wait_for_timeout(self, _milliseconds: int) -> None:
        pass


class _ResponseStub:
    def __init__(self, status: int) -> None:
        self.status = status


class _NegativeGatePageStub(_PageStub):
    def __init__(self, response: _ResponseStub | None) -> None:
        self.response = response

    def goto(self, url: str, **_options: object) -> _ResponseStub | None:
        self.url = url
        return self.response


class _ScreenshotFailurePageStub(_PageStub):
    def screenshot(self, *, path: str, **_options: object) -> None:
        raise OSError("evidence disk unavailable")


class _TracingStub:
    def start(self, **_options: object) -> None:
        pass

    def stop(self, *, path: str) -> None:
        Path(path).write_bytes(b"trace")


class _ContextStub:
    def __init__(self, page: _PageStub | None = None) -> None:
        self.page = page or _PageStub()
        self.tracing = _TracingStub()
        self.closed = False

    def set_default_timeout(self, _value: int) -> None:
        pass

    def set_default_navigation_timeout(self, _value: int) -> None:
        pass

    def new_page(self) -> _PageStub:
        return self.page

    def close(self) -> None:
        self.closed = True


class _BrowserStub:
    def __init__(self, *, fail_close: bool = False) -> None:
        self.contexts: list[_ContextStub] = []
        self.fail_close = fail_close

    def new_context(self, **_options: object) -> _ContextStub:
        context = _ContextStub()
        self.contexts.append(context)
        return context

    def close(self) -> None:
        if self.fail_close:
            raise OSError("browser close failed")


class _ChromiumStub:
    def __init__(self, browser: _BrowserStub) -> None:
        self.browser = browser

    def launch(self, **_options: object) -> _BrowserStub:
        return self.browser


class _PlaywrightStub:
    def __init__(self, browser: _BrowserStub) -> None:
        self.chromium = _ChromiumStub(browser)


class HarnessEvidenceTests(unittest.TestCase):
    def test_harness_does_not_mutate_text_or_select_values_directly(self) -> None:
        source = (HERE / "tms_ui_harness.py").read_text(encoding="utf-8")
        self.assertNotIn("locator.fill(", source)
        self.assertNotIn("select_option(", source)

    def test_select_uses_visible_keyboard_events_without_select_option(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("select", directory, scenario_name="键盘选择")
            session = RoleBrowserSession(
                role="supervisor",
                email="select@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_PageStub(),
                journal=journal,
            )
            control = _KeyboardSelectStub()
            selected = session.select(control, "负责人岗位", value="target")

        self.assertEqual(selected, ["target"])
        self.assertEqual(
            control.events,
            [("click", ""), ("press", "Home"), ("press", "ArrowDown"), ("press", "Enter")],
        )
        self.assertEqual(journal.actions[-1]["detail"]["keyboard_only"], True)

    def test_hidden_assertion_waits_for_async_ui_close(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("hidden", directory, scenario_name="异步弹窗关闭")
            session = RoleBrowserSession(
                role="sales",
                email="hidden@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_PageStub(),
                journal=journal,
                action_timeout_ms=8_000,
            )
            locator = _DelayedHiddenLocatorStub()
            session.expect_hidden(locator, "审核弹窗")

        self.assertEqual(locator.waits, [("hidden", 8_000)])

    def test_segmented_date_controls_use_visible_keyboard_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("dates", directory, scenario_name="日期输入", base_url="http://127.0.0.1:5189")
            session = RoleBrowserSession(
                role="sales",
                email="date@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_PageStub(),
                journal=journal,
            )
            date_control = _SegmentedInputStub("2026-10-05")
            datetime_control = _SegmentedInputStub("2026-10-05T15:30")
            session.type_date(date_control, "2026-10-05", "有效期")
            session.type_datetime_local(datetime_control, "2026-10-05T15:30", "预约时间")

        self.assertEqual(
            [event for event in date_control.events if event[0] == "type"],
            [("type", "2026"), ("type", "10"), ("type", "05")],
        )
        self.assertEqual(
            [event for event in datetime_control.events if event[0] == "type"],
            [("type", "2026"), ("type", "10"), ("type", "05"), ("type", "15"), ("type", "30")],
        )

    def test_summary_uses_utf8_bom_and_keeps_chinese_readable_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("encoding", directory, scenario_name="多账号权限冒烟")
            journal.add_note("门禁必须与工作流配置一致")
            path = journal.flush(status="planned")
            raw = path.read_bytes()
            decoded = raw.decode("utf-8-sig")

        self.assertTrue(raw.startswith(codecs.BOM_UTF8))
        self.assertIn("多账号权限冒烟", decoded)
        self.assertIn("门禁必须与工作流配置一致", decoded)
        self.assertNotRegex(decoded, r"鐧|鍙|鎴|绠|锛")

    def test_step_records_methodology_fields_gate_evidence_and_action_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal(
                "run-1",
                directory,
                scenario_name="权限冒烟",
                base_url="http://127.0.0.1:5189",
            )
            session = RoleBrowserSession(
                role="finance",
                email="never-journal@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_PageStub(),
                journal=journal,
            )
            gate = GateExpectation(
                "费用复核",
                "workflow_instance_field_configuration",
                "required",
                "allow",
                "必填字段显示当前责任人和办理入口",
                "字段齐全后允许提交",
                "财务会计岗",
                "核对工作流实例字段配置",
            )
            with session.step(
                "财务完成费用复核",
                case_id="COST-FIN-001",
                stage="三方结算",
                priority="P0",
                preconditions=("客服确认完成",),
                inputs={"account_email": "never-journal@example.test", "order_count": 4},
                expected_result="费用复核完成并进入对账。",
                gate=gate,
            ) as observation:
                journal.record_action(
                    role="finance", kind="click", target="确认审核", status="passed",
                    started_at="2026-09-05T00:00:00+00:00", ended_at="2026-09-05T00:00:01+00:00",
                    duration_ms=1000, url_before=_PageStub.url, url_after=_PageStub.url,
                )
                observation.observe("审核成功提示可见", gate_passed=True)
            payload = journal.payload("passed")

        step = payload["steps"][0]
        self.assertEqual(step["case_id"], "COST-FIN-001")
        self.assertEqual(step["action_counts"]["by_kind"], {"click": 1})
        self.assertEqual(step["actual_result"], "审核成功提示可见")
        self.assertTrue(step["evidence"])
        self.assertTrue(step["inputs"]["account_email"]["redacted"])
        self.assertNotIn("never-journal@example.test", json.dumps(payload, ensure_ascii=False))
        self.assertEqual(payload["gates"][0]["source"], "workflow_instance_field_configuration")

    def test_each_role_gets_a_distinct_browser_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            browser = _BrowserStub()
            harness = TmsUIHarness(
                _PlaywrightStub(browser),
                run_id="contexts",
                output_dir=directory,
                headless=True,
            )
            sales = harness.add_role("sales", "sales@example.test")
            finance = harness.add_role("finance", "finance@example.test")
            harness.close(status="planned")

        self.assertIsNot(sales.context, finance.context)
        self.assertEqual(len(browser.contexts), 2)
        self.assertTrue(all(context.closed for context in browser.contexts))

    def test_negative_gate_requires_response_and_captures_immediate_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("negative-gate", directory)
            missing_response = RoleBrowserSession(
                role="operation",
                email="operation@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_NegativeGatePageStub(None),
                journal=journal,
            )
            with self.assertRaisesRegex(AssertionError, "HTTP 响应"):
                missing_response.goto_for_negative_gate(
                    "/admin/loading/forbidden",
                    reason="验证旧负责人无法通过配载单深链越权访问",
                    expected_status=(403, 404),
                )

            denied = RoleBrowserSession(
                role="document",
                email="document@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_NegativeGatePageStub(_ResponseStub(403)),
                journal=journal,
            )
            denied.goto_for_negative_gate(
                "/admin/loading/forbidden",
                reason="验证旧单证负责人无法通过配载单深链越权访问",
                expected_status=(403, 404),
            )
            evidence = denied.capture_gate_evidence("old-document-denied")

        self.assertTrue(evidence.name.endswith("gate-old-document-denied.png"))
        self.assertEqual(journal.evidence[-1]["label"], "gate-old-document-denied")

    def test_negative_gate_recovery_clicks_visible_return_and_asserts_navigation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            page = _PageStub()
            session = RoleBrowserSession(
                role="operation",
                email="operation@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=page,
                journal=RunJournal("negative-recovery", directory),
            )
            return_control = _InteractiveLocatorStub()
            restored = _InteractiveLocatorStub()
            session.recover_from_negative_gate(
                return_control=return_control,
                restored_locator=restored,
                target="旧负责人 PZ 越权",
            )

        self.assertEqual(return_control.clicked, 1)
        self.assertEqual(restored.waits, [("visible", 15_000)])

    def test_step_evidence_failure_marks_step_and_gate_failed_and_raises(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = RunJournal("evidence-failure", directory)
            session = RoleBrowserSession(
                role="finance",
                email="finance@example.test",
                site="admin",
                base_url="http://127.0.0.1:5189",
                context=_ContextStub(),
                page=_ScreenshotFailurePageStub(),
                journal=journal,
            )
            gate = GateExpectation(
                "证据门禁",
                "system_integrity_invariant",
                "required",
                "allow",
                "成功态必须留图",
                "证据失败不得签发通过",
            )
            with self.assertRaisesRegex(RuntimeError, "证据截图失败"):
                with session.step(
                    "截图必须成功",
                    expected_result="步骤和门禁均有可核验证据",
                    gate=gate,
                ) as observation:
                    observation.observe("业务断言通过", gate_passed=True)

        self.assertEqual(journal.steps[-1]["status"], "failed")
        self.assertFalse(journal.gates[-1]["passed"])

    def test_close_downgrades_nominal_pass_and_flushes_before_browser_close_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            browser = _BrowserStub(fail_close=True)
            harness = TmsUIHarness(
                _PlaywrightStub(browser),
                run_id="close-failure",
                output_dir=directory,
                headless=True,
            )
            harness.journal.record_gate(
                role="finance",
                name="失败门禁",
                expected="应通过",
                passed=False,
                actual="未通过",
            )
            summary = harness.close(status="passed")
            payload = json.loads(summary.read_text(encoding="utf-8-sig"))

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["metrics"]["gates_failed"], 1)
        self.assertEqual(harness.last_status, "failed")
        self.assertIn("browser", harness.finalization_error)

    def test_certified_summary_rejects_failed_metrics_and_requires_fresh_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "summary.json"
            payload = {
                "status": "passed",
                "run_id": "phase1-a001",
                "metrics": {"steps_failed": 0, "steps_blocked": 0, "gates_failed": 1},
            }
            with self.assertRaisesRegex(ValueError, "gates_failed=1"):
                require_certified_summary(payload, source=source, label="Phase 1")
            payload["metrics"]["gates_failed"] = 0
            with self.assertRaisesRegex(ValueError, "fresh attempt"):
                require_certified_summary(
                    payload,
                    source=source,
                    label="Phase 1",
                    require_fresh_attempt=True,
                )


class BlueprintTests(unittest.TestCase):
    def test_full_flow_blueprint_has_exactly_one_ftl_three_ltl_and_one_pz(self) -> None:
        self.assertEqual(validate_blueprint(FULL_FLOW_CASES), [])
        payload = planned_payload()
        self.assertEqual(payload["status"], "PLANNED_NOT_EXECUTED")
        effects = [effect for item in FULL_FLOW_CASES for effect in item.entity_effects]
        self.assertEqual(effects.count("create:quote:ftl"), 1)
        self.assertEqual(effects.count("create:quote:ltl"), 3)
        self.assertEqual(effects.count("create:pz:three-ltl"), 1)

    def test_workflow_gates_all_record_configuration_source_and_ui_server_expectations(self) -> None:
        workflow_gates = [
            item.gate for item in FULL_FLOW_CASES
            if item.gate and item.gate.source.startswith("workflow_instance")
        ]
        self.assertTrue(workflow_gates)
        for gate in workflow_gates:
            assert gate is not None
            self.assertNotEqual(gate.configured_mode, "not_applicable")
            self.assertTrue(gate.ui_expectation)
            self.assertTrue(gate.server_expectation)

    def test_navigation_contracts_cover_core_roles_and_site_specific_menus(self) -> None:
        finance = CredentialRecord("finance", "admin", "财务部", "财务会计岗", "x@y.test", "secret")
        overseas = CredentialRecord("overseas_warehouse", "warehouse", "操作部", "境外仓库岗", "x@y.test", "secret")
        finance_contract = contract_for(finance)
        overseas_contract = contract_for(overseas)
        self.assertIn("费用结算", finance_contract.required)
        self.assertIn("扫码自提签收", overseas_contract.required)
        self.assertIn("货物配载", overseas_contract.forbidden)


class ExpandedGuardTests(unittest.TestCase):
    def codes(self, source: str) -> set[str]:
        return {item.code for item in scan_source(source, Path("scenario.py"))}

    def test_rejects_raw_playwright_writes_network_interception_and_dynamic_force(self) -> None:
        source = """
page.click("button")
locator.fill("secret")
context.route("**/*", handler)
locator.click(force=should_force)
"""
        codes = self.codes(source)
        self.assertIn("RAW_PLAYWRIGHT_ACTION", codes)
        self.assertIn("NETWORK_INTERCEPTION", codes)
        self.assertIn("FORCED_ACTION", codes)

    def test_accepts_recorded_role_session_actions(self) -> None:
        source = """
ui.click(customer_link, "客户管理")
ui.type_text(name_input, "全新客户", "客户名称")
ui.press("Enter", "提交客户")
"""
        self.assertEqual(self.codes(source), set())


if __name__ == "__main__":
    unittest.main()
