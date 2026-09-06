#!/usr/bin/env python3
"""International TMS 纯 UI 全流程执行器：第二阶段。

本阶段只接续已经通过的第一阶段数据，不创建替代订单：

1. 操作岗逐票完成国内运输安排；
2. 国内仓逐票扫码验收、确认货齐并取得 OUL 货物码；
3. 国内仓完成整车装车任务、逐件扫码和出库交接；
4. 国内仓将三票拼车订单生成一张 PZ 配载单；
5. 操作主管在“配载订单”页整批分配操作、单证负责人；
6. 国内仓按 PZ 创建一张装车任务，逐件扫码并整批出库；
7. 操作岗核对普通订单隐藏、三票状态同步、历史分配记录和右侧资料抽屉。

所有业务写入都通过 ``RoleBrowserSession`` 记录的可见控件完成。脚本不访问
数据库或 HTTP API，不注入 DOM/Cookie/localStorage，不使用正向深链，也不直接
给隐藏文件 input 赋值。默认只输出 ``READY_NOT_EXECUTED``；只有显式传入
``--execute`` 才会继续既有业务数据。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from playwright.sync_api import Locator, sync_playwright


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_ui_credentials import CredentialRecord, CredentialVault, load_credentials
from tms_ui_harness import (
    GateExpectation,
    RoleBrowserSession,
    TmsUIHarness,
    require_certified_summary,
    safe_artifact_name,
)
from tms_pz_account_prep import (
    build_pz_runtime_credentials,
    prepare_secondary_pz_accounts,
)


ORDER_KEYS = ("ftl", "ltl1", "ltl2", "ltl3")
LTL_KEYS = ("ltl1", "ltl2", "ltl3")
REQUIRED_ACCOUNT_ALIASES = (
    "hr_admin",
    "operation",
    "operation_supervisor",
    "document",
    "domestic_warehouse",
)
PHASE2_STAGE_ORDER = (
    "secondary_pz_account_preparation",
    "domestic_transport",
    "domestic_receiving",
    "ftl_loading_outbound",
    "ltl_consolidation",
    "batch_assignment",
    "batch_loading_outbound",
    "batch_sync_and_drawer_assertions",
)
PHASE2_NEGATIVE_GATE_CASES = (
    "P2-NEG-SCAN-CROSS-ORDER",
    "P2-NEG-SCAN-DUPLICATE",
    "P2-NEG-PZ-OLD-OWNER-DEEP-LINK",
    "P2-NEG-CHILD-OLD-OPERATION",
)
HANDOFF_SCHEMA = "international-tms-full-flow-phase2-handoff/v1"

ORDER_NUMBER_RE = re.compile(r"^SO[0-9A-Z-]{6,}$", re.I)
PZ_NUMBER_RE = re.compile(r"\bPZ-[0-9A-Z-]{4,}\b", re.I)
OUT_NUMBER_RE = re.compile(r"\bOUT-[0-9A-Z-]{4,}\b", re.I)
OUL_NUMBER_RE = re.compile(r"\bOUL-[0-9A-Z-]+\b", re.I)
FINAL_DISPATCH_BUTTON_RE = re.compile(
    r"^确认出库(?:交接|并打印交接单)$"
)
DENIED_PAGE_RE = re.compile(r"请求失败|不存在|找不到该页面|尚未分配|没有.*权限|Forbidden|403|404", re.I)
ERROR_PAGE_RE = re.compile(
    r"请求失败|SYSTEM RECOVERY|Forbidden|Internal Server Error|请求失败\s*\(403\)",
    re.I,
)


def acceptance_rejection_message(order_number: str, raw_error: str) -> str:
    """Return one stable, human-readable diagnosis for a rejected receipt."""

    detail = " ".join(raw_error.split()) or "页面没有返回可读的错误详情"
    return f"{order_number} 验收入库被系统拒绝：{detail}"


def certify_oul_label_counts(
    order_number: str,
    *,
    expected_pieces: int,
    rendered_label_count: int,
    rendered_codes: Sequence[str],
) -> list[str]:
    """Require one rendered label and one unique OUL for every expected piece."""

    if isinstance(expected_pieces, bool) or expected_pieces < 1:
        raise ValueError(f"{order_number} 的预计件数必须是正整数")
    codes = list(
        dict.fromkeys(
            str(code).strip().upper() for code in rendered_codes if str(code).strip()
        )
    )
    if rendered_label_count != expected_pieces or len(codes) != expected_pieces:
        raise ValueError(
            f"{order_number} 验收入库标签数量不一致：预计 {expected_pieces} 件/标签，"
            f"页面 {rendered_label_count} 张，唯一 OUL {len(codes)} 个"
        )
    return codes


def certify_dispatch_scan_progress(
    subject: str,
    *,
    progress_text: str,
    expected_count: int,
) -> tuple[int, int]:
    """Require the rendered loaded count and task total to match every OUL."""

    if isinstance(expected_count, bool) or expected_count < 1:
        raise ValueError(f"{subject} 的期望扫码数必须是正整数")
    match = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", progress_text)
    if not match:
        raise ValueError(f"{subject} 无法读取装车进度：{progress_text or '空白'}")
    loaded_count, item_count = (int(value) for value in match.groups())
    if loaded_count != expected_count or item_count != expected_count:
        raise ValueError(
            f"{subject} 装车扫码数量不一致：实际已扫 {loaded_count}/{item_count}，"
            f"期望 {expected_count}/{expected_count}"
        )
    return loaded_count, item_count


def dispatch_scan_completion_path(
    subject: str,
    *,
    scan_mode: str,
    scan_is_visible: bool,
    progress_text: str,
    expected_count: int,
) -> str:
    """Choose the only valid completion path for the rendered scan policy."""

    if scan_mode == "hidden":
        if scan_is_visible:
            raise ValueError(f"{subject} 扫码策略为隐藏，但页面仍显示扫码框")
        return "difference"
    if not scan_is_visible:
        raise ValueError(f"{subject} 扫码策略为 {scan_mode}，但页面没有扫码框")
    certify_dispatch_scan_progress(
        subject, progress_text=progress_text, expected_count=expected_count
    )
    return "exact"


class BusinessBlocker(RuntimeError):
    """A real UI, workflow or permission gate that prevents phase two."""

    def __init__(self, message: str, *, owner: str, remediation: str) -> None:
        super().__init__(message)
        self.owner = owner
        self.remediation = remediation


@dataclass(frozen=True, slots=True)
class Phase1Handoff:
    source_run_id: str
    orders: dict[str, str]
    customer_name: str = ""
    source_entity_prefix: str = ""
    expected_pieces: dict[str, int] = field(default_factory=dict)
    original_assignees: dict[str, dict[str, str]] = field(default_factory=dict)
    fresh_attempt_verified: bool = False


@dataclass(slots=True)
class Phase2Artifacts:
    cargo_codes: dict[str, list[str]] = field(
        default_factory=lambda: {key: [] for key in ORDER_KEYS}
    )
    batch_number: str = ""
    ftl_dispatch_number: str = ""
    ltl_dispatch_number: str = ""
    operation_assignee: str = ""
    document_assignee: str = ""


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} 必须是 JSON 对象")
    return value


def _required_expected_pieces(value: object) -> dict[str, int]:
    payload = _mapping(value, "entities.expected_pieces")
    result: dict[str, int] = {}
    for key in ORDER_KEYS:
        raw = payload.get(key)
        rendered = str(raw).strip()
        if isinstance(raw, bool) or not re.fullmatch(r"[1-9]\d*", rendered):
            raise ValueError(f"第一阶段预计件数 {key} 缺失或不是正整数")
        result[key] = int(rendered)
    return result


def load_phase1_handoff(path: Path | str) -> Phase1Handoff:
    """Read either the phase-one harness summary or its CLI result envelope."""

    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"第一阶段结果文件不存在：{source}")
    payload = _mapping(json.loads(source.read_text(encoding="utf-8-sig")), "第一阶段结果")
    evidence = require_certified_summary(
        payload,
        source=source,
        label="第一阶段",
        require_fresh_attempt=True,
    )
    source_run_id = str(evidence.get("run_id", "")).strip()
    if not source_run_id:
        raise ValueError("第一阶段结果缺少 run_id")
    envelope_run_id = str(payload.get("run_id", "")).strip()
    if envelope_run_id and envelope_run_id != source_run_id:
        raise ValueError("第一阶段结果 envelope.run_id 与 summary.run_id 不一致")

    entities = _mapping(evidence.get("entities"), "entities")
    raw_orders = entities.get("order")
    if not isinstance(raw_orders, Mapping):
        raw_orders = entities.get("orders")
    orders_payload = _mapping(raw_orders, "entities.order/orders")
    orders: dict[str, str] = {}
    for key in ORDER_KEYS:
        value = str(orders_payload.get(key, "")).strip().upper()
        if not ORDER_NUMBER_RE.fullmatch(value):
            raise ValueError(f"第一阶段订单 {key} 缺失或格式无效")
        orders[key] = value
    if len(set(orders.values())) != len(ORDER_KEYS):
        raise ValueError("第一阶段的四个订单号必须互不相同")
    expected_pieces = _required_expected_pieces(entities.get("expected_pieces"))

    raw_customer = entities.get("customer", "")
    if isinstance(raw_customer, Mapping):
        customer_name = str(raw_customer.get("primary", "")).strip()
    else:
        customer_name = str(raw_customer).strip()
    scenario = evidence.get("scenario")
    attempt = scenario.get("attempt") if isinstance(scenario, Mapping) else None
    source_entity_prefix = (
        str(attempt.get("entity_prefix", "")).strip()
        if isinstance(attempt, Mapping)
        else ""
    )
    original_assignees: dict[str, dict[str, str]] = {}
    for role in ("operation", "document", "customer_service", "finance"):
        raw_role_assignees = entities.get(f"{role}_assignee")
        if not isinstance(raw_role_assignees, Mapping):
            if role in {"operation", "document"}:
                raise ValueError(f"第一阶段交接缺少 {role} 三票拼车原负责人映射")
            continue
        if role in {"operation", "document"}:
            missing_ltl_keys = [
                key
                for key in LTL_KEYS
                if not isinstance(raw_role_assignees.get(key), str)
                or not raw_role_assignees[key].strip()
            ]
            if missing_ltl_keys:
                raise ValueError(
                    f"第一阶段交接的 {role} 原负责人映射缺少非空票据："
                    + "、".join(missing_ltl_keys)
                )
        original_assignees[role] = {
            str(key): str(value).strip()
            for key, value in raw_role_assignees.items()
            if str(value).strip()
        }
    return Phase1Handoff(
        source_run_id=source_run_id,
        orders=orders,
        customer_name=customer_name,
        source_entity_prefix=source_entity_prefix,
        expected_pieces=expected_pieces,
        original_assignees=original_assignees,
        fresh_attempt_verified=True,
    )


def build_handoff_payload(
    phase1: Phase1Handoff,
    artifacts: Phase2Artifacts,
    *,
    ready_for_phase3: bool,
) -> dict[str, Any]:
    """Build the stable machine-readable contract consumed by later phases."""

    if ready_for_phase3 and not phase1.fresh_attempt_verified:
        raise ValueError("正式 Phase 2 交接必须来自通过核验的 Phase 1 fresh attempt")
    expected_pieces = _required_expected_pieces(phase1.expected_pieces)
    cargo_codes = {
        key: [str(code).strip().upper() for code in artifacts.cargo_codes.get(key, ())]
        for key in ORDER_KEYS
    }
    if ready_for_phase3:
        for key in ORDER_KEYS:
            codes = certify_oul_label_counts(
                phase1.orders[key],
                expected_pieces=expected_pieces[key],
                rendered_label_count=len(cargo_codes[key]),
                rendered_codes=cargo_codes[key],
            )
            if any(not OUL_NUMBER_RE.fullmatch(code) for code in codes):
                raise ValueError(
                    f"{phase1.orders[key]} 的正式交接包含无效 OUL 货物码"
                )
            cargo_codes[key] = codes
        all_codes = [code for key in ORDER_KEYS for code in cargo_codes[key]]
        if len(set(all_codes)) != len(all_codes):
            raise ValueError("正式 Phase 2 交接不同订单之间不能复用同一 OUL 货物码")

    orders = {
        key: {
            "order_number": phase1.orders[key],
            "business_type": "ftl" if key == "ftl" else "ltl",
            "expected_pieces": expected_pieces[key],
            "cargo_codes": cargo_codes[key],
        }
        for key in ORDER_KEYS
    }
    return {
        "schema": HANDOFF_SCHEMA,
        "source_phase1_run_id": phase1.source_run_id,
        "source_phase1_entity_prefix": phase1.source_entity_prefix,
        "customer": {"name": phase1.customer_name},
        "orders": orders,
        "transport_batch": {
            "batch_number": artifacts.batch_number,
            "order_keys": list(LTL_KEYS),
            "order_numbers": [phase1.orders[key] for key in LTL_KEYS],
        },
        "dispatches": {
            "ftl": {"dispatch_number": artifacts.ftl_dispatch_number},
            "ltl_batch": {"dispatch_number": artifacts.ltl_dispatch_number},
        },
        "assignees": {
            "operation": artifacts.operation_assignee,
            "document": artifacts.document_assignee,
            "operation_alias": "operation_2",
            "document_alias": "document_2",
        },
        "certification_lineage": {
            "mode": "fresh-from-phase1",
            "root_phase1_run_id": phase1.source_run_id,
            "root_entity_prefix": phase1.source_entity_prefix,
            "fresh_phase1_attempt": phase1.fresh_attempt_verified,
            "recovery_branches_used": False,
        },
        "completed_stages": list(PHASE2_STAGE_ORDER) if ready_for_phase3 else [],
        "ready_for_phase3": ready_for_phase3,
    }


def augment_summary(path: Path | str, handoff: Mapping[str, Any]) -> Path:
    """Add the phase handoff without changing the harness' standard schema."""

    destination = Path(path).resolve()
    payload = _mapping(json.loads(destination.read_text(encoding="utf-8-sig")), "summary")
    updated = dict(payload)
    updated["handoff"] = dict(handoff)
    temporary = destination.with_name(".phase2-summary.json.tmp")
    temporary.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2),
        encoding="utf-8-sig",
    )
    temporary.replace(destination)
    return destination


