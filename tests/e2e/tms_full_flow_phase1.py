#!/usr/bin/env python3
"""International TMS 纯 UI 全流程执行器：第一段。

覆盖范围：

1. 业务岗从客户管理新建一个全新客户，并开通与该客户严格绑定的门户账号；
2. 业务岗创建 1 张整车、3 张拼车报价；
3. 新客户在独立客户门户上下文逐份核对并确认报价，生成 4 张订单；
4. 业务岗逐单补齐当前工作流要求的委托资料并提请业务主管审批；
5. 业务主管逐单审核委托书、审批委托并指定下一步操作主管；
6. 操作主管在“普通订单”页按订单锁定的工作流逐单分配必填责任岗位。

本文件是认证级业务场景，所有业务写入必须经 ``RoleBrowserSession`` 记录的
可见控件和键鼠动作完成。脚本不直接访问数据库或 HTTP API，不注入 DOM、
Cookie、localStorage，不使用正向深链，不使用隐藏 input 直接上传文件。

默认运行只校验执行条件并输出 ``READY_NOT_EXECUTED``。只有明确传入
``--execute`` 才会创建业务数据，避免预检或导入模块时误写系统。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from playwright.sync_api import Locator, TimeoutError as PlaywrightTimeoutError, sync_playwright


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_ui_credentials import CredentialRecord, CredentialVault, load_credentials
from tms_ui_harness import (
    AttemptIdentity,
    AttemptSeries,
    GateExpectation,
    RoleBrowserSession,
    TmsUIHarness,
)


ORDER_NUMBER_RE = re.compile(r"\bSO[0-9A-Z-]{6,}\b")
QUOTE_NUMBER_RE = re.compile(r"\bQT[0-9A-Z-]{6,}\b")
ERROR_PAGE_RE = re.compile(r"请求失败|SYSTEM RECOVERY|Forbidden|Internal Server Error", re.I)

REQUIRED_ACCOUNT_ALIASES = (
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
)
EXPECTED_ACCOUNT_SITES = {
    "domestic_warehouse": "warehouse",
    "overseas_warehouse": "warehouse",
    "customer": "portal",
}

PHASE1_STAGE_ORDER = (
    "customer_binding",
    "quotation_creation",
    "portal_acceptance",
    "consignment_submission",
    "business_approval",
    "ordinary_order_assignment",
)
PHASE1_NEGATIVE_GATE_CASES = (
    "P1-NEG-CONSIGN-REQUIRED",
)
ASSIGNMENT_POSITION_CREDENTIAL_ALIASES = {
    "SALES": "sales",
    "BUSINESS_SUPERVISOR": "business_supervisor",
    "OPERATION_SUPERVISOR": "operation_supervisor",
    "OPERATION": "operation",
    "DOC": "document",
    "CS": "customer_service",
    "FINANCE_ACCOUNTING": "finance",
    "CASHIER": "cashier",
    "WAREHOUSE": "domestic_warehouse",
    "OVERSEAS_WAREHOUSE": "overseas_warehouse",
}


def assignment_mode_requires_person(mode: str) -> bool:
    normalized = mode.strip() or "person"
    if normalized == "person":
        return True
    if normalized == "site_queue":
        return False
    raise ValueError(f"未知工作流责任分配模式：{normalized}")


class BusinessBlocker(RuntimeError):
    """A real UI/business gate that prevents the scenario from advancing."""

    def __init__(self, message: str, *, owner: str, remediation: str) -> None:
        super().__init__(message)
        self.owner = owner
        self.remediation = remediation


@dataclass(frozen=True, slots=True)
class FreshBusinessIdentity:
    customer_name: str
    customer_short_name: str
    contact_name: str
    contact_phone: str
    portal_display_name: str
    portal_email: str = field(repr=False)


@dataclass(slots=True)
class Phase1Order:
    key: str
    business_type: str
    cargo_marker: str
    quote_number: str = ""
    order_number: str = ""


def build_fresh_identity(attempt: AttemptIdentity) -> FreshBusinessIdentity:
    """Build names that can never collide with a previous failed attempt."""

    compact = re.sub(r"[^0-9A-Za-z]", "", attempt.entity_prefix)
    suffix = compact[-18:]
    digits = re.sub(r"\D", "", compact)[-8:].rjust(8, "7")
    return FreshBusinessIdentity(
        customer_name=f"UI全流程验收客户-{suffix}",
        customer_short_name=f"UI验收-{suffix[-10:]}",
        contact_name=f"验收联系人-{suffix[-8:]}",
        contact_phone=f"138{digits}",
        portal_display_name=f"客户验收账号-{suffix[-8:]}",
        portal_email=f"uie2e.phase1.{compact.lower()}@example.test",
    )


def phase1_records(attempt: AttemptIdentity) -> list[Phase1Order]:
    prefix = attempt.entity_prefix
    return [
        Phase1Order("ftl", "ftl", f"{prefix}-FTL-货物"),
        Phase1Order("ltl1", "ltl", f"{prefix}-LTL-01-货物"),
        Phase1Order("ltl2", "ltl", f"{prefix}-LTL-02-货物"),
        Phase1Order("ltl3", "ltl", f"{prefix}-LTL-03-货物"),
    ]


def validate_full_flow_credentials(
    vault: CredentialVault,
) -> tuple[CredentialRecord, ...]:
    """Fail before Phase 1 writes when any downstream actor is unusable."""

    selected = vault.select(REQUIRED_ACCOUNT_ALIASES)
    invalid = [
        item.alias
        for item in selected
        if not item.email.strip() or not item.password
    ]
    if invalid:
        raise ValueError(
            "全流程账号缺少非空登录邮箱或密码：" + "、".join(invalid)
        )
    wrong_sites = [
        item.alias
        for item in selected
        if item.site != EXPECTED_ACCOUNT_SITES.get(item.alias, "admin")
    ]
    if wrong_sites:
        raise ValueError(
            "全流程账号登录站点配置不正确：" + "、".join(wrong_sites)
        )
    return selected


def _public_preflight(vault: CredentialVault, *, base_url: str) -> dict[str, Any]:
    selected = validate_full_flow_credentials(vault)
    return {
        "status": "READY_NOT_EXECUTED",
        "base_url": base_url.rstrip("/"),
        "required_roles": [item.public_summary() for item in selected],
        "stage_order": list(PHASE1_STAGE_ORDER),
        "business_writes": False,
        "next_action": "完成权限修复 Git 检查点后，显式传入 --execute 执行。",
    }


def _workflow_gate(
    name: str,
    *,
    source: str = "workflow_instance_field_configuration",
    configured_mode: str = "required",
    expected_behavior: str = "allow",
    ui: str,
    server: str,
    owner: str,
    remediation: str,
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source=source,  # type: ignore[arg-type]
        configured_mode=configured_mode,  # type: ignore[arg-type]
        expected_behavior=expected_behavior,  # type: ignore[arg-type]
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation=remediation,
    )


def _permission_gate(name: str, *, ui: str, server: str, owner: str) -> GateExpectation:
    return GateExpectation(
        name=name,
        source="role_permission_configuration",
        configured_mode="operate",
        expected_behavior="allow",
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对岗位权限积木、订单范围与当前处理人是否一致。",
    )


class Phase1Flow:
    """Browser-only phase-one scenario using one isolated context per actor."""

    def __init__(
        self,
        *,
        harness: TmsUIHarness,
        credentials: Mapping[str, CredentialRecord],
        attempt: AttemptIdentity,
        identity: FreshBusinessIdentity,
        records: Sequence[Phase1Order],
        origin_country: str,
        origin_state: str,
        origin_city: str,
        destination_country: str,
        destination_state: str,
        destination_city: str,
    ) -> None:
        self.harness = harness
        self.credentials = dict(credentials)
        self.attempt = attempt
        self.identity = identity
        self.records = list(records)
        self.origin_country = origin_country
        self.origin_state = origin_state
        self.origin_city = origin_city
        self.destination_country = destination_country
        self.destination_state = destination_state
        self.destination_city = destination_city
        self.fixture_path: Path | None = None
        self.assignees: dict[str, dict[str, str]] = {
            "operation": {},
            "document": {},
            "customer_service": {},
            "finance": {},
        }

        self.sales = self._add_role(self.credentials["sales"])
        self.business_supervisor = self._add_role(self.credentials["business_supervisor"])
        self.operation_supervisor = self._add_role(self.credentials["operation_supervisor"])
        self.customer = harness.add_role(
            "fresh_customer",
            identity.portal_email,
            site="portal",
        )

    def _add_role(self, credential: CredentialRecord) -> RoleBrowserSession:
        return self.harness.add_role(
            credential.alias,
            credential.email,
            site=credential.site,
        )

    @staticmethod
    def _is_visible(locator: Locator) -> bool:
        return locator.count() > 0 and locator.first.is_visible()

    @staticmethod
    def _page_error_text(session: RoleBrowserSession) -> str:
        body = session.page.locator("body")
        if body.count() == 0:
            return ""
        return body.inner_text(timeout=3_000)[:8_000]

    def _assert_no_error_page(self, session: RoleBrowserSession) -> None:
        body = self._page_error_text(session)
        if ERROR_PAGE_RE.search(body):
            raise BusinessBlocker(
                "页面进入系统错误或权限恢复页，无法继续当前业务步骤。",
                owner="系统权限/路由维护者",
                remediation="核对该岗位的订单范围、页面 loader 权限和当前节点办理权限。",
            )

    def _dismiss_required_notifications(self, session: RoleBrowserSession) -> None:
        for _ in range(8):
            candidates = session.page.get_by_role(
                "button", name=re.compile(r"^(确认知悉|知道了)$")
            )
            visible: Locator | None = None
            for index in range(candidates.count()):
                candidate = candidates.nth(index)
                if candidate.is_visible():
                    visible = candidate
                    break
            if visible is None:
                return
            session.click(visible, "确认重要变更通知")
            session.page.wait_for_timeout(120)
        raise BusinessBlocker(
            "重要变更通知连续出现超过 8 次，疑似通知确认循环。",
            owner="通知中心维护者",
            remediation="检查必读通知的确认状态是否按用户持久化。",
        )

    def _login(self, session: RoleBrowserSession, password: str, label: str) -> None:
        with session.step(
            f"{label}从可见登录页登录",
            case_id=f"LOGIN-{session.role.upper().replace('_', '-')}",
            stage="账号与权限",
            priority="P0",
            preconditions=("账号来自运行时凭据文件", "浏览器上下文与其他岗位隔离"),
            inputs={"account_email": session.email, "site": session.site},
            expected_result=f"{label}进入所属工作台，不出现 403/500。",
            gate=_permission_gate(
                f"{label}登录与工作台权限",
                ui="登录成功后只显示本岗位获授权的菜单与数据入口。",
                server="会话身份、组织和岗位权限一致时允许进入。",
                owner=label,
            ),
            sensitive=True,
        ) as observation:
            session.login(password)
            self._dismiss_required_notifications(session)
            self._assert_no_error_page(session)
            observation.observe(f"{label}登录成功并进入工作台", gate_passed=True)
        session.start_trace("phase1-visible-actions")

    def _click_navigation(self, session: RoleBrowserSession, label: str) -> None:
        navigation_name = "客户门户导航" if session.site == "portal" else "运营管理导航"
        navigation = session.page.get_by_role("navigation", name=navigation_name)
        link = navigation.get_by_role("link", name=label, exact=True)
        if link.count() == 0 or not link.first.is_visible():
            raise BusinessBlocker(
                f"{session.role} 工作台未显示“{label}”菜单。",
                owner="角色权限管理员",
                remediation=f"核对 {session.role} 是否具备访问“{label}”所需的菜单与页面权限。",
            )
        session.click(link.first, f"导航到{label}")
        session.page.wait_for_timeout(180)
        self._dismiss_required_notifications(session)
        self._assert_no_error_page(session)

    def _expect_success(
        self,
        session: RoleBrowserSession,
        text: str | re.Pattern[str],
        target: str,
    ) -> str:
        success = session.page.locator(".alert.success, .gate.ok, [role='status'].alert").filter(
            has_text=text
        ).first
        try:
            session.expect_visible(success, target)
        except Exception as original:
            errors = session.page.locator(".alert.error, .gate:not(.ok), [role='alert']")
            visible_errors = [
                errors.nth(index).inner_text()[:1_500]
                for index in range(errors.count())
                if errors.nth(index).is_visible()
            ]
            if visible_errors:
                raise BusinessBlocker(
                    f"{target}被页面门禁阻断：{'；'.join(visible_errors)}",
                    owner="当前业务节点负责人",
                    remediation="按页面提示核对工作流实例中的必填字段、模块状态和岗位权限。",
                ) from original
            raise
        return success.inner_text()[:2_000]

    def _expect_current_step(
        self,
        session: RoleBrowserSession,
        step_name: str,
        order_number: str,
    ) -> None:
        current = session.page.locator(".workflow-meta").get_by_text(
            f"当前节点：{step_name}", exact=True
        )
        try:
            session.expect_visible(
                current, f"{order_number} 当前节点更新为{step_name}"
            )
        except Exception as original:
            errors = session.page.locator(".alert.error, [role='alert']")
            visible_errors = [
                errors.nth(index).inner_text()[:1_500]
                for index in range(errors.count())
                if errors.nth(index).is_visible()
            ]
            if visible_errors:
                raise BusinessBlocker(
                    f"订单 {order_number} 未进入{step_name}：{'；'.join(visible_errors)}",
                    owner="当前工作流节点维护者",
                    remediation="核对页面动作、服务端门禁与工作流实例是否使用同一配置快照。",
                ) from original
            raise

    @staticmethod
    def _option_rows(select: Locator) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        options = select.locator("option")
        for index in range(options.count()):
            option = options.nth(index)
            value = option.get_attribute("value") or ""
            label = option.inner_text().strip()
            if value and not option.is_disabled():
                result.append((value, label))
        return result

    def _select_matching(
        self,
        session: RoleBrowserSession,
        select: Locator,
        expected: str,
        target: str,
    ) -> str:
        session.expect_visible(select, target)
        candidates = self._option_rows(select)
        chosen = next(
            (item for item in candidates if item[1] == expected or expected in item[1]),
            None,
        )
        if chosen is None:
            labels = [label for _, label in candidates]
            raise BusinessBlocker(
                f"{target}找不到“{expected}”；可选项为：{labels}",
                owner="基础数据/工作流配置维护者",
                remediation=f"补齐 {target} 的可选基础数据，或修正测试环境配置。",
            )
        session.select(select, target, value=chosen[0])
        return chosen[1]

    def _select_first_nonempty(
        self,
        session: RoleBrowserSession,
        select: Locator,
        target: str,
        *,
        preferred: str = "",
    ) -> str:
        session.expect_visible(select, target)
        candidates = self._option_rows(select)
        if not candidates:
            raise BusinessBlocker(
                f"{target}没有可选择的数据。",
                owner="组织/基础数据维护者",
                remediation=f"为 {target} 配置至少一个有效选项。",
            )
        chosen = next(
            (item for item in candidates if preferred and preferred in item[1]),
            candidates[0],
        )
        session.select(select, target, value=chosen[0])
        return chosen[1]

    def _select_geo(
        self,
        session: RoleBrowserSession,
        form: Locator,
        *,
        prefix: str,
        country: str,
        state: str,
        city: str,
    ) -> None:
        picker = form.locator(f'.quote-geo-picker:has(select[name="{prefix}Country"])')
        if picker.count() == 0 or not picker.first.is_visible():
            return
        place = "起运" if prefix == "origin" else "目的"
        session.click(picker.get_by_role("button").first, f"展开{place}地区级联选择")
        for expected in (country, state, city):
            option = picker.get_by_role("option", name=expected, exact=True)
            if option.count() == 0:
                option = picker.get_by_role("option").filter(has_text=expected)
            if option.count() == 0:
                available = picker.get_by_role("option").all_inner_texts()
                raise BusinessBlocker(
                    f"{place}地区级联找不到“{expected}”；当前可选：{available}",
                    owner="基础地理数据维护者",
                    remediation="补齐国家、省州和城市的父子层级数据。",
                )
            session.click(option.first, f"选择{place}地区：{expected}")
            session.page.wait_for_timeout(80)

    def _select_assignee(
        self,
        session: RoleBrowserSession,
        picker: Locator,
        *,
        person_label: str,
        preferred_person: str = "",
    ) -> str:
        trigger = picker.locator(".organization-assignee-trigger")
        session.expect_visible(trigger, f"{person_label}选择器")
        session.click(trigger, f"展开{person_label}组织选择")
        cascade = session.page.get_by_role("group", name=f"选择{person_label}")
        session.expect_visible(cascade, f"{person_label}三级组织选择面板")

        for level, purpose in (("1", "部门"), ("2", "岗位")):
            panel = cascade.get_by_role("listbox", name=re.compile(rf"^{level}\s"))
            session.expect_visible(panel, f"{person_label}{purpose}列表")
            options = panel.get_by_role("option")
            if options.count() == 0:
                raise BusinessBlocker(
                    f"{person_label}缺少可选{purpose}。",
                    owner="组织成员维护者",
                    remediation=f"为{person_label}绑定有效部门、岗位和个人账号。",
                )
            session.click(options.first, f"选择{person_label}{purpose}")
            session.page.wait_for_timeout(80)

        people = cascade.get_by_role("listbox", name=re.compile(r"^3\s")).get_by_role(
            "option"
        )
        if people.count() == 0:
            raise BusinessBlocker(
                f"{person_label}岗位下没有可派遣个人账号。",
                owner="组织成员维护者",
                remediation=f"为{person_label}岗位绑定至少一名启用用户。",
            )
        selected = people.first
        if preferred_person:
            preferred = people.filter(has_text=preferred_person)
            if preferred.count() > 0:
                selected = preferred.first
        selected_name = selected.inner_text().strip()
        session.click(selected, f"选择{person_label}个人账户")

        validator = picker.locator("select.organization-assignee-native-validator")
        value = validator.input_value()
        if not value:
            raise AssertionError(f"{person_label}可见选择完成后，原生校验值仍为空")
        return selected_name

    def _fill_required_quote_fields(
        self,
        session: RoleBrowserSession,
        form: Locator,
        *,
        marker: str,
    ) -> None:
        controls = form.locator(".quote-workflow-field-grid [required]")
        for index in range(controls.count()):
            control = controls.nth(index)
            if not control.is_visible() or control.is_disabled():
                continue
            tag = control.get_attribute("data-e2e-tag") or ""
            input_type = (control.get_attribute("type") or "").lower()
            role = control.get_attribute("role") or ""
            name = control.get_attribute("name") or f"custom-{index + 1}"
            options = control.locator("option")
            if options.count() > 0:
                self._select_first_nonempty(
                    session, control, f"报价自定义必填下拉 {index + 1}"
                )
            elif input_type == "file":
                if self.fixture_path is None:
                    raise AssertionError("上传报价自定义附件前尚未生成运行时附件")
                session.choose_files(
                    control,
                    self.fixture_path,
                    f"报价自定义必填附件 {index + 1}",
                )
            elif input_type == "date":
                session.type_date(
                    control,
                    (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"),
                    f"报价自定义日期 {index + 1}",
                )
            elif input_type == "datetime-local":
                session.type_datetime_local(
                    control,
                    (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M"),
                    f"报价自定义时间 {index + 1}",
                )
            elif input_type in {"number", "range"}:
                session.type_text(control, "1", f"报价自定义数字 {index + 1}")
            elif input_type in {"checkbox", "radio"} or role == "checkbox":
                session.set_checked(control, True, f"报价自定义选项 {index + 1}")
            else:
                # textarea and ordinary input both support visible keyboard input.
                session.type_text(
                    control,
                    f"{marker}-必填-{index + 1}",
                    f"报价自定义字段 {name}",
                )

    def create_and_bind_customer(self) -> None:
        gate = GateExpectation(
            name="客户门户账号与唯一客户档案绑定",
            source="system_integrity_invariant",
            configured_mode="required",
            expected_behavior="allow",
            ui_expectation="客户档案中显示一个可登录且归属当前客户的门户账号。",
            server_expectation="门户会话只能读取绑定 customer_id 范围内的数据。",
            owner_role="业务岗",
            remediation="在客户档案重新开通或审批并绑定门户账号，不得复用其他客户账号。",
        )
        with self.sales.step(
            "新建客户并开通严格绑定的客户门户账号",
            case_id="CUST-001",
            stage="客户与门户绑定",
            priority="P0",
            preconditions=("业务岗已登录", "客户名称和门户邮箱均为本 attempt 全新值"),
            inputs={
                "customer_name": self.identity.customer_name,
                "portal_email": self.identity.portal_email,
            },
            expected_result="客户、默认联系人、默认提货地址与门户账号一次创建完成。",
            gate=gate,
        ) as observation:
            self._click_navigation(self.sales, "客户管理")
            self.sales.click(
                self.sales.page.get_by_role("button", name="新增客户"),
                "新增客户",
            )
            dialog = self.sales.page.get_by_role("dialog", name="新增客户")
            self.sales.expect_visible(dialog, "新增客户弹窗")
            self.sales.type_text(
                dialog.locator('input[name="name"]'),
                self.identity.customer_name,
                "客户全称",
            )
            self.sales.select(
                dialog.locator('select[name="partyCategory"]'),
                "客商分类",
                value="customer",
            )
            self.sales.click(
                dialog.locator("details.customer-role-dropdown summary"),
                "展开客户业务身份",
            )
            self.sales.set_checked(
                dialog.locator('input[name="businessRoles"][value="principal"]'),
                True,
                "业务身份：委托客户",
            )
            self.sales.click(
                dialog.locator("details.customer-role-dropdown summary"),
                "收起客户业务身份",
            )
            self.sales.type_text(
                dialog.locator('input[name="shortName"]'),
                self.identity.customer_short_name,
                "客户简称",
            )
            self.sales.type_text(
                dialog.locator('input[name="contactName"]'),
                self.identity.contact_name,
                "默认联系人姓名",
            )
            self.sales.type_text(
                dialog.locator('input[name="contactPhone"]'),
                self.identity.contact_phone,
                "默认联系电话",
            )
            self.sales.type_text(
                dialog.locator('input[name="contactEmail"]'),
                self.identity.portal_email,
                "默认联系人邮箱",
                sensitive=True,
            )
            country = dialog.locator('select[name="addressCountryCode"]')
            if country.input_value() != "CN":
                self.sales.select(country, "默认地址国家", value="CN")
            self._select_matching(
                self.sales,
                dialog.locator('select[name="addressState"]'),
                self.origin_state,
                "默认地址省/州",
            )
            self._select_matching(
                self.sales,
                dialog.locator('select[name="addressCity"]'),
                self.origin_city,
                "默认地址城市",
            )
            self.sales.type_text(
                dialog.locator('input[name="addressLine1"]'),
                f"{self.origin_city} UI 全流程验收园区 {self.attempt.attempt} 号",
                "默认提货详细地址",
            )
            self.sales.screenshot("customer-before-create")
            self.sales.press(
                "Enter",
                "确认创建客户",
                locator=dialog.get_by_role("button", name="确认创建客户"),
            )
            self._expect_success(self.sales, "客户已创建", "客户创建成功提示")

            row = self.sales.page.locator("section.customer-ledger").get_by_role(
                "row"
            ).filter(has_text=self.identity.customer_name)
            self.sales.expect_visible(row, "新客户台账行")
            self.sales.click(row.get_by_role("button", name="客户档案"), "打开新客户档案")
            dossier = self.sales.page.get_by_role(
                "dialog", name=re.compile(rf"客户档案.*{re.escape(self.identity.customer_name)}")
            )
            self.sales.expect_visible(dossier, "新客户档案")
            self.sales.click(dossier.get_by_role("button", name="开通门户"), "开通客户门户")
            portal_dialog = self.sales.page.get_by_role(
                "dialog", name=re.compile(rf"开通客户门户.*{re.escape(self.identity.customer_name)}")
            )
            self.sales.expect_visible(portal_dialog, "开通客户门户弹窗")
            self.sales.type_text(
                portal_dialog.locator('input[name="displayName"]'),
                self.identity.portal_display_name,
                "客户门户用户姓名",
            )
            self.sales.type_text(
                portal_dialog.locator('input[name="email"]'),
                self.identity.portal_email,
                "客户门户登录邮箱",
                sensitive=True,
            )
            self.sales.type_text(
                portal_dialog.locator('input[name="password"]'),
                self.credentials["customer"].password,
                "客户门户初始密码",
                sensitive=True,
            )
            self.sales.press(
                "Enter",
                "确认开通客户门户",
                locator=portal_dialog.get_by_role("button", name="确认开通门户"),
            )
            self._expect_success(
                self.sales,
                "客户门户账号已开通",
                "门户账号开通成功提示",
            )
            self.harness.journal.register_entity(
                "customer", "primary", self.identity.customer_name
            )
            observation.observe("客户档案与门户账号创建并绑定完成", gate_passed=True)
            close_dossier = dossier.get_by_role("button", name="关闭")
            if self._is_visible(close_dossier):
                self.sales.click(close_dossier, "关闭新客户档案")

        with self.customer.step(
            "新客户从可见门户登录页验证绑定范围",
            case_id="CUST-LOGIN-001",
            stage="客户与门户绑定",
            priority="P0",
            preconditions=("后台已开通本 attempt 的新门户账号",),
            inputs={"portal_email": self.identity.portal_email},
            expected_result="门户首页显示本次新建客户名称，证明账号绑定正确。",
            gate=gate,
            sensitive=True,
        ) as observation:
            self.customer.login(self.credentials["customer"].password)
            self.customer.expect_visible(
                self.customer.page.get_by_text(self.identity.customer_name, exact=True).first,
                "门户客户范围名称",
            )
            self._assert_no_error_page(self.customer)
            observation.observe("新账号登录成功，门户范围显示新客户名称", gate_passed=True)
        self.customer.start_trace("phase1-visible-actions")

    def _create_quote(self, record: Phase1Order, sequence: int) -> None:
        gate = _workflow_gate(
            "询价报价字段随工作流实例配置",
            source="workflow_instance_module_state",
            ui="仅显示当前工作流启用字段，必填标记与控件状态即时一致。",
            server="只校验当前工作流实例中启用且必填的报价字段。",
            owner="业务岗",
            remediation="核对报价锁定工作流版本的字段 required/optional/hidden 配置。",
        )
        with self.sales.step(
            f"创建{record.business_type.upper()}报价 {record.key}",
            case_id=f"QUOTE-{record.key.upper()}-001",
            stage="询价报价",
            priority="P0",
            preconditions=("全新客户与门户账号已创建", "对应类型存在已发布工作流"),
            inputs={"business_type": record.business_type, "cargo_marker": record.cargo_marker},
            expected_result="报价保存为待客户确认，并在页面返回唯一报价号。",
            gate=gate,
        ) as observation:
            self.sales.click(
                self.sales.page.get_by_role("button", name="创建报价"),
                f"打开{record.key}创建报价弹窗",
            )
            dialog = self.sales.page.get_by_role("dialog", name="创建运输报价")
            self.sales.expect_visible(dialog, f"{record.key}创建运输报价弹窗")
            form = dialog.locator("form.prototype-quote-form")
            self.sales.select(
                form.locator('select[name="customerId"]'),
                f"{record.key}报价客户",
                label=self.identity.customer_name,
            )
            self.sales.page.wait_for_timeout(100)
            contact_name = form.locator('input[name="customerContactName"]')
            if self._is_visible(contact_name) and not contact_name.is_disabled():
                self.sales.type_text(
                    contact_name,
                    self.identity.contact_name,
                    f"{record.key}客户联系人",
                )
            contact_phone = form.locator('input[name="customerContactPhone"]')
            if self._is_visible(contact_phone) and not contact_phone.is_disabled():
                self.sales.type_text(
                    contact_phone,
                    self.identity.contact_phone,
                    f"{record.key}联系电话",
                )
            self.sales.select(
                form.locator('select[name="roadLoadType"]'),
                f"{record.key}订单类型",
                value=record.business_type,
            )
            self.sales.page.wait_for_timeout(220)
            workflow_label = self._select_first_nonempty(
                self.sales,
                form.locator('select[name="workflowDefinitionId"]'),
                f"{record.key}工作流版本",
                preferred="当前发布",
            )
            customs = form.locator('select[name="customsClearanceMode"]')
            if self._is_visible(customs):
                self.sales.select(customs, f"{record.key}清关办理方式", value="company")
            self._select_geo(
                self.sales,
                form,
                prefix="origin",
                country=self.origin_country,
                state=self.origin_state,
                city=self.origin_city,
            )
            self._select_geo(
                self.sales,
                form,
                prefix="destination",
                country=self.destination_country,
                state=self.destination_state,
                city=self.destination_city,
            )

            values = {
                "pickupAddress": f"{self.origin_city} UI 验收提货点 {sequence} 号",
                "destinationWarehouseNote": f"{self.attempt.run_id} 第 {sequence} 票",
                "cargoDescription": record.cargo_marker,
                "notes": f"{record.key} 纯 UI 全流程验收",
                "pieces": str(sequence + 1),
                "weight": str(100 + sequence * 10),
                "length": "120",
                "width": "80",
                "height": "90",
                "validUntil": (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"),
            }
            for name, value in values.items():
                control = form.locator(f'[name="{name}"]')
                if (
                    self._is_visible(control)
                    and not control.is_disabled()
                    and control.get_attribute("readonly") is None
                ):
                    input_type = (control.get_attribute("type") or "").lower()
                    if input_type == "date":
                        self.sales.type_date(control, value, f"{record.key} {name}")
                    elif input_type == "datetime-local":
                        self.sales.type_datetime_local(control, value, f"{record.key} {name}")
                    else:
                        self.sales.type_text(control, value, f"{record.key} {name}")
            warehouse = form.locator('select[name="destinationWarehouseId"]')
            if self._is_visible(warehouse):
                self._select_first_nonempty(
                    self.sales, warehouse, f"{record.key}境外目的仓"
                )
            price = form.locator('input[name="chargeUnitPrice"]').first
            if self._is_visible(price):
                self.sales.type_text(
                    price,
                    str(1_800 + sequence * 100),
                    f"{record.key}报价单价",
                )
            self._fill_required_quote_fields(self.sales, form, marker=record.cargo_marker)
            self.sales.click(
                form.get_by_role("button", name="保存报价并等待客户确认"),
                f"保存{record.key}报价",
            )
            feedback = self._expect_success(
                self.sales,
                "待客户确认",
                f"{record.key}报价保存成功提示",
            )
            match = QUOTE_NUMBER_RE.search(feedback)
            if not match:
                row = self.sales.page.get_by_role("row").filter(
                    has_text=record.cargo_marker
                )
                if row.count() > 0:
                    match = QUOTE_NUMBER_RE.search(row.first.inner_text())
            if not match:
                raise BusinessBlocker(
                    f"{record.key} 报价保存成功但页面没有展示唯一报价号。",
                    owner="询价报价页面维护者",
                    remediation="在保存成功反馈或报价台账中展示可复制的报价号。",
                )
            record.quote_number = match.group(0)
            self.harness.journal.register_entity("quotation", record.key, record.quote_number)
            observation.add_note(f"工作流：{workflow_label}")
            observation.observe(
                f"报价 {record.quote_number} 已进入待客户确认", gate_passed=True
            )

    def create_quotes(self) -> None:
        self._click_navigation(self.sales, "询价与报价")
        for sequence, record in enumerate(self.records, start=1):
            self._create_quote(record, sequence)

    def accept_quotes(self) -> None:
        gate = GateExpectation(
            name="客户只能确认本客户报价且一报一单",
            source="system_integrity_invariant",
            configured_mode="required",
            expected_behavior="allow",
            ui_expectation="新客户只看到自己的 4 张报价，逐份核对后确认。",
            server_expectation="每张报价至多生成一个订单，且 customer_id 必须匹配门户会话。",
            owner_role="客户",
            remediation="核对门户客户绑定、报价生命周期与一报一单唯一约束。",
        )
        self._click_navigation(self.customer, "我的订单")
        for record in self.records:
            with self.customer.step(
                f"客户核对并确认报价 {record.key}",
                case_id=f"PORTAL-ACCEPT-{record.key.upper()}",
                stage="客户确认报价",
                priority="P0",
                preconditions=(f"报价 {record.quote_number} 为待确认",),
                inputs={"quote_number": record.quote_number, "cargo_marker": record.cargo_marker},
                expected_result="确认后当前行变为运输订单并显示唯一 SO 订单号。",
                gate=gate,
            ) as observation:
                filters = self.customer.page.locator("form.order-table-filters")
                self.customer.type_text(
                    filters.locator('input[name="keyword"]'),
                    record.cargo_marker,
                    f"筛选{record.key}待确认报价",
                )
                self.customer.click(
                    filters.get_by_role("button", name="筛选"),
                    f"执行{record.key}报价筛选",
                )
                row = self.customer.page.get_by_role("row").filter(
                    has_text=record.cargo_marker
                )
                self.customer.expect_visible(row, f"{record.key}门户报价行")
                self.customer.click(
                    row.get_by_role("button", name="查看信息"),
                    f"查看{record.key}完整报价信息",
                )
                dialog = self.customer.page.get_by_role("dialog", name="报价详情")
                self.customer.expect_visible(dialog, f"{record.key}报价详情弹窗")
                self.customer.expect_visible(
                    dialog.get_by_text(record.cargo_marker, exact=True),
                    f"{record.key}报价货物标识",
                )
                self.customer.click(
                    dialog.get_by_role("button", name="确认报价"),
                    f"确认{record.key}报价",
                )
                row = (
                    self.customer.page.get_by_role("row")
                    .filter(has_text=record.cargo_marker)
                    .filter(has_text=ORDER_NUMBER_RE)
                )
                self.customer.expect_visible(row, f"{record.key}已生成订单行")
                match = ORDER_NUMBER_RE.search(row.first.inner_text())
                if not match:
                    raise BusinessBlocker(
                        f"客户确认 {record.key} 报价后，页面未显示 SO 订单号。",
                        owner="客户门户/报价转订单维护者",
                        remediation="确保确认成功后原行实时刷新为订单并展示订单号。",
                    )
                record.order_number = match.group(0)
                self.harness.journal.register_entity("order", record.key, record.order_number)
                observation.observe(
                    f"报价 {record.quote_number} 生成订单 {record.order_number}",
                    gate_passed=True,
                )

    def _open_order_from_list(
        self,
        session: RoleBrowserSession,
        record: Phase1Order,
        *,
        expected_actionable: bool = True,
    ) -> None:
        filters = session.page.locator("form.order-table-filters")
        try:
            session.expect_visible(filters, "普通订单筛选栏")
        except PlaywrightTimeoutError as error:
            raise BusinessBlocker(
                "运输订单页缺少普通订单筛选栏。",
                owner="订单列表维护者",
                remediation="恢复普通订单页签及订单号筛选入口。",
            ) from error
        keyword = filters.locator('input[name="keyword"]')
        session.type_text(keyword, record.order_number, f"筛选订单 {record.order_number}")
        session.click(filters.get_by_role("button", name="筛选"), "执行普通订单筛选")
        row = session.page.get_by_role("row").filter(has_text=record.order_number)
        session.expect_visible(row, f"订单 {record.order_number} 列表行")
        action_name = "办理当前节点" if expected_actionable else "查看订单"
        action = row.get_by_role("link", name=action_name)
        if action.count() == 0 and expected_actionable:
            readonly = row.get_by_role("link", name="查看订单")
            if readonly.count() > 0:
                raise BusinessBlocker(
                    f"{session.role} 对订单 {record.order_number} 只有只读入口，无法办理当前节点。",
                    owner="角色权限/订单责任人维护者",
                    remediation="核对审批时指定的下一处理人、任务归属和 order.scope 权限。",
                )
        if action.count() == 0:
            action = row.locator('a[href^="/admin/orders/"]').last
        session.expect_visible(action, f"订单 {record.order_number} {action_name}入口")
        session.click(action, f"打开订单 {record.order_number} 当前节点")
        session.expect_visible(
            session.page.get_by_role("heading", name=record.order_number),
            f"订单 {record.order_number} 详情标题",
        )
        self._assert_no_error_page(session)

    def _fill_missing_custom_consignment_fields(
        self,
        session: RoleBrowserSession,
        record: Phase1Order,
    ) -> None:
        # Each save revalidates the route, so process one still-missing row at a time.
        for iteration in range(20):
            rows = session.page.locator(".consignment-custom-table tbody tr.missing")
            if rows.count() == 0:
                return
            row = rows.first
            label = row.locator("td").first.inner_text().splitlines()[0].strip()
            form = row.locator("form.workflow-custom-field-form")
            if form.count() == 0:
                raise BusinessBlocker(
                    f"订单 {record.order_number} 的必填字段“{label}”没有可编辑表单。",
                    owner="工作流字段/权限维护者",
                    remediation="确保字段启用时，当前业务岗既可见也可修改。",
                )
            control = form.locator('[name="fieldValue"]')
            input_type = (control.get_attribute("type") or "").lower()
            if control.locator("option").count() > 0:
                self._select_first_nonempty(session, control, f"委托字段：{label}")
            elif input_type == "date":
                session.type_date(
                    control,
                    (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%d"),
                    f"委托字段：{label}",
                )
            elif input_type == "datetime-local":
                session.type_datetime_local(
                    control,
                    (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M"),
                    f"委托字段：{label}",
                )
            elif input_type == "number":
                session.type_text(control, "1", f"委托字段：{label}")
            else:
                session.type_text(
                    control,
                    f"{record.cargo_marker}-{label}",
                    f"委托字段：{label}",
                )
            session.click(form.get_by_role("button", name="保存"), f"保存委托字段：{label}")
            session.page.wait_for_timeout(180)
        raise BusinessBlocker(
            f"订单 {record.order_number} 的委托字段保存超过 20 次仍未完成。",
            owner="工作流字段保存逻辑维护者",
            remediation="检查保存后 present 状态与实例字段值是否实时刷新。",
        )

    def _open_consignment_submit_form(
        self,
        record: Phase1Order,
    ) -> tuple[Locator, Locator | None]:
        form = self.sales.page.locator(
            'form.consignment-submit-bar:has(input[name="actionCode"][value="submit"])'
        )
        if self._is_visible(form):
            return form.first, None
        quick_actions = self.sales.page.locator(
            '[aria-label="委托资料快捷操作"]'
        )
        self.sales.click(
            quick_actions.get_by_role("button", name="提交审批", exact=True),
            f"打开 {record.order_number} 提交审批弹窗",
        )
        dialog = self.sales.page.get_by_role(
            "dialog",
            name=re.compile(
                rf"^提交审批\s*·\s*{re.escape(record.order_number)}$"
            ),
        )
        self.sales.expect_visible(dialog, f"{record.order_number} 提交审批弹窗")
        return (
            dialog.locator(
                'form.consignment-submit-bar:has(input[name="actionCode"][value="submit"])'
            ).first,
            dialog,
        )

    def _assert_required_consignment_rejected(self, record: Phase1Order) -> None:
        """Exercise one non-mutating, workflow-derived missing-field gate."""

        missing = self.sales.page.locator(
            ".consignment-custom-table tbody tr.missing"
        )
        form, dialog = self._open_consignment_submit_form(record)
        self.sales.expect_visible(form, f"{record.order_number} 提交审批栏")
        if missing.count() > 0:
            missing_labels = [
                missing.nth(index).locator("td").first.inner_text().splitlines()[0].strip()
                for index in range(missing.count())
            ]
            self._select_assignee(
                self.sales,
                form.locator(".organization-assignee-picker"),
                person_label="业务主管",
                preferred_person=self.credentials["business_supervisor"].role,
            )
            self.sales.click(
                form.get_by_role("button", name="提交审批"),
                f"缺少必填资料时尝试提交 {record.order_number}",
            )
            rejected = self.sales.page.get_by_text(
                re.compile(r"请先补齐当前工作流要求的字段"),
                exact=False,
            )
            self.sales.expect_visible(
                rejected,
                f"{record.order_number} 缺必填资料阻断提示",
            )
            self._expect_current_step(
                self.sales, "委托资料补充", record.order_number
            )
            actual = "服务端拒绝提交；仍缺：" + "、".join(missing_labels)
            expectation = GateExpectation(
                name="委托资料缺必填时禁止提请审批",
                source="workflow_instance_field_configuration",
                configured_mode="required",
                expected_behavior="block",
                ui_expectation="缺失当前实例必填字段时留在本节点并明确提示。",
                server_expectation="只按订单冻结工作流的启用必填字段校验，失败不得推进订单。",
                owner_role="业务岗",
                remediation="统一委托页必填标记、错误提示与服务端冻结实例校验。",
            )
        else:
            # A workflow may legitimately configure every consignment field as
            # optional/hidden. The next-handler selector remains structurally
            # required, so exercise that visible native-form gate instead.
            self.sales.click(
                form.get_by_role("button", name="提交审批"),
                f"未选择业务主管时尝试提交 {record.order_number}",
            )
            invalid_assignee = form.locator(
                "select.organization-assignee-native-validator:invalid"
            )
            self.sales.expect_visible(
                invalid_assignee,
                f"{record.order_number} 下一处理人必选门禁",
            )
            self._expect_current_step(
                self.sales, "委托资料补充", record.order_number
            )
            actual = "当前实例没有缺失业务字段；浏览器拒绝未选择下一处理人的提交"
            expectation = GateExpectation(
                name="委托提交必须指定下一处理人",
                source="system_integrity_invariant",
                configured_mode="required",
                expected_behavior="block",
                ui_expectation="未选择下一处理人时由可见表单校验阻止提交，并留在本节点。",
                server_expectation="提交 action 必须再次校验下一处理人有效且属于可选范围。",
                owner_role="业务岗",
                remediation="保持浏览器校验与提交 action 的下一处理人约束一致。",
            )
        self.sales.capture_gate_evidence(PHASE1_NEGATIVE_GATE_CASES[0])
        self.sales.record_gate(
            name=expectation.name,
            expected=(
                f"UI：{expectation.ui_expectation}；服务端：{expectation.server_expectation}"
            ),
            passed=True,
            actual=actual,
            owner=expectation.owner_role,
            remediation=expectation.remediation,
            expectation=expectation,
            case_id=PHASE1_NEGATIVE_GATE_CASES[0],
        )
        if dialog is not None and self._is_visible(dialog):
            self.sales.press("Escape", "关闭缺必填提交弹窗", dialog)

    def submit_consignments(self) -> None:
        gate = _workflow_gate(
            "委托资料提请审批门禁",
            source="workflow_instance_module_state",
            ui="必填项缺失时明确指出；选填或隐藏字段不使用红色阻断。",
            server="只依据订单锁定工作流实例中的启用必填字段和模块规则决定是否允许提交。",
            owner="业务岗",
            remediation="核对委托模块字段、文件规则和页面提示是否使用同一工作流实例快照。",
        )
        self._click_navigation(self.sales, "运输订单")
        if self.fixture_path is None:
            self.fixture_path = self.sales.screenshot("runtime-upload-fixture")
        for record in self.records:
            with self.sales.step(
                f"补齐并提请审批 {record.order_number}",
                case_id=f"CONSIGN-{record.key.upper()}",
                stage="委托资料补充",
                priority="P0",
                preconditions=("客户已确认报价", "订单处于待补充委托资料"),
                inputs={"order_number": record.order_number},
                expected_result="仅补当前实例必填资料，提交后进入委托审核并归属业务主管。",
                gate=gate,
            ) as observation:
                self._open_order_from_list(self.sales, record)
                if record.key == "ftl":
                    self._assert_required_consignment_rejected(record)
                self._fill_missing_custom_consignment_fields(self.sales, record)
                sections = self.sales.page.get_by_role(
                    "navigation", name="委托资料补充分区"
                )
                files_tab = sections.get_by_role(
                    "link", name=re.compile(r"^文件管理")
                )
                self.sales.expect_visible(files_tab, f"{record.order_number} 文件管理页签")
                if files_tab.get_attribute("aria-current") != "page":
                    self.sales.click(
                        files_tab, f"切换 {record.order_number} 到文件管理"
                    )
                self.sales.expect_visible(
                    self.sales.page.locator("#module-source-documents"),
                    f"{record.order_number} 本节点文件区",
                )
                document_row = self.sales.page.locator("article.source-document-row").filter(
                    has_text="委托书"
                )
                if self._is_visible(document_row):
                    upload_trigger = document_row.get_by_text("选择并上传", exact=True)
                    if self._is_visible(upload_trigger):
                        self.sales.choose_files(
                            upload_trigger,
                            self.fixture_path,
                            f"上传 {record.order_number} 委托书",
                        )
                        self.sales.page.wait_for_timeout(220)
                        self.sales.expect_visible(
                            document_row.filter(has_text=self.fixture_path.name),
                            f"{record.order_number} 委托书上传结果",
                        )
                form = self.sales.page.locator(
                    'form.consignment-submit-bar:has(input[name="actionCode"][value="submit"])'
                )
                if not self._is_visible(form):
                    quick_actions = self.sales.page.locator(
                        '[aria-label="委托资料快捷操作"]'
                    )
                    self.sales.click(
                        quick_actions.get_by_role(
                            "button", name="提交审批", exact=True
                        ),
                        f"打开 {record.order_number} 提交审批弹窗",
                    )
                    dialog = self.sales.page.get_by_role(
                        "dialog",
                        name=re.compile(
                            rf"^提交审批\s*·\s*{re.escape(record.order_number)}$"
                        ),
                    )
                    self.sales.expect_visible(
                        dialog, f"{record.order_number} 提交审批弹窗"
                    )
                    form = dialog.locator(
                        'form.consignment-submit-bar:has(input[name="actionCode"][value="submit"])'
                    )
                self.sales.expect_visible(form, f"{record.order_number} 提交审批栏")
                picker = form.locator(".organization-assignee-picker")
                self._select_assignee(
                    self.sales,
                    picker,
                    person_label="业务主管",
                    preferred_person=self.credentials["business_supervisor"].role,
                )
                self.sales.click(
                    form.get_by_role("button", name="提交审批"),
                    f"提交 {record.order_number} 委托审批",
                )
                self._expect_current_step(
                    self.sales, "委托审核", record.order_number
                )
                observation.observe(
                    f"订单 {record.order_number} 已提交业务主管审核", gate_passed=True
                )
                self.sales.click(
                    self.sales.page.get_by_role("link", name="返回订单列表"),
                    "返回普通订单列表",
                )

    def approve_consignments(self) -> None:
        gate = _permission_gate(
            "业务主管审批与下一步操作主管指定",
            ui="只有本次提交指定的业务主管显示审批表单；业务岗仅看到实时只读状态。",
            server="审批人必须等于当前 assignee，审批时必须指定有效操作主管个人账号。",
            owner="业务主管",
        )
        self._click_navigation(self.business_supervisor, "运输订单")
        for record in self.records:
            with self.business_supervisor.step(
                f"业务主管审批 {record.order_number}",
                case_id=f"APPROVE-{record.key.upper()}",
                stage="委托审核",
                priority="P0",
                preconditions=("业务岗已提请审批", "当前账号为提交时指定的审批人"),
                inputs={"order_number": record.order_number},
                expected_result="委托文件通过、订单进入任务分配并归属指定操作主管。",
                gate=gate,
            ) as observation:
                self._open_order_from_list(self.business_supervisor, record)
                document_row = self.business_supervisor.page.locator(
                    "article.source-document-row"
                ).filter(has_text="委托书")
                if self._is_visible(document_row):
                    review = document_row.get_by_role("button", name="审核", exact=True)
                    if self._is_visible(review):
                        self.business_supervisor.click(
                            review,
                            f"审核 {record.order_number} 委托书",
                        )
                        dialog = self.business_supervisor.page.get_by_role(
                            "dialog", name=re.compile(r"审核文件.*委托书")
                        )
                        self.business_supervisor.expect_visible(
                            dialog, f"{record.order_number} 委托书审核弹窗"
                        )
                        self.business_supervisor.select(
                            dialog.locator('select[name="reviewStatus"]'),
                            "委托书审核结果",
                            value="approved",
                        )
                        self.business_supervisor.click(
                            dialog.get_by_role("button", name="确认审核结果"),
                            f"确认 {record.order_number} 委托书审核通过",
                        )
                        self.business_supervisor.page.wait_for_timeout(180)
                        self.business_supervisor.expect_hidden(
                            dialog, f"{record.order_number} 委托书审核弹窗已关闭"
                        )
                form = self.business_supervisor.page.locator(
                    "form#consignment-approval-form"
                )
                if form.count() == 0:
                    form = self.business_supervisor.page.locator(
                        'form.consignment-submit-bar:has(input[value="approve"])'
                    )
                self.business_supervisor.expect_visible(
                    form, f"{record.order_number} 委托审批表单"
                )
                self._select_assignee(
                    self.business_supervisor,
                    form.locator(".organization-assignee-picker"),
                    person_label="下一步操作主管",
                    preferred_person=self.credentials["operation_supervisor"].role,
                )
                approve = form.get_by_role(
                    "button", name=re.compile(r"审批通过(?:并进入任务分配)?")
                )
                self.business_supervisor.click(
                    approve,
                    f"审批通过 {record.order_number}",
                )
                self._expect_current_step(
                    self.business_supervisor, "任务分配", record.order_number
                )
                observation.observe(
                    f"订单 {record.order_number} 审批完成并指定操作主管", gate_passed=True
                )
                self.business_supervisor.click(
                    self.business_supervisor.page.get_by_role("link", name="返回订单列表"),
                    "返回普通订单列表",
                )

    def assign_ordinary_orders(self) -> None:
        gate = _workflow_gate(
            "普通订单任务分配门禁",
            source="workflow_instance_module_state",
            ui="只显示锁定实例中的岗位、模块和任务；必填项阻断，可选项不阻断。",
            server="仅在当前实例要求的分配信息齐全后确认派单并进入国内运输。",
            owner="操作主管",
            remediation="核对 assignment 模块启用/必填状态、组织成员和派单责任人。",
        )
        self._click_navigation(self.operation_supervisor, "运输订单")
        ordinary_tab = self.operation_supervisor.page.get_by_role(
            "navigation", name="普通订单与配载订单分类"
        ).get_by_role("link", name=re.compile(r"普通订单"))
        if ordinary_tab.count() > 0 and ordinary_tab.get_attribute("aria-current") != "page":
            self.operation_supervisor.click(ordinary_tab, "切换到普通订单页签")
        for record in self.records:
            with self.operation_supervisor.step(
                f"普通订单一键分配 {record.order_number}",
                case_id=f"ASSIGN-{record.key.upper()}",
                stage="任务分配",
                priority="P0",
                preconditions=("业务主管已审批并指定当前操作主管", "当前位于普通订单页签"),
                inputs={"order_number": record.order_number},
                expected_result="实例要求的全部必填责任岗位落实到个人，订单进入国内运输。",
                gate=gate,
            ) as observation:
                self._open_order_from_list(self.operation_supervisor, record)
                form = self.operation_supervisor.page.locator("form.assignment-manifest")
                self.operation_supervisor.expect_visible(
                    form, f"{record.order_number} 任务分配清单"
                )
                source = form.get_attribute("data-assignment-source")
                if source != "workflow-instance":
                    raise BusinessBlocker(
                        f"新订单 {record.order_number} 未进入冻结工作流派单模式。",
                        owner="工作流实例维护者",
                        remediation="确认订单创建时已锁定 workflow_instance_id，且派单页从实例快照加载。",
                    )
                assignment_rows = form.locator("tr[data-assignment-position]")
                if assignment_rows.count() == 0:
                    raise BusinessBlocker(
                        f"订单 {record.order_number} 的锁定工作流没有显示任何责任分配组。",
                        owner="工作流配置维护者",
                        remediation="检查锁定实例中的待办模块、任务和责任岗位配置。",
                    )
                assigned_people: list[str] = []
                for index in range(assignment_rows.count()):
                    row = assignment_rows.nth(index)
                    if row.get_attribute("data-assignment-required") != "true":
                        continue
                    assignment_mode = row.get_attribute("data-assignment-mode") or "person"
                    try:
                        requires_person = assignment_mode_requires_person(assignment_mode)
                    except ValueError as error:
                        raise BusinessBlocker(
                            str(error),
                            owner="工作流配置维护者",
                            remediation="将责任分配模式配置为 person 或 site_queue。",
                        ) from error
                    if not requires_person:
                        self.operation_supervisor.expect_visible(
                            row.locator(".assignment-site-queue"),
                            "目标仓岗位队列提示",
                        )
                        observation.add_note(
                            f"{row.get_attribute('data-assignment-position') or '未配置岗位'} 自动进入目标仓岗位队列"
                        )
                        continue
                    position_code = row.get_attribute("data-assignment-position") or ""
                    alias = ASSIGNMENT_POSITION_CREDENTIAL_ALIASES.get(position_code)
                    credential = self.credentials.get(alias) if alias else None
                    picker = row.locator(".organization-assignee-picker")
                    person_label = (
                        picker.locator(".organization-assignee-trigger > span")
                        .inner_text()
                        .replace("*", "")
                        .strip()
                    )
                    assigned_name = self._select_assignee(
                        self.operation_supervisor,
                        picker,
                        person_label=person_label,
                        preferred_person=credential.role if credential else "",
                    )
                    assigned_people.append(assigned_name)
                    journal_alias = alias or f"position_{position_code.lower()}"
                    self.assignees.setdefault(journal_alias, {})[record.key] = assigned_name
                    self.harness.journal.register_entity(
                        f"{journal_alias}_assignee", record.key, assigned_name
                    )
                notes = form.locator('textarea[name="notes"]')
                if self._is_visible(notes):
                    self.operation_supervisor.type_text(
                        notes,
                        f"{self.attempt.run_id} {record.key} 纯 UI 派单",
                        "派单说明",
                    )
                self.operation_supervisor.click(
                    form.get_by_role(
                        "button", name=re.compile(r"确认派单并进入国内运输")
                    ),
                    f"确认派单 {record.order_number}",
                )
                self._expect_current_step(
                    self.operation_supervisor, "国内运输", record.order_number
                )
                observation.add_note("分配角色数量：" + str(len(assigned_people)))
                observation.observe(
                    f"订单 {record.order_number} 已完成锁定工作流必填岗位分配并进入国内运输",
                    gate_passed=True,
                )
                self.operation_supervisor.click(
                    self.operation_supervisor.page.get_by_role("link", name="返回订单列表"),
                    "返回普通订单列表",
                )

    def run(self) -> None:
        self._login(
            self.sales,
            self.credentials["sales"].password,
            "业务岗",
        )
        self._login(
            self.business_supervisor,
            self.credentials["business_supervisor"].password,
            "业务主管",
        )
        self._login(
            self.operation_supervisor,
            self.credentials["operation_supervisor"].password,
            "操作主管",
        )
        # Generate a harmless PNG through the visible browser itself.  The same
        # file is selected later via native file choosers; no hidden input or
        # repository fixture shortcut is used.
        self.fixture_path = self.sales.screenshot(
            "runtime-document-fixture", full_page=False
        )
        self.create_and_bind_customer()
        self.create_quotes()
        self.accept_quotes()
        self.submit_consignments()
        self.approve_consignments()
        self.assign_ordinary_orders()
        self.harness.assert_certifiable()


def _redact_reason(reason: str, records: Sequence[CredentialRecord], identity: FreshBusinessIdentity | None) -> str:
    safe = reason
    secrets = [item.email for item in records] + [item.password for item in records]
    if identity is not None:
        secrets.append(identity.portal_email)
    for value in sorted((item for item in secrets if item), key=len, reverse=True):
        safe = safe.replace(value, "<redacted>")
    return safe[:2_000]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="纯 UI 执行：全新客户 → 1 FTL + 3 LTL → 审批 → 普通订单分配。"
    )
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument("--output-root", type=Path, default=Path("output/playwright"))
    parser.add_argument("--series-id", default="phase1-one-ftl-three-ltl")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--slow-mo", type=int, default=40)
    parser.add_argument("--timeout-ms", type=int, default=20_000)
    parser.add_argument("--navigation-timeout-ms", type=int, default=35_000)
    parser.add_argument("--origin-country", default="中国")
    parser.add_argument("--origin-state", default="广东省")
    parser.add_argument("--origin-city", default="深圳市")
    parser.add_argument("--destination-country", default="乌兹别克斯坦")
    parser.add_argument("--destination-state", default="塔什干市")
    parser.add_argument("--destination-city", default="塔什干")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="显式允许创建业务数据；未传入时只做无写入配置预检。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    vault = load_credentials(args.credentials_file)
    required = validate_full_flow_credentials(vault)
    if not args.execute:
        print(json.dumps(_public_preflight(vault, base_url=args.base_url), ensure_ascii=False, indent=2))
        return 0

    credentials = {item.alias: item for item in vault.records}
    series = AttemptSeries(args.series_id, args.output_root)
    attempt = series.begin_attempt()
    identity = build_fresh_identity(attempt)
    records = phase1_records(attempt)
    status = "failed"
    reason = ""
    summary_path: Path | None = None

    try:
        with sync_playwright() as playwright:
            harness = TmsUIHarness(
                playwright,
                run_id=attempt.run_id,
                output_dir=attempt.output_dir,
                base_url=args.base_url,
                headless=args.headless,
                slow_mo=args.slow_mo,
                action_timeout_ms=args.timeout_ms,
                navigation_timeout_ms=args.navigation_timeout_ms,
                attempt=attempt,
                scenario_name="全新客户 + 1 FTL + 3 LTL 全流程第一段",
            )
            flow = Phase1Flow(
                harness=harness,
                credentials=credentials,
                attempt=attempt,
                identity=identity,
                records=records,
                origin_country=args.origin_country,
                origin_state=args.origin_state,
                origin_city=args.origin_city,
                destination_country=args.destination_country,
                destination_state=args.destination_state,
                destination_city=args.destination_city,
            )
            try:
                flow.run()
                status = "passed"
            except BusinessBlocker as error:
                status = "blocked"
                reason = f"{error}；责任方：{error.owner}；建议：{error.remediation}"
                harness.journal.add_note(reason)
            except Exception as error:
                status = "failed"
                reason = f"{type(error).__name__}: {error}"
                harness.journal.add_note("未预期异常：" + reason)
            finally:
                reason = _redact_reason(reason, required, identity)
                summary_path = harness.close(status=status)  # type: ignore[arg-type]
                if harness.last_status != status:
                    status = str(harness.last_status)
                    if not reason:
                        reason = harness.finalization_error or "步骤、门禁或证据汇总未通过"
    except Exception as error:
        status = "failed"
        reason = _redact_reason(f"{type(error).__name__}: {error}", required, identity)

    series.finish_attempt(
        attempt,
        status=status,  # type: ignore[arg-type]
        reason=reason,
    )
    print(
        json.dumps(
            {
                "status": status.upper(),
                "run_id": attempt.run_id,
                "attempt": attempt.attempt,
                "summary": str(summary_path) if summary_path else "",
                "reason": reason,
                "entities": {
                    "customer": identity.customer_name,
                    "quotes": {item.key: item.quote_number for item in records},
                    "orders": {item.key: item.order_number for item in records},
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
