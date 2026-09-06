#!/usr/bin/env python3
"""International TMS 纯 UI 全流程执行器：第三阶段。

本阶段只接续第二阶段已经通过的四票业务数据：

1. 单证岗核对整车与 PZ 配载单逐票报关文件，登记正式报关单并确认放行；
2. 操作岗登记整车与 PZ 的口岸到达、实际出境和境外运输节点；
3. 境外目的仓逐件扫描国内仓原 OUL 货物码，完成入库清点并触发客户通知；
4. 新建客户在独立门户上下文核对通知，并在业务开放时完成一次代表性提货预约；
5. 境外目的仓逐件扫描原 OUL，逐件核对货物并确认客户自提签收。

所有业务写入必须通过 ``RoleBrowserSession`` 记录的可见控件、键盘、鼠标和
原生文件选择器完成。本脚本不访问数据库或 HTTP API，不注入 DOM、Cookie、
localStorage，不使用正向深链，也不直接给隐藏文件控件赋值。默认仅输出
``READY_NOT_EXECUTED``；只有显式传入 ``--execute`` 才会推进既有业务数据。
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
from tms_pz_account_prep import build_pz_runtime_credentials


ORDER_KEYS = ("ftl", "ltl1", "ltl2", "ltl3")
LTL_KEYS = ("ltl1", "ltl2", "ltl3")
REQUIRED_ACCOUNT_ALIASES = ("operation", "document", "overseas_warehouse", "customer")
PHASE2_HANDOFF_SCHEMA = "international-tms-full-flow-phase2-handoff/v1"
PHASE3_HANDOFF_SCHEMA = "international-tms-full-flow-phase3-handoff/v1"
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
PHASE3_STAGE_ORDER = (
    "customs_permission_alignment",
    "ftl_customs_release",
    "batch_customs_release",
    "ftl_actual_exit_and_tracking",
    "batch_actual_exit_and_tracking",
    "overseas_original_label_inbound",
    "customer_notification_and_optional_appointment",
    "overseas_pickup_scan_and_signoff",
)
PHASE3_PERMISSION_AND_NEGATIVE_CASES = (
    "P3-PERM-PZ-NEW-DOCUMENT",
    "P3-NEG-PZ-OLD-DOCUMENT-DEEP-LINK",
    "P3-NEG-PZ-PARTIAL-CUSTOMS-EXIT",
    "P3-NEG-CHILD-OLD-DOCUMENT",
)

ORDER_NUMBER_RE = re.compile(r"^SO[0-9A-Z-]{6,}$", re.I)
PZ_NUMBER_RE = re.compile(r"^PZ-[0-9A-Z-]{4,}$", re.I)
OUT_NUMBER_RE = re.compile(r"^OUT-[0-9A-Z-]{4,}$", re.I)
OUL_NUMBER_RE = re.compile(r"^OUL-[0-9A-Z-]+$", re.I)
PHASE1_RUN_ID_RE = re.compile(
    r"-a(?P<attempt>[0-9]{3})-(?P<stamp>[0-9]{14})-(?P<nonce>[0-9a-f]{8})$",
    re.I,
)
DENIED_PAGE_RE = re.compile(r"请求失败|不存在|找不到该页面|尚未分配|没有.*权限|Forbidden|403|404", re.I)
ERROR_PAGE_RE = re.compile(
    r"请求失败|SYSTEM RECOVERY|Forbidden|Internal Server Error|请求失败\s*\(403\)",
    re.I,
)


class BusinessBlocker(RuntimeError):
    """A real UI, workflow or permission gate that prevents phase three."""

    def __init__(self, message: str, *, owner: str, remediation: str) -> None:
        super().__init__(message)
        self.owner = owner
        self.remediation = remediation


@dataclass(frozen=True, slots=True)
class Phase3Order:
    key: str
    order_number: str
    business_type: str
    expected_pieces: int
    cargo_codes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class Phase2Handoff:
    source_run_id: str
    source_phase1_run_id: str
    source_phase1_entity_prefix: str
    customer_name: str
    orders: tuple[Phase3Order, ...]
    batch_number: str
    dispatches: Mapping[str, str]
    batch_operation_alias: str = "operation_2"
    batch_document_alias: str = "document_2"
    certification_lineage: Mapping[str, Any] = field(default_factory=dict)

    def order(self, key: str) -> Phase3Order:
        try:
            return next(item for item in self.orders if item.key == key)
        except StopIteration as error:
            raise KeyError(key) from error

    @property
    def all_cargo_codes(self) -> tuple[str, ...]:
        return tuple(code for order in self.orders for code in order.cargo_codes)


@dataclass(slots=True)
class Phase3Artifacts:
    customs_declarations: dict[str, str] = field(default_factory=dict)
    completed_tracking_nodes: dict[str, list[str]] = field(
        default_factory=lambda: {"ftl": [], "ltl_batch": []}
    )
    inbound_cargo_codes: list[str] = field(default_factory=list)
    pickup_cargo_codes: list[str] = field(default_factory=list)
    appointed_order: str = ""
    signed_orders: list[str] = field(default_factory=list)


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} 必须是 JSON 对象")
    return value


def derive_phase1_entity_prefix(source_run_id: str) -> str:
    """Recover phase-one's non-secret entity prefix from its stable run id."""

    match = PHASE1_RUN_ID_RE.search(source_run_id.strip())
    if match is None:
        return ""
    return (
        f"UIE2E-{match.group('stamp')}-A{match.group('attempt')}-"
        f"{match.group('nonce').upper()}"
    )


def portal_email_from_entity_prefix(entity_prefix: str) -> str:
    """Rebuild the runtime-only portal login created by phase one."""

    compact = re.sub(r"[^0-9A-Za-z]", "", entity_prefix)
    if not compact:
        raise ValueError("第二阶段交接缺少可重建客户门户账号的 phase1 entity_prefix")
    return f"uie2e.phase1.{compact.lower()}@example.test"


def _cargo_codes(value: object, label: str) -> tuple[str, ...]:
    raw = value.split(",") if isinstance(value, str) else value
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise ValueError(f"{label} 必须是 OUL 货物码数组")
    result = tuple(str(item).strip().upper() for item in raw if str(item).strip())
    if not result or any(not OUL_NUMBER_RE.fullmatch(item) for item in result):
        raise ValueError(f"{label} 缺失或含无效 OUL 货物码")
    if len(set(result)) != len(result):
        raise ValueError(f"{label} 存在重复 OUL 货物码")
    return result


def _expected_pieces(value: object, label: str) -> int:
    rendered = str(value).strip()
    if isinstance(value, bool) or not re.fullmatch(r"[1-9]\d*", rendered):
        raise ValueError(f"{label} 缺失或不是正整数")
    return int(rendered)


def load_phase2_handoff(path: Path | str) -> Phase2Handoff:
    """Load and strictly validate a passed phase-two summary/envelope."""

    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"第二阶段结果文件不存在：{source}")
    payload = _mapping(json.loads(source.read_text(encoding="utf-8-sig")), "第二阶段结果")
    evidence = require_certified_summary(
        payload,
        source=source,
        label="第二阶段",
    )
    source_run_id = str(evidence.get("run_id", "")).strip()
    if not source_run_id:
        raise ValueError("第二阶段结果缺少 run_id")
    envelope_run_id = str(payload.get("run_id", "")).strip()
    if envelope_run_id and envelope_run_id != source_run_id:
        raise ValueError("第二阶段结果 envelope.run_id 与 summary.run_id 不一致")
    handoff = _mapping(evidence.get("handoff"), "handoff")
    if handoff.get("schema") != PHASE2_HANDOFF_SCHEMA:
        raise ValueError("第二阶段 handoff schema 不受支持")
    if handoff.get("ready_for_phase3") is not True:
        raise ValueError("第二阶段尚未明确 ready_for_phase3")
    completed_stages = tuple(str(item) for item in handoff.get("completed_stages", ()))
    if completed_stages != PHASE2_STAGE_ORDER:
        raise ValueError("第二阶段 completed_stages 不完整或顺序不一致")

    raw_orders = _mapping(handoff.get("orders"), "handoff.orders")
    orders: list[Phase3Order] = []
    for key in ORDER_KEYS:
        item = _mapping(raw_orders.get(key), f"handoff.orders.{key}")
        number = str(item.get("order_number", "")).strip().upper()
        expected_type = "ftl" if key == "ftl" else "ltl"
        business_type = str(item.get("business_type", "")).strip().lower()
        if not ORDER_NUMBER_RE.fullmatch(number):
            raise ValueError(f"第二阶段订单 {key} 缺失或格式无效")
        if business_type != expected_type:
            raise ValueError(f"第二阶段订单 {key} 的业务类型应为 {expected_type}")
        expected_pieces = _expected_pieces(
            item.get("expected_pieces"), f"第二阶段订单 {key} expected_pieces"
        )
        cargo_codes = _cargo_codes(item.get("cargo_codes"), f"订单 {key}")
        if len(cargo_codes) != expected_pieces:
            raise ValueError(
                f"第二阶段订单 {key} OUL 数量与预计件数不一致："
                f"expected_pieces={expected_pieces}，OUL={len(cargo_codes)}"
            )
        orders.append(
            Phase3Order(
                key=key,
                order_number=number,
                business_type=business_type,
                expected_pieces=expected_pieces,
                cargo_codes=cargo_codes,
            )
        )
    if len({item.order_number for item in orders}) != len(ORDER_KEYS):
        raise ValueError("第二阶段四个订单号必须互不相同")
    all_codes = [code for item in orders for code in item.cargo_codes]
    if len(set(all_codes)) != len(all_codes):
        raise ValueError("第二阶段不同订单之间不能复用同一 OUL 货物码")

    batch = _mapping(handoff.get("transport_batch"), "handoff.transport_batch")
    batch_number = str(batch.get("batch_number", "")).strip().upper()
    if not PZ_NUMBER_RE.fullmatch(batch_number):
        raise ValueError("第二阶段 PZ 配载单号缺失或格式无效")
    order_keys = tuple(str(item) for item in batch.get("order_keys", ()))
    order_numbers = tuple(str(item).strip().upper() for item in batch.get("order_numbers", ()))
    if order_keys != LTL_KEYS:
        raise ValueError("PZ 配载范围必须严格包含 ltl1、ltl2、ltl3")
    if order_numbers != tuple(item.order_number for item in orders if item.key in LTL_KEYS):
        raise ValueError("PZ 挂载订单号与 orders 交接不一致")

    raw_dispatches = _mapping(handoff.get("dispatches"), "handoff.dispatches")
    dispatches: dict[str, str] = {}
    for key in ("ftl", "ltl_batch"):
        item = _mapping(raw_dispatches.get(key), f"handoff.dispatches.{key}")
        number = str(item.get("dispatch_number", "")).strip().upper()
        if not OUT_NUMBER_RE.fullmatch(number):
            raise ValueError(f"第二阶段装车任务 {key} 缺失或格式无效")
        dispatches[key] = number

    source_phase1_run_id = str(handoff.get("source_phase1_run_id", "")).strip()
    if not source_phase1_run_id:
        raise ValueError("第二阶段交接缺少 source_phase1_run_id")
    entity_prefix = str(handoff.get("source_phase1_entity_prefix", "")).strip()
    derived_entity_prefix = derive_phase1_entity_prefix(source_phase1_run_id)
    if entity_prefix and derived_entity_prefix and entity_prefix != derived_entity_prefix:
        raise ValueError("第二阶段交接的 Phase 1 entity_prefix 与 run_id 不一致")
    if not entity_prefix:
        entity_prefix = derived_entity_prefix
    portal_email_from_entity_prefix(entity_prefix)
    customer = _mapping(handoff.get("customer", {}), "handoff.customer")
    customer_name = str(customer.get("name", "")).strip()
    if not customer_name:
        raise ValueError("第二阶段交接缺少客户名称，无法核对客户门户数据隔离")
    assignees = _mapping(handoff.get("assignees", {}), "handoff.assignees")
    batch_operation_alias = str(
        assignees.get("operation_alias", "operation_2")
    ).strip()
    batch_document_alias = str(
        assignees.get("document_alias", "document_2")
    ).strip()
    if batch_operation_alias != "operation_2" or batch_document_alias != "document_2":
        raise ValueError("第二阶段 PZ 必须交接给 operation_2 和 document_2")
    lineage = _mapping(
        handoff.get("certification_lineage"), "handoff.certification_lineage"
    )
    if (
        lineage.get("mode") != "fresh-from-phase1"
        or lineage.get("fresh_phase1_attempt") is not True
        or lineage.get("recovery_branches_used") is not False
    ):
        raise ValueError("第二阶段认证链路不是无恢复分支的 Phase 1 fresh attempt")
    if str(lineage.get("root_phase1_run_id", "")).strip() != source_phase1_run_id:
        raise ValueError("第二阶段认证链路的 Phase 1 run_id 不一致")
    if str(lineage.get("root_entity_prefix", "")).strip() != entity_prefix:
        raise ValueError("第二阶段认证链路的 fresh entity_prefix 不一致")
    return Phase2Handoff(
        source_run_id=source_run_id,
        source_phase1_run_id=source_phase1_run_id,
        source_phase1_entity_prefix=entity_prefix,
        customer_name=customer_name,
        orders=tuple(orders),
        batch_number=batch_number,
        dispatches=dispatches,
        batch_operation_alias=batch_operation_alias,
        batch_document_alias=batch_document_alias,
        certification_lineage=dict(lineage),
    )


