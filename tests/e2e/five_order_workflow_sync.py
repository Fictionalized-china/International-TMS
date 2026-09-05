#!/usr/bin/env python3
# LEGACY / NON-CERTIFICATION ONLY: this historical 2 FTL + 3 LTL script does
# not satisfy the current UI-only guard. Do not run it for acceptance evidence.
# 正式认证只使用 tms_multi_account_smoke.py、tms_pz_account_prep.py 和 phase1..phase4。

"""2 整车 + 3 拼车工作流及门户关键功能真实 UI 回归。

所有业务写入都由 Playwright 的 click/fill/select_option/set_input_files/
keyboard.press 完成；脚本不使用 page.request、HTTP API 或数据库。
原五单业务步骤保持串行；扩展步骤额外验证客户自助注册、后台绑定、
同一 BrowserContext 三窗口身份隔离、站内通知、订单唯一性与唛头。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence
from urllib.parse import parse_qs, quote, urljoin, urlparse

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Locator,
    Page,
    Playwright,
    expect,
    sync_playwright,
)


ORDER_NUMBER_RE = re.compile(r"\bSO[0-9A-Z-]{6,}\b")
QUOTE_NUMBER_RE = re.compile(r"\bQT[0-9A-Z-]{6,}\b")
BATCH_NUMBER_RE = re.compile(r"\bPZ-[0-9A-Z-]{4,}\b")
PORTAL_CONTEXT_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
MAX_DIAGNOSTICS_PER_CASE = 500
MAX_DIAGNOSTIC_TEXT = 1_200


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "-", value).strip("-.") or "artifact"


def truncated(value: Any, limit: int = MAX_DIAGNOSTIC_TEXT) -> str:
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}…<truncated {len(text) - limit} chars>"


@dataclass
class OrderRecord:
    case_id: str
    load_type: str
    customer_name: str
    customer_email: str
    cargo_marker: str
    quote_number: str = ""
    workflow_id: str = ""
    workflow_name: str = ""
    workflow_version: str = ""
    order_number: str = ""
    order_id: str = ""
    domestic_warehouse_id: str = ""


class FiveOrderWorkflowSync:
    def __init__(self, playwright: Playwright, args: argparse.Namespace) -> None:
        self.args = args
        self.output_dir = Path(args.output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        expect.set_options(timeout=args.timeout_ms)
        self.browser: Browser = playwright.chromium.launch(
            headless=args.headless,
            slow_mo=args.slow_mo,
        )
        self.contexts: dict[str, BrowserContext] = {}
        self.pages: dict[str, Page] = {}
        self.active_case_by_page: dict[str, dict[str, Any] | None] = {}
        self.portal_context_ids: dict[str, str] = {}
        self.cases: list[dict[str, Any]] = []
        self.orders: dict[str, OrderRecord] = {}
        self.batch: dict[str, str] = {}
        for name in (
            "admin",
            "customer4",
            "customer5",
            "customer6",
            "warehouse",
            "portalShared",
        ):
            context = self.browser.new_context(
                locale="zh-CN",
                viewport={"width": 1600, "height": 1000},
                accept_downloads=True,
            )
            context.set_default_timeout(args.timeout_ms)
            context.set_default_navigation_timeout(args.navigation_timeout_ms)
            page = context.new_page()
            self.contexts[name] = context
            self.pages[name] = page
            self.active_case_by_page[name] = None
            self._attach_diagnostics(name, page)

    def close(self) -> None:
        for context in self.contexts.values():
            try:
                context.close()
            except Exception:
                pass
        self.browser.close()

    def url(self, path: str) -> str:
        return urljoin(f"{self.args.base_url.rstrip('/')}/", path.lstrip("/"))

    def portal_path(self, page_name: str, path: str) -> str:
        context_id = self.portal_context_ids.get(page_name, "")
        if not context_id:
            current_values = parse_qs(urlparse(self.pages[page_name].url).query).get(
                "portalContext", []
            )
            context_id = current_values[0] if current_values else ""
        if not PORTAL_CONTEXT_RE.fullmatch(context_id):
            raise AssertionError(f"{page_name} 缺少有效的 portalContext")
        self.portal_context_ids[page_name] = context_id.lower()
        separator = "&" if "?" in path else "?"
        return f"{path}{separator}portalContext={quote(context_id.lower())}"

    def _attach_diagnostics(self, page_name: str, page: Page) -> None:
        page.on("pageerror", lambda error: self._diagnostic(page_name, "pageerror", error))
        page.on(
            "console",
            lambda message: self._diagnostic(page_name, "console.error", message.text)
            if message.type == "error"
            else None,
        )
        page.on(
            "requestfailed",
            lambda request: self._diagnostic(
                page_name,
                "requestfailed",
                f"{request.method} {request.url} | {request.failure or 'unknown failure'}",
            ),
        )

    def _diagnostic(self, page_name: str, kind: str, message: Any) -> None:
        case = self.active_case_by_page.get(page_name)
        if case is None:
            return
        if len(case["diagnostics"]) >= MAX_DIAGNOSTICS_PER_CASE:
            case["diagnostics_truncated"] += 1
            return
        case["diagnostics"].append(
            {"at": utc_now(), "page": page_name, "kind": kind, "message": truncated(message)}
        )

    def new_case(self, case_id: str, title: str, expected: str) -> dict[str, Any]:
        case = {
            "id": case_id,
            "title": title,
            "expected": expected,
            "status": "RUNNING",
            "started_at": utc_now(),
            "ended_at": None,
            "steps": [],
            "values": {},
            "screenshots": [],
            "traces": [],
            "diagnostics": [],
            "diagnostics_truncated": 0,
            "error": None,
        }
        self.cases.append(case)
        return case

    @contextmanager
    def step(self, case: dict[str, Any], title: str, page_name: str | None = None) -> Iterator[None]:
        item = {"title": title, "status": "RUNNING", "started_at": utc_now(), "ended_at": None}
        case["steps"].append(item)
        try:
            yield
            item["status"] = "PASSED"
        except Exception as error:
            item["status"] = "FAILED"
            item["error"] = truncated(error, 3_000)
            if page_name:
                self.screenshot(case, page_name, f"failure-{len(case['steps']):02d}-{title}")
                self.write_page_diagnostic(case, page_name, f"failure-{len(case['steps']):02d}-{title}")
            raise
        finally:
            item["ended_at"] = utc_now()
            print(
                json.dumps(
                    {
                        "event": "step",
                        "case": case["id"],
                        "step": title,
                        "status": item["status"],
                        "ended_at": item["ended_at"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    def screenshot(self, case: dict[str, Any], page_name: str, label: str) -> str:
        path = self.output_dir / f"{case['id']}-{safe_name(label)}-{page_name}.png"
        try:
            self.pages[page_name].screenshot(path=str(path), full_page=True)
            case["screenshots"].append(str(path))
        except Exception as error:
            case["steps"].append(
                {"title": f"截图失败：{label}", "status": "WARNING", "error": truncated(error)}
            )
        return str(path)

    def write_page_diagnostic(self, case: dict[str, Any], page_name: str, label: str) -> None:
        page = self.pages[page_name]
        path = self.output_dir / f"{case['id']}-{safe_name(label)}-{page_name}.txt"
        try:
            body = page.locator("body").inner_text(timeout=3_000)
            path.write_text(
                f"URL: {page.url}\nTITLE: {page.title()}\n\n{truncated(body, 16_000)}\n",
                encoding="utf-8",
            )
        except Exception as error:
            path.write_text(f"无法采集页面诊断：{error}\nURL: {page.url}\n", encoding="utf-8")

    def start_traces(self, case: dict[str, Any], context_names: Sequence[str]) -> None:
        for name in context_names:
            self.active_case_by_page[name] = case
            self.contexts[name].tracing.start(screenshots=True, snapshots=True, sources=True)

    def stop_traces(self, case: dict[str, Any], context_names: Sequence[str]) -> None:
        for name in context_names:
            path = self.output_dir / f"{case['id']}-{name}-trace.zip"
            try:
                self.contexts[name].tracing.stop(path=str(path))
                case["traces"].append(str(path))
            except Exception as error:
                case["steps"].append(
                    {"title": f"停止 {name} trace", "status": "WARNING", "error": truncated(error)}
                )
            finally:
                context = self.contexts[name]
                for page_name, page in self.pages.items():
                    if page.context == context:
                        self.active_case_by_page[page_name] = None

    def run_case(
        self,
        case_id: str,
        title: str,
        expected: str,
        context_names: Sequence[str],
        callback: Callable[[dict[str, Any]], None],
    ) -> None:
        case = self.new_case(case_id, title, expected)
        self.start_traces(case, context_names)
        try:
            callback(case)
            self.assert_no_critical_diagnostics(case)
            case["status"] = "PASSED"
        except Exception as error:
            case["status"] = "FAILED"
            case["error"] = truncated(error, 6_000)
            case["traceback"] = truncated(traceback.format_exc(), 12_000)
            for page_name in context_names:
                self.screenshot(case, page_name, "case-final-failure")
                self.write_page_diagnostic(case, page_name, "case-final-failure")
            raise
        finally:
            case["ended_at"] = utc_now()
            self.stop_traces(case, context_names)
            self.flush_summary(partial=True)
            print(
                json.dumps(
                    {
                        "event": "case",
                        "case": case["id"],
                        "status": case["status"],
                        "ended_at": case["ended_at"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    def assert_no_critical_diagnostics(self, case: dict[str, Any]) -> None:
        critical = []
        manifest_request_failure = any(
            event["kind"] == "requestfailed"
            and "/__manifest?" in event["message"]
            for event in case["diagnostics"]
        )
        for event in case["diagnostics"]:
            if event["kind"] in {"pageerror", "console.error"}:
                if (
                    manifest_request_failure
                    and "Failed to fetch manifest patches" in event["message"]
                ):
                    # React Router's development manifest request is cancelled
                    # when the next real UI navigation wins the race.  Keep it
                    # in diagnostics, but do not misclassify that paired
                    # ERR_ABORTED event as an application crash.
                    continue
                critical.append(event)
            elif (
                event["kind"] == "requestfailed"
                and "ERR_ABORTED" not in event["message"]
                and "/__manifest?" not in event["message"]
            ):
                critical.append(event)
        if critical:
            brief = "; ".join(
                f"{item['page']} {item['kind']}: {item['message']}" for item in critical[:5]
            )
            raise AssertionError(f"浏览器运行时出现 {len(critical)} 个关键异常：{brief}")

    def flush_summary(self, partial: bool = False) -> None:
        payload = {
            "schema": "international-tms-five-order-workflow-sync/v1",
            "run_id": self.args.run_id,
            "generated_at": utc_now(),
            "partial": partial,
            "environment": {
                "base_url": self.args.base_url,
                "admin_email": self.args.admin_email,
                "warehouse_email": self.args.warehouse_email,
                "pdf": str(Path(self.args.pdf).resolve()),
                "browser": "chromium",
                "headed": not self.args.headless,
                "contexts": list(self.contexts),
                "resume_portal_features_from": self.args.resume_portal_features_from or None,
                "business_write_channels": [
                    "page.click",
                    "locator.fill",
                    "locator.select_option",
                    "locator.set_input_files",
                    "page.keyboard.press",
                ],
            },
            "summary": {
                "passed": sum(case["status"] == "PASSED" for case in self.cases),
                "failed": sum(case["status"] == "FAILED" for case in self.cases),
                "blocked": sum(case["status"] == "BLOCKED" for case in self.cases),
                "total": len(self.cases),
            },
            "orders": {key: asdict(value) for key, value in self.orders.items()},
            "batch": self.batch,
            "cases": self.cases,
            "diagnostic_truncation": {
                "max_events_per_case": MAX_DIAGNOSTICS_PER_CASE,
                "max_event_text": MAX_DIAGNOSTIC_TEXT,
                "discarded_events": sum(case["diagnostics_truncated"] for case in self.cases),
            },
        }
        name = "summary.partial.json" if partial else "summary.json"
        (self.output_dir / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def navigate(self, page: Page, path: str) -> None:
        response = page.goto(self.url(path), wait_until="domcontentloaded")
        if response is not None and response.status >= 500:
            raise AssertionError(f"页面 {path} 返回 HTTP {response.status}")
        expect(page.locator("body")).not_to_contain_text(
            re.compile(r"Error 500|Internal Server Error")
        )
        self.acknowledge_required_notifications(page)

    @staticmethod
    def acknowledge_required_notifications(page: Page) -> None:
        """Acknowledge mandatory workflow-change notices through their UI.

        These dialogs are an intentional product gate for the boss/developer
        account, so the regression must click them like a human instead of
        forcing clicks through the backdrop or mutating notification state.
        """
        trigger = page.locator(".internal-notification-trigger")
        if trigger.count() and trigger.is_visible() and trigger.locator("b").count():
            # The popup is opened by a hydration effect after DOMContentLoaded.
            # Give that effect one short UI frame window before checking it.
            page.wait_for_timeout(350)
        for _ in range(8):
            cards = page.locator(".internal-notification-card")
            visible: Locator | None = None
            for index in range(cards.count()):
                candidate = cards.nth(index)
                if candidate.is_visible():
                    visible = candidate
                    break
            if visible is None:
                return
            dialog = visible.locator("xpath=ancestor::*[@role='dialog'][1]")
            dialog.get_by_role(
                "button", name=re.compile(r"^(确认知悉|知道了)$")
            ).click()
            expect(visible).not_to_be_visible()
            page.wait_for_timeout(100)
        raise AssertionError("待确认的重要变更通知超过 8 条，停止以避免通知循环")

    def login_admin(self, case: dict[str, Any]) -> None:
        page = self.pages["admin"]
        self.navigate(page, "/login")
        if "/login" not in urlparse(page.url).path:
            return
        page.locator('input[name="email"]').fill(self.args.admin_email)
        page.locator('input[name="password"]').fill(self.args.admin_password)
        page.get_by_role("button", name="登录后台").click()
        expect(page).to_have_url(re.compile(r"/admin(?:/|$|\?)"))
        self.screenshot(case, "admin", "admin-login")

    def login_portal(
        self,
        case: dict[str, Any],
        page_name: str,
        email: str,
        customer_name: str,
    ) -> None:
        page = self.pages[page_name]
        login_path = (
            self.portal_path(page_name, "/portal/login")
            if page_name in self.portal_context_ids
            else "/portal/login"
        )
        self.navigate(page, login_path)
        if "/portal/login" in urlparse(page.url).path:
            page.locator('input[name="email"]').fill(email)
            page.locator('input[name="password"]').fill(self.args.portal_password)
            page.get_by_role("button", name="进入客户门户").click()
        # Do not let the login URL itself satisfy the assertion.  Wait for the
        # form action and the contextual portal-home redirect to complete.
        expect(page).to_have_url(re.compile(r"/portal/?(?:\?.*)?$"))
        context_values = parse_qs(urlparse(page.url).query).get("portalContext", [])
        context_id = context_values[0] if context_values else ""
        if not PORTAL_CONTEXT_RE.fullmatch(context_id):
            raise AssertionError(
                f"{page_name} 登录后 URL 未返回有效 portalContext：{page.url}"
            )
        self.portal_context_ids[page_name] = context_id.lower()
        expect(page.get_by_text(customer_name, exact=True).first).to_be_visible()
        self.screenshot(case, page_name, "portal-login")

    def login_warehouse(self, case: dict[str, Any]) -> None:
        page = self.pages["warehouse"]
        self.navigate(page, "/warehouse/login")
        if "/warehouse/login" not in urlparse(page.url).path:
            return
        # 这两个字段是 React 受控输入。DOM 刚出现时立即 fill，
        # 可能在开发模式水合完成时被初始空状态覆盖。按人类操作节奏
        # 等待一帧，并在点击前确认输入值仍然存在。
        page.wait_for_timeout(400)
        email = page.locator('input[name="email"]')
        password = page.locator('input[name="password"]')
        email.fill(self.args.warehouse_email)
        expect(email).to_have_value(self.args.warehouse_email)
        password.fill(
            self.args.warehouse_password or self.args.admin_password
        )
        expect(password).not_to_have_value("")
        expect(email).to_have_value(self.args.warehouse_email)
        page.get_by_role("button", name="进入仓库作业").click()
        # `/warehouse/login` must not be mistaken for a successful login.
        expect(page).to_have_url(
            re.compile(r"/warehouse/?(?:\?.*)?$"), timeout=self.args.timeout_ms
        )
        self.screenshot(case, "warehouse", "warehouse-login")

    @staticmethod
    def select_first_nonempty(
        select: Locator, purpose: str, preferred_text: str | None = None
    ) -> tuple[str, str]:
        expect(select).to_be_visible()
        expect(select).to_be_enabled()
        options = select.locator("option")
        labels = options.all_inner_texts()
        candidates: list[tuple[str, str]] = []
        for index, label in enumerate(labels):
            value = options.nth(index).get_attribute("value") or ""
            if value:
                candidates.append((value, label.strip()))
        if not candidates:
            raise AssertionError(f"{purpose} 没有可选择的数据；页面选项：{labels}")
        chosen = None
        if preferred_text:
            chosen = next(
                (item for item in candidates if preferred_text.lower() in item[1].lower()), None
            )
        value, label = chosen or candidates[0]
        select.select_option(value=value)
        return value, label

    @staticmethod
    def select_matching_text(select: Locator, expected_text: str, purpose: str) -> tuple[str, str]:
        expect(select).to_be_visible()
        expect(select).to_be_enabled()
        options = select.locator("option")
        available: list[str] = []
        for index in range(options.count()):
            option = options.nth(index)
            label = option.inner_text().strip()
            value = option.get_attribute("value") or ""
            available.append(label)
            if value and (label == expected_text or expected_text in label):
                select.select_option(value=value)
                return value, label
        raise AssertionError(f"{purpose} 找不到“{expected_text}”；可选项：{available}")

    def create_customer_and_portal(
        self,
        case: dict[str, Any],
        customer_name: str,
        email: str,
        sequence: int,
    ) -> None:
        page = self.pages["admin"]
        self.navigate(page, "/admin/customers")
        page.get_by_role("button", name="新增客户").click()
        dialog = page.get_by_role("dialog", name="新增客户")
        expect(dialog).to_be_visible()
        dialog.locator('input[name="name"]').fill(customer_name)
        dialog.locator('select[name="partyCategory"]').select_option(value="customer")
        dialog.locator("details.customer-role-dropdown summary").click()
        dialog.locator('input[name="businessRoles"][value="principal"]').click()
        dialog.locator('input[name="shortName"]').fill(f"五单同步客户{sequence}")
        dialog.locator('input[name="contactName"]').fill(f"测试联系人{sequence}")
        dialog.locator('input[name="contactPhone"]').fill(f"13800002{sequence:03d}")
        dialog.locator('input[name="contactEmail"]').fill(email)
        dialog.locator('select[name="addressCountryCode"]').select_option(value="CN")
        self.select_matching_text(
            dialog.locator('select[name="addressState"]'),
            self.args.customer_state,
            "客户默认地址省/州",
        )
        self.select_matching_text(
            dialog.locator('select[name="addressCity"]'),
            self.args.customer_city,
            "客户默认地址城市",
        )
        dialog.locator('input[name="addressLine1"]').fill(
            f"五订单工作流同步测试园区 {sequence} 号"
        )
        self.screenshot(case, "admin", f"customer-{sequence}-before-create")
        dialog.get_by_role("button", name="确认创建客户").click()
        expect(page.locator(".alert.success")).to_contain_text("客户已创建")

        row = page.locator("section.customer-ledger").get_by_role("row").filter(
            has_text=customer_name
        )
        expect(row).to_be_visible()
        row.get_by_role("button", name="客户档案").click()
        dossier = page.get_by_role(
            "dialog", name=re.compile(rf"客户档案.*{re.escape(customer_name)}")
        )
        expect(dossier).to_be_visible()
        dossier.get_by_role("button", name="开通门户").click()
        portal_dialog = page.get_by_role(
            "dialog", name=re.compile(rf"开通客户门户.*{re.escape(customer_name)}")
        )
        expect(portal_dialog).to_be_visible()
        portal_dialog.locator('input[name="displayName"]').fill(f"客户{sequence}测试账号")
        portal_dialog.locator('input[name="email"]').fill(email)
        portal_dialog.locator('input[name="password"]').fill(self.args.portal_password)
        portal_dialog.get_by_role("button", name="确认开通门户").click()
        expect(page.locator(".alert.success")).to_contain_text("客户门户账号已开通")
        case["values"][f"customer{sequence}"] = {"name": customer_name, "email": email}
        self.screenshot(case, "admin", f"customer-{sequence}-portal-opened")

    def create_customer_without_portal(
        self,
        case: dict[str, Any],
        customer_name: str,
        email: str,
        sequence: int,
    ) -> None:
        """通过客户管理页新建客户，故意不在后台直接开通门户。"""
        page = self.pages["admin"]
        self.navigate(page, "/admin/customers")
        page.get_by_role("button", name="新增客户").click()
        dialog = page.get_by_role("dialog", name="新增客户")
        expect(dialog).to_be_visible()
        dialog.locator('input[name="name"]').fill(customer_name)
        dialog.locator('select[name="partyCategory"]').select_option(value="customer")
        dialog.locator("details.customer-role-dropdown summary").click()
        dialog.locator('input[name="businessRoles"][value="principal"]').click()
        dialog.locator('input[name="shortName"]').fill(f"自助注册客户{sequence}")
        dialog.locator('input[name="contactName"]').fill(f"注册联系人{sequence}")
        dialog.locator('input[name="contactPhone"]').fill(f"13800004{sequence:03d}")
        dialog.locator('input[name="contactEmail"]').fill(email)
        dialog.locator('select[name="addressCountryCode"]').select_option(value="CN")
        self.select_matching_text(
            dialog.locator('select[name="addressState"]'),
            self.args.customer_state,
            "客户6默认地址省/州",
        )
        self.select_matching_text(
            dialog.locator('select[name="addressCity"]'),
            self.args.customer_city,
            "客户6默认地址城市",
        )
        dialog.locator('input[name="addressLine1"]').fill(
            f"客户自助注册回归园区 {sequence} 号"
        )
        self.screenshot(case, "admin", f"customer-{sequence}-before-create")
        dialog.get_by_role("button", name="确认创建客户").click()
        expect(page.locator(".alert.success")).to_contain_text("客户已创建")
        row = page.locator("section.customer-ledger").get_by_role("row").filter(
            has_text=customer_name
        )
        expect(row).to_be_visible()
        case["values"][f"customer{sequence}"] = {
            "name": customer_name,
            "email": email,
            "portal_opened_by_admin": False,
        }
        self.screenshot(case, "admin", f"customer-{sequence}-created-without-portal")

    def submit_portal_registration(
        self,
        case: dict[str, Any],
        page_name: str,
        customer_name: str,
        email: str,
        sequence: int,
    ) -> None:
        page = self.pages[page_name]
        self.navigate(page, "/portal/register")
        form = page.locator("form.portal-register-form")
        expect(form).to_be_visible()
        form.locator('input[name="companyName"]').fill(customer_name)
        form.locator('input[name="displayName"]').fill(f"客户{sequence}自助注册账号")
        form.locator('input[name="phone"]').fill(f"13800005{sequence:03d}")
        form.locator('input[name="email"]').fill(email)
        form.locator('input[name="password"]').fill(self.args.portal_password)
        form.locator('input[name="confirmPassword"]').fill(self.args.portal_password)
        form.locator('input[name="acceptedTerms"]').check()
        self.screenshot(case, page_name, f"customer-{sequence}-registration-before-submit")
        form.get_by_role("button", name="提交注册申请").click()
        expect(page.get_by_role("heading", name="注册申请已提交")).to_be_visible()
        self.screenshot(case, page_name, f"customer-{sequence}-registration-submitted")

    def assert_pending_registration_cannot_login(
        self,
        case: dict[str, Any],
        page_name: str,
        email: str,
    ) -> None:
        page = self.pages[page_name]
        page.get_by_role("link", name=re.compile(r"返回客户门户登录")).click()
        expect(page).to_have_url(re.compile(r"/portal/login(?:\?.*)?$"))
        page.locator('input[name="email"]').fill(email)
        page.locator('input[name="password"]').fill(self.args.portal_password)
        page.get_by_role("button", name="进入客户门户").click()
        expect(page.locator(".alert.error")).to_contain_text("审核中")
        case["values"]["pending_registration_login_blocked"] = True
        self.screenshot(case, page_name, "registration-pending-login-blocked")

    def approve_portal_registration(
        self,
        case: dict[str, Any],
        customer_name: str,
        email: str,
    ) -> None:
        page = self.pages["admin"]
        self.navigate(page, "/admin/customers#portal-registration-requests")
        # 若管理端原本就停在客户页，仅增加 hash 是同文档导航，
        # React Router loader 不会重读另一窗口刚提交的注册申请。
        page.reload(wait_until="domcontentloaded")
        self.acknowledge_required_notifications(page)
        section = page.locator("#portal-registration-requests")
        row = section.get_by_role("row").filter(has_text=email)
        expect(row).to_be_visible()
        select = row.locator('select[name="customerId"]')
        self.select_matching_text(select, customer_name, "自助注册最终绑定客户")
        row.get_by_role("button", name="批准并绑定").click()
        success = page.locator(".alert.success")
        expect(success).to_contain_text(email)
        expect(success).to_contain_text(customer_name)
        expect(section.get_by_role("row").filter(has_text=email)).to_have_count(0)
        case["values"]["registration_binding"] = {
            "email": email,
            "customer": customer_name,
        }
        self.screenshot(case, "admin", "registration-approved-and-bound")

    def _fill_quote_geo(
        self, form: Locator, prefix: str, country: str, state: str, city: str
    ) -> None:
        picker = form.locator(f'.quote-geo-picker:has(select[name="{prefix}Country"])')
        if picker.count() == 0:
            return
        expect(picker).to_be_visible()
        picker.get_by_role("button").click()
        for expected_name in (country, state, city):
            option = picker.get_by_role("option", name=expected_name, exact=True)
            if option.count() == 0:
                option = picker.get_by_role("option").filter(has_text=expected_name)
            if option.count() == 0:
                available = picker.get_by_role("option").all_inner_texts()
                raise AssertionError(
                    f"{prefix} 地区级联找不到“{expected_name}”；当前可选项：{available}"
                )
            option.first.click()

    def _fill_required_custom_quote_fields(self, form: Locator, marker: str) -> None:
        controls = form.locator(".quote-workflow-field-grid [required]")
        for index in range(controls.count()):
            control = controls.nth(index)
            input_type = (control.get_attribute("type") or "").lower()
            if control.locator("option").count():
                self.select_first_nonempty(control, f"报价自定义必填下拉 #{index + 1}")
            elif input_type == "file":
                control.set_input_files(str(Path(self.args.pdf).resolve()))
            elif input_type == "date":
                control.fill((datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"))
            elif input_type == "datetime-local":
                control.fill((datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M"))
            elif input_type == "number":
                control.fill("1")
            else:
                control.fill(f"{marker}-自定义必填-{index + 1}")

    def create_quote(
        self,
        case: dict[str, Any],
        case_id: str,
        load_type: str,
        customer_name: str,
        customer_email: str,
        sequence: int,
    ) -> OrderRecord:
        page = self.pages["admin"]
        cargo_marker = f"E2E-{self.args.run_id}-{case_id}-货物"
        self.navigate(page, "/admin/quotations")
        page.get_by_role("button", name="创建报价").click()
        dialog = page.get_by_role("dialog", name="创建运输报价")
        expect(dialog).to_be_visible()
        form = dialog.locator("form.prototype-quote-form")
        form.locator('select[name="customerId"]').select_option(label=customer_name)
        contact_name = form.locator('input[name="customerContactName"]')
        if contact_name.count() and contact_name.is_visible():
            contact_name.fill(f"测试联系人{4 if 'customer4' in customer_email else 5}")
        contact_phone = form.locator('input[name="customerContactPhone"]')
        if contact_phone.count() and contact_phone.is_visible():
            contact_phone.fill(f"13800003{sequence:03d}")
        form.locator('select[name="roadLoadType"]').select_option(value=load_type)
        workflow_select = form.locator('select[name="workflowDefinitionId"]')
        workflow_id, workflow_label = self.select_first_nonempty(
            workflow_select,
            f"{case_id} {load_type.upper()} 工作流版本",
            preferred_text="当前发布",
        )
        workflow_match = re.search(r"^(.*?)\s*·\s*v(\d+)", workflow_label)
        workflow_name = (
            workflow_match.group(1).strip()
            if workflow_match
            else workflow_label.split("·")[0].strip()
        )
        workflow_version = workflow_match.group(2) if workflow_match else ""

        customs = form.locator('select[name="customsClearanceMode"]')
        if customs.count() and customs.is_visible():
            customs.select_option(value="company")
        self._fill_quote_geo(
            form,
            "origin",
            self.args.origin_country,
            self.args.origin_state,
            self.args.origin_city,
        )
        self._fill_quote_geo(
            form,
            "destination",
            self.args.destination_country,
            self.args.destination_state,
            self.args.destination_city,
        )
        values = {
            "pickupAddress": f"{self.args.origin_city} E2E 提货点 {sequence} 号",
            "destinationWarehouseNote": f"{self.args.run_id} 五单同步测试",
            "cargoDescription": cargo_marker,
            "notes": f"{case_id} 工作流即时同步真实浏览器回归",
            "pieces": str(sequence + 1),
            "weight": str(100 + sequence),
            "length": "120",
            "width": "80",
            "height": "90",
            "validUntil": (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"),
        }
        for name, value in values.items():
            control = form.locator(f'[name="{name}"]')
            if control.count() and control.is_visible() and not control.is_disabled():
                control.fill(value)
        destination_warehouse = form.locator('select[name="destinationWarehouseId"]')
        if destination_warehouse.count() and destination_warehouse.is_visible():
            self.select_first_nonempty(destination_warehouse, "报价境外目的仓")
        price = form.locator('input[name="chargeUnitPrice"]').first
        if price.count() and price.is_visible():
            price.fill(str(1800 + sequence * 100))
        self._fill_required_custom_quote_fields(form, cargo_marker)
        self.screenshot(case, "admin", f"{case_id}-quote-before-save")
        form.get_by_role("button", name="保存报价并等待客户确认").click()
        success = page.locator(".gate.ok, .alert.success").filter(
            has_text="待客户确认"
        ).first
        expect(success).to_contain_text("待客户确认")
        success_text = success.inner_text()
        quote_match = QUOTE_NUMBER_RE.search(success_text)
        if not quote_match:
            row = page.get_by_role("row").filter(has_text=cargo_marker)
            expect(row).to_be_visible()
            quote_match = QUOTE_NUMBER_RE.search(row.inner_text())
        if not quote_match:
            raise AssertionError(f"报价保存成功，但页面未显示报价号：{success_text}")
        record = OrderRecord(
            case_id=case_id,
            load_type=load_type,
            customer_name=customer_name,
            customer_email=customer_email,
            cargo_marker=cargo_marker,
            quote_number=quote_match.group(0),
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            workflow_version=workflow_version,
        )
        self.orders[case_id] = record
        case["values"]["quote"] = {
            "number": record.quote_number,
            "load_type": load_type,
            "workflow_id": workflow_id,
            "workflow": workflow_label,
        }
        self.screenshot(case, "admin", f"{case_id}-quote-saved")
        return record

    def accept_quote_in_portal(
        self, case: dict[str, Any], page_name: str, record: OrderRecord
    ) -> None:
        page = self.pages[page_name]
        self.navigate(page, self.portal_path(page_name, "/portal/quotes"))
        row = page.get_by_role("row").filter(has_text=record.quote_number)
        expect(row).to_be_visible()
        row.get_by_role("button", name="接受报价").click()
        success = page.locator(".alert.success")
        expect(success).to_contain_text(re.compile(r"订单|接受"))
        page.wait_for_timeout(300)
        row = page.get_by_role("row").filter(has_text=record.quote_number)
        order_match = ORDER_NUMBER_RE.search(row.inner_text()) or ORDER_NUMBER_RE.search(
            success.inner_text()
        )
        if not order_match:
            raise AssertionError(f"客户接受 {record.quote_number} 后页面没有显示 SO 订单号")
        record.order_number = order_match.group(0)
        self.screenshot(case, page_name, f"{record.case_id}-quote-accepted")

        admin = self.pages["admin"]
        self.navigate(admin, f"/admin/quotations?q={quote(record.quote_number)}")
        admin_row = admin.get_by_role("row").filter(has_text=record.quote_number)
        expect(admin_row).to_be_visible()
        order_link = admin_row.locator('a[href^="/admin/orders/"]').first
        expect(order_link).to_be_visible()
        href = order_link.get_attribute("href") or ""
        match = re.search(r"/admin/orders/([^/?#]+)", href)
        if not match:
            raise AssertionError(f"管理端报价行未提供有效订单链接：{href}")
        record.order_id = match.group(1)
        case["values"]["order"] = {"number": record.order_number, "id": record.order_id}

    def open_workflow_editor(self, record: OrderRecord) -> Locator:
        page = self.pages["admin"]
        self.navigate(page, "/admin/workflow")
        group = page.locator(f".workflow-type-{record.load_type}")
        expect(group).to_be_visible()
        cards = group.locator("button.workflow-definition-card").filter(
            has_text=record.workflow_name
        )
        if record.workflow_version:
            versioned = cards.filter(
                has_text=re.compile(rf"v{re.escape(record.workflow_version)}\b")
            )
            if versioned.count():
                cards = versioned
        if cards.count() == 0:
            raise AssertionError(
                f"{record.load_type.upper()} 工作流分组中找不到 "
                f"{record.workflow_name} v{record.workflow_version}"
            )
        cards.first.click()
        inspect_dialog = page.get_by_role(
            "dialog", name=re.compile(rf"工作流配置.*{re.escape(record.workflow_name)}")
        )
        expect(inspect_dialog).to_be_visible()
        # 当前已选版本使用 button，非当前版本使用携带
        # workflowId/edit=1 的 link；两种都是真实 UI 入口。
        edit_entry = inspect_dialog.locator("button, a").filter(
            has_text=re.compile(r"^编辑$")
        )
        expect(edit_entry).to_have_count(1)
        edit_entry.click()
        editor = page.get_by_role("dialog", name=re.compile(r"节点配置"))
        expect(editor).to_be_visible()
        return editor

    def ensure_workflow_precondition(
        self, case: dict[str, Any], load_type: str, target: str
    ) -> None:
        """Reset a published workflow through the UI before the serial cases.

        A failed prior run may legitimately leave the shared test workflow in
        the mode it had already applied.  Replaying from a known state keeps
        each new run independent without database or API setup writes.
        """
        page = self.pages["admin"]
        self.navigate(page, "/admin/workflow")
        group = page.locator(f".workflow-type-{load_type}")
        expect(group).to_be_visible()
        cards = group.locator("button.workflow-definition-card")
        published = cards.filter(has_text=re.compile(r"当前发布|已发布"))
        card = published.first if published.count() else cards.first
        expect(card).to_be_visible()
        workflow_name = card.locator(
            ".workflow-definition-card-title strong"
        ).inner_text().strip()
        version_match = re.search(r"\bv(\d+)\b", card.inner_text())
        record = OrderRecord(
            case_id=f"setup-{load_type}",
            load_type=load_type,
            customer_name="",
            customer_email="",
            cargo_marker="",
            workflow_name=workflow_name,
            workflow_version=version_match.group(1) if version_match else "",
        )
        editor = self.open_workflow_editor(record)
        label = editor.locator(
            "details.workflow-node-config > summary > strong"
        ).filter(has_text=re.compile(r"^委托资料补充$"))
        expect(label).to_have_count(1)
        node = label.locator("xpath=../..")
        if node.get_attribute("open") is None:
            node.locator(":scope > summary").click()
        field_row = node.locator(".workflow-field-table tbody tr").filter(
            has_text="委托书"
        )
        expect(field_row).to_have_count(1)
        mode = field_row.locator('select[aria-label="委托书填写规则"]')
        before = mode.input_value()
        if before != target:
            mode.select_option(value=target)
            field_row.get_by_role("button", name="预览影响").click()
            confirm = page.get_by_role("dialog", name=re.compile(r"确认.*委托书"))
            expect(confirm).to_be_visible()
            confirm.get_by_role("button", name="确认应用规则").click()
            expect(page.locator(".alert.success")).to_contain_text("委托书")
        case.setdefault("values", {}).setdefault("workflow_preconditions", {})[
            load_type
        ] = {"before": before, "after": target, "channel": "browser-ui"}

    def assert_quotation_catalog_visible(
        self, case: dict[str, Any], editor: Locator, record: OrderRecord
    ) -> None:
        label = editor.locator(
            "details.workflow-node-config > summary > strong"
        ).filter(has_text=re.compile(r"^询价报价$"))
        expect(label).to_have_count(1)
        node = label.locator("xpath=../..")
        expect(node).to_have_count(1)
        node.locator(":scope > summary").click()
        rows = node.locator(".workflow-field-table tbody tr")
        count = rows.count()
        if count < 19:
            raise AssertionError(
                f"{record.load_type.upper()} 询价报价节点只显示 {count} 个字段，"
                "预期至少 19 个标准字段"
            )
        text = node.inner_text()
        for expected_text in ("客户联系人", "预计重量 KG", "报价有效期"):
            if expected_text not in text:
                raise AssertionError(f"询价报价节点缺少标准字段：{expected_text}")
        case["values"][f"{record.load_type}_quotation_field_count"] = count
        self.screenshot(case, "admin", f"{record.case_id}-quotation-fields-{count}")

    def change_consignment_letter_mode(
        self,
        case: dict[str, Any],
        record: OrderRecord,
        expected_before: str,
        target: str,
        assert_quote_catalog: bool = False,
    ) -> None:
        editor = self.open_workflow_editor(record)
        if assert_quote_catalog:
            self.assert_quotation_catalog_visible(case, editor, record)
        label = editor.locator(
            "details.workflow-node-config > summary > strong"
        ).filter(has_text=re.compile(r"^委托资料补充$"))
        expect(label).to_have_count(1)
        node = label.locator("xpath=../..")
        expect(node).to_have_count(1)
        if node.get_attribute("open") is None:
            node.locator(":scope > summary").click()
        field_row = node.locator(".workflow-field-table tbody tr").filter(has_text="委托书")
        expect(field_row).to_have_count(1)
        mode = field_row.locator('select[aria-label="委托书填写规则"]')
        expect(mode).to_be_visible()
        current = mode.input_value()
        if current != expected_before:
            raise AssertionError(
                f"{record.case_id} 修改前委托书规则应为 {expected_before}，实际为 {current}"
            )
        mode.select_option(value=target)
        field_row.get_by_role("button", name="预览影响").click()
        confirm = self.pages["admin"].get_by_role(
            "dialog", name=re.compile(r"确认.*委托书")
        )
        expect(confirm).to_be_visible()
        self.screenshot(
            case, "admin", f"{record.case_id}-policy-impact-{expected_before}-to-{target}"
        )
        confirm.get_by_role("button", name="确认应用规则").click()
        alert = self.pages["admin"].locator(".alert.success")
        expect(alert).to_contain_text("委托书")
        expect(alert).to_contain_text("同步")
        case["values"]["consignment_letter_policy"] = {
            "before": expected_before,
            "after": target,
            "message": alert.inner_text(),
        }

    def _consignment_page(self, record: OrderRecord) -> Page:
        page = self.pages["admin"]
        self.navigate(page, f"/admin/orders/{record.order_id}/modules/consignment")
        expect(page.get_by_text(record.order_number, exact=False).first).to_be_visible()
        return page

    def _select_approver_and_submit(self, page: Page) -> None:
        form = page.locator('form.consignment-submit-bar:has(input[value="submit"])')
        expect(form).to_be_visible()
        self.select_first_nonempty(
            form.locator('select[name="assigneeUserId"]'), "委托审批负责人", "E2E Admin"
        )
        form.get_by_role("button", name="提交审批").click()

    @staticmethod
    def open_consignment_files(page: Page) -> Locator:
        row = page.locator("article.source-document-row").filter(has_text="委托书")
        if not row.count() or not row.first.is_visible():
            page.get_by_role("link", name=re.compile(r"^文件管理")).click()
            expect(page).to_have_url(re.compile(r"[?&]section=files(?:&|$)"))
            row = page.locator("article.source-document-row").filter(has_text="委托书")
        expect(row).to_have_count(1)
        expect(row).to_be_visible()
        return row

    def upload_consignment_letter(self, page: Page) -> None:
        row = self.open_consignment_files(page)
        expect(row).to_be_visible()
        upload = row.locator('input[name="attachments"][type="file"]')
        expect(upload).to_be_enabled()
        upload.set_input_files(str(Path(self.args.pdf).resolve()))
        # The file input auto-submits and the stable feedback lives on the row
        # itself; assert the persisted filename and review state instead of an
        # ephemeral action banner that can disappear during revalidation.
        expect(row).to_contain_text(Path(self.args.pdf).name)
        expect(row).to_contain_text(re.compile(r"待审核|已上传"))

    def review_consignment_letter(self, page: Page) -> None:
        row = self.open_consignment_files(page)
        expect(row).to_be_visible()
        row.get_by_role("button", name="审核", exact=True).click()
        dialog = page.get_by_role("dialog", name=re.compile(r"审核文件.*委托书"))
        expect(dialog).to_be_visible()
        dialog.locator('select[name="reviewStatus"]').select_option(value="approved")
        dialog.get_by_role("button", name="确认审核结果").click()
        expect(row).to_contain_text(re.compile(r"已通过|已审"))

    def approve_consignment(self, page: Page, record: OrderRecord) -> None:
        candidates = page.get_by_role("button", name=re.compile(r"审批通过"))
        target: Locator | None = None
        for index in range(candidates.count()):
            candidate = candidates.nth(index)
            if candidate.is_visible() and candidate.is_enabled():
                target = candidate
        if target is None:
            raise AssertionError(f"{record.order_number} 没有可点击的审批通过按钮")
        target.click()
        expect(page).to_have_url(
            re.compile(rf"/admin/orders/{re.escape(record.order_id)}(?:\?|$)")
        )

    def exercise_consignment_gate(
        self,
        case: dict[str, Any],
        record: OrderRecord,
        should_block_without_letter: bool,
        upload_after_block: bool,
    ) -> None:
        page = self._consignment_page(record)
        if should_block_without_letter:
            self._select_approver_and_submit(page)
            error = page.locator(".alert.error")
            expect(error).to_be_visible()
            expect(error).to_contain_text("委托书")
            case["values"]["missing_letter_block"] = error.inner_text()
            self.screenshot(case, "admin", f"{record.case_id}-missing-letter-blocked")
            if not upload_after_block:
                return
            self.upload_consignment_letter(page)
            self._select_approver_and_submit(page)
        else:
            self._select_approver_and_submit(page)
            expect(page).to_have_url(
                re.compile(rf"/admin/orders/{re.escape(record.order_id)}(?:\?|$)")
            )
            case["values"]["missing_letter_block"] = None
            self.screenshot(case, "admin", f"{record.case_id}-optional-letter-not-blocked")

        page = self._consignment_page(record)
        if upload_after_block:
            self.review_consignment_letter(page)
        self.approve_consignment(page, record)
        expect(page.get_by_text(re.compile(r"任务分配")).first).to_be_visible()
        self.screenshot(case, "admin", f"{record.case_id}-approved-to-assignment")

    def assign_order(self, case: dict[str, Any], record: OrderRecord) -> None:
        page = self.pages["admin"]
        self.navigate(page, f"/admin/orders/{record.order_id}/modules/assignment")
        form = page.locator("form.assignment-manifest")
        expect(form).to_be_visible()
        rows = form.locator("tbody tr")
        if rows.count() == 0:
            raise AssertionError(f"{record.order_number} 任务分配页没有待分配业务模组")
        for index in range(rows.count()):
            row = rows.nth(index)
            selects = row.locator("select")
            if selects.count() < 2:
                continue
            self.select_first_nonempty(
                selects.nth(0), f"{record.order_number} 第 {index + 1} 行岗位", "操作"
            )
            page.wait_for_timeout(100)
            self.select_first_nonempty(
                selects.nth(1), f"{record.order_number} 第 {index + 1} 行负责人", "E2E Admin"
            )
        self.select_first_nonempty(
            form.locator('select[name="assigneeUserId"]'), "主操作员", "E2E Admin"
        )
        notes = form.locator('textarea[name="notes"]')
        if notes.count():
            notes.fill(f"{self.args.run_id} {record.case_id} 自动化派单")
        self.screenshot(case, "admin", f"{record.case_id}-assignment-ready")
        form.get_by_role("button", name=re.compile(r"确认派单并进入国内运输")).click()
        expect(page).to_have_url(
            re.compile(rf"/admin/orders/{re.escape(record.order_id)}(?:\?|$)")
        )
        expect(page.get_by_text("国内运输", exact=True).first).to_be_visible()

    def arrange_domestic_transport(
        self, case: dict[str, Any], record: OrderRecord, sequence: int
    ) -> None:
        page = self.pages["admin"]
        self.navigate(page, f"/admin/orders/{record.order_id}/modules/transport")
        form = page.locator("form.transport-arrangement-form")
        expect(form).to_be_visible()
        self.select_first_nonempty(form.locator('select[name="carrierId"]'), "国内承运商")
        page.wait_for_timeout(100)
        vehicle_id, _ = self.select_first_nonempty(
            form.locator('select[name="vehicleMasterId"]'), "国内车辆"
        )
        if vehicle_id == "__new__":
            form.locator('input[name="newVehiclePlateNumber"]').fill(
                f"E2E{self.args.run_id[-6:]}{sequence}"
            )
            form.locator('input[name="newVehicleType"]').fill("E2E 测试货车")
            form.locator('input[name="newVehicleCapacityWeight"]').fill("30000")
            form.locator('input[name="newVehicleCapacityVolume"]').fill("80")
        driver_id, _ = self.select_first_nonempty(
            form.locator('select[name="driverMasterId"]'), "国内司机"
        )
        if driver_id == "__new__":
            form.locator('input[name="newDriverName"]').fill(
                f"E2E测试司机{sequence}"
            )
            form.locator('input[name="newDriverPhone"]').fill(
                f"13800004{sequence:03d}"
            )
            form.locator('input[name="newDriverLicenseNumber"]').fill(
                f"E2E-LIC-{self.args.run_id[-6:]}-{sequence}"
            )
        warehouse_id, _ = self.select_first_nonempty(
            form.locator('select[name="destinationWarehouseId"]'), "国内入仓终点"
        )
        record.domestic_warehouse_id = warehouse_id
        form.locator('input[name="freightUnitPrice"]').fill(str(600 + sequence * 10))
        start = datetime.now() + timedelta(hours=2 + sequence)
        arrival = start + timedelta(hours=4)
        form.locator('input[name="plannedDepartureAt"]').fill(
            start.strftime("%Y-%m-%dT%H:%M")
        )
        form.locator('input[name="plannedArrivalAt"]').fill(
            arrival.strftime("%Y-%m-%dT%H:%M")
        )
        notes = form.locator('textarea[name="notes"]')
        if notes.count() and notes.is_visible():
            notes.fill(f"{record.case_id} 国内运输安排")
        self.screenshot(case, "admin", f"{record.case_id}-domestic-transport-ready")
        form.get_by_role("button", name="保存运输安排").click()
        expect(page.get_by_role("tab", name=re.compile(r"已有运输安排"))).to_have_attribute(
            "aria-selected", "true"
        )
        expect(page.get_by_text("国内运输安排已完成", exact=False)).to_be_visible()
        self.screenshot(case, "admin", f"{record.case_id}-domestic-transport-saved")

    def warehouse_accept_order(self, case: dict[str, Any], record: OrderRecord) -> None:
        page = self.pages["warehouse"]
        warehouse_query = (
            f"?warehouseId={quote(record.domestic_warehouse_id)}"
            if record.domestic_warehouse_id
            else ""
        )
        self.navigate(page, f"/warehouse/acceptance{warehouse_query}")
        scan = page.locator('input[name="reference"]')
        scan.fill(record.order_number)
        page.keyboard.press("Enter")
        workbench = page.locator("form.acceptance-workbench")
        expect(workbench).to_be_visible()
        expect(workbench.get_by_text(record.order_number, exact=False)).to_be_visible()
        self.select_first_nonempty(
            workbench.locator('select[name="locationId"]'), "仓库入库库位"
        )
        workbench.locator('input[name="receiptResult"][value="ready"]').click()
        self.screenshot(case, "warehouse", f"{record.case_id}-acceptance-ready")
        workbench.get_by_role("button", name="确认验收、入库并生成标签").click()
        labels = page.locator("section.acceptance-label-section")
        expect(labels).to_be_visible()
        expect(labels).to_contain_text(record.order_number)
        self.screenshot(case, "warehouse", f"{record.case_id}-warehouse-inbound-complete")

    def progress_ltl_to_warehouse(
        self, case: dict[str, Any], record: OrderRecord, sequence: int
    ) -> None:
        self.assign_order(case, record)
        self.arrange_domestic_transport(case, record, sequence)
        self.warehouse_accept_order(case, record)

    def create_pz_batch(
        self, case: dict[str, Any], records: Sequence[OrderRecord]
    ) -> None:
        page = self.pages["warehouse"]
        warehouse_ids = {record.domestic_warehouse_id for record in records}
        if "" in warehouse_ids or len(warehouse_ids) != 1:
            raise AssertionError(
                f"三票拼车的国内入仓仓库不一致：{sorted(warehouse_ids)}"
            )
        warehouse_id = next(iter(warehouse_ids))
        self.navigate(
            page, f"/warehouse/consolidation?warehouseId={quote(warehouse_id)}"
        )
        clear = page.get_by_role("button", name="清空")
        if clear.count() and clear.is_enabled():
            clear.click()
        filter_form = page.locator("form.consolidation-filter-form")
        filter_form.locator('select[name="eligibility"]').select_option(value="eligible")
        filter_form.locator('select[name="pageSize"]').select_option(value="100")
        filter_form.get_by_role("button", name="筛选").click()
        for record in records:
            checkbox = page.get_by_role(
                "checkbox", name=f"选择订单 {record.order_number}"
            )
            expect(checkbox).to_be_visible()
            expect(checkbox).to_be_enabled()
            checkbox.click()
        self.screenshot(
            case, "warehouse", "ltl-three-orders-selectable-with-mixed-letter-state"
        )
        trigger = page.get_by_role("button", name=f"生成配载（{len(records)}）")
        expect(trigger).to_be_enabled()
        trigger.click()
        dialog = page.get_by_role("dialog", name="生成配载单")
        form = dialog.locator("form.consolidation-create-form")
        carrier_id, carrier_label = self.select_first_nonempty(
            form.locator('select[name="carrierId"]'), "PZ 境外承运商"
        )
        page.wait_for_timeout(100)
        _, vehicle_label = self.select_first_nonempty(
            form.locator('select[name="vehicleMasterId"]'), "PZ 出境车辆"
        )
        _, driver_label = self.select_first_nonempty(
            form.locator('select[name="driverMasterId"]'), "PZ 出境司机"
        )
        border_value, border_label = self.select_first_nonempty(
            form.locator('select[name="borderPort"]'), "PZ 出境口岸"
        )
        customs_value, customs_label = self.select_first_nonempty(
            form.locator('select[name="customsLocation"]'), "PZ 清关地"
        )
        form.locator('input[name="batchName"]').fill(
            f"{self.args.run_id}-三票拼车同步验证"
        )
        form.locator('input[name="plannedLoadingAt"]').fill(
            (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
        )
        form.locator('input[name="plannedDepartureAt"]').fill(
            (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M")
        )
        form.locator('input[name="routeNotes"]').fill("三票拼车统一出境线路")
        form.locator('input[name="notes"]').fill("委托书历史状态不得阻断配载")
        self.screenshot(case, "warehouse", "pz-form-ready")
        form.get_by_role("button", name="确认配载信息，生成 PZ 配载单").click()
        success = page.locator(".alert.success")
        expect(success).to_contain_text("配载单")
        success_text = success.inner_text()
        batch_match = BATCH_NUMBER_RE.search(success_text)
        batch_link = success.locator('a[href^="/admin/loading/"]').first
        expect(batch_link).to_be_visible()
        href = batch_link.get_attribute("href") or ""
        id_match = re.search(r"/admin/loading/([^/?#]+)", href)
        if not batch_match or not id_match:
            raise AssertionError(
                f"PZ 创建成功但批次号或批次链接缺失：{success_text} / {href}"
            )
        self.batch = {
            "id": id_match.group(1),
            "number": batch_match.group(0),
            "warehouse_id": warehouse_id,
            "carrier_id": carrier_id,
            "carrier": carrier_label,
            "vehicle": vehicle_label,
            "driver": driver_label,
            "border_port_value": border_value,
            "border_port": border_label,
            "customs_location_value": customs_value,
            "customs_location": customs_label,
        }
        case["values"]["batch"] = self.batch.copy()
        self.screenshot(case, "warehouse", "pz-created")

    def upload_required_batch_documents(
        self, case: dict[str, Any], records: Sequence[OrderRecord]
    ) -> None:
        page = self.pages["warehouse"]
        self.navigate(
            page,
            "/warehouse/loading-documents?"
            f"warehouseId={quote(self.batch['warehouse_id'])}"
            f"&batchId={quote(self.batch['id'])}",
        )
        batch_dialog = page.get_by_role(
            "dialog", name=re.compile(re.escape(self.batch["number"]))
        )
        expect(batch_dialog).to_be_visible()
        header_labels = [
            text.strip() for text in batch_dialog.locator("table thead th").all_inner_texts()
        ]
        case["values"]["pz_document_columns"] = header_labels
        if "委托书" in header_labels:
            consignment_index = header_labels.index("委托书")
            consignment_matrix: dict[str, str] = {}
            for index, record in enumerate(records):
                row = batch_dialog.get_by_role("row").filter(
                    has_text=record.order_number
                )
                expect(row).to_be_visible()
                cell_text = row.locator("td").nth(consignment_index).inner_text()
                consignment_matrix[record.order_number] = cell_text
                if index == 0:
                    if "选填" not in cell_text or "待上传" in cell_text:
                        raise AssertionError(
                            f"{record.order_number} 无委托书应显示选填且不形成PZ门禁：{cell_text}"
                        )
                elif "必填" not in cell_text or not re.search(
                    r"已通过|已归档", cell_text
                ):
                    raise AssertionError(
                        f"{record.order_number} 必填委托书应沿用已审核版本：{cell_text}"
                    )
            case["values"]["pz_consignment_matrix"] = consignment_matrix

        for record in records:
            batch_dialog = page.get_by_role(
                "dialog", name=re.compile(re.escape(self.batch["number"]))
            )
            row = batch_dialog.get_by_role("row").filter(has_text=record.order_number)
            expect(row).to_be_visible()
            upload_button = row.get_by_role("button", name="上传文件")
            if upload_button.count() == 0:
                continue
            upload_button.click()
            selection = page.get_by_role(
                "dialog", name=re.compile(rf"上传订单文件.*{record.order_number}")
            )
            expect(selection).to_be_visible()
            missing_required = selection.locator(
                ".warehouse-order-document-picker-row"
            ).filter(has_text=re.compile(r"必填.*尚未上传", re.S))
            selected_count = missing_required.count()
            for index in range(selected_count):
                missing_required.nth(index).locator('input[type="file"]').set_input_files(
                    str(Path(self.args.pdf).resolve())
                )
            if selected_count == 0:
                page.keyboard.press("Escape")
                continue
            selection.get_by_role(
                "button", name=re.compile(rf"查看并确认（{selected_count}）")
            ).click()
            preview = page.get_by_role(
                "dialog", name=re.compile(rf"文件总览.*{record.order_number}")
            )
            expect(preview).to_be_visible()
            preview.get_by_role("button", name="确认并上传").click()
            # The multipart action closes the preview before React Router finishes
            # revalidating the file matrix.  Wait for the global interaction state
            # to become idle so the assertion observes the persisted loader data,
            # not the previous table that remains visible under the progress layer.
            expect(page.locator(".interaction-progress.is-active")).to_have_count(
                0, timeout=30_000
            )
            batch_dialog = page.get_by_role(
                "dialog", name=re.compile(re.escape(self.batch["number"]))
            )
            persisted_row = batch_dialog.get_by_role("row").filter(
                has_text=record.order_number
            )
            expect(persisted_row.locator(".status-pill", has_text="待上传")).to_have_count(0)

        batch_dialog = page.get_by_role(
            "dialog", name=re.compile(re.escape(self.batch["number"]))
        )
        expect(batch_dialog.locator(".status-pill", has_text="待上传")).to_have_count(0)
        self.screenshot(case, "warehouse", "pz-required-files-complete")
        page.keyboard.press("Escape")
        batch_row = page.get_by_role("row").filter(has_text=self.batch["number"])
        expect(batch_row).to_be_visible()
        if "缺 " in batch_row.inner_text():
            raise AssertionError(f"PZ 必填文件仍不齐套：{batch_row.inner_text()}")
        case["values"]["pz_document_summary"] = batch_row.inner_text()

    def assert_batch_synced_to_orders(
        self, case: dict[str, Any], records: Sequence[OrderRecord]
    ) -> None:
        page = self.pages["admin"]
        for record in records:
            self.navigate(page, f"/admin/orders/{record.order_id}/modules/loading")
            expect(page.get_by_text(self.batch["number"], exact=False)).to_be_visible()
            body = page.locator("body").inner_text()
            for label, value in (
                ("境外承运商", self.batch["carrier"]),
                ("出境车辆", self.batch["vehicle"]),
                ("出境司机", self.batch["driver"]),
            ):
                primary = value.split("·")[0].strip()
                if primary and primary not in body:
                    raise AssertionError(f"{record.order_number} 未同步 {label}：{primary}")
            self.screenshot(case, "admin", f"{record.case_id}-pz-synced")

    @staticmethod
    def context_id_from_page(page: Page) -> str:
        values = parse_qs(urlparse(page.url).query).get("portalContext", [])
        context_id = values[0].lower() if values else ""
        if not PORTAL_CONTEXT_RE.fullmatch(context_id):
            raise AssertionError(f"客户门户 URL 缺少有效 portalContext：{page.url}")
        return context_id

    def add_shared_portal_page(
        self, case: dict[str, Any], page_name: str
    ) -> Page:
        page = self.contexts["portalShared"].new_page()
        self.pages[page_name] = page
        self.active_case_by_page[page_name] = case
        self._attach_diagnostics(page_name, page)
        return page

    def assert_portal_identity(
        self,
        page_name: str,
        customer_name: str,
        email: str | None = None,
    ) -> None:
        page = self.pages[page_name]
        expect(page.locator(".portal-scope strong")).to_have_text(customer_name)
        expect(page.locator(".top-user small")).to_have_text(customer_name)
        context_id = self.context_id_from_page(page)
        expected_context_id = self.portal_context_ids.get(page_name)
        if expected_context_id and context_id != expected_context_id:
            raise AssertionError(
                f"{page_name} 导航后 portalContext 改变："
                f"{expected_context_id} -> {context_id}"
            )
        self.portal_context_ids[page_name] = context_id
        if email:
            page.get_by_role("link", name="账户中心", exact=True).click()
            expect(page).to_have_url(re.compile(r"/portal/account(?:\?.*)?$"))
            expect(page.locator('input[value="' + email + '"]')).to_be_visible()
            expect(page.locator(".portal-scope strong")).to_have_text(customer_name)

    def case_registration_binding(self, case: dict[str, Any]) -> None:
        with self.step(case, "管理端新增客户6，不直接开通门户", "admin"):
            self.create_customer_without_portal(
                case,
                self.args.customer6_name,
                self.args.customer6_email,
                6,
            )
        with self.step(case, "客户6通过注册页提交开户申请", "customer6"):
            self.submit_portal_registration(
                case,
                "customer6",
                self.args.customer6_name,
                self.args.customer6_email,
                6,
            )
        with self.step(case, "后台批准前注册账号不能查看客户数据", "customer6"):
            self.assert_pending_registration_cannot_login(
                case, "customer6", self.args.customer6_email
            )
        with self.step(case, "管理端将注册账号绑定到客户6", "admin"):
            self.approve_portal_registration(
                case, self.args.customer6_name, self.args.customer6_email
            )
        with self.step(case, "客户6审核后登录并显示正确客户", "customer6"):
            self.login_portal(
                case,
                "customer6",
                self.args.customer6_email,
                self.args.customer6_name,
            )
            self.assert_portal_identity(
                "customer6", self.args.customer6_name, self.args.customer6_email
            )
            self.screenshot(case, "customer6", "registration-bound-portal")

    def case_same_browser_portal_isolation(self, case: dict[str, Any]) -> None:
        page_names = (
            "portalShared",
            "portalSharedCustomer5",
            "portalSharedCustomer6",
        )
        customer_names = (
            self.args.customer4_name,
            self.args.customer5_name,
            self.args.customer6_name,
        )
        emails = (
            self.args.customer4_email,
            self.args.customer5_email,
            self.args.customer6_email,
        )
        with self.step(case, "同一浏览器上创建三个客户门户窗口", "portalShared"):
            self.add_shared_portal_page(case, page_names[1])
            self.add_shared_portal_page(case, page_names[2])
            for page_name, customer_name, email in zip(
                page_names, customer_names, emails, strict=True
            ):
                self.login_portal(case, page_name, email, customer_name)
            context_ids = [self.portal_context_ids[name] for name in page_names]
            if len(set(context_ids)) != 3:
                raise AssertionError(
                    f"同浏览器三窗口 portalContext 不唯一：{context_ids}"
                )
            case["values"]["shared_window_contexts"] = dict(
                zip(page_names, context_ids, strict=True)
            )

        with self.step(case, "三窗口点击我的订单后仅显示各自数据", "portalShared"):
            own_orders = (
                self.orders["ftl1"].order_number,
                self.orders["ltl3"].order_number,
                "",
            )
            foreign_orders = (
                self.orders["ltl3"].order_number,
                self.orders["ftl1"].order_number,
                self.orders["ftl1"].order_number,
            )
            for page_name, customer_name, own_order, foreign_order in zip(
                page_names,
                customer_names,
                own_orders,
                foreign_orders,
                strict=True,
            ):
                page = self.pages[page_name]
                page.get_by_role("link", name="我的订单", exact=True).click()
                expect(page).to_have_url(re.compile(r"/portal/orders(?:\?.*)?$"))
                self.assert_portal_identity(page_name, customer_name)
                if own_order:
                    expect(page.get_by_role("row").filter(has_text=own_order)).to_be_visible()
                else:
                    expect(page.get_by_text("暂无订单", exact=False)).to_be_visible()
                expect(page.get_by_role("row").filter(has_text=foreign_order)).to_have_count(0)
                self.screenshot(case, page_name, "shared-window-own-orders")

        with self.step(case, "三窗口进入账户中心并刷新，身份不串号", "portalShared"):
            for page_name, customer_name, email in zip(
                page_names, customer_names, emails, strict=True
            ):
                self.assert_portal_identity(page_name, customer_name, email)
                page = self.pages[page_name]
                page.reload(wait_until="domcontentloaded")
                self.acknowledge_required_notifications(page)
                self.assert_portal_identity(page_name, customer_name)
                expect(page.locator('input[value="' + email + '"]')).to_be_visible()

        with self.step(case, "中间窗口退出不影响其他两个窗口", "portalSharedCustomer5"):
            middle = self.pages[page_names[1]]
            middle.get_by_role("button", name="退出登录").click()
            expect(middle).to_have_url(re.compile(r"/portal/login(?:\?.*)?$"))
            for page_name, customer_name in (
                (page_names[0], customer_names[0]),
                (page_names[2], customer_names[2]),
            ):
                page = self.pages[page_name]
                page.reload(wait_until="domcontentloaded")
                self.acknowledge_required_notifications(page)
                self.assert_portal_identity(page_name, customer_name)
            self.login_portal(
                case, page_names[1], self.args.customer5_email, self.args.customer5_name
            )
            self.assert_portal_identity(page_names[1], self.args.customer5_name)
            case["values"]["middle_window_logout_isolated"] = True
            self.screenshot(case, page_names[1], "middle-window-relogin")

    def case_portal_order_features(self, case: dict[str, Any]) -> None:
        record = self.orders["ltl1"]
        page_name = "customer4"
        page = self.pages[page_name]
        with self.step(case, "客户4的报价通知可查看并标为已读", page_name):
            self.login_portal(
                case, page_name, self.args.customer4_email, self.args.customer4_name
            )
            page.locator(".portal-sidebar").get_by_role(
                "link", name=re.compile(r"^消息中心")
            ).click()
            article = page.locator(".notification-list article").filter(
                has_text=record.quote_number
            )
            expect(article).to_be_visible()
            expect(article).to_contain_text("新报价待确认")
            read_button = article.get_by_role("button", name="标为已读")
            if read_button.count():
                read_button.click()
                expect(page.locator(".alert.success")).to_contain_text("消息已读")
                article = page.locator(".notification-list article").filter(
                    has_text=record.quote_number
                )
                expect(article.get_by_role("button", name="标为已读")).to_have_count(0)
            case["values"]["quote_notification"] = record.quote_number
            self.screenshot(case, page_name, "quote-notification-read")

        with self.step(case, "键盘筛选订单且同一报价只有一张订单", page_name):
            page.get_by_role("link", name="我的订单", exact=True).click()
            search = page.locator('form.order-table-filters input[name="keyword"]')
            search.fill(record.quote_number)
            search.press("Enter")
            row = page.get_by_role("row").filter(has_text=record.quote_number)
            expect(row).to_have_count(1)
            numbers = set(ORDER_NUMBER_RE.findall(row.inner_text()))
            if numbers != {record.order_number}:
                raise AssertionError(
                    f"报价 {record.quote_number} 关联订单异常：{sorted(numbers)}"
                )
            case["values"]["unique_order_for_quote"] = {
                "quote": record.quote_number,
                "order": record.order_number,
                "row_count": 1,
            }

        with self.step(case, "查看唯一唛头并通过页面按钮下载SVG", page_name):
            row = page.get_by_role("row").filter(has_text=record.order_number)
            trigger = row.get_by_role("button", name="查看唛头")
            expect(trigger).to_be_visible()
            trigger.click()
            dialog = page.get_by_role(
                "dialog", name=f"查看唛头 · {record.order_number}"
            )
            expect(dialog).to_be_visible()
            expect(dialog.locator(".order-mark-number")).to_have_text(record.order_number)
            expect(dialog).to_contain_text(record.customer_name)
            expect(dialog).to_contain_text(record.cargo_marker)
            print_button = dialog.get_by_role("button", name="打印唛头")
            expect(print_button).to_be_visible()
            expect(print_button).to_be_focused()
            with page.expect_download() as download_info:
                dialog.get_by_role("link", name="下载 SVG").click()
            download = download_info.value
            expected_name = f"{record.order_number}-mark-label.svg"
            if download.suggested_filename != expected_name:
                raise AssertionError(
                    f"唛头下载文件名错误：{download.suggested_filename}"
                )
            saved = self.output_dir / expected_name
            download.save_as(str(saved))
            if not saved.is_file() or saved.stat().st_size <= 0:
                raise AssertionError("唛头 SVG 下载文件为空")
            case["values"]["mark_label"] = {
                "number": record.order_number,
                "download": str(saved),
                "bytes": saved.stat().st_size,
            }
            self.screenshot(case, page_name, "mark-label-modal")
            page.keyboard.press("Escape")
            expect(dialog).not_to_be_visible()
            expect(trigger).to_be_focused()

        with self.step(case, "已接受报价刷新后不再出现重复接受入口", page_name):
            self.navigate(page, self.portal_path(page_name, "/portal/quotes"))
            quote_row = page.get_by_role("row").filter(has_text=record.quote_number)
            expect(quote_row).to_have_count(1)
            expect(quote_row.get_by_role("button", name="接受报价")).to_have_count(0)
            quote_row_text = quote_row.inner_text()
            if record.order_number not in quote_row_text:
                raise AssertionError(
                    f"已接受报价行未保留原订单号：{quote_row_text}"
                )
            page.reload(wait_until="domcontentloaded")
            self.acknowledge_required_notifications(page)
            quote_row = page.get_by_role("row").filter(has_text=record.quote_number)
            expect(quote_row.get_by_role("button", name="接受报价")).to_have_count(0)
            case["values"]["duplicate_accept_prevented"] = True

        with self.step(case, "订单查看轨迹保留当前窗口上下文", page_name):
            self.navigate(page, self.portal_path(page_name, "/portal/orders"))
            row = page.get_by_role("row").filter(has_text=record.order_number)
            row.get_by_role("link", name="查看轨迹").click()
            expect(page).to_have_url(re.compile(r"/portal/tracking\?.*order="))
            self.assert_portal_identity(page_name, self.args.customer4_name)
            expect(page.locator("body")).to_contain_text(record.order_number)
            self.screenshot(case, page_name, "tracking-from-order")

    def load_portal_feature_resume_state(self) -> None:
        source = Path(self.args.resume_portal_features_from).resolve()
        if not source.is_file():
            raise AssertionError(f"续测摘要不存在：{source}")
        payload = json.loads(source.read_text(encoding="utf-8"))
        raw_orders = payload.get("orders") or {}
        for case_id, raw in raw_orders.items():
            self.orders[case_id] = OrderRecord(**raw)
        if "ltl1" not in self.orders:
            raise AssertionError(f"续测摘要缺少 ltl1 订单：{source}")
        customer4 = self.orders["ltl1"]
        self.args.customer4_name = customer4.customer_name
        self.args.customer4_email = customer4.customer_email
        self.batch = dict(payload.get("batch") or {})

    def run_resumed_portal_features(self) -> int:
        self.load_portal_feature_resume_state()
        failure: Exception | None = None
        try:
            self.run_case(
                "08-portal-order-notification-mark-resume",
                "客户门户订单、通知、唛头与防重续测",
                "使用已由同一真实键鼠用例创建的订单，续测通知、"
                "键盘筛选、唛头SVG、报价防重和轨迹导航。",
                ("customer4",),
                self.case_portal_order_features,
            )
        except Exception as error:
            failure = error
        self.flush_summary(partial=False)
        return 1 if failure else 0

    def case_ftl_1(self, case: dict[str, Any]) -> None:
        with self.step(case, "登录管理后台", "admin"):
            self.login_admin(case)
        with self.step(case, "通过页面恢复整车与拼车工作流用例初始状态", "admin"):
            self.ensure_workflow_precondition(case, "ftl", "required")
            self.ensure_workflow_precondition(case, "ltl", "required")
        with self.step(case, "新增客户4并开通绑定门户账号", "admin"):
            self.create_customer_and_portal(
                case, self.args.customer4_name, self.args.customer4_email, 4
            )
        with self.step(case, "客户4使用独立上下文登录", "customer4"):
            self.login_portal(
                case,
                "customer4",
                self.args.customer4_email,
                self.args.customer4_name,
            )
        with self.step(case, "创建整车订单1报价", "admin"):
            record = self.create_quote(
                case,
                "ftl1",
                "ftl",
                self.args.customer4_name,
                self.args.customer4_email,
                1,
            )
        with self.step(case, "客户4接受整车订单1报价", "customer4"):
            self.accept_quote_in_portal(case, "customer4", record)
        with self.step(case, "核验询价字段并将整车委托书必填改为选填", "admin"):
            self.change_consignment_letter_mode(
                case, record, "required", "optional", assert_quote_catalog=True
            )
        with self.step(case, "整车订单1无委托书仍可提交并审批", "admin"):
            self.exercise_consignment_gate(
                case, record, should_block_without_letter=False, upload_after_block=False
            )

    def case_ftl_2(self, case: dict[str, Any]) -> None:
        with self.step(case, "创建整车订单2报价", "admin"):
            record = self.create_quote(
                case,
                "ftl2",
                "ftl",
                self.args.customer4_name,
                self.args.customer4_email,
                2,
            )
        with self.step(case, "客户4接受整车订单2报价", "customer4"):
            self.accept_quote_in_portal(case, "customer4", record)
        with self.step(case, "将整车委托书选填改为必填", "admin"):
            self.change_consignment_letter_mode(case, record, "optional", "required")
        with self.step(case, "整车订单2缺委托书被阻断，上传审核后解除", "admin"):
            self.exercise_consignment_gate(
                case, record, should_block_without_letter=True, upload_after_block=True
            )

    def case_ltl_1(self, case: dict[str, Any]) -> None:
        with self.step(case, "创建拼车订单1报价", "admin"):
            record = self.create_quote(
                case,
                "ltl1",
                "ltl",
                self.args.customer4_name,
                self.args.customer4_email,
                3,
            )
        with self.step(case, "客户4接受拼车订单1报价", "customer4"):
            self.accept_quote_in_portal(case, "customer4", record)
        with self.step(case, "核验询价字段并将拼车委托书必填改为选填", "admin"):
            self.change_consignment_letter_mode(
                case, record, "required", "optional", assert_quote_catalog=True
            )
        with self.step(case, "拼车订单1无委托书仍可提交并审批", "admin"):
            self.exercise_consignment_gate(
                case, record, should_block_without_letter=False, upload_after_block=False
            )
        with self.step(case, "仓库账号独立登录", "warehouse"):
            self.login_warehouse(case)
        with self.step(case, "拼车订单1派单、国内运输并验收入库", "warehouse"):
            self.progress_ltl_to_warehouse(case, record, 3)

    def case_ltl_2(self, case: dict[str, Any]) -> None:
        with self.step(
            case,
            "创建拼车订单2报价（原需求整车字样按已确认笔误执行LTL）",
            "admin",
        ):
            record = self.create_quote(
                case,
                "ltl2",
                "ltl",
                self.args.customer4_name,
                self.args.customer4_email,
                4,
            )
        with self.step(case, "客户4接受拼车订单2报价", "customer4"):
            self.accept_quote_in_portal(case, "customer4", record)
        with self.step(case, "将拼车委托书选填改为必填", "admin"):
            self.change_consignment_letter_mode(case, record, "optional", "required")
        with self.step(case, "拼车订单2缺委托书被阻断，上传审核后解除", "admin"):
            self.exercise_consignment_gate(
                case, record, should_block_without_letter=True, upload_after_block=True
            )
        with self.step(case, "拼车订单2派单、国内运输并验收入库", "warehouse"):
            self.progress_ltl_to_warehouse(case, record, 4)

    def case_ltl_3(self, case: dict[str, Any]) -> None:
        with self.step(case, "新增客户5并开通绑定门户账号", "admin"):
            self.create_customer_and_portal(
                case, self.args.customer5_name, self.args.customer5_email, 5
            )
        with self.step(case, "客户5使用独立上下文登录", "customer5"):
            self.login_portal(
                case,
                "customer5",
                self.args.customer5_email,
                self.args.customer5_name,
            )
        with self.step(case, "创建拼车订单3报价", "admin"):
            record = self.create_quote(
                case,
                "ltl3",
                "ltl",
                self.args.customer5_name,
                self.args.customer5_email,
                5,
            )
        with self.step(case, "客户5接受拼车订单3报价", "customer5"):
            self.accept_quote_in_portal(case, "customer5", record)
        with self.step(case, "拼车订单3按当前必填规则上传委托书并审批", "admin"):
            page = self._consignment_page(record)
            self.upload_consignment_letter(page)
            self._select_approver_and_submit(page)
            page = self._consignment_page(record)
            self.review_consignment_letter(page)
            self.approve_consignment(page, record)
        with self.step(case, "拼车订单3派单、国内运输并验收入库", "warehouse"):
            self.progress_ltl_to_warehouse(case, record, 5)
        ltl_records = [self.orders["ltl1"], self.orders["ltl2"], self.orders["ltl3"]]
        with self.step(case, "三票不同委托书历史状态均可勾选并生成PZ", "warehouse"):
            self.create_pz_batch(case, ltl_records)
        with self.step(case, "只按PZ阶段动态规则补齐并核验必填文件", "warehouse"):
            self.upload_required_batch_documents(case, ltl_records)
        with self.step(case, "PZ承运资源、口岸及清关信息同步到三票订单", "admin"):
            self.assert_batch_synced_to_orders(case, ltl_records)

    def run(self) -> int:
        if self.args.resume_portal_features_from:
            return self.run_resumed_portal_features()
        base_plans: list[
            tuple[str, str, str, Sequence[str], Callable[[dict[str, Any]], None]]
        ] = [
            (
                "01-ftl-required-to-optional",
                "整车订单1：委托书必填改选填后不阻断",
                "客户4接受报价；未上传委托书；即时改为选填；提交审批不被阻断。",
                ("admin", "customer4"),
                self.case_ftl_1,
            ),
            (
                "02-ftl-optional-to-required",
                "整车订单2：委托书选填改必填后立即阻断",
                "缺委托书明确阻断；上传并审核后解除，且不死锁。",
                ("admin", "customer4"),
                self.case_ftl_2,
            ),
            (
                "03-ltl-required-to-optional",
                "拼车订单1：委托书必填改选填后不阻断",
                "无委托书完成委托审批、派单、国内运输和仓库货齐入库。",
                ("admin", "customer4", "warehouse"),
                self.case_ltl_1,
            ),
            (
                "04-ltl-optional-to-required",
                "拼车订单2：委托书选填改必填后立即阻断",
                "缺委托书阻断；补齐后完成入库；业务类型严格按LTL执行。",
                ("admin", "customer4", "warehouse"),
                self.case_ltl_2,
            ),
            (
                "05-ltl-three-order-pz",
                "拼车订单3及三票PZ配载同步",
                "新客户5完成第三票；三票不受历史委托书差异阻断；"
                "PZ文件齐套且信息同步订单。",
                ("admin", "customer5", "warehouse"),
                self.case_ltl_3,
            ),
        ]
        failure: Exception | None = None
        for index, (case_id, title, expected, contexts, callback) in enumerate(base_plans):
            try:
                self.run_case(case_id, title, expected, contexts, callback)
            except Exception as error:
                failure = error
                for blocked_id, blocked_title, blocked_expected, _, _ in base_plans[index + 1 :]:
                    blocked = self.new_case(blocked_id, blocked_title, blocked_expected)
                    blocked["status"] = "BLOCKED"
                    blocked["error"] = (
                        f"前置串行案例 {case_id} 失败，后续业务状态不可可信地继续："
                        f"{truncated(error)}"
                    )
                    blocked["ended_at"] = utc_now()
                break

        extension_plans: list[
            tuple[
                str,
                str,
                str,
                Sequence[str],
                Sequence[str],
                Callable[[dict[str, Any]], None],
            ]
        ] = [
            (
                "06-portal-self-registration-binding",
                "客户自助注册、审核前阻断与后台绑定",
                "客户6只由页面新建客户与提交注册；审核前不可登录，绑定后只显示客户6。",
                ("admin", "customer6"),
                (),
                self.case_registration_binding,
            ),
            (
                "07-same-browser-three-window-isolation",
                "同一浏览器三窗口客户身份隔离",
                "客户4/5/6 使用同一 BrowserContext 不同窗口登录；"
                "导航、刷新、单窗口退出均不串号。",
                ("portalShared",),
                ("06-portal-self-registration-binding",),
                self.case_same_browser_portal_isolation,
            ),
            (
                "08-portal-order-notification-mark",
                "客户门户订单、通知、唛头与防重",
                "报价通知可已读；键盘查询只返回唯一订单；"
                "唛头号等于订单号且SVG可下载；已接受报价不可重复接受。",
                ("customer4",),
                (),
                self.case_portal_order_features,
            ),
        ]
        if failure is None:
            for case_id, title, expected, contexts, dependencies, callback in extension_plans:
                failed_dependencies = [
                    dependency
                    for dependency in dependencies
                    if not any(
                        item["id"] == dependency and item["status"] == "PASSED"
                        for item in self.cases
                    )
                ]
                if failed_dependencies:
                    blocked = self.new_case(case_id, title, expected)
                    blocked["status"] = "BLOCKED"
                    blocked["error"] = (
                        "扩展用例依赖未通过：" + "、".join(failed_dependencies)
                    )
                    blocked["ended_at"] = utc_now()
                    failure = failure or RuntimeError(blocked["error"])
                    continue
                try:
                    self.run_case(case_id, title, expected, contexts, callback)
                except Exception as error:
                    # 扩展用例彼此独立：记录失败并继续收集后续功能证据。
                    failure = failure or error
        else:
            for case_id, title, expected, _, _, _ in extension_plans:
                blocked = self.new_case(case_id, title, expected)
                blocked["status"] = "BLOCKED"
                blocked["error"] = "原五单串行业务前置失败，扩展结果不可信。"
                blocked["ended_at"] = utc_now()
        self.flush_summary(partial=False)
        return 1 if failure else 0


def build_parser() -> argparse.ArgumentParser:
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    parser = argparse.ArgumentParser(
        description="真实 Playwright 键鼠验证 2 整车 + 3 拼车及客户门户关键功能。"
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument("--admin-email", default="admin@e2e.test")
    parser.add_argument("--warehouse-email", default="ucrstore01@e2e.test")
    parser.add_argument(
        "--admin-password",
        default=os.environ.get("TMS_E2E_ADMIN_PASSWORD", ""),
        help="也可用 TMS_E2E_ADMIN_PASSWORD 环境变量提供",
    )
    parser.add_argument(
        "--portal-password",
        default=os.environ.get("TMS_E2E_PORTAL_PASSWORD", ""),
        help="也可用 TMS_E2E_PORTAL_PASSWORD 环境变量提供",
    )
    parser.add_argument(
        "--warehouse-password",
        default=os.environ.get("TMS_E2E_WAREHOUSE_PASSWORD", ""),
        help="可选；未提供时使用管理员密码",
    )
    parser.add_argument("--pdf", default=".tmp_consign.pdf", help="委托书及测试文件 PDF")
    parser.add_argument("--run-id", default=run_id)
    parser.add_argument("--customer4-name", default=f"五单同步测试客户4-{run_id}")
    parser.add_argument("--customer5-name", default=f"五单同步测试客户5-{run_id}")
    parser.add_argument("--customer6-name", default=f"自助注册测试客户6-{run_id}")
    parser.add_argument("--customer4-email", default=f"customer4.{run_id}@e2e.test")
    parser.add_argument("--customer5-email", default=f"customer5.{run_id}@e2e.test")
    parser.add_argument("--customer6-email", default=f"customer6.{run_id}@e2e.test")
    parser.add_argument(
        "--resume-portal-features-from",
        default="",
        help="从先前 summary.json 读取已创建订单，仅续测客户门户功能",
    )
    parser.add_argument("--customer-state", default="广东省")
    parser.add_argument("--customer-city", default="深圳市")
    parser.add_argument("--origin-country", default="中国")
    parser.add_argument("--origin-state", default="广东省")
    parser.add_argument("--origin-city", default="深圳市")
    parser.add_argument("--destination-country", default="乌兹别克斯坦")
    parser.add_argument("--destination-state", default="塔什干市")
    parser.add_argument("--destination-city", default="塔什干")
    parser.add_argument(
        "--output-dir", default=f"output/playwright/five-order-workflow-sync-{run_id}"
    )
    parser.add_argument("--timeout-ms", type=int, default=15_000)
    parser.add_argument("--navigation-timeout-ms", type=int, default=30_000)
    parser.add_argument("--slow-mo", type=int, default=50)
    parser.add_argument("--headless", action="store_true", help="默认有头；指定后改为无头")
    parser.add_argument("--stdout-json-limit", type=int, default=12_000)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    errors = []
    if not args.admin_password:
        errors.append("缺少 --admin-password 或 TMS_E2E_ADMIN_PASSWORD")
    if not args.portal_password:
        errors.append("缺少 --portal-password 或 TMS_E2E_PORTAL_PASSWORD")
    elif not (
        len(args.portal_password) >= 12
        and re.search(r"[a-z]", args.portal_password)
        and re.search(r"[A-Z]", args.portal_password)
        and re.search(r"\d", args.portal_password)
    ):
        errors.append("客户门户密码需至少 12 位，并包含大小写字母和数字")
    pdf = Path(args.pdf).resolve()
    if not pdf.is_file():
        errors.append(f"测试 PDF 不存在：{pdf}")
    if errors:
        print(
            json.dumps({"status": "CONFIG_ERROR", "errors": errors}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    runner: FiveOrderWorkflowSync | None = None
    exit_code = 1
    with sync_playwright() as playwright:
        try:
            runner = FiveOrderWorkflowSync(playwright, args)
            exit_code = runner.run()
        except Exception as error:
            if runner is not None:
                runner.flush_summary(partial=False)
            print(
                json.dumps(
                    {"status": "FAILED", "error": truncated(error, 6_000)},
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
        finally:
            if runner is not None:
                runner.close()
    console_payload = {
        "status": "PASSED" if exit_code == 0 else "FAILED",
        "run_id": args.run_id,
        "summary": str(Path(args.output_dir).resolve() / "summary.json"),
        "artifacts": str(Path(args.output_dir).resolve()),
        "orders": {
            case_id: record.order_number
            for case_id, record in (runner.orders.items() if runner is not None else [])
        },
        "pz_batch": runner.batch.get("number", "") if runner is not None else "",
    }
    output = json.dumps(console_payload, ensure_ascii=False)
    if len(output) > args.stdout_json_limit:
        output = f"{output[:args.stdout_json_limit]}…<stdout-json-truncated>"
    print(output)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