def _public_preflight(
    vault: CredentialVault,
    phase1: Phase1Handoff,
    *,
    base_url: str,
    fixture_file: Path | str,
) -> dict[str, Any]:
    selected = vault.select(REQUIRED_ACCOUNT_ALIASES)
    expected_pieces = _required_expected_pieces(phase1.expected_pieces)
    fixture = Path(fixture_file).resolve()
    if not fixture.is_file():
        raise FileNotFoundError(f"原生文件选择器测试附件不存在：{fixture}")
    return {
        "status": "READY_NOT_EXECUTED",
        "business_writes": False,
        "base_url": base_url.rstrip("/"),
        "source_phase1_run_id": phase1.source_run_id,
        "orders": dict(phase1.orders),
        "expected_pieces": expected_pieces,
        "required_roles": [item.public_summary() for item in selected],
        "derived_runtime_roles": ["operation_2", "document_2"],
        "stage_order": list(PHASE2_STAGE_ORDER),
        "file_chooser_fixture": fixture.name,
        "next_action": "仅在服务、主数据和第一阶段结果确认无误后显式传入 --execute。",
    }


def _workflow_gate(
    name: str,
    *,
    ui: str,
    server: str,
    owner: str,
    source: str = "workflow_instance_module_state",
    configured_mode: str = "required",
    expected_behavior: str = "allow",
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source=source,  # type: ignore[arg-type]
        configured_mode=configured_mode,  # type: ignore[arg-type]
        expected_behavior=expected_behavior,  # type: ignore[arg-type]
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对该订单工作流实例字段显隐/必填配置、当前模块状态及岗位权限是否一致。",
    )


def _permission_gate(
    name: str,
    *,
    ui: str,
    server: str,
    owner: str,
    writable: bool = True,
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source="role_permission_configuration",
        configured_mode="operate" if writable else "read_only",
        expected_behavior="allow" if writable else "read_only",
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对岗位权限、订单/配载单数据范围和当前负责人绑定。",
    )