def build_handoff_payload(
    source: Phase2Handoff,
    artifacts: Phase3Artifacts,
    *,
    ready_for_phase4: bool,
) -> dict[str, Any]:
    if ready_for_phase4 and not source.certification_lineage:
        raise ValueError("正式 Phase 3 交接缺少 Phase 1 fresh attempt 认证链路")
    lineage = dict(source.certification_lineage)
    lineage["source_phase2_run_id"] = source.source_run_id
    return {
        "schema": PHASE3_HANDOFF_SCHEMA,
        "source_phase2_run_id": source.source_run_id,
        "source_phase1_run_id": source.source_phase1_run_id,
        "source_phase1_entity_prefix": source.source_phase1_entity_prefix,
        "customer": {"name": source.customer_name},
        "orders": {
            item.key: {
                "order_number": item.order_number,
                "business_type": item.business_type,
                "expected_pieces": item.expected_pieces,
                "cargo_codes": list(item.cargo_codes),
            }
            for item in source.orders
        },
        "transport_batch": {
            "batch_number": source.batch_number,
            "order_keys": list(LTL_KEYS),
            "order_numbers": [source.order(key).order_number for key in LTL_KEYS],
        },
        "dispatches": dict(source.dispatches),
        "certification_lineage": lineage,
        "oul_numbers": {
            item.key: list(item.cargo_codes) for item in source.orders
        },
        "customs_declarations": dict(artifacts.customs_declarations),
        "tracking_nodes": {
            key: list(values) for key, values in artifacts.completed_tracking_nodes.items()
        },
        "overseas_inbound": list(artifacts.inbound_cargo_codes),
        "appointed_order": artifacts.appointed_order,
        "pickup_cargo_codes": list(artifacts.pickup_cargo_codes),
        "pickup_signed_orders": list(artifacts.signed_orders),
        "completed_stages": list(PHASE3_STAGE_ORDER) if ready_for_phase4 else [],
        "ready_for_phase4": ready_for_phase4,
    }