class Phase2Flow:
    """Visible-browser continuation for one FTL and three LTL orders."""

    def __init__(
        self,
        *,
        harness: TmsUIHarness,
        credentials: Mapping[str, CredentialRecord],
        phase1: Phase1Handoff,
        fixture_file: Path,
    ) -> None:
        self.harness = harness
        self.credentials = credentials
        self.phase1 = phase1
        self.fixture_file = fixture_file.resolve()
        self.artifacts = Phase2Artifacts()
        self.domestic_warehouse_id = ""
        self.domestic_warehouse_name = ""
        self.operation = self._add_role("operation")
        self.batch_operation = self._add_role("operation_2")
        self.operation_supervisor = self._add_role("operation_supervisor")
        self.domestic_warehouse = self._add_role("domestic_warehouse")
        for key, number in phase1.orders.items():
            self.harness.journal.register_entity("order", key, number)
        if phase1.customer_name:
            self.harness.journal.register_entity("customer", "primary", phase1.customer_name)

    def _add_role(self, alias: str) -> RoleBrowserSession:
        credential = self.credentials[alias]
        return self.harness.add_role(
            alias,
            credential.email,
            credential.site,
        )

    @staticmethod
    def _is_visible(locator: Locator) -> bool:
        return locator.count() > 0 and locator.first.is_visible()

    @staticmethod
    def _locator_text(locator: Locator, limit: int = 4_000) -> str:
        if locator.count() == 0:
            return ""
        try:
            return locator.first.inner_text(timeout=3_000).strip()[:limit]
        except Exception:
            return ""

    def _assert_no_error_page(self, session: RoleBrowserSession) -> None:
        body = self._locator_text(session.page.locator("body"), 12_000)
        if ERROR_PAGE_RE.search(body):
            raise BusinessBlocker(
                f"{session.role} 页面出现 403/500 恢复页：{body[:500]}",
                owner="权限与路由维护人",
                remediation="核对菜单可见权限与目标 loader/action 的服务端授权是否使用同一规则。",
            )

    def _dismiss_required_notifications(self, session: RoleBrowserSession) -> None:
        for _ in range(8):
            candidates = session.page.get_by_role(
                "button", name=re.compile(r"^(确认知悉|知道了)$")
            )
            visible = next(
                (
                    candidates.nth(index)
                    for index in range(candidates.count())
                    if candidates.nth(index).is_visible()
                ),
                None,
            )
            if visible is None:
                return
            session.click(visible, "确认重要变更通知")
            session.page.wait_for_timeout(120)
        raise BusinessBlocker(
            "重要变更通知连续出现超过 8 次，疑似确认状态循环",
            owner="通知中心维护人",
            remediation="检查必读通知确认是否按当前用户持久化。",
        )

    def _login(self, session: RoleBrowserSession, label: str) -> None:
        credential = self.credentials[session.role]
        with session.step(
            f"{label}从独立登录页进入工作台",
            case_id=f"P2-LOGIN-{session.role.upper().replace('_', '-')}",
            stage="账号与权限",
            priority="P0",
            preconditions=("账号来自独立凭据文件", "浏览器上下文不与其他岗位共享"),
            inputs={"account_email": credential.email, "site": credential.site},
            expected_result=f"{label}登录成功，菜单与服务端权限一致且无 403/500",
            gate=_permission_gate(
                f"{label}登录和工作台权限",
                ui="只显示当前岗位可访问的菜单与可办理控件。",
                server="相同岗位和数据范围在页面 loader/action 中被允许。",
                owner=label,
            ),
            sensitive=True,
        ) as observation:
            session.login(credential.password)
            self._dismiss_required_notifications(session)
            self._assert_no_error_page(session)
            observation.observe(f"{label}登录成功", gate_passed=True)
        session.start_trace("phase2-visible-actions")

    def _click_navigation(self, session: RoleBrowserSession, label: str) -> None:
        navigation_name = "仓库作业导航" if session.site == "warehouse" else "运营管理导航"
        navigation = session.page.get_by_role("navigation", name=navigation_name)
        link = navigation.get_by_role("link", name=label, exact=True)
        if not self._is_visible(link):
            raise BusinessBlocker(
                f"{session.role} 工作台没有显示“{label}”菜单",
                owner="角色权限管理员",
                remediation=f"核对 {session.role} 的菜单权限和“{label}”页面服务端权限。",
            )
        session.click(link.first, f"导航到{label}")
        session.expect_hidden(
            session.page.get_by_role("progressbar", name="系统正在处理请求"),
            f"{label}页面数据同步完成",
        )
        self._dismiss_required_notifications(session)
        self._assert_no_error_page(session)

    def _click_workload_tab(self, session: RoleBrowserSession, label: str) -> None:
        tabs = session.page.get_by_role("navigation", name="普通订单与配载订单分类")
        link = tabs.get_by_role("link", name=re.compile(rf"^{re.escape(label)}"))
        if not self._is_visible(link):
            raise BusinessBlocker(
                f"{session.role} 未显示“{label}”页签",
                owner="权限与订单列表维护人",
                remediation="核对普通订单/配载订单页签的岗位可见规则。",
            )
        session.click(link.first, f"切换到{label}页签")
        session.expect_hidden(
            session.page.get_by_role("progressbar", name="系统正在处理请求"),
            f"{label}页签数据同步完成",
        )
        self._assert_no_error_page(session)

    @staticmethod
    def _option_value(option: Locator) -> str:
        return str(option.get_attribute("value") or "").strip()

    def _option_value_containing(self, select: Locator, expected_text: str) -> str:
        if not expected_text or not self._is_visible(select):
            return ""
        options = select.locator("option")
        for index in range(options.count()):
            option = options.nth(index)
            if expected_text in self._locator_text(option, 500):
                return self._option_value(option)
        return ""

    def _select_first_available(
        self,
        session: RoleBrowserSession,
        select: Locator,
        target: str,
        *,
        preferred_value: str = "",
        excluded_values: Sequence[str] = ("__new__",),
        wait_rounds: int = 10,
    ) -> str:
        if not self._is_visible(select):
            return ""
        excluded = set(excluded_values)
        for _ in range(wait_rounds):
            options = select.locator("option")
            values: list[str] = []
            for index in range(options.count()):
                option = options.nth(index)
                value = self._option_value(option)
                if value and value not in excluded and not option.is_disabled():
                    values.append(value)
            selected = preferred_value if preferred_value in values else (values[0] if values else "")
            if selected:
                session.select(select.first, target, value=selected)
                session.page.wait_for_timeout(120)
                return selected
            session.page.wait_for_timeout(160)
        required = select.first.get_attribute("required") is not None
        if required:
            raise BusinessBlocker(
                f"{target}是当前工作流必填项，但页面没有可选主数据",
                owner="基础资料管理员",
                remediation=f"在对应台账补齐可用的{target}，并保证关联关系有效。",
            )
        return ""

    def _fill_if_visible(
        self,
        session: RoleBrowserSession,
        form: Locator,
        name: str,
        value: str,
        target: str,
    ) -> None:
        control = form.locator(f'[name="{name}"]')
        if not self._is_visible(control):
            return
        if control.first.get_attribute("readonly") is not None:
            return
        session.type_text(control.first, value, target)

    def _type_datetime_if_visible(
        self,
        session: RoleBrowserSession,
        form: Locator,
        name: str,
        value: str,
        target: str,
    ) -> None:
        control = form.locator(f'input[type="datetime-local"][name="{name}"]')
        if not self._is_visible(control):
            return
        session.type_datetime_local(control.first, value, target)

    def _visible_error_text(self, session: RoleBrowserSession) -> str:
        errors = session.page.locator(
            ".alert.error, .alert.danger, [role='alert'], .gate:not(.ok)"
        )
        rows = [
            self._locator_text(errors.nth(index), 1_200)
            for index in range(errors.count())
            if errors.nth(index).is_visible()
        ]
        return "；".join(item for item in rows if item)[:4_000]

    def _expect_visible_or_block(
        self,
        session: RoleBrowserSession,
        locator: Locator,
        target: str,
        *,
        owner: str,
        remediation: str,
    ) -> None:
        try:
            session.expect_visible(locator, target)
        except Exception as original:
            error_text = self._visible_error_text(session)
            if error_text:
                raise BusinessBlocker(
                    f"{target}未出现；页面提示：{error_text}",
                    owner=owner,
                    remediation=remediation,
                ) from original
            raise

    def _open_ordinary_order(self, session: RoleBrowserSession, order_number: str) -> None:
        self._click_navigation(session, "运输订单")
        tabs = session.page.get_by_role("navigation", name="普通订单与配载订单分类")
        if self._is_visible(tabs):
            self._click_workload_tab(session, "普通订单")
        form = session.page.locator("form.order-table-filters")
        self._expect_visible_or_block(
            session,
            form,
            "普通订单筛选表单",
            owner="运输订单页面维护人",
            remediation="恢复普通订单页可见筛选和办理入口。",
        )
        session.type_text(form.locator('input[name="keyword"]'), order_number, "输入订单号")
        session.click(form.get_by_role("button", name="筛选"), "筛选普通订单")
        row = session.page.locator("table tbody tr").filter(has_text=order_number)
        self._expect_visible_or_block(
            session,
            row,
            f"普通订单 {order_number}",
            owner="订单范围与负责人维护人",
            remediation="确认第一阶段已分配给当前操作岗且订单没有被错误隐藏。",
        )
        action = row.first.get_by_role(
            "link", name=re.compile(r"^(办理当前节点|查看订单)$")
        )
        self._expect_visible_or_block(
            session,
            action,
            f"{order_number} 办理入口",
            owner="订单路由维护人",
            remediation="保证列表办理入口和详情页服务端授权一致。",
        )
        session.click(action.first, f"打开订单 {order_number}")
        session.page.wait_for_timeout(180)
        self._assert_no_error_page(session)

    def arrange_domestic_transport(self) -> None:
        for sequence, key in enumerate(ORDER_KEYS, start=1):
            order_number = self.phase1.orders[key]
            with self.operation.step(
                f"操作岗完成 {order_number} 国内运输安排",
                case_id=f"P2-TRANSPORT-{sequence:02d}",
                stage="国内运输",
                priority="P0",
                preconditions=("第一阶段已完成普通订单分配", "国内承运商、车辆、司机和仓库主数据可用"),
                inputs={"order_number": order_number, "business_type": "ftl" if key == "ftl" else "ltl"},
                expected_result="页面按本订单工作流显示并校验字段，保存运输安排后进入国内仓验收",
                gate=_workflow_gate(
                    f"{order_number} 国内运输工作流门禁",
                    ui="只显示当前订单工作流启用的字段；可见必填项有明确标记和可选数据。",
                    server="提交时使用同一订单工作流实例校验字段并推进运输模块。",
                    owner="操作岗",
                ),
            ) as observation:
                self._open_ordinary_order(self.operation, order_number)
                already_done = self.operation.page.get_by_text("国内运输安排已完成", exact=False)
                if self._is_visible(already_done):
                    raise BusinessBlocker(
                        f"{order_number} 在本轮到达前已经完成国内运输安排，不能作为 fresh 全流程认证数据",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                form = self.operation.page.locator("form.transport-arrangement-form")
                self._expect_visible_or_block(
                    self.operation,
                    form,
                    f"{order_number} 国内运输安排表单",
                    owner="工作流与订单模块维护人",
                    remediation="确认 transport 模块为当前可办理节点，字段显隐和操作岗权限一致。",
                )
                self._select_first_available(
                    self.operation,
                    form.locator('select[name="carrierId"]'),
                    "国内承运商",
                )
                self._select_first_available(
                    self.operation,
                    form.locator('select[name="chargeName"]'),
                    "应付费用名称",
                    excluded_values=(),
                )
                self._select_first_available(
                    self.operation,
                    form.locator('select[name="freightCurrency"]'),
                    "国内运费币种",
                    preferred_value="CNY",
                    excluded_values=(),
                )
                self._fill_if_visible(
                    self.operation, form, "freightExchangeRate", "1", "填写汇率"
                )
                self._fill_if_visible(
                    self.operation, form, "freightQuantity", "1", "填写计费数量"
                )
                self._fill_if_visible(
                    self.operation, form, "freightUnitPrice", "100", "填写预计运费单价"
                )
                self._select_first_available(
                    self.operation,
                    form.locator('select[name="vehicleMasterId"]'),
                    "国内车辆",
                )
                self._select_first_available(
                    self.operation,
                    form.locator('select[name="driverMasterId"]'),
                    "国内司机",
                )
                warehouse_select = form.locator('select[name="destinationWarehouseId"]')
                preferred_warehouse = self.domestic_warehouse_id or self._option_value_containing(
                    warehouse_select, self.domestic_warehouse_name
                )
                if (
                    self._is_visible(warehouse_select)
                    and self.domestic_warehouse_name
                    and not preferred_warehouse
                ):
                    raise BusinessBlocker(
                        f"国内运输目的仓下拉没有当前仓库账号绑定的“{self.domestic_warehouse_name}”",
                        owner="仓库与账号主数据维护人",
                        remediation="将国内仓账号绑定仓库加入订单组织的可用国内集货仓/口岸仓。",
                    )
                self.domestic_warehouse_id = self._select_first_available(
                    self.operation,
                    warehouse_select,
                    "国内入仓终点",
                    preferred_value=preferred_warehouse,
                    excluded_values=(),
                )
                planned_departure = datetime.now() + timedelta(hours=1)
                planned_arrival = planned_departure + timedelta(hours=4)
                self._type_datetime_if_visible(
                    self.operation,
                    form,
                    "plannedDepartureAt",
                    planned_departure.strftime("%Y-%m-%dT%H:%M"),
                    "填写计划提货时间",
                )
                self._type_datetime_if_visible(
                    self.operation,
                    form,
                    "plannedArrivalAt",
                    planned_arrival.strftime("%Y-%m-%dT%H:%M"),
                    "填写计划到仓时间",
                )
                self._fill_if_visible(
                    self.operation,
                    form,
                    "loadingRequirements",
                    "按订单与标签逐件核对",
                    "填写国内装载要求",
                )
                self._fill_if_visible(
                    self.operation,
                    form,
                    "notes",
                    "纯 UI 全流程第二阶段验收",
                    "填写国内运输备注",
                )
                self.operation.click(
                    form.get_by_role("button", name="保存运输安排"),
                    f"保存 {order_number} 国内运输安排",
                )
                success = self.operation.page.get_by_text(
                    re.compile(r"国内运输安排已(保存|更新|完成)"),
                )
                self._expect_visible_or_block(
                    self.operation,
                    success,
                    f"{order_number} 国内运输保存结果",
                    owner="订单运输模块维护人",
                    remediation="根据页面错误修复字段门禁或运输安排原子写入。",
                )
                observation.observe(self._locator_text(success), gate_passed=True)

    def accept_orders_into_warehouse(self) -> None:
        self._click_navigation(self.domestic_warehouse, "验收收货")
        for sequence, key in enumerate(ORDER_KEYS, start=1):
            order_number = self.phase1.orders[key]
            expected_pieces = self.phase1.expected_pieces[key]
            with self.domestic_warehouse.step(
                f"国内仓扫码验收 {order_number} 并确认货齐",
                case_id=f"P2-RECEIVE-{sequence:02d}",
                stage="国内仓入库",
                priority="P0",
                preconditions=("操作岗已经保存国内入仓终点", "当前仓库存在可用库位"),
                inputs={
                    "order_number": order_number,
                    "expected_pieces": expected_pieces,
                },
                expected_result=(
                    "扫描订单后按工作流显示验收字段，入库成功并精确生成 "
                    f"{expected_pieces} 张标签及 {expected_pieces} 个唯一 OUL"
                ),
                gate=_workflow_gate(
                    f"{order_number} 国内仓验收与货齐门禁",
                    ui="工作流隐藏字段不出现，可见必填字段必须完成后才允许确认验收入库。",
                    server="验收提交使用相同字段配置累计实收，货齐后开放配载或装车。",
                    owner="国内仓库岗",
                ),
            ) as observation:
                scan = self.domestic_warehouse.page.locator('input[name="reference"]')
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    scan,
                    "扫码订单号输入框",
                    owner="仓库验收页面维护人",
                    remediation="本认证要求真实扫码入口；恢复可见扫码框并与工作流验收模块一致。",
                )
                self.domestic_warehouse.type_text(scan.first, order_number, "扫描订单号")
                self.domestic_warehouse.press("Enter", "回车调出验收信息", scan.first)
                form = self.domestic_warehouse.page.locator("form.acceptance-workbench")
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    form,
                    f"{order_number} 验收工作台",
                    owner="仓库范围与运输同步维护人",
                    remediation="确认运输安排选择的仓库与当前仓库账号绑定一致。",
                )
                self._select_first_available(
                    self.domestic_warehouse,
                    form.locator('select[name="locationId"]'),
                    "入库库位",
                    excluded_values=(),
                )
                ready = form.locator('input[name="receiptResult"][value="ready"]')
                if self._is_visible(ready):
                    self.domestic_warehouse.set_checked(ready.first, True, "确认订单货齐")
                self._fill_if_visible(
                    self.domestic_warehouse,
                    form,
                    "evidenceNote",
                    f"现场扫码验收凭证 {order_number}",
                    "填写收货凭证",
                )
                self._fill_if_visible(
                    self.domestic_warehouse,
                    form,
                    "notes",
                    "实物、包装与预录数据核对一致",
                    "填写收货备注",
                )
                self.domestic_warehouse.click(
                    form.get_by_role("button", name="确认验收、入库并生成标签"),
                    f"确认 {order_number} 验收入库",
                )
                labels = self.domestic_warehouse.page.locator(
                    ".acceptance-label-section:visible"
                )
                acceptance_error = self.domestic_warehouse.page.locator(
                    '[data-acceptance-feedback="error"][role="alert"]:visible'
                )
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    labels.or_(acceptance_error),
                    f"{order_number} 验收入库响应（标签或错误提示）",
                    owner="仓库验收入库维护人",
                    remediation="检查验收原子写入、货齐判定和 OUL 标签生成。",
                )
                if self._is_visible(acceptance_error):
                    error_text = self._locator_text(acceptance_error.first, 1_200)
                    raise BusinessBlocker(
                        acceptance_rejection_message(order_number, error_text),
                        owner="仓库验收入库维护人",
                        remediation=(
                            "按页面提示修正预录/实收数据或工作流配置；"
                            "不得把业务门禁误判为标签生成超时。"
                        ),
                    )
                label_text = self._locator_text(labels, 20_000)
                rendered_label_count = labels.locator(
                    ".warehouse-package-label"
                ).count()
                try:
                    codes = certify_oul_label_counts(
                        order_number,
                        expected_pieces=expected_pieces,
                        rendered_label_count=rendered_label_count,
                        rendered_codes=OUL_NUMBER_RE.findall(label_text),
                    )
                except ValueError as error:
                    raise BusinessBlocker(
                        str(error),
                        owner="仓库标签生成维护人",
                        remediation=(
                            "核对报价转订单的逐件包装拆分、验收实收包装数和 OUL 唯一性；"
                            "修复后必须用全新同类型订单重新认证。"
                        ),
                    ) from error
                self.artifacts.cargo_codes[key] = codes
                self.harness.journal.register_entity("cargo_codes", key, ",".join(codes))
                observation.observe(
                    f"验收入库完成，{expected_pieces} 件货物精确生成 "
                    f"{rendered_label_count} 张标签和 {len(codes)} 个唯一 OUL",
                    gate_passed=True,
                )

    def _open_pending_load_unit(self, subject: str) -> None:
        self._click_navigation(self.domestic_warehouse, "在仓待装")
        form = self.domestic_warehouse.page.locator("form.outbound-order-filter-form")
        self._expect_visible_or_block(
            self.domestic_warehouse,
            form,
            "在仓订单筛选表单",
            owner="仓库装车页面维护人",
            remediation="恢复在仓待装列表和查询入口。",
        )
        self.domestic_warehouse.type_text(
            form.locator('input[name="q"]'), subject, "输入订单或配载单号"
        )
        self.domestic_warehouse.click(form.get_by_role("button", name="查询"), "查询在仓装车单位")
        row = self.domestic_warehouse.page.locator(
            ".outbound-load-units-table tbody tr"
        ).filter(has_text=subject)
        self._expect_visible_or_block(
            self.domestic_warehouse,
            row,
            f"待装单位 {subject}",
            owner="仓库装车门禁维护人",
            remediation="核对货齐、异常、配载审批、文件和既有装车任务状态。",
        )
        action = row.first.get_by_role("link", name="创建装车任务", exact=True)
        self._expect_visible_or_block(
            self.domestic_warehouse,
            action,
            f"{subject} 创建装车任务入口",
            owner="仓库装车页面维护人",
            remediation="保证列表状态和创建页 loader 使用同一门禁。",
        )
        self.domestic_warehouse.click(action.first, f"为 {subject} 创建装车任务")
        self._expect_visible_or_block(
            self.domestic_warehouse,
            self.domestic_warehouse.page.get_by_role("heading", name="创建装车任务"),
            f"{subject} 创建装车任务页面",
            owner="仓库装车路由维护人",
            remediation="修复列表入口与创建页服务端权限不一致。",
        )
        self._assert_no_error_page(self.domestic_warehouse)

    def _resolve_loading_documents(self, subject: str) -> Locator:
        session = self.domestic_warehouse
        for _ in range(40):
            create_form = session.page.locator("form.outbound-inline-create-form")
            if self._is_visible(create_form):
                return create_form.first

            dialog = session.page.get_by_role(
                "dialog", name=re.compile(r"^补充装车必需文件")
            )
            if not self._is_visible(dialog):
                trigger = session.page.get_by_role(
                    "button", name=re.compile(r"^(补充必需文件|核验必需文件)\s*\d+")
                )
                if self._is_visible(trigger):
                    session.click(trigger.first, f"打开 {subject} 必需文件补充")
                    session.page.wait_for_timeout(160)
                    continue

            if self._is_visible(dialog):
                missing = dialog.locator("label.outbound-document-name-upload.missing")
                visible_missing = next(
                    (
                        missing.nth(index)
                        for index in range(missing.count())
                        if missing.nth(index).is_visible()
                    ),
                    None,
                )
                if visible_missing is not None:
                    document_name = self._locator_text(visible_missing, 300) or "必需文件"
                    session.choose_files(
                        visible_missing,
                        self.fixture_file,
                        f"通过原生文件选择器上传 {subject} {document_name}",
                    )
                    session.page.wait_for_timeout(300)
                    continue
                approve = dialog.get_by_role("button", name="完成补充并重新核验")
                if self._is_visible(approve) and approve.first.is_enabled():
                    session.click(approve.first, f"完成 {subject} 文件补充并重新核验")
                    session.page.wait_for_timeout(260)
                    continue

            session.page.wait_for_timeout(180)

        error_text = self._visible_error_text(session)
        raise BusinessBlocker(
            f"{subject} 文件补充后仍未开放装车任务创建{f'：{error_text}' if error_text else ''}",
            owner="单证岗与装车文件门禁维护人",
            remediation="逐项核对工作流生效文件、上传审核状态及其他装车阻断条件。",
        )

    def _fill_ftl_outbound_resources(self, form: Locator) -> None:
        session = self.domestic_warehouse
        self._select_first_available(
            session,
            form.locator('select[name="exitPort"]'),
            "整车出境口岸",
            excluded_values=(),
        )
        self._select_first_available(
            session,
            form.locator('select[name="customsLocation"]'),
            "整车起运地清关地",
            excluded_values=(),
        )
        self._select_first_available(
            session,
            form.locator('select[name="outboundCarrierId"]'),
            "整车境外承运商",
            excluded_values=(),
        )
        self._select_first_available(
            session,
            form.locator('select[name="outboundDriverId"]'),
            "整车出境司机",
            excluded_values=(),
        )
        self._select_first_available(
            session,
            form.locator('select[name="outboundVehicleId"]'),
            "整车出境车辆",
            excluded_values=(),
        )
        self._type_datetime_if_visible(
            session,
            form,
            "plannedDepartureAt",
            (datetime.now() + timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M"),
            "填写整车计划出境发车时间",
        )
        self._fill_if_visible(
            session,
            form,
            "notes",
            "仓库核对货物码、车辆和司机无误",
            "填写装车交接备注",
        )

    def _assert_rejected_loading_scan(
        self,
        *,
        subject: str,
        code: str,
        expected_message: str,
        case_id: str,
        label: str,
    ) -> None:
        session = self.domestic_warehouse
        progress = session.page.locator(
            ".outbound-task-detail-workbench .dispatch-progress strong"
        )
        self._expect_visible_or_block(
            session,
            progress,
            f"{subject} 装车进度",
            owner="仓库装车页面维护人",
            remediation="装车任务详情必须持续显示已扫/总数，供防重校验。",
        )
        before = self._locator_text(progress, 200)
        scan_form = session.page.locator("form.outbound-loading-scan")
        barcode = scan_form.locator('input[name="barcode"]')
        self._expect_visible_or_block(
            session,
            barcode,
            f"{subject} {label}扫码框",
            owner="仓库扫码工作流维护人",
            remediation="当前实例启用逐件扫码时必须提供可见扫码框。",
        )
        session.type_text(barcode.first, code, f"{label}输入货物码 {code}")
        session.click(
            scan_form.get_by_role("button", name="确认装车"),
            f"{label}尝试确认装车",
        )
        rejected = session.page.get_by_text(expected_message, exact=False)
        self._expect_visible_or_block(
            session,
            rejected,
            f"{label}扫码拒绝提示",
            owner="仓库扫码完整性门禁维护人",
            remediation="跨任务或重复货物码必须明确拒绝，且不得累计装车进度。",
        )
        after = self._locator_text(progress, 200)
        if after != before:
            raise BusinessBlocker(
                f"{label}扫码被提示拒绝，但装车进度仍从 {before} 变为 {after}",
                owner="仓库扫码事务维护人",
                remediation="拒绝分支不得更新装车明细、包装状态或累计数量。",
            )
        session.capture_gate_evidence(case_id)
        expectation = GateExpectation(
            name=f"{subject} {label}扫码完整性门禁",
            source="system_integrity_invariant",
            configured_mode="required",
            expected_behavior="block",
            ui_expectation=f"{label}扫码就地明确拒绝，装车进度保持 {before}。",
            server_expectation="dispatch、仓库、包装归属和已装车状态必须在写入前原子校验。",
            owner_role="国内仓库岗",
            remediation="修复扫码归属/幂等门禁，拒绝时不得留下部分写入。",
        )
        session.record_gate(
            name=expectation.name,
            expected=f"UI：{expectation.ui_expectation}；服务端：{expectation.server_expectation}",
            passed=True,
            actual=f"页面提示“{expected_message}”，进度保持 {before}",
            owner=expectation.owner_role,
            remediation=expectation.remediation,
            expectation=expectation,
            case_id=case_id,
        )

    def _wait_for_loading_scan_commit(
        self,
        *,
        subject: str,
        code: str,
        previous_loaded: int,
        item_count: int,
    ) -> int:
        """Wait until revalidation renders the next persisted loaded count."""

        session = self.domestic_warehouse
        expected_loaded = previous_loaded + 1
        progress = session.page.locator(
            ".outbound-task-detail-workbench .dispatch-progress strong"
        )
        expected_progress = progress.filter(
            has_text=re.compile(
                rf"^\s*{expected_loaded}\s*/\s*{item_count}\s*$"
            )
        )
        try:
            expected_progress.first.wait_for(
                state="visible", timeout=session.action_timeout_ms
            )
        except Exception as error:
            actual = self._locator_text(progress, 200) or "无法读取"
            page_error = self._visible_error_text(session)
            raise BusinessBlocker(
                f"{subject} 扫描 {code} 后未确认持久化："
                f"期望进度 {expected_loaded}/{item_count}，页面为 {actual}"
                f"{f'；{page_error}' if page_error else ''}",
                owner="仓库装车重验证维护人",
                remediation="每次扫码 action 完成后必须返回成功并刷新已装数量，再开放下一码输入。",
            ) from error
        actual = self._locator_text(progress, 200)
        if not re.fullmatch(
            rf"\s*{expected_loaded}\s*/\s*{item_count}\s*", actual
        ):
            raise BusinessBlocker(
                f"{subject} 扫描 {code} 后装车进度异常：{actual or '无法读取'}",
                owner="仓库装车计数维护人",
                remediation="核对扫码写入与 loader 重验证后的 loaded_count/item_count。",
            )
        return expected_loaded

    def _create_dispatch(self, subject: str, cargo_codes: Sequence[str], *, ftl: bool) -> str:
        self._open_pending_load_unit(subject)
        form = self._resolve_loading_documents(subject)
        if ftl:
            self._fill_ftl_outbound_resources(form)
        else:
            self._fill_if_visible(
                self.domestic_warehouse,
                form,
                "notes",
                "按 PZ 配载单整批装车并逐件扫码",
                "填写整批装车交接备注",
            )
        create = form.get_by_role("button", name="确认并创建装车任务")
        if not self._is_visible(create) or not create.first.is_enabled():
            raise BusinessBlocker(
                f"{subject} 文件已核验但创建装车任务按钮仍不可用",
                owner="工作流门禁与运输主数据维护人",
                remediation="核对当前实例必填字段、承运商车辆司机主数据和按钮禁用条件。",
            )
        self.domestic_warehouse.click(create.first, f"确认创建 {subject} 装车任务")
        detail = self.domestic_warehouse.page.locator(".outbound-task-detail-workbench")
        self._expect_visible_or_block(
            self.domestic_warehouse,
            detail,
            f"{subject} 装车任务详情",
            owner="仓库装车任务维护人",
            remediation="修复创建任务后的原子写入和跳转。",
        )
        detail_text = self._locator_text(detail, 20_000)
        dispatch_numbers = OUT_NUMBER_RE.findall(detail_text)
        if not dispatch_numbers:
            raise BusinessBlocker(
                f"{subject} 装车任务详情未显示 OUT 编号",
                owner="仓库装车任务维护人",
                remediation="创建成功页必须明确显示可追踪的装车任务编号。",
            )
        dispatch_number = dispatch_numbers[0].upper()

        unique_codes = list(dict.fromkeys(code.upper() for code in cargo_codes))
        if not unique_codes:
            raise BusinessBlocker(
                f"{subject} 没有可用于正式全扫的 OUL 货物码",
                owner="仓库标签生成维护人",
                remediation="返回验收入库页生成完整 OUL 标签后，以全新同类型订单重新测试。",
            )
        progress = self.domestic_warehouse.page.locator(
            ".outbound-task-detail-workbench .dispatch-progress strong"
        )
        initial_progress = self._locator_text(progress, 200)
        initial_match = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", initial_progress)
        if not initial_match or tuple(map(int, initial_match.groups())) != (0, len(unique_codes)):
            raise BusinessBlocker(
                f"{subject} 新建任务进度不是 fresh 0/{len(unique_codes)}："
                f"{initial_progress or '无法读取'}",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新订单并核对任务货物总数后重测。",
            )
        loaded_count = 0
        scan_form = self.domestic_warehouse.page.locator("form.outbound-loading-scan")
        barcode = scan_form.locator('input[name="barcode"]')
        hidden_notice = self.domestic_warehouse.page.get_by_text(
            re.compile(r"当前工作流已隐藏逐件扫码")
        )
        scan_is_visible = self._is_visible(barcode)
        hidden_by_workflow = self._is_visible(hidden_notice)

        if scan_is_visible:
            scan_label = self._locator_text(scan_form.locator("label").first, 1_000)
            scan_mode = "optional" if "选填" in scan_label else "required"
        elif hidden_by_workflow:
            scan_mode = "hidden"
        else:
            final_ready = self.domestic_warehouse.page.get_by_role(
                "button", name=FINAL_DISPATCH_BUTTON_RE
            )
            if self._is_visible(final_ready):
                raise BusinessBlocker(
                    f"{subject} 新建任务进入时已完成全部扫码，疑似沿用了旧装车任务，不能作为 fresh 全流程认证数据",
                    owner="全流程认证数据隔离维护人",
                    remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                )
            scan_mode = "optional"

        scan_expectation = GateExpectation(
            name=f"{subject} 逐件扫码门禁",
            source="workflow_instance_field_configuration",
            configured_mode=scan_mode,  # type: ignore[arg-type]
            expected_behavior="hide" if scan_mode == "hidden" else "allow",
            ui_expectation=(
                "隐藏模式不渲染扫码框并提供双确认差异出库；选填模式可扫码也可双确认；必填模式必须全部扫码"
            ),
            server_expectation=(
                "出库服务端读取同一锁定实例策略：仅必填模式以未扫货物阻断，隐藏/选填模式要求差异二次确认"
            ),
            owner_role="国内仓库岗",
            remediation="统一工作流实例字段策略、页面提示和出库 action 的扫码判断。",
        )
        self.domestic_warehouse.record_gate(
            name=scan_expectation.name,
            expected=scan_expectation.ui_expectation,
            passed=(scan_is_visible and not hidden_by_workflow)
            or (scan_mode == "hidden" and hidden_by_workflow and not scan_is_visible)
            or self._is_visible(
                self.domestic_warehouse.page.get_by_role(
                    "button", name=FINAL_DISPATCH_BUTTON_RE
                )
            ),
            actual=f"页面解析到逐件扫码策略：{scan_mode}",
            expectation=scan_expectation,
            case_id="P2-OUTBOUND-SCAN-GATE-01",
        )

        exercise_negative_scans = not ftl and scan_is_visible and len(unique_codes) >= 2
        if exercise_negative_scans:
            foreign_codes = self.artifacts.cargo_codes.get("ftl", [])
            foreign_code = foreign_codes[0] if foreign_codes else f"OUL-FOREIGN-{dispatch_number}"
            self._assert_rejected_loading_scan(
                subject=subject,
                code=foreign_code,
                expected_message="该货物不属于当前装车任务",
                case_id=PHASE2_NEGATIVE_GATE_CASES[0],
                label="跨任务",
            )

        if scan_is_visible and unique_codes:
            for index, code in enumerate(unique_codes, start=1):
                # The scan form is keyed by loaded_count and is replaced after
                # each submit, so reacquire it before every visible interaction.
                scan_form = self.domestic_warehouse.page.locator(
                    "form.outbound-loading-scan"
                )
                barcode = scan_form.locator('input[name="barcode"]')
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    barcode,
                    f"{subject} 第 {index}/{len(unique_codes)} 个货物扫码框",
                    owner="出库工作流配置与仓库装车页面维护人",
                    remediation="核对逐件扫码策略和装车累计状态是否使用同一任务。",
                )
                self.domestic_warehouse.type_text(
                    barcode.first, code, f"扫描货物码 {code}"
                )
                self.domestic_warehouse.click(
                    scan_form.get_by_role("button", name="确认装车"),
                    f"确认货物码 {code} 装车",
                )
                loaded_count = self._wait_for_loading_scan_commit(
                    subject=subject,
                    code=code,
                    previous_loaded=loaded_count,
                    item_count=len(unique_codes),
                )
                if exercise_negative_scans and index == 1:
                    self._assert_rejected_loading_scan(
                        subject=subject,
                        code=code,
                        expected_message="该货物已经装车，请勿重复扫描",
                        case_id=PHASE2_NEGATIVE_GATE_CASES[1],
                        label="重复",
                    )

        progress_text = self._locator_text(progress, 200)
        try:
            completion_path = dispatch_scan_completion_path(
                subject,
                scan_mode=scan_mode,
                scan_is_visible=scan_is_visible,
                progress_text=progress_text,
                expected_count=len(unique_codes),
            )
        except ValueError as error:
            raise BusinessBlocker(
                str(error),
                owner="仓库装车计数维护人",
                remediation="逐码等待重验证，并确保最终 loaded_count 与 OUL 数量及任务 item_count 完全一致。",
            ) from error

        final_button = self.domestic_warehouse.page.get_by_role(
            "button", name=FINAL_DISPATCH_BUTTON_RE
        )
        if completion_path == "exact":
            self._expect_visible_or_block(
                self.domestic_warehouse,
                final_button,
                f"{subject} 全部扫码后的正式出库按钮",
                owner="仓库出库门禁维护人",
                remediation="精确达到全部扫码后必须开放正式出库，不能要求差异确认。",
            )
            self.domestic_warehouse.click(
                final_button.first, f"确认 {subject} 出库交接"
            )
        else:
            # Only a workflow-hidden scan field may use the recorded difference
            # path. Visible optional/required certification must be exact n/n.
            acknowledge = self.domestic_warehouse.page.get_by_role(
                "button", name="我已核对，继续办理出库"
            )
            self._expect_visible_or_block(
                self.domestic_warehouse,
                acknowledge,
                f"{subject} 未扫码差异首次确认",
                owner="仓库出库门禁维护人",
                remediation="隐藏/选填扫码必须显示差异说明和两次显式确认，不能静默放行。",
            )
            self.domestic_warehouse.click(
                acknowledge.first, f"核对 {subject} 未扫码差异并继续"
            )
            confirm_difference = self.domestic_warehouse.page.get_by_role(
                "button", name="确认差异并出库"
            )
            self._expect_visible_or_block(
                self.domestic_warehouse,
                confirm_difference,
                f"{subject} 未扫码差异最终确认",
                owner="仓库出库门禁维护人",
                remediation="首次确认后必须出现最终出库按钮并由操作员再次确认。",
            )
            self.domestic_warehouse.click(
                confirm_difference.first, f"确认 {subject} 差异并出库"
            )
        completed = self.domestic_warehouse.page.get_by_role(
            "heading", name="出库交接已完成"
        )
        self._expect_visible_or_block(
            self.domestic_warehouse,
            completed,
            f"{subject} 出库交接完成状态",
            owner="仓库出库同步维护人",
            remediation="修复出库事务、订单模块同步和完成页状态。",
        )
        return dispatch_number

    def complete_ftl_outbound(self) -> None:
        order_number = self.phase1.orders["ftl"]
        with self.domestic_warehouse.step(
            f"国内仓为整车 {order_number} 创建任务、扫码并出库",
            case_id="P2-FTL-OUTBOUND-01",
            stage="整车装车出库",
            priority="P0",
            preconditions=("整车已确认货齐并生成 OUL", "文件与出境运输资源可在当前页完成"),
            inputs={"order_number": order_number, "cargo_code_count": len(self.artifacts.cargo_codes["ftl"])},
            expected_result="文件门禁、资源字段和扫码门禁均随工作流实例生效，整车完成出库交接",
            gate=_workflow_gate(
                f"{order_number} 整车装车出库门禁",
                ui="当前页补齐生效必需文件与可见必填资源，全部 OUL 扫描后开放最终出库。",
                server="文件、资源、扫码与出库提交使用同一实例配置并原子推进订单模块。",
                owner="国内仓库岗",
            ),
        ) as observation:
            number = self._create_dispatch(
                order_number,
                self.artifacts.cargo_codes["ftl"],
                ftl=True,
            )
            self.artifacts.ftl_dispatch_number = number
            self.harness.journal.register_entity("dispatch", "ftl", number)
            observation.observe(f"整车装车任务 {number} 已完成出库交接", gate_passed=True)

    def create_ltl_batch(self) -> None:
        with self.domestic_warehouse.step(
            "国内仓将三票拼车订单生成一张 PZ 配载单",
            case_id="P2-LTL-CONSOLIDATE-01",
            stage="拼车配载",
            priority="P0",
            preconditions=("三票拼车订单已在同一仓确认货齐", "三票境外目的仓与目的地区一致"),
            inputs={"order_numbers": [self.phase1.orders[key] for key in LTL_KEYS]},
            expected_result="通过可见筛选和勾选保留三票选择，按工作流填写整批资源后生成唯一 PZ",
            gate=_workflow_gate(
                "三票拼车订单兼容性与配载字段门禁",
                ui="候选订单明确显示可配载状态；配载字段显隐与必填标记取自三票工作流的合并策略。",
                server="再次校验仓库、货齐、异常、目的仓/地区兼容性和整批必填字段。",
                owner="国内仓库岗",
            ),
        ) as observation:
            self._click_navigation(self.domestic_warehouse, "货物配载")
            tabs = self.domestic_warehouse.page.get_by_role("navigation", name="货物配载页面")
            stock_tab = tabs.get_by_role("link", name=re.compile(r"^在库货物\b"))
            if self._is_visible(stock_tab):
                self.domestic_warehouse.click(stock_tab.first, "切换到在库货物")
            for selected_count, key in enumerate(LTL_KEYS, start=1):
                order_number = self.phase1.orders[key]
                form = self.domestic_warehouse.page.locator(
                    "form.consolidation-filter-form:not(.consolidation-batch-filter-form)"
                )
                self.domestic_warehouse.type_text(
                    form.locator('input[name="q"]'), order_number, "筛选拼车订单"
                )
                eligibility = form.locator('select[name="eligibility"]')
                if self._is_visible(eligibility):
                    self.domestic_warehouse.select(
                        eligibility.first,
                        "仅显示可配载订单",
                        value="eligible",
                    )
                self.domestic_warehouse.click(
                    form.get_by_role("button", name="筛选"),
                    f"筛选 {order_number}",
                )
                checkbox = self.domestic_warehouse.page.get_by_role(
                    "checkbox", name=f"选择订单 {order_number}"
                )
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    checkbox,
                    f"可配载订单 {order_number}",
                    owner="拼车候选规则维护人",
                    remediation="检查订单货齐、异常、目的仓、现有配载和装车任务阻断原因。",
                )
                if checkbox.first.is_disabled():
                    raise BusinessBlocker(
                        f"{order_number} 在可配载筛选中出现但复选框不可操作",
                        owner="拼车候选规则维护人",
                        remediation="统一候选状态标签和复选框禁用条件。",
                    )
                self.domestic_warehouse.set_checked(
                    checkbox.first, True, f"选择拼车订单 {order_number}"
                )
                selected_status = self.domestic_warehouse.page.get_by_text(
                    re.compile(rf"已选\s*{selected_count}\s*/")
                )
                self._expect_visible_or_block(
                    self.domestic_warehouse,
                    selected_status,
                    f"已累计选择 {selected_count} 票",
                    owner="货物配载页面状态维护人",
                    remediation="保证用户通过页面筛选后，选择状态在同一浏览器会话中保留。",
                )

            trigger = self.domestic_warehouse.page.get_by_role(
                "button", name="生成配载（3）", exact=True
            )
            self._expect_visible_or_block(
                self.domestic_warehouse,
                trigger,
                "生成三票配载单入口",
                owner="货物配载页面维护人",
                remediation="选择三票完整订单后开放生成配载按钮。",
            )
            self.domestic_warehouse.click(trigger.first, "打开生成配载单")
            dialog = self.domestic_warehouse.page.get_by_role("dialog", name="生成配载单")
            form = dialog.locator("form.consolidation-create-form")
            self._expect_visible_or_block(
                self.domestic_warehouse,
                form,
                "生成配载单表单",
                owner="货物配载页面维护人",
                remediation="恢复配载弹窗及当前工作流生效字段。",
            )
            self._select_first_available(
                self.domestic_warehouse,
                form.locator('select[name="carrierId"]'),
                "配载境外承运商",
                excluded_values=(),
            )
            self._select_first_available(
                self.domestic_warehouse,
                form.locator('select[name="vehicleMasterId"]'),
                "配载出境车辆",
                excluded_values=(),
            )
            self._select_first_available(
                self.domestic_warehouse,
                form.locator('select[name="driverMasterId"]'),
                "配载出境司机",
                excluded_values=(),
            )
            self._select_first_available(
                self.domestic_warehouse,
                form.locator('select[name="borderPort"]'),
                "配载出境口岸",
                excluded_values=(),
            )
            self._select_first_available(
                self.domestic_warehouse,
                form.locator('select[name="customsLocation"]'),
                "配载清关地",
                excluded_values=(),
            )
            self._fill_if_visible(
                self.domestic_warehouse,
                form,
                "batchName",
                f"UI全流程-{safe_artifact_name(self.phase1.source_run_id)[-18:]}",
                "填写配载单名称",
            )
            now = datetime.now()
            for name, hours, target in (
                ("plannedLoadingAt", 2, "填写计划装车时间"),
                ("plannedDepartureAt", 8, "填写计划出境发车时间"),
                ("plannedArrivalAt", 72, "填写计划境外到仓时间"),
            ):
                self._type_datetime_if_visible(
                    self.domestic_warehouse,
                    form,
                    name,
                    (now + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M"),
                    target,
                )
            self._fill_if_visible(
                self.domestic_warehouse,
                form,
                "routeNotes",
                "国内仓至出境口岸再至境外目的仓",
                "填写运输线路",
            )
            self._fill_if_visible(
                self.domestic_warehouse,
                form,
                "notes",
                "三票拼车订单按一张 PZ 统一办理",
                "填写配载备注",
            )
            self.domestic_warehouse.click(
                form.get_by_role("button", name="确认配载信息，生成 PZ 配载单"),
                "确认生成 PZ 配载单",
            )
            success = self.domestic_warehouse.page.locator(".alert.success").filter(
                has_text=re.compile(r"配载单\s+PZ-")
            )
            self._expect_visible_or_block(
                self.domestic_warehouse,
                success,
                "PZ 配载单生成结果",
                owner="拼车配载服务维护人",
                remediation="修复整批兼容性校验、资源写入或审批提交。",
            )
            numbers = PZ_NUMBER_RE.findall(self._locator_text(success))
            if not numbers:
                raise BusinessBlocker(
                    "配载成功提示没有可交接的 PZ 编号",
                    owner="拼车配载页面维护人",
                    remediation="成功提示必须显示新建配载单号。",
                )
            self.artifacts.batch_number = numbers[0].upper()
            self.harness.journal.register_entity(
                "transport_batch", "ltl", self.artifacts.batch_number
            )
            observation.observe(
                f"{self.artifacts.batch_number} 已生成并提交操作主管",
                gate_passed=True,
            )

    def _pick_batch_assignee(
        self,
        person_label: str,
        preferred_person: str,
        *,
        excluded_people: Sequence[str] = (),
    ) -> str:
        session = self.operation_supervisor
        dialog = session.page.get_by_role(
            "dialog", name=f"配载单一键分配 · {self.artifacts.batch_number}"
        )
        picker = dialog.locator(".organization-assignee-picker").filter(
            has_text=person_label
        )
        self._expect_visible_or_block(
            session,
            picker,
            person_label,
            owner="组织与人员维护人",
            remediation=f"为{person_label}岗位维护有效部门、岗位和个人账户绑定。",
        )
        trigger = picker.locator("button.organization-assignee-trigger")
        if trigger.first.is_disabled():
            raise BusinessBlocker(
                f"{person_label}没有可选人员",
                owner="组织与人员维护人",
                remediation=f"补齐{person_label}的部门、岗位和个人账户绑定。",
            )
        session.click(trigger.first, f"打开{person_label}级联选择器")
        group = session.page.get_by_role("group", name=f"选择{person_label}")
        self._expect_visible_or_block(
            session,
            group,
            f"选择{person_label}面板",
            owner="组织人员选择器维护人",
            remediation="修复级联弹层定位和可访问名称。",
        )
        for listbox_name in ("1  部门", "2  岗位"):
            listbox = group.get_by_role("listbox", name=listbox_name)
            self._expect_visible_or_block(
                session,
                listbox,
                f"{person_label} {listbox_name}",
                owner="组织与人员维护人",
                remediation=f"确认{person_label}候选人存在完整部门和岗位路径。",
            )
            option = listbox.get_by_role("option")
            if option.count() == 0:
                raise BusinessBlocker(
                    f"{person_label}的“{listbox_name}”没有可选项",
                    owner="组织与人员维护人",
                    remediation=f"补齐{person_label}候选人的组织结构路径。",
                )
            option_name = self._locator_text(option.first, 300).splitlines()[0].strip()
            session.click(option.first, f"选择{person_label} {listbox_name} {option_name}")
            session.page.wait_for_timeout(100)
        people = group.get_by_role("listbox", name=f"3  {person_label}").get_by_role(
            "option"
        )
        if people.count() == 0:
            raise BusinessBlocker(
                f"{person_label}岗位下没有可派遣个人账户",
                owner="组织与人员维护人",
                remediation=f"为{person_label}岗位绑定至少一个启用用户。",
            )
        excluded = {item.strip() for item in excluded_people if item.strip()}
        candidates: list[Locator] = []
        preferred_candidates: list[Locator] = []
        for index in range(people.count()):
            candidate = people.nth(index)
            candidate_name = self._locator_text(candidate, 300).splitlines()[0].strip()
            if candidate.is_disabled() or candidate_name in excluded:
                continue
            candidates.append(candidate)
            if preferred_person and preferred_person in self._locator_text(candidate, 500):
                preferred_candidates.append(candidate)
        if not candidates:
            raise BusinessBlocker(
                f"{person_label}没有区别于挂载订单原负责人的可选新人员",
                owner="组织与人员维护人",
                remediation=f"为{person_label}岗位至少维护两名可登录人员；PZ 首次分配不得沿用任一子订单原负责人。",
            )
        selected = preferred_candidates[0] if preferred_candidates else candidates[0]
        selected_name = self._locator_text(selected, 300).splitlines()[0].strip()
        if selected_name in excluded:
            raise AssertionError(f"{person_label}错误选择了挂载订单原负责人")
        session.click(selected, f"选择{person_label}个人账户 {selected_name}")
        validator = picker.locator("select.organization-assignee-native-validator")
        if not validator.input_value():
            raise AssertionError(f"{person_label}可见选择完成后，原生校验值仍为空")
        return selected_name

    def assign_batch(self) -> None:
        pz = self.artifacts.batch_number
        with self.operation_supervisor.step(
            f"操作主管在配载订单页整批分配 {pz}",
            case_id="P2-BATCH-ASSIGN-01",
            stage="配载单整批分配",
            priority="P0",
            preconditions=("仓库已生成并提交 PZ", "操作和单证岗位均有有效个人账户"),
            inputs={"batch_number": pz, "order_count": 3},
            expected_result="主管一次指定整批操作和单证负责人，原订单关系解除且分配历史行继续可见",
            gate=_permission_gate(
                f"{pz} 操作主管整批分配权限",
                ui="配载订单页显示整批一键分配，提交后保留状态为已分配的历史行。",
                server="仅有权主管可审批并原子同步三票订单后续操作/单证责任。",
                owner="操作主管",
            ),
        ) as observation:
            self._click_navigation(self.operation_supervisor, "运输订单")
            self._click_workload_tab(self.operation_supervisor, "配载订单")
            form = self.operation_supervisor.page.locator("form.batch-workload-filters")
            self.operation_supervisor.type_text(
                form.locator('input[name="batchKeyword"]'), pz, "输入配载单号"
            )
            self.operation_supervisor.click(
                form.get_by_role("button", name="查询"), "查询配载订单"
            )
            row = self.operation_supervisor.page.locator(
                ".batch-assignment-table tbody tr"
            ).filter(has_text=pz)
            self._expect_visible_or_block(
                self.operation_supervisor,
                row,
                f"待分配配载单 {pz}",
                owner="配载审批范围维护人",
                remediation="确认三票原订单的操作主管一致，且 PZ 已提交待审批。",
            )
            action = row.first.get_by_role("button", name="整批一键分配")
            self._expect_visible_or_block(
                self.operation_supervisor,
                action,
                f"{pz} 整批一键分配按钮",
                owner="操作主管权限维护人",
                remediation="统一配载状态、当前主管与按钮可见/服务端授权规则。",
            )
            self.operation_supervisor.click(action.first, f"打开 {pz} 整批分配")
            original_operation_people = tuple(
                self.phase1.original_assignees.get("operation", {}).get(key, "")
                for key in LTL_KEYS
            )
            original_document_people = tuple(
                self.phase1.original_assignees.get("document", {}).get(key, "")
                for key in LTL_KEYS
            )
            if not all(original_operation_people) or not all(original_document_people):
                raise BusinessBlocker(
                    "第一阶段交接结果缺少三票挂载订单的原操作/单证负责人证据",
                    owner="纯 UI 验收例程维护人",
                    remediation="必须用新版 Phase1 从全新客户重新执行并记录每票原负责人，禁止复用旧摘要。",
                )
            self.artifacts.operation_assignee = self._pick_batch_assignee(
                "整批操作负责人",
                self.credentials["operation_2"].role,
                excluded_people=original_operation_people,
            )
            self.artifacts.document_assignee = self._pick_batch_assignee(
                "整批单证负责人",
                self.credentials["document_2"].role,
                excluded_people=original_document_people,
            )
            dialog = self.operation_supervisor.page.get_by_role(
                "dialog", name=f"配载单一键分配 · {pz}"
            )
            submit = dialog.get_by_role(
                "button", name="审核通过并同步 3 票订单", exact=True
            )
            self.operation_supervisor.click(submit, f"审核通过并同步 {pz} 三票订单")
            history = self.operation_supervisor.page.locator(
                "tr.batch-history-row"
            ).filter(has_text=pz)
            self._expect_visible_or_block(
                self.operation_supervisor,
                history,
                f"{pz} 已分配历史行",
                owner="配载订单历史维护人",
                remediation="分配后不得从列表删除 PZ；应保留只读历史状态。",
            )
            if "已分配" not in self._locator_text(history):
                raise BusinessBlocker(
                    f"{pz} 分配后历史行没有“已分配”状态标签",
                    owner="配载订单列表维护人",
                    remediation="使用状态标签区分待分配和历史记录。",
                )
            self.operation_supervisor.expect_hidden(
                history.get_by_role("button", name="整批一键分配"),
                f"{pz} 历史行不再显示重复分配入口",
            )
            observation.observe(
                f"已分配：操作 {self.artifacts.operation_assignee}；单证 {self.artifacts.document_assignee}；历史行保留",
                gate_passed=True,
            )

    def assert_mounted_orders_leave_ordinary_table(self) -> None:
        batch_href = ""
        child_order_href = ""
        with self.operation.step(
            "原操作岗核对三票挂载订单已解除普通订单办理关系",
            case_id="P2-BATCH-VISIBILITY-OLD-OWNER",
            stage="配载单列表与权限",
            priority="P0",
            preconditions=("操作主管已完成整批分配",),
            inputs={"order_numbers": [self.phase1.orders[key] for key in LTL_KEYS]},
            expected_result="原操作岗的普通订单办理表不再出现三票挂载订单",
            gate=_permission_gate(
                "PZ 首次换人后原操作关系解除",
                ui="原操作岗普通订单页不再提供挂载子订单的办理行。",
                server="整批审批原子解除子订单原操作关系，历史只读记录单独保留。",
                owner="原操作岗",
                writable=False,
            ),
        ) as observation:
            for key in LTL_KEYS:
                order_number = self.phase1.orders[key]
                self._click_navigation(self.operation, "运输订单")
                self._click_workload_tab(self.operation, "普通订单")
                form = self.operation.page.locator("form.order-table-filters")
                self.operation.type_text(
                    form.locator('input[name="keyword"]'), order_number, "查询挂载子订单"
                )
                self.operation.click(form.get_by_role("button", name="筛选"), "筛选普通订单")
                rows = self.operation.page.locator("table tbody tr").filter(
                    has_text=order_number
                )
                self.operation.expect_hidden(
                    rows, f"挂载订单 {order_number} 不在普通订单表"
                )
            observation.observe("原操作岗普通订单表已移除三票挂载订单", gate_passed=True)

        with self.batch_operation.step(
            "新整批操作负责人核对唯一 PZ 和三票挂载范围",
            case_id="P2-BATCH-VISIBILITY-NEW-OWNER",
            stage="配载单列表与权限",
            priority="P0",
            preconditions=("操作主管已把 PZ 分配给 operation_2",),
            inputs={"batch_number": self.artifacts.batch_number},
            expected_result="新负责人只在配载订单页看到唯一 PZ，且 PZ 行集中包含三票订单",
            gate=_permission_gate(
                "PZ 新整批操作负责人可见范围",
                ui="新操作负责人配载订单页显示 PZ 及全部三票订单号。",
                server="查询范围严格按 transport_batches.operation_assignee_user_id 授权。",
                owner="整批操作负责人",
                writable=False,
            ),
        ) as observation:
            self._click_navigation(self.batch_operation, "运输订单")
            self._click_workload_tab(self.batch_operation, "配载订单")
            batch_form = self.batch_operation.page.locator("form.batch-workload-filters")
            self.batch_operation.type_text(
                batch_form.locator('input[name="batchKeyword"]'),
                self.artifacts.batch_number,
                "查询已分配 PZ",
            )
            self.batch_operation.click(
                batch_form.get_by_role("button", name="查询"), "筛选配载订单"
            )
            row = self.batch_operation.page.locator("table tbody tr").filter(
                has_text=self.artifacts.batch_number
            )
            self._expect_visible_or_block(
                self.batch_operation,
                row,
                f"新负责人配载单 {self.artifacts.batch_number}",
                owner="配载单负责人范围维护人",
                remediation="确认整批操作负责人绑定已生效并纳入操作岗数据范围。",
            )
            row_text = self._locator_text(row, 5_000)
            missing = [self.phase1.orders[key] for key in LTL_KEYS if self.phase1.orders[key] not in row_text]
            if missing:
                raise BusinessBlocker(
                    f"{self.artifacts.batch_number} 列表行缺少挂载订单：{'、'.join(missing)}",
                    owner="配载订单列表维护人",
                    remediation="配载行应集中展示所有有效挂载订单号。",
                )
            batch_link = row.first.get_by_role(
                "link", name=self.artifacts.batch_number, exact=True
            )
            self._expect_visible_or_block(
                self.batch_operation,
                batch_link,
                f"新负责人 {self.artifacts.batch_number} 办理链接",
                owner="配载单负责人范围维护人",
                remediation="新负责人列表必须提供同一 PZ 的可见办理入口。",
            )
            batch_href = batch_link.first.get_attribute("href") or ""
            if not batch_href.startswith("/"):
                raise BusinessBlocker(
                    f"{self.artifacts.batch_number} 办理链接不是站内路径",
                    owner="配载订单路由维护人",
                    remediation="列表办理入口必须使用可审计的站内相对路径。",
                )
            self.batch_operation.click(
                batch_link.first, f"进入 {self.artifacts.batch_number} 取得挂载订单详情入口"
            )
            child_number = self.phase1.orders[LTL_KEYS[0]]
            child_row = self.batch_operation.page.locator("table tbody tr").filter(
                has_text=child_number
            )
            child_link = child_row.first.get_by_role(
                "link", name=f"查看订单 {child_number}", exact=True
            )
            self._expect_visible_or_block(
                self.batch_operation,
                child_link,
                f"{self.artifacts.batch_number} 挂载订单 {child_number} 详情入口",
                owner="配载单挂载订单展示维护人",
                remediation="配载单详情必须提供挂载订单的可见详情入口。",
            )
            child_order_href = child_link.first.get_attribute("href") or ""
            if not child_order_href.startswith("/"):
                raise BusinessBlocker(
                    f"挂载订单 {child_number} 详情链接不是站内路径",
                    owner="配载单挂载订单路由维护人",
                    remediation="挂载订单详情入口必须使用可审计的站内相对路径。",
                )
            observation.observe("新整批操作负责人可见唯一 PZ 和三票挂载订单", gate_passed=True)

        with self.operation.step(
            "原操作负责人通过已知 PZ 深链尝试越权",
            case_id=PHASE2_NEGATIVE_GATE_CASES[2],
            stage="配载单列表与权限",
            priority="P0",
            preconditions=("整批分配已经解除原操作负责人关系", "PZ 路径由新负责人可见列表取得"),
            inputs={"batch_number": self.artifacts.batch_number},
            expected_result="原负责人即使知道 PZ 地址也得到 403/404，不能读取或办理整批业务",
            gate=GateExpectation(
                name="PZ 原操作负责人深链越权门禁",
                source="role_permission_configuration",
                configured_mode="read_only",
                expected_behavior="block",
                ui_expectation="原负责人列表不显示 PZ，已知深链也进入明确拒绝页。",
                server_expectation="配载单查询按当前 operation_assignee_user_id 精确授权。",
                owner_role="原操作负责人",
                remediation="统一列表范围与详情 loader 的精确配载负责人校验。",
            ),
        ) as observation:
            self.operation.goto_for_negative_gate(
                batch_href,
                reason="验证原操作负责人解除后不能通过配载单深链读取或办理新负责人的业务",
                expected_status=(403, 404),
            )
            body = self._locator_text(self.operation.page.locator("body"), 4_000)
            if not DENIED_PAGE_RE.search(body):
                raise BusinessBlocker(
                    "原操作负责人深链返回拒绝状态，但页面没有可理解的拒绝说明",
                    owner="配载单权限错误页维护人",
                    remediation="403/404 页面应说明无权或资源不可见，不能显示空白恢复页。",
                )
            self.operation.capture_gate_evidence(PHASE2_NEGATIVE_GATE_CASES[2])
            observation.observe("原操作负责人 PZ 深链被服务端拒绝且页面有明确说明", gate_passed=True)
            back = self.operation.page.get_by_role(
                "button", name="返回上一页", exact=True
            )
            self.operation.recover_from_negative_gate(
                return_control=back,
                restored_locator=self.operation.page.get_by_role(
                    "link", name="运输订单", exact=True
                ),
                target="原操作负责人 PZ 越权",
            )
            observation.add_note("负向深链验证后已通过可见返回动作恢复原账号会话")

        with self.operation.step(
            "原操作负责人通过挂载子订单地址尝试越权",
            case_id=PHASE2_NEGATIVE_GATE_CASES[3],
            stage="配载单列表与权限",
            priority="P0",
            preconditions=("PZ 换人已解除子订单原操作负责人关系", "子订单路径来自新负责人可见详情"),
            inputs={"order_number": self.phase1.orders[LTL_KEYS[0]]},
            expected_result="原操作负责人访问子订单时只得到 403/404 或严格只读页面，不能编辑或提交",
            gate=GateExpectation(
                name="PZ 挂载子订单原操作负责人写权限门禁",
                source="role_permission_configuration",
                configured_mode="read_only",
                expected_behavior="read_only",
                ui_expectation="旧负责人不可见任何子订单编辑或提交控件。",
                server_expectation="子订单 loader/action 均按 PZ 当前整批 operation_assignee_user_id 授权。",
                owner_role="原操作负责人",
                remediation="统一子订单详情、模块 loader 和 action 的当前整批负责人校验。",
            ),
        ) as observation:
            response = self.operation.goto_for_negative_gate(
                child_order_href,
                reason="验证 PZ 换人后原操作负责人不能通过挂载子订单深链继续编辑或提交",
                expected_status=(200, 403, 404),
            )
            body = self._locator_text(self.operation.page.locator("body"), 8_000)
            if response.status == 200:
                if not re.search(r"只读|仅供查看|不由本账号办理|无权", body):
                    raise BusinessBlocker(
                        "挂载子订单向原操作负责人返回 200，但没有明确只读说明",
                        owner="子订单权限与提示维护人",
                        remediation="旧负责人可查看时必须明确标注只读，并移除全部办理控件。",
                    )
                self.operation.expect_not_rendered(
                    self.operation.page.locator(
                        "form.transport-arrangement-form button[type='submit'], "
                        "form.tracking-node-entry-form button[type='submit'], "
                        "form.order-module-data-form button[type='submit'], "
                        ".order-module-action button[type='submit'], "
                        "main form[method='post'] button[type='submit']"
                    ),
                    "原操作负责人不渲染挂载子订单编辑或提交控件",
                )
            elif not DENIED_PAGE_RE.search(body):
                raise BusinessBlocker(
                    "挂载子订单拒绝页没有可理解的无权或资源不可见说明",
                    owner="子订单权限错误页维护人",
                    remediation="403/404 页面应明确说明当前账号无权办理该挂载订单。",
                )
            self.operation.capture_gate_evidence(PHASE2_NEGATIVE_GATE_CASES[3])
            observation.observe(
                f"原操作负责人挂载子订单深链为 HTTP {response.status}，且无编辑/提交能力",
                gate_passed=True,
            )
            self.operation.recover_from_negative_gate(
                return_control=self.operation.page.get_by_role(
                    "button", name="返回上一页", exact=True
                ),
                restored_locator=self.operation.page.get_by_role(
                    "link", name="运输订单", exact=True
                ),
                target="原操作负责人挂载子订单越权",
            )

    def complete_ltl_batch_outbound(self) -> None:
        codes = [
            code
            for key in LTL_KEYS
            for code in self.artifacts.cargo_codes.get(key, ())
        ]
        with self.domestic_warehouse.step(
            f"国内仓按 {self.artifacts.batch_number} 创建任务、扫码并整批出库",
            case_id="P2-LTL-OUTBOUND-01",
            stage="拼车整批装车出库",
            priority="P0",
            preconditions=("操作主管已完成整批负责人分配", "三票订单 OUL 均已生成"),
            inputs={"batch_number": self.artifacts.batch_number, "cargo_code_count": len(codes)},
            expected_result="只创建一张 PZ 装车任务，扫描全部三票 OUL 后一次确认整批出库",
            gate=_workflow_gate(
                f"{self.artifacts.batch_number} 整批装车出库门禁",
                ui="按逐票工作流合并文件门禁；PZ 一张任务统一显示扫码进度和最终出库入口。",
                server="审批负责人、文件、资源和全部 OUL 条件满足后原子同步三票订单状态。",
                owner="国内仓库岗",
                source="workflow_instance_module_state",
            ),
        ) as observation:
            number = self._create_dispatch(
                self.artifacts.batch_number,
                codes,
                ftl=False,
            )
            self.artifacts.ltl_dispatch_number = number
            self.harness.journal.register_entity("dispatch", "ltl_batch", number)
            observation.observe(f"整批装车任务 {number} 已完成出库交接", gate_passed=True)

    def assert_batch_sync_and_drawer(self) -> None:
        pz = self.artifacts.batch_number
        session = self.batch_operation
        with session.step(
            f"新整批操作负责人核对 {pz} 三票出库同步与右侧资料抽屉",
            case_id="P2-BATCH-SYNC-DRAWER-01",
            stage="配载单同步与资料可见性",
            priority="P0",
            preconditions=("国内仓已完成 PZ 整批出库交接",),
            inputs={"batch_number": pz, "order_numbers": [self.phase1.orders[key] for key in LTL_KEYS]},
            expected_result="三票挂载行均显示已出库；右侧抽屉逐票展示货物信息、货物标签和对应 OUL",
            gate=_permission_gate(
                f"{pz} 出库同步和操作岗资料可见性",
                ui="配载与车辆页实时显示三票已出库，侧栏就地打开抽屉并展开逐票货物资料。",
                server="整批出库同步每票装车模块；操作负责人可读但不越权修改仓库事实。",
                owner="整批操作负责人",
                writable=False,
            ),
        ) as observation:
            self._click_navigation(session, "运输订单")
            self._click_workload_tab(session, "配载订单")
            form = session.page.locator("form.batch-workload-filters")
            session.type_text(
                form.locator('input[name="batchKeyword"]'), pz, "查询出库后的 PZ"
            )
            session.click(form.get_by_role("button", name="查询"), "筛选配载订单")
            row = session.page.locator("table tbody tr").filter(has_text=pz)
            self._expect_visible_or_block(
                session,
                row,
                f"出库后的配载单 {pz}",
                owner="配载单负责人范围维护人",
                remediation="保证整批职责在出库后仍保留历史可读范围。",
            )
            pz_link = row.first.get_by_role("link", name=pz, exact=True)
            session.click(pz_link, f"打开配载单 {pz}")
            self._assert_no_error_page(session)
            workspace_tabs = session.page.get_by_role(
                "navigation", name="配载单工作区"
            )
            batch_tab = workspace_tabs.get_by_role("link", name=re.compile(r"配载与车辆"))
            session.click(batch_tab.first, "切换到配载与车辆")
            mounted = session.page.locator(".loading-sheet-section").filter(
                has=session.page.get_by_role("heading", name="挂载订单")
            )
            self._expect_visible_or_block(
                session,
                mounted,
                "挂载订单状态表",
                owner="配载单详情维护人",
                remediation="恢复仓库配载结果和挂载订单表。",
            )
            for key in LTL_KEYS:
                order_number = self.phase1.orders[key]
                order_row = mounted.locator("tbody tr").filter(has_text=order_number)
                self._expect_visible_or_block(
                    session,
                    order_row,
                    f"挂载订单 {order_number}",
                    owner="整批出库同步维护人",
                    remediation="保证 PZ 出库后每票仍留在挂载关系并同步包装状态。",
                )
                if "已出库" not in self._locator_text(order_row):
                    raise BusinessBlocker(
                        f"{order_number} 在 PZ 完成后仍未显示已出库",
                        owner="整批出库同步维护人",
                        remediation="修复 PZ dispatch 完成后对子订单、shipment 和 package 状态的同步。",
                    )

            side = session.page.get_by_role(
                "complementary", name="配载单关键资料与快捷查看"
            )
            open_drawer = side.get_by_role("button", name="展开 →")
            session.click(open_drawer, "展开配载单右侧资料抽屉")
            drawer = session.page.get_by_role("dialog", name=f"配载单资料 · {pz}")
            self._expect_visible_or_block(
                session,
                drawer,
                f"{pz} 右侧资料抽屉",
                owner="配载单详情体验维护人",
                remediation="侧栏展开应在当前页打开抽屉，不得跳回第一个页面。",
            )
            for key in LTL_KEYS:
                order_number = self.phase1.orders[key]
                disclosure = drawer.locator("details.batch-drawer-order-disclosure").filter(
                    has_text=order_number
                )
                self._expect_visible_or_block(
                    session,
                    disclosure,
                    f"{order_number} 抽屉订单详情",
                    owner="配载单资料抽屉维护人",
                    remediation="挂载订单必须提供可展开的逐票货物详情。",
                )
                summary = disclosure.locator("summary")
                session.click(summary, f"展开 {order_number} 货物详情")
                detail_text = self._locator_text(disclosure, 20_000)
                required_text = ("货物信息", "货物标签与货物码")
                if any(item not in detail_text for item in required_text):
                    raise BusinessBlocker(
                        f"{order_number} 抽屉详情缺少货物信息或货物标签区",
                        owner="配载单资料抽屉维护人",
                        remediation="逐票详情必须并列展示结构化货物信息和标签/货物码。",
                    )
                missing_codes = [
                    code
                    for code in self.artifacts.cargo_codes[key]
                    if code not in detail_text
                ]
                if missing_codes:
                    raise BusinessBlocker(
                        f"{order_number} 抽屉缺少 OUL：{'、'.join(missing_codes)}",
                        owner="配载单货物标签同步维护人",
                        remediation="将仓库生成的全部 OUL 标签同步到 PZ 逐票资料抽屉。",
                    )
            observation.observe("三票均显示已出库，抽屉逐票货物信息和 OUL 齐全", gate_passed=True)

    def run(self) -> Phase2Artifacts:
        self._login(self.operation, "操作岗")
        self._login(self.batch_operation, "PZ 新整批操作负责人")
        self._login(self.operation_supervisor, "操作主管")
        self._login(self.domestic_warehouse, "国内仓库岗")
        warehouse_name = self.domestic_warehouse.page.locator(
            ".warehouse-account-context strong"
        )
        self._expect_visible_or_block(
            self.domestic_warehouse,
            warehouse_name,
            "当前账号绑定仓库名称",
            owner="仓库账号绑定维护人",
            remediation="国内仓账号必须唯一绑定可用仓库，并在仓库工作台明确展示。",
        )
        self.domestic_warehouse_name = self._locator_text(warehouse_name, 500)
        self.arrange_domestic_transport()
        self.accept_orders_into_warehouse()
        self.complete_ftl_outbound()
        self.create_ltl_batch()
        self.assign_batch()
        self.assert_mounted_orders_leave_ordinary_table()
        self.complete_ltl_batch_outbound()
        self.assert_batch_sync_and_drawer()
        self.harness.assert_certifiable()
        return self.artifacts


def _redact_reason(reason: str, records: Sequence[CredentialRecord]) -> str:
    safe = reason
    secrets = [item.email for item in records] + [item.password for item in records]
    for value in sorted((item for item in secrets if item), key=len, reverse=True):
        safe = safe.replace(value, "<redacted>")
    return safe[:2_000]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="纯 UI 接续第一阶段：国内运输/入库 → FTL 出库 → 三票 LTL 配载和整批出库。"
    )
    parser.add_argument("--phase1-summary", type=Path, required=True)
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument("--output-root", type=Path, default=Path("output/playwright"))
    parser.add_argument(
        "--fixture-file",
        type=Path,
        default=HERE / "fixtures" / "tms-phase2-document.pdf",
    )
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--slow-mo", type=int, default=40)
    parser.add_argument("--timeout-ms", type=int, default=20_000)
    parser.add_argument("--navigation-timeout-ms", type=int, default=35_000)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="显式允许通过可见 UI 接续既有业务数据；未传入时只做无写入预检。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    phase1 = load_phase1_handoff(args.phase1_summary)
    vault = load_credentials(args.credentials_file)
    required = vault.select(REQUIRED_ACCOUNT_ALIASES)
    preflight = _public_preflight(
        vault,
        phase1,
        base_url=args.base_url,
        fixture_file=args.fixture_file,
    )
    if not args.execute:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0

    credentials = build_pz_runtime_credentials(vault)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    run_id = (
        f"phase2-{safe_artifact_name(phase1.source_run_id)}-"
        f"{stamp}-{uuid.uuid4().hex[:8]}"
    )
    output_dir = args.output_root.resolve() / "phase2-resume" / run_id
    status = "failed"
    reason = ""
    summary_path: Path | None = None
    artifacts = Phase2Artifacts()

    try:
        with sync_playwright() as playwright:
            harness = TmsUIHarness(
                playwright,
                run_id=run_id,
                output_dir=output_dir,
                base_url=args.base_url,
                headless=args.headless,
                slow_mo=args.slow_mo,
                action_timeout_ms=args.timeout_ms,
                navigation_timeout_ms=args.navigation_timeout_ms,
                scenario_name="1 FTL + 3 LTL 全流程第二阶段：国内入库、配载与装车出库",
            )
            flow: Phase2Flow | None = None
            try:
                credentials, prepared_accounts = prepare_secondary_pz_accounts(
                    harness=harness,
                    credentials=credentials,
                )
                harness.journal.add_note(
                    "PZ 独立负责人账号准备完成："
                    + "、".join(
                        f"{item.alias}={item.outcome}" for item in prepared_accounts
                    )
                )
                flow = Phase2Flow(
                    harness=harness,
                    credentials=credentials,
                    phase1=phase1,
                    fixture_file=args.fixture_file,
                )
                artifacts = flow.run()
                status = "passed"
            except BusinessBlocker as error:
                if flow is not None:
                    artifacts = flow.artifacts
                status = "blocked"
                reason = f"{error}；责任方：{error.owner}；建议：{error.remediation}"
                harness.journal.add_note(reason)
            except Exception as error:
                if flow is not None:
                    artifacts = flow.artifacts
                status = "failed"
                reason = f"{type(error).__name__}: {error}"
                harness.journal.add_note("未预期异常：" + reason)
            finally:
                for key, codes in artifacts.cargo_codes.items():
                    if codes:
                        harness.journal.register_entity("cargo_codes", key, ",".join(codes))
                if artifacts.batch_number:
                    harness.journal.register_entity(
                        "transport_batch", "ltl", artifacts.batch_number
                    )
                if artifacts.ftl_dispatch_number:
                    harness.journal.register_entity(
                        "dispatch", "ftl", artifacts.ftl_dispatch_number
                    )
                if artifacts.ltl_dispatch_number:
                    harness.journal.register_entity(
                        "dispatch", "ltl_batch", artifacts.ltl_dispatch_number
                    )
                reason = _redact_reason(reason, tuple(credentials.values()))
                summary_path = harness.close(status=status)  # type: ignore[arg-type]
                if harness.last_status != status:
                    status = str(harness.last_status)
                    if not reason:
                        reason = harness.finalization_error or "步骤、门禁或证据汇总未通过"
    except Exception as error:
        status = "failed"
        reason = _redact_reason(
            f"{type(error).__name__}: {error}", tuple(credentials.values())
        )

    handoff = build_handoff_payload(
        phase1,
        artifacts,
        ready_for_phase3=status == "passed",
    )
    if summary_path is not None:
        summary_path = augment_summary(summary_path, handoff)
    print(
        json.dumps(
            {
                "status": status.upper(),
                "run_id": run_id,
                "summary": str(summary_path) if summary_path else "",
                "reason": reason,
                "handoff": handoff,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