def augment_summary(path: Path | str, handoff: Mapping[str, Any]) -> Path:
    destination = Path(path).resolve()
    payload = _mapping(json.loads(destination.read_text(encoding="utf-8-sig")), "summary")
    updated = dict(payload)
    updated["handoff"] = dict(handoff)
    temporary = destination.with_name(".phase3-summary.json.tmp")
    temporary.write_text(json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8-sig")
    temporary.replace(destination)
    return destination


def _public_preflight(
    vault: CredentialVault,
    source: Phase2Handoff,
    *,
    base_url: str,
    fixture_file: Path | str,
) -> dict[str, Any]:
    selected = vault.select(REQUIRED_ACCOUNT_ALIASES)
    fixture = Path(fixture_file).resolve()
    if not fixture.is_file():
        raise FileNotFoundError(f"原生文件选择器测试附件不存在：{fixture}")
    return {
        "status": "READY_NOT_EXECUTED",
        "business_writes": False,
        "base_url": base_url.rstrip("/"),
        "source_phase2_run_id": source.source_run_id,
        "orders": {item.key: item.order_number for item in source.orders},
        "expected_pieces": {
            item.key: item.expected_pieces for item in source.orders
        },
        "transport_batch": source.batch_number,
        "dispatches": dict(source.dispatches),
        "oul_count": len(source.all_cargo_codes),
        "portal_identity_reconstructable": bool(source.source_phase1_entity_prefix),
        "required_roles": [item.public_summary() for item in selected],
        "pz_runtime_roles": [
            source.batch_operation_alias,
            source.batch_document_alias,
        ],
        "stage_order": list(PHASE3_STAGE_ORDER),
        "file_chooser_fixture": fixture.name,
        "next_action": "仅在服务与第二阶段结果确认无误后显式传入 --execute。",
    }


def _workflow_gate(
    name: str,
    *,
    ui: str,
    server: str,
    owner: str,
    configured_mode: str = "required",
    source: str = "workflow_instance_module_state",
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source=source,  # type: ignore[arg-type]
        configured_mode=configured_mode,  # type: ignore[arg-type]
        expected_behavior="allow",
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对工作流实例字段显隐/必填、模块状态、前置节点和当前负责人权限。",
    )


def _permission_gate(
    name: str,
    *,
    ui: str,
    server: str,
    owner: str,
    expected_behavior: str = "allow",
) -> GateExpectation:
    behavior = "read_only" if expected_behavior == "deny" else expected_behavior
    return GateExpectation(
        name=name,
        source="role_permission_configuration",
        configured_mode="read_only" if behavior in {"hide", "read_only"} else "operate",
        expected_behavior=behavior,  # type: ignore[arg-type]
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对岗位权限、订单/PZ 数据范围与当前负责人绑定是否使用同一规则。",
    )


def batch_tab_name_pattern(label: str) -> re.Pattern[str]:
    """Match a tab label even when its status pill leads the accessible name."""

    return re.compile(rf"(?:^|\s){re.escape(label)}(?:\s|$)")


class Phase3Flow:
    """Visible-browser continuation from customs through pickup sign-off."""

    def __init__(
        self,
        *,
        harness: TmsUIHarness,
        credentials: Mapping[str, CredentialRecord],
        source: Phase2Handoff,
        fixture_file: Path,
        entity_prefix: str,
    ) -> None:
        self.harness = harness
        self.credentials = dict(credentials)
        self.source = source
        self.fixture_file = fixture_file.resolve()
        self.entity_prefix = re.sub(r"[^0-9A-Za-z]", "", entity_prefix)[-20:]
        self.artifacts = Phase3Artifacts()
        self.portal_email = portal_email_from_entity_prefix(
            source.source_phase1_entity_prefix
        )

        self.operation = self._add_role("operation")
        self.batch_operation = self._add_role(source.batch_operation_alias)
        self.document = self._add_role("document")
        self.batch_document = self._add_role(source.batch_document_alias)
        self.overseas_warehouse = self._add_role("overseas_warehouse")
        self.customer = harness.add_role(
            "fresh_customer_phase3", self.portal_email, site="portal"
        )
        for item in source.orders:
            harness.journal.register_entity("order", item.key, item.order_number)
            harness.journal.register_entity(
                "cargo_codes", item.key, ",".join(item.cargo_codes)
            )
            for index, code in enumerate(item.cargo_codes, start=1):
                harness.journal.register_entity("oul", f"{item.key}_{index}", code)
        harness.journal.register_entity("transport_batch", "ltl", source.batch_number)
        for key, value in source.dispatches.items():
            harness.journal.register_entity("dispatch", key, value)
        if source.customer_name:
            harness.journal.register_entity("customer", "primary", source.customer_name)

    def _add_role(self, alias: str) -> RoleBrowserSession:
        credential = self.credentials[alias]
        return self.harness.add_role(alias, credential.email, credential.site)

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
                remediation="核对菜单、loader 与 action 是否使用相同岗位和数据范围规则。",
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
            "重要变更通知连续出现超过 8 次，疑似确认循环",
            owner="通知中心维护人",
            remediation="检查必读通知确认状态是否按当前用户持久化。",
        )

    def _login(
        self,
        session: RoleBrowserSession,
        *,
        password: str,
        label: str,
    ) -> None:
        with session.step(
            f"{label}从独立登录页进入工作台",
            case_id=f"P3-LOGIN-{session.role.upper().replace('_', '-')}",
            stage="账号与权限",
            priority="P0",
            preconditions=("账号来自运行时凭据", "浏览器上下文不与其他岗位共享"),
            inputs={"account_email": session.email, "site": session.site},
            expected_result=f"{label}登录成功，菜单与服务端权限一致且无 403/500",
            gate=_permission_gate(
                f"{label}登录和工作台权限",
                ui="只显示当前岗位可访问的菜单与可办理控件。",
                server="相同身份、组织和负责人范围在 loader/action 中被允许。",
                owner=label,
            ),
            sensitive=True,
        ) as observation:
            session.login(password)
            self._dismiss_required_notifications(session)
            self._assert_no_error_page(session)
            observation.observe(f"{label}登录成功", gate_passed=True)
        session.start_trace("phase3-visible-actions")

    def _click_navigation(self, session: RoleBrowserSession, label: str) -> None:
        if session.site == "warehouse":
            navigation_name = "仓库作业导航"
        elif session.site == "portal":
            navigation_name = "客户门户导航"
        else:
            navigation_name = "运营管理导航"
        navigation = session.page.get_by_role("navigation", name=navigation_name)
        link = navigation.get_by_role("link", name=label, exact=True)
        if not self._is_visible(link):
            raise BusinessBlocker(
                f"{session.role} 工作台没有显示“{label}”菜单",
                owner="角色权限管理员",
                remediation=f"核对 {session.role} 菜单权限与“{label}”页面授权。",
            )
        session.click(link.first, f"导航到{label}")
        session.page.wait_for_timeout(180)
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
        session.page.wait_for_timeout(150)
        self._assert_no_error_page(session)

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

    def _expect_not_rendered_or_block(
        self,
        session: RoleBrowserSession,
        locator: Locator,
        target: str,
        *,
        owner: str,
        remediation: str,
    ) -> None:
        """Require an unauthorized action to be absent, not merely disabled/closed."""

        session.expect_hidden(locator, target)
        if locator.count() > 0:
            raise BusinessBlocker(
                f"{target}仍被渲染；只读角色不应接收可办理控件",
                owner=owner,
                remediation=remediation,
            )

    def _expect_success(
        self,
        session: RoleBrowserSession,
        text: str | re.Pattern[str],
        target: str,
    ) -> str:
        locator = session.page.locator(
            ".alert.success, .batch-action-toast.success, [role='status']"
        ).filter(has_text=text)
        self._expect_visible_or_block(
            session,
            locator,
            target,
            owner="当前业务节点维护人",
            remediation="根据可见错误核对工作流门禁、字段值和负责人权限。",
        )
        return self._locator_text(locator, 2_000)

    @staticmethod
    def _option_rows(select: Locator) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        options = select.locator("option")
        for index in range(options.count()):
            option = options.nth(index)
            value = str(option.get_attribute("value") or "").strip()
            if value and not option.is_disabled():
                result.append((value, option.inner_text().strip()))
        return result

    def _select_first_available(
        self,
        session: RoleBrowserSession,
        select: Locator,
        target: str,
        *,
        preferred_value: str = "",
    ) -> str:
        if not self._is_visible(select):
            return ""
        candidates = self._option_rows(select.first)
        if not candidates:
            if select.first.get_attribute("required") is not None:
                raise BusinessBlocker(
                    f"{target}是必填项但没有可用选项",
                    owner="基础资料管理员",
                    remediation=f"为{target}配置至少一个启用选项。",
                )
            return ""
        chosen = next(
            (item for item in candidates if item[0] == preferred_value), candidates[0]
        )
        session.select(select.first, target, value=chosen[0])
        return chosen[0]

    def _fill_if_visible(
        self,
        session: RoleBrowserSession,
        form: Locator,
        name: str,
        value: str,
        target: str,
        *,
        only_if_empty: bool = False,
    ) -> None:
        control = form.locator(f'[name="{name}"]')
        if not self._is_visible(control) or control.first.is_disabled():
            return
        if control.first.get_attribute("readonly") is not None:
            return
        if only_if_empty and str(control.first.input_value()).strip():
            return
        control_type = str(control.first.get_attribute("type") or "").lower()
        if control_type == "date":
            session.type_date(control.first, value, target)
        elif control_type == "datetime-local":
            session.type_datetime_local(control.first, value, target)
        else:
            session.type_text(control.first, value, target)

    def _open_ordinary_order(
        self, session: RoleBrowserSession, order_number: str
    ) -> None:
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
            remediation="恢复普通订单页筛选和查看/办理入口。",
        )
        session.type_text(form.locator('input[name="keyword"]'), order_number, "输入订单号")
        session.click(form.get_by_role("button", name="筛选"), "筛选普通订单")
        row = session.page.locator("table tbody tr").filter(has_text=order_number)
        self._expect_visible_or_block(
            session,
            row,
            f"普通订单 {order_number}",
            owner="订单范围与负责人维护人",
            remediation="确认整车仍按负责人显示在普通订单页。",
        )
        action = row.first.get_by_role(
            "link", name=re.compile(r"^(办理当前节点|查看订单)$")
        )
        self._expect_visible_or_block(
            session,
            action,
            f"{order_number} 查看/办理入口",
            owner="订单路由维护人",
            remediation="保证列表入口与详情页 loader 权限一致。",
        )
        session.click(action.first, f"打开订单 {order_number}")
        session.expect_visible(
            session.page.get_by_role("heading", name=order_number, exact=True),
            f"{order_number} 订单详情标题",
        )
        self._assert_no_error_page(session)

    def _open_batch(self, session: RoleBrowserSession) -> str:
        self._click_navigation(session, "运输订单")
        self._click_workload_tab(session, "配载订单")
        form = session.page.locator("form.batch-workload-filters")
        self._expect_visible_or_block(
            session,
            form,
            "配载订单筛选表单",
            owner="配载订单列表维护人",
            remediation="恢复配载页筛选和办理入口。",
        )
        session.type_text(
            form.locator('input[name="batchKeyword"]'),
            self.source.batch_number,
            "输入 PZ 配载单号",
        )
        session.click(form.get_by_role("button", name="查询"), "查询配载订单")
        row = session.page.locator("table tbody tr").filter(
            has_text=self.source.batch_number
        )
        self._expect_visible_or_block(
            session,
            row,
            f"配载单 {self.source.batch_number}",
            owner="整批负责人范围维护人",
            remediation="确认 PZ 分配关系在装车出库后仍有效。",
        )
        link = row.first.get_by_role("link", name=self.source.batch_number, exact=True)
        if not self._is_visible(link):
            link = row.first.get_by_role("link", name=re.compile(r"^(办理配载单|查看详情)$"))
        href = link.first.get_attribute("href") or ""
        if not href.startswith("/"):
            raise BusinessBlocker(
                f"{self.source.batch_number} 办理链接不是站内路径",
                owner="配载订单路由维护人",
                remediation="列表办理入口必须使用可审计的站内相对路径。",
            )
        session.click(link.first, f"打开配载单 {self.source.batch_number}")
        session.page.wait_for_timeout(180)
        self._assert_no_error_page(session)
        return href

    def _open_batch_tab(self, session: RoleBrowserSession, label: str) -> None:
        tabs = session.page.get_by_role("navigation", name="配载单工作区")
        link = tabs.get_by_role(
            "link", name=batch_tab_name_pattern(label)
        )
        self._expect_visible_or_block(
            session,
            link,
            f"配载单页签：{label}",
            owner="配载单工作台维护人",
            remediation="保证 PZ 工作台按业务顺序展示同级页签。",
        )
        session.click(link.first, f"切换到{label}")
        session.page.wait_for_timeout(150)
        self._assert_no_error_page(session)

    def _open_ordinary_business_tab(
        self,
        session: RoleBrowserSession,
        label: str,
    ) -> None:
        tabs = session.page.get_by_role("navigation", name="本节点业务分区")
        link = tabs.get_by_role("link", name=re.compile(rf"^{re.escape(label)}"))
        self._expect_visible_or_block(
            session,
            link,
            f"普通订单页签：{label}",
            owner="普通订单工作台维护人",
            remediation="按当前业务顺序提供可见同级页签，并保持页签状态实时同步。",
        )
        session.click(link.first, f"切换到{label}")
        session.page.wait_for_timeout(150)
        self._assert_no_error_page(session)

    def _ensure_ftl_customs_documents(self) -> None:
        section = self.document.page.get_by_role("region", name="本节点文件")
        if not self._is_visible(section):
            self._open_ordinary_business_tab(self.document, "报关文件")
            section = self.document.page.get_by_role("region", name="本节点文件")
            self._expect_visible_or_block(
                self.document,
                section,
                "整车报关文件办理区",
                owner="普通订单报关页签维护人",
                remediation="报关文件页签必须展示工作流要求的文件与就地上传、审核入口。",
            )
        for _ in range(12):
            required_missing = section.locator("article.source-document-row.required-missing")
            pending = section.locator("article.source-document-row.optional-empty").filter(
                has_text="已上传待审核"
            )
            if required_missing.count() == 0 and pending.count() == 0:
                self._open_ordinary_business_tab(self.document, "报关单")
                return
            candidate = required_missing.first if required_missing.count() else pending.first
            upload = candidate.locator("label.document-upload-button")
            if self._is_visible(upload):
                document_name = candidate.locator(".source-document-name strong").inner_text()
                uploaded_missing = section.locator(
                    "article.source-document-row.required-missing"
                ).filter(has_text=document_name)
                self.document.choose_files(
                    upload.first, self.fixture_file, "选择报关必填文件并上传"
                )
                self.document.expect_hidden(
                    uploaded_missing,
                    f"{document_name.strip()} 上传完成并退出缺失状态",
                )
                section = self.document.page.get_by_role("region", name="本节点文件")
                continue
            review = candidate.get_by_role("button", name="审核", exact=True)
            if self._is_visible(review):
                self.document.click(review.first, "审核报关节点文件")
                dialog = self.document.page.get_by_role(
                    "dialog", name=re.compile(r"^审核文件")
                )
                self.document.select(
                    dialog.locator('select[name="reviewStatus"]'),
                    "审核结果：通过",
                    value="approved",
                )
                self.document.click(
                    dialog.get_by_role("button", name="确认审核结果"),
                    "确认文件审核通过",
                )
                self.document.expect_hidden(dialog, "报关文件审核提交完成")
                section = self.document.page.get_by_role("region", name="本节点文件")
                continue
            raise BusinessBlocker(
                "整车报关节点存在必填/待审核文件，但当前单证岗没有可见办理入口",
                owner="单证权限与文件工作台维护人",
                remediation="让上传、审核控件与工作流文件门禁和单证负责人权限保持一致。",
            )
        raise BusinessBlocker(
            "整车报关文件连续处理 12 次仍未就绪，疑似状态刷新循环",
            owner="订单文件状态同步维护人",
            remediation="检查上传、审核结果与工作流文件存在性实时同步。",
        )

    def _declaration_number(self, key: str, sequence: int) -> str:
        suffix = self.entity_prefix[-12:] or uuid.uuid4().hex[:12].upper()
        return f"E2E-{suffix}-{key.upper()}-{sequence:02d}"

    def _fill_customs_form(
        self,
        session: RoleBrowserSession,
        form: Locator,
        *,
        declaration_number: str,
        sequence: int,
    ) -> None:
        stage = form.locator('select[name="clearanceStage"]')
        if self._is_visible(stage):
            session.select(stage.first, "报关作业阶段", value="origin")
        status = form.locator('select[name="status"]')
        if self._is_visible(status):
            session.select(status.first, "申报单状态", value="declared")
        self._fill_if_visible(
            session, form, "declarationNumber", declaration_number, "填写报关单号"
        )
        self._fill_if_visible(
            session, form, "declarationType", "一般贸易", "填写报关单类型"
        )
        self._fill_if_visible(
            session,
            form,
            "declaredAt",
            datetime.now().strftime("%Y-%m-%dT%H:%M"),
            "填写申报时间",
        )
        self._fill_if_visible(
            session, form, "declarationTitle", "UI全流程验收申报", "填写申报抬头"
        )
        self._fill_if_visible(
            session, form, "declaringCompany", "新翎航国际物流", "填写申报公司"
        )
        self._fill_if_visible(
            session,
            form,
            "declaredAmount",
            str(1000 + sequence * 100),
            "填写申报金额",
        )
        currency = form.locator('select[name="currency"]')
        if self._is_visible(currency):
            session.select(currency.first, "申报币种", value="USD")
        self._fill_if_visible(
            session,
            form,
            "grossWeightKg",
            str(100 + sequence),
            "填写申报毛重",
        )
        reason = form.locator('textarea[name="changeReason"]')
        if (
            self._is_visible(reason)
            and reason.first.get_attribute("required") is not None
            and not reason.first.input_value().strip()
        ):
            session.type_text(
                reason.first, "正常申报，无业务变更", "填写必填申报说明"
            )

    def assert_customs_permission_alignment(self) -> None:
        ftl = self.source.order("ftl")
        with self.operation.step(
            "操作岗核对整车报关页面只有只读信息",
            case_id="P3-PERM-CUSTOMS-FTL",
            stage="报关权限一致性",
            priority="P0",
            preconditions=("整车已完成装车出库", "当前节点由单证负责人办理"),
            inputs={"order_number": ftl.order_number},
            expected_result="操作岗能查看报关状态，但页面不渲染新增、审核或放行操作",
            gate=_permission_gate(
                "整车报关操作岗只读门禁",
                ui="操作岗只显示实时状态表和资料，不显示禁用的办理按钮。",
                server="非单证负责人即使构造提交也不能修改报关数据。",
                owner="权限与订单模块维护人",
                expected_behavior="deny",
            ),
        ) as observation:
            self._open_ordinary_order(self.operation, ftl.order_number)
            self.operation.expect_visible(
                self.operation.page.get_by_role("region", name="报关作业办理顺序"),
                "整车报关办理顺序",
            )
            self._expect_not_rendered_or_block(
                self.operation,
                self.operation.page.get_by_role("button", name="新增报关单", exact=True),
                "操作岗不渲染新增报关单",
                owner="整车报关权限维护人",
                remediation="只读视角应仅渲染状态与资料，不要输出禁用或折叠隐藏的办理按钮。",
            )
            self._expect_not_rendered_or_block(
                self.operation,
                self.operation.page.locator(
                    ".customs-inline-release-form button, .customs-release-inline button"
                ),
                "操作岗不渲染报关放行入口",
                owner="整车报关权限维护人",
                remediation="放行控件只能在当前单证负责人视角渲染。",
            )
            observation.observe("整车报关信息可读，新增与放行控件均未渲染", gate_passed=True)

        with self.batch_operation.step(
            "PZ 新整批操作负责人核对逐票报关工作台只有只读信息",
            case_id="P3-PERM-CUSTOMS-PZ",
            stage="报关权限一致性",
            priority="P0",
            preconditions=("PZ 已完成装车出库", "整批单证负责人已经分配"),
            inputs={"batch_number": self.source.batch_number},
            expected_result="操作岗可查看三票文件与申报状态，但不显示办理控件",
            gate=_permission_gate(
                "PZ 报关操作岗只读门禁",
                ui="同一 PZ 页面展示只读状态，不展示新增报关单和确认放行按钮。",
                server="PZ action 只允许整批单证负责人处理报关。",
                owner="配载单权限维护人",
                expected_behavior="deny",
            ),
        ) as observation:
            self._open_batch(self.batch_operation)
            self._open_batch_tab(self.batch_operation, "报关与文件")
            self.batch_operation.expect_visible(
                self.batch_operation.page.get_by_text("当前只读", exact=False),
                "PZ 报关只读提示",
            )
            self._expect_not_rendered_or_block(
                self.batch_operation,
                self.batch_operation.page.locator(".batch-customs-create-button"),
                "操作岗不渲染 PZ 新增报关单",
                owner="PZ 报关权限维护人",
                remediation="配载单只读视角不得输出单证办理控件。",
            )
            self._expect_not_rendered_or_block(
                self.batch_operation,
                self.batch_operation.page.locator(".batch-order-direct-customs-button"),
                "操作岗不渲染 PZ 放行入口",
                owner="PZ 报关权限维护人",
                remediation="PZ 放行控件只能在整批单证负责人视角渲染。",
            )
            observation.observe("PZ 三票报关可读，整批办理控件均未渲染", gate_passed=True)

        batch_href = ""
        child_order_href = ""
        with self.batch_document.step(
            "PZ 新整批单证负责人核对可见办理入口",
            case_id=PHASE3_PERMISSION_AND_NEGATIVE_CASES[0],
            stage="报关权限一致性",
            priority="P0",
            preconditions=("PZ 已换人分配", "当前账号是整批单证负责人"),
            inputs={"batch_number": self.source.batch_number},
            expected_result="新负责人可以从配载订单列表进入，并看到逐票新增报关单入口",
            gate=_permission_gate(
                "PZ 新整批单证负责人可办理",
                ui="新负责人从配载列表进入后显示逐票报关办理控件。",
                server="PZ 数据范围和 action 均按当前 document_assignee_user_id 授权。",
                owner="整批单证负责人",
            ),
        ) as observation:
            batch_href = self._open_batch(self.batch_document)
            self._open_batch_tab(self.batch_document, "报关与文件")
            first_order = self.source.order(LTL_KEYS[0])
            row = self.batch_document.page.locator(
                "section.batch-order-documents tbody tr"
            ).filter(has_text=first_order.order_number)
            self._expect_visible_or_block(
                self.batch_document,
                row,
                f"新负责人挂载订单 {first_order.order_number}",
                owner="PZ 单证范围维护人",
                remediation="整批单证负责人必须看到全部有效挂载订单。",
            )
            disclosure = row.locator("details.batch-order-file-details")
            self.batch_document.click(
                disclosure.locator("summary"),
                f"展开 {first_order.order_number} 报关办理区",
            )
            self._expect_visible_or_block(
                self.batch_document,
                disclosure.get_by_role("button", name="新增报关单", exact=True),
                f"新负责人 {first_order.order_number} 新增报关单入口",
                owner="PZ 单证权限维护人",
                remediation="新负责人应有操作控件，不能只显示只读状态。",
            )
            child_link = disclosure.get_by_role(
                "link",
                name=f"查看订单 {first_order.order_number}",
                exact=True,
            )
            self._expect_visible_or_block(
                self.batch_document,
                child_link,
                f"新负责人挂载订单 {first_order.order_number} 详情入口",
                owner="PZ 挂载订单展示维护人",
                remediation="逐票报关面板必须提供挂载订单的可见详情入口。",
            )
            child_order_href = child_link.first.get_attribute("href") or ""
            if not child_order_href.startswith("/"):
                raise BusinessBlocker(
                    f"挂载订单 {first_order.order_number} 详情链接不是站内路径",
                    owner="PZ 挂载订单路由维护人",
                    remediation="挂载订单详情入口必须使用可审计的站内相对路径。",
                )
            observation.observe("新整批单证负责人可见逐票报关办理入口", gate_passed=True)

        with self.document.step(
            "PZ 原单证负责人通过已知深链尝试越权",
            case_id=PHASE3_PERMISSION_AND_NEGATIVE_CASES[1],
            stage="报关权限一致性",
            priority="P0",
            preconditions=("整批分配已解除原单证负责人关系", "PZ 路径由新负责人可见列表取得"),
            inputs={"batch_number": self.source.batch_number},
            expected_result="原单证负责人即使知道 PZ 地址也得到 403/404，不能查看或办理逐票报关",
            gate=GateExpectation(
                name="PZ 原单证负责人深链越权门禁",
                source="role_permission_configuration",
                configured_mode="read_only",
                expected_behavior="block",
                ui_expectation="原负责人列表不显示 PZ，已知深链也进入明确拒绝页。",
                server_expectation="配载单查询按当前 document_assignee_user_id 精确授权。",
                owner_role="原单证负责人",
                remediation="统一配载列表、详情 loader 和 action 的当前单证负责人校验。",
            ),
        ) as observation:
            self.document.goto_for_negative_gate(
                batch_href,
                reason="验证原单证负责人解除后不能通过配载单深链读取或办理新负责人的业务",
                expected_status=(403, 404),
            )
            body = self._locator_text(self.document.page.locator("body"), 4_000)
            if not DENIED_PAGE_RE.search(body):
                raise BusinessBlocker(
                    "原单证负责人深链返回拒绝状态，但页面没有可理解的拒绝说明",
                    owner="配载单权限错误页维护人",
                    remediation="403/404 页面应明确说明无权或资源不可见。",
                )
            self.document.capture_gate_evidence(PHASE3_PERMISSION_AND_NEGATIVE_CASES[1])
            observation.observe("原单证负责人 PZ 深链被服务端拒绝且页面有明确说明", gate_passed=True)
            back = self.document.page.get_by_role(
                "button", name="返回上一页", exact=True
            )
            self.document.recover_from_negative_gate(
                return_control=back,
                restored_locator=self.document.page.get_by_role(
                    "link", name="运输订单", exact=True
                ),
                target="原单证负责人 PZ 越权",
            )
            observation.add_note("负向深链验证后已通过可见返回动作恢复原账号会话")

        with self.document.step(
            "PZ 原单证负责人通过挂载子订单地址尝试越权",
            case_id=PHASE3_PERMISSION_AND_NEGATIVE_CASES[3],
            stage="报关权限一致性",
            priority="P0",
            preconditions=("PZ 换人已解除子订单原单证负责人关系", "子订单路径来自新负责人可见详情"),
            inputs={"order_number": self.source.order(LTL_KEYS[0]).order_number},
            expected_result="原单证负责人访问子订单时只得到 403/404 或严格只读页面，不能新增、申报或放行",
            gate=GateExpectation(
                name="PZ 挂载子订单原单证负责人写权限门禁",
                source="role_permission_configuration",
                configured_mode="read_only",
                expected_behavior="read_only",
                ui_expectation="旧负责人不可见任何子订单报关新增、申报或放行控件。",
                server_expectation="子订单 loader/action 均按 PZ 当前整批 document_assignee_user_id 授权。",
                owner_role="原单证负责人",
                remediation="统一子订单详情、报关模块 loader 和 action 的当前整批负责人校验。",
            ),
        ) as observation:
            response = self.document.goto_for_negative_gate(
                child_order_href,
                reason="验证 PZ 换人后原单证负责人不能通过挂载子订单深链继续申报或放行",
                expected_status=(200, 403, 404),
            )
            body = self._locator_text(self.document.page.locator("body"), 8_000)
            if response.status == 200:
                if not re.search(r"只读|仅供查看|不由本账号办理|无权", body):
                    raise BusinessBlocker(
                        "挂载子订单向原单证负责人返回 200，但没有明确只读说明",
                        owner="子订单权限与提示维护人",
                        remediation="旧负责人可查看时必须明确标注只读，并移除全部报关办理控件。",
                    )
                self.document.expect_not_rendered(
                    self.document.page.get_by_role(
                        "button", name="新增报关单", exact=True
                    ),
                    "原单证负责人不渲染挂载子订单新增报关单入口",
                )
                self.document.expect_not_rendered(
                    self.document.page.locator(
                        ".customs-inline-release-form button, "
                        ".customs-release-inline button, "
                        "form.customs-declaration-form button[type='submit']"
                    ),
                    "原单证负责人不渲染挂载子订单报关编辑或提交控件",
                )
            elif not DENIED_PAGE_RE.search(body):
                raise BusinessBlocker(
                    "挂载子订单拒绝页没有可理解的无权或资源不可见说明",
                    owner="子订单权限错误页维护人",
                    remediation="403/404 页面应明确说明当前账号无权办理该挂载订单。",
                )
            self.document.capture_gate_evidence(PHASE3_PERMISSION_AND_NEGATIVE_CASES[3])
            observation.observe(
                f"原单证负责人挂载子订单深链为 HTTP {response.status}，且无申报/放行能力",
                gate_passed=True,
            )
            self.document.recover_from_negative_gate(
                return_control=self.document.page.get_by_role(
                    "button", name="返回上一页", exact=True
                ),
                restored_locator=self.document.page.get_by_role(
                    "link", name="运输订单", exact=True
                ),
                target="原单证负责人挂载子订单越权",
            )

    def complete_ftl_customs(self) -> None:
        order = self.source.order("ftl")
        declaration_number = self._declaration_number("ftl", 1)
        with self.document.step(
            f"单证岗办理整车 {order.order_number} 报关申报与放行",
            case_id="P3-CUSTOMS-FTL",
            stage="整车报关放行",
            priority="P0",
            preconditions=("整车已装车出库", "单证岗是当前报关负责人"),
            inputs={"order_number": order.order_number},
            expected_result="必填文件按工作流就绪，正式报关单保存并放行，订单自动进入运输跟踪",
            gate=_workflow_gate(
                "整车报关文件、申报与放行门禁",
                ui="只呈现工作流启用字段和必填文件；缺项就地办理，放行后实时显示通过。",
                server="使用同一实例配置校验必填文件、申报字段、负责人和放行顺序。",
                owner="单证岗",
            ),
        ) as observation:
            self._open_ordinary_order(self.document, order.order_number)
            self._ensure_ftl_customs_documents()
            create = self.document.page.get_by_role(
                "button", name="新增报关单", exact=True
            )
            if not self._is_visible(create):
                released = self.document.page.get_by_text("报关已放行", exact=False)
                if self._is_visible(released):
                    raise BusinessBlocker(
                        f"{order.order_number} 在本轮到达前已经报关放行，不能作为 fresh 全流程认证数据",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                raise BusinessBlocker(
                    "单证岗未显示整车“新增报关单”入口",
                    owner="单证权限与报关页面维护人",
                    remediation="让单证负责人权限、工作流报关字段和页面操作入口保持一致。",
                )
            self.document.click(create.first, "新增整车报关单")
            dialog = self.document.page.get_by_role("dialog", name="新增报关单")
            self.document.expect_visible(dialog, "新增整车报关单弹窗")
            form = dialog.locator("form.customs-declaration-form")
            self._fill_customs_form(
                self.document,
                form,
                declaration_number=declaration_number,
                sequence=1,
            )
            self.document.click(
                form.get_by_role("button", name="保存申报单"), "保存整车正式申报单"
            )
            saved_row = self.document.page.locator(
                ".module-record-table tbody tr"
            ).filter(has_text=declaration_number)
            self.document.expect_visible(
                saved_row.first, "整车报关单保存后的持久记录"
            )
            release = saved_row.locator(
                ".customs-inline-release-form button"
            ).filter(has_text="确认放行")
            self._expect_visible_or_block(
                self.document,
                release,
                "整车确认放行入口",
                owner="整车报关门禁维护人",
                remediation="申报保存后应立即按工作流开放放行入口。",
            )
            self.document.click(release.first, "确认整车报关放行")
            released_row = self.document.page.locator(
                ".module-record-table tbody tr"
            ).filter(has_text=declaration_number).filter(has_text="已放行")
            self.document.expect_visible(
                released_row.first,
                "整车报关单放行后的持久状态",
            )
            self.artifacts.customs_declarations["ftl"] = declaration_number
            self.harness.journal.register_entity(
                "customs_declaration", "ftl", declaration_number
            )
            observation.observe(
                f"整车报关单 {declaration_number} 已申报并放行", gate_passed=True
            )

    def _assert_batch_exit_blocked_before_all_customs(
        self,
        released_order_number: str,
    ) -> None:
        session = self.batch_operation
        self._open_batch(session)
        self._open_batch_tab(session, "口岸到达与实际出境")
        blocker = session.page.get_by_text(
            "当前待办：完成工作流要求的逐票报关与文件",
            exact=False,
        )
        self._expect_visible_or_block(
            session,
            blocker,
            "PZ 部分报关放行时的出境前置提示",
            owner="PZ 出境门禁维护人",
            remediation="逐票必办报关未全部放行时必须继续停留在报关前置门禁。",
        )
        session.expect_hidden(
            session.page.get_by_role("button", name="登记口岸到达", exact=True),
            "部分报关放行时不开放口岸到达按钮",
        )
        session.expect_hidden(
            session.page.locator("form.batch-inline-exit-form"),
            "部分报关放行时不开放实际出境表单",
        )
        session.capture_gate_evidence(PHASE3_PERMISSION_AND_NEGATIVE_CASES[2])
        expectation = GateExpectation(
            name="PZ 未全部报关放行不得进入出境办理",
            source="workflow_instance_module_state",
            configured_mode="required",
            expected_behavior="block",
            ui_expectation="逐票必办报关未全部完成时只显示返回报关页的前置提示。",
            server_expectation="整批出境前按每票冻结工作流重算文件和报关放行门禁。",
            owner_role="整批操作负责人",
            remediation="统一报关完成统计、出境页按钮显示和 action 服务端门禁。",
        )
        session.record_gate(
            name=expectation.name,
            expected=f"UI：{expectation.ui_expectation}；服务端：{expectation.server_expectation}",
            passed=True,
            actual=f"仅 {released_order_number} 已放行时，口岸到达和实际出境入口均未开放",
            owner=expectation.owner_role,
            remediation=expectation.remediation,
            expectation=expectation,
            case_id=PHASE3_PERMISSION_AND_NEGATIVE_CASES[2],
        )

    def complete_batch_customs(self) -> None:
        session = self.batch_document
        with session.step(
            f"PZ 新整批单证负责人在 {self.source.batch_number} 当前页逐票申报并放行",
            case_id="P3-CUSTOMS-PZ",
            stage="PZ 逐票报关放行",
            priority="P0",
            preconditions=("PZ 已装车出库", "整批单证负责人已经分配"),
            inputs={
                "batch_number": self.source.batch_number,
                "order_numbers": [self.source.order(key).order_number for key in LTL_KEYS],
            },
            expected_result="三票必填文件均就绪，每票一张正式报关单完成申报和放行，PZ 门禁通过",
            gate=_workflow_gate(
                "PZ 逐票文件、申报和放行门禁",
                ui="在配载单报关页展开每票就地办理；三票完成后同页显示门禁通过。",
                server="按每票工作流配置、整批单证负责人和申报时序校验并同步全部子订单。",
                owner="整批单证负责人",
            ),
        ) as observation:
            self._open_batch(session)
            self._open_batch_tab(session, "报关与文件")
            table = session.page.locator("section.batch-order-documents")
            session.expect_visible(table, "PZ 逐票报关表")
            for sequence, key in enumerate(LTL_KEYS, start=2):
                order = self.source.order(key)
                row = table.locator("tbody tr").filter(has_text=order.order_number)
                self._expect_visible_or_block(
                    session,
                    row,
                    f"PZ 挂载订单 {order.order_number}",
                    owner="PZ 报关列表维护人",
                    remediation="配载单报关页必须显示全部有效挂载订单。",
                )
                row_text = self._locator_text(row, 8_000)
                if "待处理" in row_text or "待仓库上传" in row_text:
                    raise BusinessBlocker(
                        f"{order.order_number} 仍有装车阶段必填文件未就绪",
                        owner="国内仓文件交接维护人",
                        remediation="回到 PZ 装车文件步骤，通过可见上传和审核完成必填项。",
                    )
                if "张放行" in row_text and not "0/" in row_text:
                    raise BusinessBlocker(
                        f"{order.order_number} 在本轮到达前已有报关放行记录，不能作为 fresh 全流程认证数据",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                disclosure = row.locator("details.batch-order-file-details")
                session.click(disclosure.locator("summary"), f"展开 {order.order_number} 报关")
                panel = disclosure.locator(".batch-order-file-panel")
                session.expect_visible(panel, f"{order.order_number} 报关办理面板")
                create = panel.get_by_role("button", name="新增报关单", exact=True)
                self._expect_visible_or_block(
                    session,
                    create,
                    f"{order.order_number} 新增报关单入口",
                    owner="PZ 单证权限维护人",
                    remediation="整批单证负责人应能在当前 PZ 页逐票办理。",
                )
                declaration_number = self._declaration_number(key, sequence)
                session.click(create.first, f"新增 {order.order_number} 报关单")
                dialog = session.page.get_by_role(
                    "dialog", name="新增本票报关单"
                )
                session.expect_visible(dialog, f"{order.order_number} 新增报关单弹窗")
                form = dialog.locator("form.customs-declaration-form")
                self._fill_customs_form(
                    session,
                    form,
                    declaration_number=declaration_number,
                    sequence=sequence,
                )
                session.click(
                    form.get_by_role("button", name="保存报关单"),
                    f"保存 {order.order_number} 正式报关单",
                )
                table = session.page.locator("section.batch-order-documents")
                row = table.locator("tbody tr").filter(has_text=order.order_number)
                saved_row = row.filter(has_text=declaration_number)
                session.expect_visible(
                    saved_row.first,
                    f"{order.order_number} 报关单保存后的持久记录",
                )
                release = saved_row.get_by_role("button", name="确认放行", exact=True)
                self._expect_visible_or_block(
                    session,
                    release,
                    f"{order.order_number} 确认放行入口",
                    owner="PZ 报关放行门禁维护人",
                    remediation="正式申报保存后应在同一订单行开放放行。",
                )
                session.click(release.first, f"打开 {order.order_number} 放行确认")
                release_dialog = session.page.get_by_role(
                    "dialog", name=re.compile(r"^确认报关放行")
                )
                session.expect_visible(
                    release_dialog, f"{order.order_number} 放行确认弹窗"
                )
                release_form = release_dialog.locator("form")
                self._fill_if_visible(
                    session,
                    release_form,
                    "releasedAt",
                    datetime.now().strftime("%Y-%m-%dT%H:%M"),
                    "填写报关放行时间",
                )
                session.click(
                    release_form.get_by_role("button", name="确认放行并同步工作流"),
                    f"确认 {order.order_number} 放行",
                )
                table = session.page.locator("section.batch-order-documents")
                released_row = table.locator("tbody tr").filter(
                    has_text=order.order_number
                ).filter(has_text=declaration_number).filter(has_text="1/1 张放行")
                session.expect_visible(
                    released_row.first,
                    f"{order.order_number} 报关放行后的持久状态",
                )
                self.artifacts.customs_declarations[key] = declaration_number
                self.harness.journal.register_entity(
                    "customs_declaration", key, declaration_number
                )
                if key == LTL_KEYS[0]:
                    self._assert_batch_exit_blocked_before_all_customs(order.order_number)
            ready = session.page.get_by_text("门禁已通过", exact=False)
            self._expect_visible_or_block(
                session,
                ready,
                "PZ 报关门禁通过",
                owner="配载单门禁同步维护人",
                remediation="三票放行后实时重算 PZ 文件与报关门禁。",
            )
            observation.observe("PZ 三票正式报关均已放行，整批门禁通过", gate_passed=True)

    @staticmethod
    def _event_time(_sequence_hint: int) -> str:
        """Use the real visible-action minute; never manufacture future milestones."""

        return datetime.now().strftime("%Y-%m-%dT%H:%M")

    def _submit_ftl_tracking_node(
        self,
        *,
        code: str,
        label: str,
        offset_minutes: int,
        location: str,
    ) -> None:
        form = self.operation.page.locator("form.tracking-node-entry-form")
        self._expect_visible_or_block(
            self.operation,
            form,
            f"整车运输节点表单：{label}",
            owner="整车运踪工作台维护人",
            remediation="报关放行后应按工作流开放操作岗运输节点表单。",
        )
        milestone = form.locator('select[name="milestoneCode"]')
        if self._is_visible(milestone):
            self.operation.select(milestone.first, f"运输节点：{label}", value=code)
        else:
            guidance = self._locator_text(
                self.operation.page.locator(".tracking-next-guidance"), 1_000
            )
            if label not in guidance:
                raise BusinessBlocker(
                    f"工作流隐藏节点选择器，但系统定位的下一节点不是“{label}”",
                    owner="工作流字段与运踪顺序维护人",
                    remediation="隐藏节点选择器时必须由系统按必经顺序给出唯一下一节点。",
                )
        self._fill_if_visible(
            self.operation,
            form,
            "eventAt",
            self._event_time(offset_minutes),
            f"填写{label}时间",
        )
        self._fill_if_visible(
            self.operation, form, "location", location, f"填写{label}地点"
        )
        self._fill_if_visible(
            self.operation,
            form,
            "vehicleReference",
            f"UI-FTL-{self.entity_prefix[-6:]}",
            f"填写{label}车辆",
            only_if_empty=True,
        )
        self._fill_if_visible(
            self.operation,
            form,
            "notes",
            f"纯 UI 第三阶段：{label}",
            f"填写{label}说明",
        )
        visibility = form.locator('select[name="visibleToCustomer"]')
        if self._is_visible(visibility):
            self.operation.select(
                visibility.first, f"{label}同步客户门户", value="1"
            )
        self.operation.click(
            form.get_by_role("button", name="保存运输节点"), f"保存整车{label}"
        )
        self._expect_success(
            self.operation, "运输节点已更新", f"整车{label}保存成功提示"
        )
        self.artifacts.completed_tracking_nodes["ftl"].append(code)

    def complete_ftl_tracking(self) -> None:
        order = self.source.order("ftl")
        nodes = (
            ("border_arrived", "到达出境口岸", 1, "霍尔果斯口岸"),
            ("exported", "出境", 2, "霍尔果斯口岸"),
            ("foreign_entered", "国外入境", 3, "境外入境口岸"),
            ("customs_cleared", "目的地清关完成", 4, "目的地海关"),
        )
        with self.operation.step(
            f"操作岗推进整车 {order.order_number} 实际出境与境外运踪",
            case_id="P3-TRACKING-FTL",
            stage="整车实际出境与运踪",
            priority="P0",
            preconditions=("整车正式报关单已放行", "整车 OUT 已完成出库交接"),
            inputs={"order_number": order.order_number, "dispatch": self.source.dispatches["ftl"]},
            expected_result="按时间顺序完成口岸到达、实际出境、国外入境和目的地清关；到仓仅由仓库扫码触发",
            gate=_workflow_gate(
                "整车实际出境与运踪顺序门禁",
                ui="系统定位下一必经节点；到仓不提供手工登记入口。",
                server="按放行、出库、前序节点和时间顺序校验，每次登记同步运单与客户轨迹。",
                owner="操作岗",
                source="workflow_instance_module_state",
            ),
        ) as observation:
            self._open_ordinary_order(self.operation, order.order_number)
            self.operation.expect_visible(
                self.operation.page.get_by_role(
                    "heading", name="运输进度与运单跟踪", exact=True
                ),
                "整车运踪工作台",
            )
            for code, label, offset, location in nodes:
                progress_row = self.operation.page.locator(
                    "table.tracking-progress-table tbody tr"
                ).filter(has_text=label)
                if self._is_visible(progress_row) and "已完成" in self._locator_text(progress_row):
                    raise BusinessBlocker(
                        f"{order.order_number} 的{label}在本轮到达前已经登记，不能作为 fresh 全流程认证数据",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                self._submit_ftl_tracking_node(
                    code=code,
                    label=label,
                    offset_minutes=offset,
                    location=location,
                )
            manual_arrival = self.operation.page.locator(
                'form.tracking-node-entry-form option[value="station_arrived"]'
            )
            self.operation.expect_hidden(
                manual_arrival, "整车目的仓到仓不提供人工节点选项"
            )
            observation.observe(
                "整车已完成实际出境和境外清关，目的仓到仓保留给仓库扫码",
                gate_passed=True,
            )

    def _fill_batch_tracking_form(
        self,
        session: RoleBrowserSession,
        form: Locator,
        *,
        label: str,
        offset_minutes: int,
        location: str,
    ) -> None:
        self._fill_if_visible(
            session,
            form,
            "eventAt",
            self._event_time(offset_minutes),
            f"填写 PZ {label}时间",
        )
        self._fill_if_visible(
            session, form, "location", location, f"填写 PZ {label}地点"
        )
        self._fill_if_visible(
            session,
            form,
            "vehicleReference",
            f"UI-PZ-{self.entity_prefix[-6:]}",
            f"填写 PZ {label}车辆",
            only_if_empty=True,
        )
        self._fill_if_visible(
            session,
            form,
            "notes",
            f"纯 UI 第三阶段：PZ {label}",
            f"填写 PZ {label}备注",
        )
        visibility = form.locator('select[name="visibleToCustomer"]')
        if self._is_visible(visibility):
            session.select(
                visibility.first, f"PZ {label}同步客户门户", value="on"
            )

    def _submit_batch_node(
        self,
        session: RoleBrowserSession,
        *,
        code: str,
        row_label: str,
        dialog_label: str,
        offset_minutes: int,
        location: str,
    ) -> None:
        table = session.page.locator("table.batch-tracking-node-table")
        row = table.locator("tbody tr").filter(has_text=row_label)
        self._expect_visible_or_block(
            session,
            row,
            f"PZ 运踪节点：{row_label}",
            owner="PZ 运踪工作台维护人",
            remediation="按挂载订单工作流并集展示必经节点。",
        )
        if "全票已登记" in self._locator_text(row):
            self.artifacts.completed_tracking_nodes["ltl_batch"].append(code)
            return
        session.click(
            row.get_by_role("button", name="登记节点", exact=True),
            f"打开 PZ {row_label}登记",
        )
        dialog = session.page.get_by_role(
            "dialog", name=f"登记运输节点 · {dialog_label}"
        )
        session.expect_visible(dialog, f"PZ {row_label}登记弹窗")
        form = dialog.locator("form.batch-tracking-modal-form")
        self._fill_batch_tracking_form(
            session,
            form,
            label=row_label,
            offset_minutes=offset_minutes,
            location=location,
        )
        session.click(
            form.get_by_role("button", name=re.compile(r"^登记到本批")),
            f"登记 PZ {row_label}到三票订单",
        )
        self._expect_success(
            session,
            re.compile(rf"已为\s*3\s*票订单登记.*{re.escape(dialog_label)}"),
            f"PZ {row_label}保存成功提示",
        )
        self.artifacts.completed_tracking_nodes["ltl_batch"].append(code)

    def complete_batch_tracking(self) -> None:
        session = self.batch_operation
        with session.step(
            f"PZ 新整批操作负责人推进 {self.source.batch_number} 实际出境与整批运踪",
            case_id="P3-TRACKING-PZ",
            stage="PZ 实际出境与运踪",
            priority="P0",
            preconditions=("PZ 三票报关均已放行", "PZ OUT 已完成出库交接"),
            inputs={
                "batch_number": self.source.batch_number,
                "dispatch": self.source.dispatches["ltl_batch"],
            },
            expected_result="一次登记同步三票口岸到达和实际出境，再同步海外入境及目的清关",
            gate=_workflow_gate(
                "PZ 实际出境与整批运踪门禁",
                ui="页面按装车、报关、口岸到达、实际出境顺序开放唯一当前操作。",
                server="同一 PZ 原子校验三票出库/放行/前序节点并同步三票轨迹。",
                owner="整批操作负责人",
                source="workflow_instance_module_state",
            ),
        ) as observation:
            self._open_batch(session)
            self._open_batch_tab(session, "口岸到达与实际出境")
            arrived_row = session.page.locator(
                "table.batch-tracking-node-table tbody tr"
            ).filter(has_text="口岸到达")
            if not (self._is_visible(arrived_row) and "全票已登记" in self._locator_text(arrived_row)):
                trigger = session.page.get_by_role(
                    "button", name="登记口岸到达", exact=True
                )
                self._expect_visible_or_block(
                    session,
                    trigger,
                    "PZ 登记口岸到达入口",
                    owner="PZ 运输顺序门禁维护人",
                    remediation="装车和报关完成后应在当前页开放口岸到达。",
                )
                session.click(trigger.first, "打开 PZ 口岸到达登记")
                dialog = session.page.get_by_role(
                    "dialog", name="登记运输节点 · 口岸到达"
                )
                session.expect_visible(dialog, "PZ 口岸到达弹窗")
                form = dialog.locator("form.batch-tracking-modal-form")
                self._fill_batch_tracking_form(
                    session,
                    form,
                    label="口岸到达",
                    offset_minutes=5,
                    location="霍尔果斯口岸",
                )
                session.click(
                    form.get_by_role("button", name=re.compile(r"^登记到本批")),
                    "登记 PZ 三票口岸到达",
                )
                self._expect_success(
                    session, "口岸到达", "PZ 口岸到达保存提示"
                )
            self.artifacts.completed_tracking_nodes["ltl_batch"].append(
                "border_arrived"
            )

            exit_form = session.page.locator("form.batch-inline-exit-form")
            if self._is_visible(exit_form):
                self._fill_if_visible(
                    session,
                    exit_form,
                    "actualExitAt",
                    self._event_time(6),
                    "填写 PZ 实际出境时间",
                )
                exit_port = exit_form.locator('select[name="exitPort"]')
                if self._is_visible(exit_port) and not exit_port.first.input_value().strip():
                    self._select_first_available(
                        session, exit_port, "PZ 实际出境口岸"
                    )
                self._fill_if_visible(
                    session,
                    exit_form,
                    "exitVehiclePlate",
                    f"UI-PZ-{self.entity_prefix[-6:]}",
                    "填写 PZ 实际出境车牌",
                    only_if_empty=True,
                )
                self._fill_if_visible(
                    session,
                    exit_form,
                    "exitNotes",
                    "纯 UI 第三阶段 PZ 实际出境",
                    "填写 PZ 出境备注",
                )
                session.click(
                    exit_form.get_by_role(
                        "button", name="确认实际出境并同步订单"
                    ),
                    "确认 PZ 实际出境",
                )
                self._expect_success(
                    session, "出境确认完成", "PZ 实际出境成功提示"
                )
            else:
                session.expect_visible(
                    session.page.get_by_text("实际出境已确认", exact=False),
                    "PZ 已确认实际出境",
                )
            self.artifacts.completed_tracking_nodes["ltl_batch"].append("exported")

            self._submit_batch_node(
                session,
                code="foreign_entered",
                row_label="海外入境",
                dialog_label="海外入境",
                offset_minutes=7,
                location="境外入境口岸",
            )
            self._submit_batch_node(
                session,
                code="customs_cleared",
                row_label="目的清关",
                dialog_label="目的清关",
                offset_minutes=8,
                location="目的地海关",
            )
            station_row = session.page.locator(
                "table.batch-tracking-node-table tbody tr"
            ).filter(has_text="目的仓到达")
            session.expect_hidden(
                station_row.get_by_role("button", name="登记节点"),
                "PZ 目的仓到达不提供手工登记按钮",
            )
            observation.observe(
                "PZ 三票已同步实际出境、海外入境与目的清关，到仓留给境外仓扫码",
                gate_passed=True,
            )

    def _prepare_overseas_receipt(self, order: Phase3Order, code: str) -> None:
        form = self.overseas_warehouse.page.locator("form.acceptance-workbench")
        self._expect_visible_or_block(
            self.overseas_warehouse,
            form,
            f"{code} 境外仓验收工作台",
            owner="境外目的仓收货维护人",
            remediation="原 OUL 扫描后应调出匹配订单、运单和实收表单。",
        )
        package_type = form.locator('select[name="packageType"]')
        if self._is_visible(package_type) and not package_type.first.input_value().strip():
            self._select_first_available(
                self.overseas_warehouse, package_type, "实际包装类型"
            )
        defaults = {
            "pieces": "1",
            "weight": "100",
            "length": "100",
            "width": "80",
            "height": "60",
        }
        labels = {
            "pieces": "实收件数",
            "weight": "实际重量",
            "length": "实际长度",
            "width": "实际宽度",
            "height": "实际高度",
        }
        for name, value in defaults.items():
            self._fill_if_visible(
                self.overseas_warehouse,
                form,
                name,
                value,
                f"填写{labels[name]}",
                only_if_empty=True,
            )
        location = form.locator('select[name="locationId"]')
        if self._is_visible(location) and not location.first.input_value().strip():
            self._select_first_available(
                self.overseas_warehouse, location, "境外仓入库库位"
            )
        ready = form.locator('input[name="receiptResult"][value="ready"]')
        self.overseas_warehouse.set_checked(ready, True, "本次验收结果：清点无误")
        self._fill_if_visible(
            self.overseas_warehouse,
            form,
            "evidenceNote",
            f"原 OUL {code} 现场核对无误",
            "填写境外收货凭证",
        )
        self._fill_if_visible(
            self.overseas_warehouse,
            form,
            "notes",
            f"纯 UI 第三阶段收货：{order.order_number}",
            "填写境外收货备注",
        )
        self.overseas_warehouse.click(
            form.get_by_role("button", name="确认验收并扫码入库"),
            f"确认 {code} 境外仓入库",
        )

    def complete_overseas_inbound(self) -> None:
        with self.overseas_warehouse.step(
            "境外目的仓逐件扫描四票原 OUL 并完成入库清点",
            case_id="P3-OVERSEAS-INBOUND",
            stage="境外目的仓原码入库",
            priority="P0",
            preconditions=("整车和 PZ 均已实际出境", "全部订单已完成目的地清关节点"),
            inputs={
                "orders": [item.order_number for item in self.source.orders],
                "original_oul_count": len(self.source.all_cargo_codes),
            },
            expected_result="只复用国内仓原 OUL，不生成重复标签；每票清点后推进并通知客户，PZ 三票到齐后整批结束运输",
            gate=_workflow_gate(
                "境外目的仓原 OUL 入库门禁",
                ui="扫描原标签后显示对应订单和实收字段；清点无误后给出明确同步结果。",
                server="校验实际出境、目的清关、目标仓归属和标签上一仓出库状态，再幂等推进订单/PZ。",
                owner="境外目的仓库岗",
                source="system_integrity_invariant",
            ),
        ) as observation:
            self._click_navigation(self.overseas_warehouse, "验收收货")
            for order in self.source.orders:
                for code in order.cargo_codes:
                    scan = self.overseas_warehouse.page.locator(
                        "form.acceptance-scan-form"
                    )
                    self.overseas_warehouse.type_text(
                        scan.locator('input[name="reference"]'),
                        code,
                        f"扫描原 OUL {code}",
                    )
                    self.overseas_warehouse.click(
                        scan.get_by_role("button", name="调出验收信息"),
                        f"调出 {code} 验收信息",
                    )
                    summary = self.overseas_warehouse.page.get_by_role(
                        "region", name="待验收订单摘要"
                    )
                    self._expect_visible_or_block(
                        self.overseas_warehouse,
                        summary.filter(has_text=order.order_number),
                        f"{code} 匹配订单 {order.order_number}",
                        owner="境外仓标签归属维护人",
                        remediation="原 OUL 必须唯一匹配阶段二订单和指定目的仓。",
                    )
                    self._prepare_overseas_receipt(order, code)
                    result = self._expect_success(
                        self.overseas_warehouse,
                        re.compile(rf"境外目的仓收货完成：{re.escape(code)}"),
                        f"{code} 境外入库成功提示",
                    )
                    if order.cargo_codes[-1] == code and order.key == "ftl":
                        if "自动通知客户" not in result:
                            raise BusinessBlocker(
                                "整车全部原码入库后未明确提示客户通知结果",
                                owner="境外仓到仓通知维护人",
                                remediation="每票清点完成时原子推进到 notified 并显示通知结果。",
                            )
                    self.artifacts.inbound_cargo_codes.append(code)
            if self.artifacts.inbound_cargo_codes != list(self.source.all_cargo_codes):
                raise AssertionError("境外入库 OUL 顺序与第二阶段交接不一致")
            self.overseas_warehouse.screenshot("phase3-overseas-inbound-complete")
            observation.observe(
                f"{len(self.artifacts.inbound_cargo_codes)} 个原 OUL 全部入库，四票客户通知已触发",
                gate_passed=True,
            )

    def verify_portal_and_optional_appointment(self) -> None:
        with self.customer.step(
            "新客户核对四票到仓状态并按开放业务完成一次代表性预约",
            case_id="P3-PORTAL-NOTIFY-APPOINT",
            stage="客户通知与可选预约",
            priority="P0",
            preconditions=("四票已由境外目的仓完成清点", "客户门户账号仍严格绑定新客户"),
            inputs={"order_numbers": [item.order_number for item in self.source.orders]},
            expected_result="门户仅显示本客户四票到仓状态；预约入口随业务状态显示且保存后同步仓库",
            gate=_workflow_gate(
                "客户通知与可选提货预约门禁",
                ui="到仓订单显示待自提与预约入口；未开放状态不显示操作。",
                server="客户只能修改自身订单，且仅 notified/appointment 状态允许预约。",
                owner="客户门户维护人",
                configured_mode="optional",
                source="workflow_instance_module_state",
            ),
        ) as observation:
            self.customer.expect_visible(
                self.customer.page.get_by_text(self.source.customer_name, exact=True),
                "客户门户绑定范围",
            )
            self._click_navigation(self.customer, "我的订单")
            appointment_done = False
            for order in self.source.orders:
                filters = self.customer.page.locator("form.order-table-filters")
                self.customer.type_text(
                    filters.locator('input[name="keyword"]'),
                    order.order_number,
                    "输入客户订单号",
                )
                self.customer.click(
                    filters.get_by_role("button", name="筛选"), "筛选客户订单"
                )
                row = self.customer.page.locator("table tbody tr").filter(
                    has_text=order.order_number
                )
                self._expect_visible_or_block(
                    self.customer,
                    row,
                    f"客户门户订单 {order.order_number}",
                    owner="客户数据隔离维护人",
                    remediation="到仓推进后订单必须在原客户门户范围实时可见。",
                )
                if "待自提" not in self._locator_text(row, 5_000):
                    raise BusinessBlocker(
                        f"{order.order_number} 到仓后门户未显示待客户自提",
                        owner="订单状态与客户门户同步维护人",
                        remediation="境外仓到仓后同步 overseas operation 和客户可见状态。",
                    )
                self.customer.expect_visible(
                    row.get_by_role("link", name="查看轨迹"),
                    f"{order.order_number} 客户轨迹入口",
                )
                appointment = row.get_by_role("button", name="预约提货", exact=True)
                if not appointment_done and self._is_visible(appointment):
                    self.customer.click(appointment.first, f"预约 {order.order_number} 提货")
                    dialog = self.customer.page.get_by_role(
                        "dialog", name=f"预约提货时间 · {order.order_number}"
                    )
                    self.customer.expect_visible(dialog, "客户提货预约弹窗")
                    self.customer.type_date(
                        dialog.locator('input[name="appointmentDate"]'),
                        (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d"),
                        "填写预约提货日期",
                    )
                    morning = dialog.locator(
                        'input[name="appointmentPeriod"][value="morning"]'
                    )
                    self.customer.set_checked(morning, True, "选择上午提货")
                    self.customer.click(
                        dialog.get_by_role("button", name="确认预约"),
                        "确认客户提货预约",
                    )
                    self._expect_success(
                        self.customer,
                        re.compile(rf"{re.escape(order.order_number)} 已预约.*仓库已同步"),
                        "客户预约同步成功提示",
                    )
                    self.artifacts.appointed_order = order.order_number
                    appointment_done = True
            if not appointment_done:
                self.customer.record_gate(
                    name="客户预约业务入口",
                    expected="工作流/状态要求预约时显示，否则允许直接现场自提",
                    passed=True,
                    actual="四票当前状态均未要求预约，记录为不适用并继续现场扫码自提",
                    expectation=_workflow_gate(
                        "客户预约业务入口",
                        ui="预约为选办，不应阻断直接现场自提。",
                        server="notified 状态允许预约或直接扫码自提。",
                        owner="客户门户维护人",
                        configured_mode="optional",
                    ),
                    case_id="P3-PORTAL-NOTIFY-APPOINT",
                )
                observation.add_note("预约入口未出现；按选办逻辑继续现场自提。")
            self.customer.screenshot("phase3-customer-orders-ready-for-pickup")
            observation.observe(
                "四票待自提状态与轨迹可见，代表性预约按实际开放情况完成",
                gate_passed=True,
            )

    def complete_pickup_signoff(self) -> None:
        with self.overseas_warehouse.step(
            "境外目的仓逐件扫描原 OUL 并由客户核对确认自提签收",
            case_id="P3-OVERSEAS-PICKUP-SIGN",
            stage="境外仓自提签收",
            priority="P0",
            preconditions=("四票均已到仓并通知客户", "所有原 OUL 当前在目的仓库存"),
            inputs={
                "orders": [item.order_number for item in self.source.orders],
                "original_oul_count": len(self.source.all_cargo_codes),
            },
            expected_result="每票必须逐件扫码并在货物核对弹窗确认，随后完成自提出库与签收并进入费用结算",
            gate=_workflow_gate(
                "境外仓逐件扫码和客户确认收货门禁",
                ui="全部标签扫描前不显示确认收货；齐全后自动弹出逐件核对表。",
                server="仅 notified/appointment、全部标签已扫描且无异常时允许确认签收。",
                owner="境外目的仓库岗",
                source="system_integrity_invariant",
            ),
        ) as observation:
            self._click_navigation(self.overseas_warehouse, "扫码自提签收")
            for order in self.source.orders:
                for index, code in enumerate(order.cargo_codes, start=1):
                    scan = self.overseas_warehouse.page.locator(
                        "form.overseas-pickup-scan-form"
                    )
                    self.overseas_warehouse.type_text(
                        scan.locator('input[name="barcode"]'),
                        code,
                        f"自提扫描原 OUL {code}",
                    )
                    self.overseas_warehouse.click(
                        scan.get_by_role("button", name="确认扫描"),
                        f"确认扫描 {code}",
                    )
                    self.artifacts.pickup_cargo_codes.append(code)
                    if index < len(order.cargo_codes):
                        self._expect_success(
                            self.overseas_warehouse,
                            re.compile(rf"{re.escape(order.order_number)} 已扫描"),
                            f"{order.order_number} 自提扫码进度",
                        )
                dialog = self.overseas_warehouse.page.get_by_role(
                    "dialog",
                    name=f"核对货物并确认收货 · {order.order_number}",
                )
                self._expect_visible_or_block(
                    self.overseas_warehouse,
                    dialog,
                    f"{order.order_number} 全部货物核对弹窗",
                    owner="境外仓自提核对维护人",
                    remediation="全部原 OUL 扫描后必须显示逐件货物核对，不得直接完成签收。",
                )
                dialog_text = self._locator_text(dialog, 20_000)
                missing = [code for code in order.cargo_codes if code not in dialog_text]
                if missing:
                    raise BusinessBlocker(
                        f"{order.order_number} 核对弹窗缺少原 OUL：{'、'.join(missing)}",
                        owner="自提货物完整性维护人",
                        remediation="确认弹窗必须列出本票全部未出库标签。",
                    )
                self.overseas_warehouse.click(
                    dialog.get_by_role("button", name="确认收货"),
                    f"客户确认 {order.order_number} 收货",
                )
                success_dialog = self.overseas_warehouse.page.get_by_role(
                    "dialog", name="出库成功"
                )
                self.overseas_warehouse.expect_visible(
                    success_dialog, f"{order.order_number} 自提出库成功弹窗"
                )
                self.overseas_warehouse.expect_visible(
                    success_dialog.get_by_text(
                        f"{order.order_number} 已完成自提出库", exact=False
                    ),
                    f"{order.order_number} 签收同步结果",
                )
                self.overseas_warehouse.click(
                    success_dialog.get_by_role("button", name="知道了"),
                    "关闭自提出库成功弹窗",
                )
                self.artifacts.signed_orders.append(order.order_number)
            if self.artifacts.pickup_cargo_codes != list(self.source.all_cargo_codes):
                raise AssertionError("自提扫描 OUL 与第二阶段交接不一致")
            self.overseas_warehouse.screenshot("phase3-all-orders-pickup-signed")
            observation.observe(
                f"四票、{len(self.artifacts.pickup_cargo_codes)} 个原 OUL 均完成扫码核对和签收",
                gate_passed=True,
            )

    def run(self) -> Phase3Artifacts:
        self._login(
            self.operation,
            password=self.credentials["operation"].password,
            label="普通订单原操作岗",
        )
        self._login(
            self.batch_operation,
            password=self.credentials[self.source.batch_operation_alias].password,
            label="PZ 新整批操作负责人",
        )
        self._login(
            self.document,
            password=self.credentials["document"].password,
            label="整车原单证岗",
        )
        self._login(
            self.batch_document,
            password=self.credentials[self.source.batch_document_alias].password,
            label="PZ 新整批单证负责人",
        )
        self._login(
            self.overseas_warehouse,
            password=self.credentials["overseas_warehouse"].password,
            label="境外目的仓库岗",
        )
        self._login(
            self.customer,
            password=self.credentials["customer"].password,
            label="新建客户门户账号",
        )
        self.assert_customs_permission_alignment()
        self.complete_ftl_customs()
        self.complete_batch_customs()
        self.complete_ftl_tracking()
        self.complete_batch_tracking()
        self.complete_overseas_inbound()
        self.verify_portal_and_optional_appointment()
        self.complete_pickup_signoff()
        self.harness.assert_certifiable()
        return self.artifacts


def _redact_reason(
    reason: str,
    records: Sequence[CredentialRecord],
    *,
    portal_email: str = "",
) -> str:
    safe = reason
    secrets = [item.email for item in records] + [item.password for item in records]
    if portal_email:
        secrets.append(portal_email)
    for value in sorted((item for item in secrets if item), key=len, reverse=True):
        safe = safe.replace(value, "<redacted>")
    return safe[:2_000]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="纯 UI 接续第二阶段：报关放行 → 实际出境/运踪 → 境外入库 → 自提签收。"
    )
    parser.add_argument("--phase2-summary", type=Path, required=True)
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
        help="显式允许通过可见 UI 接续业务数据；未传入时仅做无写入预检。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    source = load_phase2_handoff(args.phase2_summary)
    vault = load_credentials(args.credentials_file)
    required = vault.select(REQUIRED_ACCOUNT_ALIASES)
    preflight = _public_preflight(
        vault,
        source,
        base_url=args.base_url,
        fixture_file=args.fixture_file,
    )
    if not args.execute:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0

    credentials = build_pz_runtime_credentials(vault)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    nonce = uuid.uuid4().hex[:8]
    run_id = f"phase3-{safe_artifact_name(source.source_run_id)}-{stamp}-{nonce}"
    output_dir = args.output_root.resolve() / "phase3-resume" / run_id
    status = "failed"
    reason = ""
    summary_path: Path | None = None
    artifacts = Phase3Artifacts()
    portal_email = portal_email_from_entity_prefix(source.source_phase1_entity_prefix)

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
                scenario_name="1 FTL + 3 LTL 全流程第三阶段：报关、出境、境外仓与自提签收",
            )
            flow = Phase3Flow(
                harness=harness,
                credentials=credentials,
                source=source,
                fixture_file=args.fixture_file,
                entity_prefix=f"P3-{stamp}-{nonce.upper()}",
            )
            try:
                artifacts = flow.run()
                status = "passed"
            except BusinessBlocker as error:
                artifacts = flow.artifacts
                status = "blocked"
                reason = f"{error}；责任方：{error.owner}；建议：{error.remediation}"
                harness.journal.add_note(reason)
            except Exception as error:
                artifacts = flow.artifacts
                status = "failed"
                reason = f"{type(error).__name__}: {error}"
                harness.journal.add_note("未预期异常：" + reason)
            finally:
                for key, value in artifacts.customs_declarations.items():
                    harness.journal.register_entity("customs_declaration", key, value)
                for key, values in artifacts.completed_tracking_nodes.items():
                    if values:
                        harness.journal.register_entity(
                            "tracking_nodes", key, ",".join(values)
                        )
                for index, number in enumerate(artifacts.signed_orders, start=1):
                    harness.journal.register_entity("pickup_signed_order", str(index), number)
                reason = _redact_reason(
                    reason, tuple(credentials.values()), portal_email=portal_email
                )
                summary_path = harness.close(status=status)  # type: ignore[arg-type]
                if harness.last_status != status:
                    status = str(harness.last_status)
                    if not reason:
                        reason = harness.finalization_error or "步骤、门禁或证据汇总未通过"
    except Exception as error:
        status = "failed"
        reason = _redact_reason(
            f"{type(error).__name__}: {error}",
            tuple(credentials.values()),
            portal_email=portal_email,
        )

    handoff = build_handoff_payload(
        source, artifacts, ready_for_phase4=status == "passed"
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
