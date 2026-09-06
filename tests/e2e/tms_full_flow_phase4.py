#!/usr/bin/env python3
"""International TMS 纯 UI 全流程执行器：第四阶段。

本阶段只承接第三阶段已经完成境外仓扫码自提签收的四票数据：

1. 客服核对或补齐工作流要求的费用，并完成客服费用确认；
2. 业务员完成本人订单的业务费用审核；
3. 财务完成费用审核、对账、发票记录和结算文件审核；
4. 出纳登记真实收付款流水并按对账单核销；
5. 仓库仅在存在目标订单未结异常时，通过异常工作台办理结案；
6. 财务按当前工作流实例显示的复盘字段生成复盘并确认订单归档。

脚本只通过 ``RoleBrowserSession`` 记录的可见控件、键盘、鼠标和原生文件
选择器完成业务写入。它不访问数据库或 HTTP API，不执行 JavaScript，不注入
DOM/Cookie/localStorage，不使用正向深链，也不直接给文件 input 赋值。费用、
结算、文件、异常和复盘门禁均以页面当前工作流实例的实时显示为准；隐藏字段
不会被写死为必办。默认只输出 ``READY_NOT_EXECUTED``，只有显式传入
``--execute`` 才会接续既有业务数据。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
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


ORDER_KEYS = ("ftl", "ltl1", "ltl2", "ltl3")
LTL_KEYS = ("ltl1", "ltl2", "ltl3")
REQUIRED_ACCOUNT_ALIASES = ("customer_service", "sales", "finance", "cashier")
OPTIONAL_WAREHOUSE_ALIASES = ("domestic_warehouse", "overseas_warehouse")
PHASE4_STAGE_ORDER = (
    "warehouse_difference_confirmation",
    "customer_service_expense_confirmation",
    "business_expense_review",
    "finance_expense_review",
    "reconciliation_and_invoice",
    "settlement_evidence",
    "cash_and_writeoff",
    "exception_closure",
    "completion_review_and_archive",
)
PHASE3_HANDOFF_SCHEMA = "international-tms-full-flow-phase3-handoff/v1"
HANDOFF_SCHEMA = "international-tms-full-flow-phase4-handoff/v1"
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

ORDER_NUMBER_RE = re.compile(r"^SO[0-9A-Z-]{6,}$", re.I)
PZ_NUMBER_RE = re.compile(r"^PZ-[0-9A-Z-]{4,}$", re.I)
OUT_NUMBER_RE = re.compile(r"^OUT-[0-9A-Z-]{4,}$", re.I)
OUL_NUMBER_RE = re.compile(r"^OUL-[0-9A-Z-]+$", re.I)
TRACKING_NODE_ORDER = (
    "border_arrived",
    "exported",
    "foreign_entered",
    "customs_cleared",
)
RECONCILIATION_NUMBER_RE = re.compile(r"\b(?:REC|PAY)[0-9A-Z]{8,}\b", re.I)
INVOICE_RECORD_RE = re.compile(r"\bTAX[0-9A-Z]{8,}\b", re.I)
CASH_TRANSACTION_RE = re.compile(r"\bCASH[0-9A-Z]{8,}\b", re.I)
ERROR_PAGE_RE = re.compile(
    r"请求失败|SYSTEM RECOVERY|Forbidden|Internal Server Error|请求失败\s*\(403\)",
    re.I,
)

FIELD_LABELS = {
    "receivable_expenses": "应收费用",
    "payable_expenses": "应付费用",
    "customer_service_confirmation": "客服费用确认",
    "business_review": "业务审核",
    "finance_review": "财务审核",
    "reconciliation_statement": "对账单",
    "invoice_records": "开票/收票记录",
    "cash_records": "收付款流水",
    "writeoff_records": "核销记录",
    "document_billing_statement": "账单",
    "document_payment_receipt": "收款凭证",
}


class BusinessBlocker(RuntimeError):
    """A visible workflow, permission, master-data or state gate."""

    def __init__(self, message: str, *, owner: str, remediation: str) -> None:
        super().__init__(message)
        self.owner = owner
        self.remediation = remediation


@dataclass(frozen=True, slots=True)
class Phase3Order:
    order_number: str
    business_type: str
    expected_pieces: int
    cargo_codes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Phase3Handoff:
    source_run_id: str
    source_phase2_run_id: str
    source_phase1_run_id: str
    source_phase1_entity_prefix: str
    customer_name: str
    orders: dict[str, Phase3Order]
    transport_batch_number: str
    transport_batch_order_keys: tuple[str, ...]
    transport_batch_order_numbers: tuple[str, ...]
    dispatches: dict[str, str]
    oul_numbers: dict[str, tuple[str, ...]]
    customs_declarations: dict[str, str]
    tracking_nodes: dict[str, tuple[str, ...]]
    overseas_inbound: tuple[str, ...]
    pickup_cargo_codes: tuple[str, ...]
    appointed_order: str
    pickup_signed_orders: tuple[str, ...]
    certification_lineage: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class WorkflowFieldObservation:
    field_key: str
    label: str
    active: bool
    required: bool
    present: bool

    @property
    def configured_mode(self) -> str:
        if not self.active:
            return "hidden"
        return "required" if self.required else "optional"


@dataclass(slots=True)
class ReconciliationArtifact:
    document_number: str
    direction: str
    order_keys: list[str] = field(default_factory=list)
    invoice_record_number: str = ""
    invoice_number: str = ""
    cash_transaction_number: str = ""
    settled: bool = False


@dataclass(slots=True)
class Phase4Artifacts:
    workflow_gates: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    reconciliations: dict[str, ReconciliationArtifact] = field(default_factory=dict)
    document_evidence: dict[str, list[str]] = field(
        default_factory=lambda: {key: [] for key in ORDER_KEYS}
    )
    closed_exceptions: list[str] = field(default_factory=list)
    archived_orders: list[str] = field(default_factory=list)


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} 必须是 JSON 对象")
    return value


def _string_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(str(item).strip() for item in value if str(item).strip())


def _required_string_list(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError(f"{label} 必须是数组")
    result = tuple(str(item).strip() for item in value)
    if not result or any(not item for item in result):
        raise ValueError(f"{label} 缺失或包含空值")
    return result


def _oul_codes(value: object, label: str) -> tuple[str, ...]:
    result = tuple(item.upper() for item in _required_string_list(value, label))
    if any(not OUL_NUMBER_RE.fullmatch(item) for item in result):
        raise ValueError(f"{label} 包含无效 OUL 货物码")
    if len(set(result)) != len(result):
        raise ValueError(f"{label} 包含重复 OUL 货物码")
    return result


def _expected_pieces(value: object, label: str) -> int:
    rendered = str(value).strip()
    if isinstance(value, bool) or not re.fullmatch(r"[1-9]\d*", rendered):
        raise ValueError(f"{label} 缺失或不是正整数")
    return int(rendered)


def _dispatch_number(value: object) -> str:
    if isinstance(value, Mapping):
        return str(value.get("dispatch_number", "")).strip()
    return str(value or "").strip()


def load_phase3_handoff(path: Path | str) -> Phase3Handoff:
    """Read a Phase 3 harness summary or CLI result envelope."""

    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"第三阶段结果文件不存在：{source}")
    payload = _mapping(json.loads(source.read_text(encoding="utf-8-sig")), "第三阶段结果")
    evidence = require_certified_summary(
        payload,
        source=source,
        label="第三阶段",
    )
    source_run_id = str(evidence.get("run_id", "")).strip()
    if not source_run_id:
        raise ValueError("第三阶段结果缺少 run_id")
    envelope_run_id = str(payload.get("run_id", "")).strip()
    if envelope_run_id and envelope_run_id != source_run_id:
        raise ValueError("第三阶段结果 envelope.run_id 与 summary.run_id 不一致")
    raw_handoff = evidence.get("handoff")
    handoff = _mapping(raw_handoff, "handoff")
    if str(handoff.get("schema", "")).strip() != PHASE3_HANDOFF_SCHEMA:
        raise ValueError("第三阶段 handoff schema 不受支持")
    if handoff.get("ready_for_phase4") is not True:
        raise ValueError("第三阶段尚未声明 ready_for_phase4")
    completed_stages = tuple(str(item) for item in handoff.get("completed_stages", ()))
    if completed_stages != PHASE3_STAGE_ORDER:
        raise ValueError("第三阶段 completed_stages 不完整或顺序不一致")

    raw_orders = _mapping(handoff.get("orders"), "handoff.orders")
    orders: dict[str, Phase3Order] = {}
    for key in ORDER_KEYS:
        raw_order = _mapping(raw_orders.get(key), f"handoff.orders.{key}")
        number = str(raw_order.get("order_number", "")).strip().upper()
        business_type = str(raw_order.get("business_type", "")).strip().lower()
        expected_type = "ftl" if key == "ftl" else "ltl"
        if not ORDER_NUMBER_RE.fullmatch(number):
            raise ValueError(f"第三阶段订单 {key} 缺失或格式无效")
        if business_type != expected_type:
            raise ValueError(f"第三阶段订单 {key} 类型应为 {expected_type}")
        expected_pieces = _expected_pieces(
            raw_order.get("expected_pieces"),
            f"第三阶段订单 {key} expected_pieces",
        )
        cargo_codes = _oul_codes(
            raw_order.get("cargo_codes"), f"第三阶段订单 {key} cargo_codes"
        )
        if len(cargo_codes) != expected_pieces:
            raise ValueError(
                f"第三阶段订单 {key} OUL 数量与预计件数不一致："
                f"expected_pieces={expected_pieces}，OUL={len(cargo_codes)}"
            )
        orders[key] = Phase3Order(
            order_number=number,
            business_type=business_type,
            expected_pieces=expected_pieces,
            cargo_codes=cargo_codes,
        )
    if len({item.order_number for item in orders.values()}) != len(ORDER_KEYS):
        raise ValueError("第三阶段的四个订单号必须互不相同")
    all_order_codes = tuple(
        code for key in ORDER_KEYS for code in orders[key].cargo_codes
    )
    if len(set(all_order_codes)) != len(all_order_codes):
        raise ValueError("第三阶段不同订单之间不能复用同一 OUL 货物码")

    customer = _mapping(handoff.get("customer"), "handoff.customer")
    customer_name = str(customer.get("name", "")).strip()
    if not customer_name:
        raise ValueError("第三阶段交接缺少客户名称")
    batch = _mapping(handoff.get("transport_batch"), "handoff.transport_batch")
    batch_number = str(batch.get("batch_number", "")).strip().upper()
    if not PZ_NUMBER_RE.fullmatch(batch_number):
        raise ValueError("第三阶段结果缺少有效 PZ 配载单号")
    batch_order_keys = _required_string_list(
        batch.get("order_keys"), "handoff.transport_batch.order_keys"
    )
    batch_order_numbers = tuple(
        item.upper()
        for item in _required_string_list(
            batch.get("order_numbers"), "handoff.transport_batch.order_numbers"
        )
    )
    if batch_order_keys != LTL_KEYS:
        raise ValueError("第三阶段 PZ 配载范围必须严格包含 ltl1、ltl2、ltl3")
    expected_batch_numbers = tuple(orders[key].order_number for key in LTL_KEYS)
    if batch_order_numbers != expected_batch_numbers:
        raise ValueError("第三阶段 PZ 挂载订单号与 orders 交接不一致")
    dispatch_payload = _mapping(handoff.get("dispatches"), "handoff.dispatches")
    dispatches = {
        "ftl": _dispatch_number(dispatch_payload.get("ftl")).upper(),
        "ltl_batch": _dispatch_number(dispatch_payload.get("ltl_batch")).upper(),
    }
    if any(not OUT_NUMBER_RE.fullmatch(value) for value in dispatches.values()):
        raise ValueError("第三阶段交接缺少有效装车任务号")
    if len(set(dispatches.values())) != len(dispatches):
        raise ValueError("第三阶段整车与 PZ 装车任务号必须互不相同")
    signed = tuple(
        item.upper()
        for item in _required_string_list(
            handoff.get("pickup_signed_orders"), "handoff.pickup_signed_orders"
        )
    )
    expected_signed = tuple(orders[key].order_number for key in ORDER_KEYS)
    if signed != expected_signed:
        raise ValueError("第三阶段必须完成四票境外仓扫码自提签收")

    raw_oul = handoff.get("oul_numbers")
    oul_payload = _mapping(raw_oul, "handoff.oul_numbers")
    oul_numbers: dict[str, tuple[str, ...]] = {}
    for key in ORDER_KEYS:
        codes = _oul_codes(oul_payload.get(key), f"handoff.oul_numbers.{key}")
        if codes != orders[key].cargo_codes:
            raise ValueError(f"第三阶段订单 {key} 的 OUL 汇总与 cargo_codes 不一致")
        oul_numbers[key] = codes

    customs_payload = _mapping(
        handoff.get("customs_declarations"), "handoff.customs_declarations"
    )
    if set(customs_payload) != set(ORDER_KEYS):
        raise ValueError("第三阶段四票报关单交接键不完整")
    customs_declarations = {
        key: str(customs_payload.get(key, "")).strip() for key in ORDER_KEYS
    }
    if any(not value for value in customs_declarations.values()):
        raise ValueError("第三阶段四票报关单号必须全部非空")
    if len(set(customs_declarations.values())) != len(ORDER_KEYS):
        raise ValueError("第三阶段四票报关单号必须互不相同")

    tracking_payload = _mapping(
        handoff.get("tracking_nodes"), "handoff.tracking_nodes"
    )
    if set(tracking_payload) != {"ftl", "ltl_batch"}:
        raise ValueError("第三阶段运踪交接必须严格包含 ftl 与 ltl_batch")
    tracking_nodes = {
        key: _required_string_list(
            tracking_payload.get(key), f"handoff.tracking_nodes.{key}"
        )
        for key in ("ftl", "ltl_batch")
    }
    if any(nodes != TRACKING_NODE_ORDER for nodes in tracking_nodes.values()):
        raise ValueError("第三阶段整车与 PZ 必经运踪节点不完整或顺序不一致")

    overseas_inbound = _oul_codes(
        handoff.get("overseas_inbound"), "handoff.overseas_inbound"
    )
    if overseas_inbound != all_order_codes:
        raise ValueError("第三阶段境外入库 OUL 与订单交接不一致")
    pickup_cargo_codes = _oul_codes(
        handoff.get("pickup_cargo_codes"), "handoff.pickup_cargo_codes"
    )
    if pickup_cargo_codes != all_order_codes:
        raise ValueError("第三阶段自提扫码 OUL 与订单交接不一致")
    appointed_order = str(handoff.get("appointed_order", "")).strip().upper()
    if appointed_order and appointed_order not in expected_signed:
        raise ValueError("第三阶段预约订单不属于本轮四票订单")

    source_phase2_run_id = str(handoff.get("source_phase2_run_id", "")).strip()
    source_phase1_run_id = str(handoff.get("source_phase1_run_id", "")).strip()
    if not source_phase2_run_id or not source_phase1_run_id:
        raise ValueError("第三阶段交接缺少 Phase 1/2 run_id")
    lineage = _mapping(
        handoff.get("certification_lineage"), "handoff.certification_lineage"
    )
    if (
        lineage.get("mode") != "fresh-from-phase1"
        or lineage.get("fresh_phase1_attempt") is not True
        or lineage.get("recovery_branches_used") is not False
    ):
        raise ValueError("第三阶段认证链路不是无恢复分支的 Phase 1 fresh attempt")
    if str(lineage.get("root_phase1_run_id", "")).strip() != source_phase1_run_id:
        raise ValueError("第三阶段认证链路的 Phase 1 run_id 不一致")
    if str(lineage.get("source_phase2_run_id", "")).strip() != source_phase2_run_id:
        raise ValueError("第三阶段认证链路的 Phase 2 run_id 不一致")
    root_entity_prefix = str(lineage.get("root_entity_prefix", "")).strip()
    if not root_entity_prefix:
        raise ValueError("第三阶段认证链路缺少 fresh entity_prefix")
    explicit_entity_prefix = str(
        handoff.get("source_phase1_entity_prefix", "")
    ).strip()
    if explicit_entity_prefix and explicit_entity_prefix != root_entity_prefix:
        raise ValueError("第三阶段交接的 Phase 1 entity_prefix 与认证链路不一致")

    return Phase3Handoff(
        source_run_id=source_run_id,
        source_phase2_run_id=source_phase2_run_id,
        source_phase1_run_id=source_phase1_run_id,
        source_phase1_entity_prefix=root_entity_prefix,
        customer_name=customer_name,
        orders=orders,
        transport_batch_number=batch_number,
        transport_batch_order_keys=batch_order_keys,
        transport_batch_order_numbers=batch_order_numbers,
        dispatches=dispatches,
        oul_numbers=oul_numbers,
        customs_declarations=customs_declarations,
        tracking_nodes=tracking_nodes,
        overseas_inbound=overseas_inbound,
        pickup_cargo_codes=pickup_cargo_codes,
        appointed_order=appointed_order,
        pickup_signed_orders=signed,
        certification_lineage=dict(lineage),
    )


def workflow_action_required(
    snapshot: Mapping[str, WorkflowFieldObservation], field_key: str
) -> bool:
    observation = snapshot.get(field_key)
    return bool(observation and observation.active and observation.required)


def build_handoff_payload(
    phase3: Phase3Handoff,
    artifacts: Phase4Artifacts,
    *,
    ready_for_final_acceptance: bool,
) -> dict[str, Any]:
    if ready_for_final_acceptance and not phase3.certification_lineage:
        raise ValueError("最终认证交接缺少 Phase 1 fresh attempt 认证链路")
    orders = {
        key: {
            "order_number": item.order_number,
            "business_type": item.business_type,
            "expected_pieces": item.expected_pieces,
            "cargo_codes": list(item.cargo_codes),
        }
        for key, item in phase3.orders.items()
    }
    reconciliations = [
        {
            "document_number": item.document_number,
            "direction": item.direction,
            "order_keys": list(item.order_keys),
            "invoice_record_number": item.invoice_record_number,
            "invoice_number": item.invoice_number,
            "cash_transaction_number": item.cash_transaction_number,
            "settled": item.settled,
        }
        for item in artifacts.reconciliations.values()
    ]
    lineage = dict(phase3.certification_lineage)
    lineage["source_phase3_run_id"] = phase3.source_run_id
    return {
        "schema": HANDOFF_SCHEMA,
        "source_phase3_run_id": phase3.source_run_id,
        "source_phase2_run_id": phase3.source_phase2_run_id,
        "source_phase1_run_id": phase3.source_phase1_run_id,
        "source_phase1_entity_prefix": phase3.source_phase1_entity_prefix,
        "customer": {"name": phase3.customer_name},
        "orders": orders,
        "transport_batch": {
            "batch_number": phase3.transport_batch_number,
            "order_keys": list(phase3.transport_batch_order_keys),
            "order_numbers": list(phase3.transport_batch_order_numbers),
        },
        "dispatches": dict(phase3.dispatches),
        "certification_lineage": lineage,
        "oul_numbers": {
            key: list(values) for key, values in phase3.oul_numbers.items()
        },
        "customs_declarations": dict(phase3.customs_declarations),
        "tracking_nodes": {
            key: list(values) for key, values in phase3.tracking_nodes.items()
        },
        "overseas_inbound": list(phase3.overseas_inbound),
        "pickup_cargo_codes": list(phase3.pickup_cargo_codes),
        "appointed_order": phase3.appointed_order,
        "pickup_signed_orders": list(phase3.pickup_signed_orders),
        "workflow_gates": artifacts.workflow_gates,
        "reconciliations": reconciliations,
        "document_evidence": {
            key: list(values) for key, values in artifacts.document_evidence.items()
        },
        "closed_exceptions": list(artifacts.closed_exceptions),
        "archived_orders": list(artifacts.archived_orders),
        "completed_stages": list(PHASE4_STAGE_ORDER)
        if ready_for_final_acceptance
        else [],
        "ready_for_final_acceptance": ready_for_final_acceptance,
    }


def augment_summary(path: Path | str, handoff: Mapping[str, Any]) -> Path:
    destination = Path(path).resolve()
    payload = _mapping(json.loads(destination.read_text(encoding="utf-8-sig")), "summary")
    updated = dict(payload)
    updated["handoff"] = dict(handoff)
    temporary = destination.with_name(".phase4-summary.json.tmp")
    temporary.write_text(
        json.dumps(updated, ensure_ascii=False, indent=2), encoding="utf-8-sig"
    )
    temporary.replace(destination)
    return destination


def _public_preflight(
    vault: CredentialVault,
    phase3: Phase3Handoff,
    *,
    base_url: str,
    fixture_file: Path | str,
) -> dict[str, Any]:
    selected = vault.select(REQUIRED_ACCOUNT_ALIASES)
    fixture = Path(fixture_file).resolve()
    if not fixture.is_file():
        raise FileNotFoundError(f"原生文件选择器测试附件不存在：{fixture}")
    optional = [
        item.public_summary()
        for item in vault.records
        if item.alias in OPTIONAL_WAREHOUSE_ALIASES
    ]
    return {
        "status": "READY_NOT_EXECUTED",
        "business_writes": False,
        "base_url": base_url.rstrip("/"),
        "source_phase3_run_id": phase3.source_run_id,
        "orders": {
            key: item.order_number for key, item in phase3.orders.items()
        },
        "expected_pieces": {
            key: item.expected_pieces for key, item in phase3.orders.items()
        },
        "required_roles": [item.public_summary() for item in selected],
        "optional_exception_roles": optional,
        "stage_order": list(PHASE4_STAGE_ORDER),
        "file_chooser_fixture": fixture.name,
        "workflow_gate_policy": "仅办理页面当前显示且标记为必办的业务动作；隐藏项不构造、不提交、不阻断。",
        "next_action": "仅在服务、Phase 3 summary 和岗位账号确认无误后显式传入 --execute。",
    }


def _workflow_gate(
    name: str,
    *,
    mode: str,
    ui: str,
    server: str,
    owner: str,
    source: str = "workflow_instance_field_configuration",
) -> GateExpectation:
    return GateExpectation(
        name=name,
        source=source,  # type: ignore[arg-type]
        configured_mode=mode,  # type: ignore[arg-type]
        expected_behavior="allow" if mode != "hidden" else "hide",
        ui_expectation=ui,
        server_expectation=server,
        owner_role=owner,
        remediation="核对当前订单工作流实例字段模式、模块状态、页面提示和服务端校验是否读取同一配置。",
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
        remediation="核对岗位权限、订单数据范围和任务分配的具体个人账号。",
    )


class Phase4Flow:
    """Visible-browser continuation from settlement to final archive."""

    def __init__(
        self,
        *,
        harness: TmsUIHarness,
        credentials: Mapping[str, CredentialRecord],
        phase3: Phase3Handoff,
        fixture_file: Path,
    ) -> None:
        self.harness = harness
        self.credentials = credentials
        self.phase3 = phase3
        self.fixture_file = fixture_file.resolve()
        self.artifacts = Phase4Artifacts()
        self._generated_reconciliation_orders: set[str] = set()
        self.customer_service = self._add_role("customer_service")
        self.sales = self._add_role("sales")
        self.finance = self._add_role("finance")
        self.cashier = self._add_role("cashier")
        self.warehouse_sessions: list[RoleBrowserSession] = []
        for alias in OPTIONAL_WAREHOUSE_ALIASES:
            if alias in credentials:
                self.warehouse_sessions.append(self._add_role(alias))
        for key, item in phase3.orders.items():
            self.harness.journal.register_entity("order", key, item.order_number)
            if item.cargo_codes:
                self.harness.journal.register_entity(
                    "cargo_codes", key, ",".join(item.cargo_codes)
                )
        self.harness.journal.register_entity(
            "transport_batch", "ltl", phase3.transport_batch_number
        )
        if phase3.customer_name:
            self.harness.journal.register_entity(
                "customer", "primary", phase3.customer_name
            )

    def _add_role(self, alias: str) -> RoleBrowserSession:
        credential = self.credentials[alias]
        return self.harness.add_role(alias, credential.email, credential.site)

    @staticmethod
    def _is_visible(locator: Locator) -> bool:
        return locator.count() > 0 and locator.first.is_visible()

    @staticmethod
    def _text(locator: Locator, limit: int = 6_000) -> str:
        if locator.count() == 0:
            return ""
        try:
            return locator.first.inner_text(timeout=3_000).strip()[:limit]
        except Exception:
            return ""

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
            body = self._text(session.page.locator("body"), 14_000)
            if ERROR_PAGE_RE.search(body):
                self._assert_no_error_page(session)
            raise BusinessBlocker(
                f"{target}未出现",
                owner=owner,
                remediation=remediation,
            ) from original

    def _assert_no_error_page(self, session: RoleBrowserSession) -> None:
        body = self._text(session.page.locator("body"), 14_000)
        if ERROR_PAGE_RE.search(body):
            raise BusinessBlocker(
                f"{session.role} 页面出现 403/500 恢复页：{body[:500]}",
                owner="权限与路由维护人",
                remediation="核对菜单可见权限与目标 loader/action 的服务端权限是否一致。",
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
            remediation="检查必读通知确认状态是否按当前用户持久化。",
        )

    def _login(self, session: RoleBrowserSession, label: str) -> None:
        credential = self.credentials[session.role]
        with session.step(
            f"{label}从独立登录页进入工作台",
            case_id=f"P4-LOGIN-{session.role.upper().replace('_', '-')}",
            stage="账号与权限",
            priority="P0",
            preconditions=("账号来自独立凭据文件", "浏览器上下文不共享会话"),
            inputs={"account_email": credential.email, "site": credential.site},
            expected_result=f"{label}登录成功，菜单权限与服务端权限一致",
            gate=_permission_gate(
                f"{label}登录与工作台权限",
                ui="只显示当前岗位能够查看和办理的菜单。",
                server="同一岗位和数据范围的页面 loader/action 被允许。",
                owner=label,
            ),
            sensitive=True,
        ) as observation:
            session.login(credential.password)
            self._dismiss_required_notifications(session)
            self._assert_no_error_page(session)
            observation.observe(f"{label}登录成功", gate_passed=True)
        session.start_trace("phase4-visible-actions")

    def _click_navigation(self, session: RoleBrowserSession, label: str) -> None:
        navigations = (
            session.page.get_by_role("navigation", name="运营管理导航"),
            session.page.get_by_role("navigation", name="仓库作业导航"),
        )
        link = next(
            (
                navigation.get_by_role("link", name=label, exact=True)
                for navigation in navigations
                if self._is_visible(
                    navigation.get_by_role("link", name=label, exact=True)
                )
            ),
            session.page.get_by_role("link", name=label, exact=True),
        )
        if not self._is_visible(link):
            raise BusinessBlocker(
                f"{session.role} 工作台没有显示“{label}”菜单",
                owner="角色权限管理员",
                remediation=f"核对 {session.role} 的菜单权限和“{label}”页面授权。",
            )
        session.click(link.first, f"导航到{label}")
        session.page.wait_for_timeout(180)
        self._dismiss_required_notifications(session)
        self._assert_no_error_page(session)

    def _open_order(self, session: RoleBrowserSession, order_number: str) -> None:
        self._click_navigation(session, "运输订单")
        tabs = session.page.get_by_role("navigation", name="普通订单与配载订单分类")
        if self._is_visible(tabs):
            ordinary = tabs.get_by_role("link", name=re.compile(r"^普通订单\b"))
            if self._is_visible(ordinary):
                session.click(ordinary.first, "切换普通订单")
        filters = session.page.locator("form.order-table-filters")
        self._expect_visible_or_block(
            session,
            filters,
            "普通订单筛选表单",
            owner="订单列表维护人",
            remediation="核对普通订单页签、岗位范围和列表筛选组件。",
        )
        session.type_text(
            filters.locator('input[name="keyword"]'), order_number, f"筛选订单 {order_number}"
        )
        session.click(filters.get_by_role("button", name="筛选", exact=True), "提交订单筛选")
        session.page.wait_for_timeout(180)
        row = session.page.locator(".order-table-panel tbody tr").filter(
            has_text=order_number
        )
        self._expect_visible_or_block(
            session,
            row,
            f"{session.role} 普通订单 {order_number}",
            owner="订单范围与任务分配维护人",
            remediation="核对 Phase 3 是否已结束 PZ 自提、订单是否回到普通订单表及当前账号的数据范围。",
        )
        action = row.first.get_by_role(
            "link", name=re.compile(r"^(办理当前节点|查看订单)$")
        )
        self._expect_visible_or_block(
            session,
            action,
            f"{order_number} 查看/办理入口",
            owner="订单列表维护人",
            remediation="确保订单行使用统一的可见详情入口。",
        )
        session.click(action.first, f"打开订单 {order_number}")
        heading = session.page.get_by_role("heading", name=order_number, exact=True)
        session.expect_visible(heading, f"{order_number} 订单详情标题")
        self._assert_no_error_page(session)

    def _click_business_tab(self, session: RoleBrowserSession, label: str) -> bool:
        tabs = session.page.get_by_role("navigation", name="本节点业务分区")
        if not self._is_visible(tabs):
            return False
        link = tabs.get_by_role("link", name=re.compile(rf"^{re.escape(label)}(?:\s|$)"))
        if not self._is_visible(link):
            return False
        session.click(link.first, f"切换本节点{label}分区")
        active = tabs.locator('a[aria-current="page"]').filter(has_text=label)
        self._expect_visible_or_block(
            session,
            active,
            f"本节点{label}活动页签",
            owner="订单同级页签维护人",
            remediation="等待页签视图切换与 URL 同步完成后再读取目标业务表单。",
        )
        self._assert_no_error_page(session)
        return True

    def _open_costs(self, session: RoleBrowserSession, order_number: str, section: str) -> None:
        self._open_order(session, order_number)
        if self._click_business_tab(session, section):
            return
        settlement_step = session.page.get_by_role(
            "navigation", name="订单工作流"
        ).get_by_role("link", name=re.compile(r"对账结算$"))
        if self._is_visible(settlement_step):
            session.click(settlement_step.first, "打开已完成的对账结算节点")
            session.expect_visible(
                session.page.get_by_role("heading", name="对账结算", exact=True),
                "对账结算历史节点标题",
            )
            self._assert_no_error_page(session)
            if self._click_business_tab(session, section):
                return
        if not self._click_business_tab(session, section):
            body = self._text(session.page.locator("body"), 10_000)
            if "订单已归档" in body or "订单已完成" in body:
                return
            raise BusinessBlocker(
                f"订单 {order_number} 当前节点未显示费用“{section}”分区",
                owner="工作流配置维护人",
                remediation="核对订单是否处于对账结算节点，以及 costs 模块是否在当前实例启用。",
            )

    def _read_workflow_snapshot(
        self, session: RoleBrowserSession
    ) -> dict[str, WorkflowFieldObservation]:
        result: dict[str, WorkflowFieldObservation] = {}
        cells = session.page.locator(".workflow-field-checklist .workflow-requirement-cell")
        for index in range(cells.count()):
            cell = cells.nth(index)
            if not cell.is_visible():
                continue
            label = self._text(cell.locator("span").first, 300).replace("*", "").strip()
            href = str(cell.get_attribute("href") or "")
            field_key = ""
            marker = "#workflow-field-"
            if marker in href:
                field_key = href.split(marker, 1)[1].split("?", 1)[0]
            if not field_key:
                field_key = next(
                    (key for key, value in FIELD_LABELS.items() if value == label), ""
                )
            if not field_key:
                continue
            classes = str(cell.get_attribute("class") or "")
            result[field_key] = WorkflowFieldObservation(
                field_key=field_key,
                label=label or FIELD_LABELS.get(field_key, field_key),
                active=True,
                required=cell.locator(".required-mark").count() > 0,
                present="ready" in classes and "missing" not in classes,
            )
        blocker_parts: list[str] = []
        for selector in (
            ".gate",
            ".current-summary .danger",
            ".costs-review-entry.pending",
            ".review-blocker-list",
        ):
            candidates = session.page.locator(selector)
            for index in range(candidates.count()):
                candidate = candidates.nth(index)
                if candidate.is_visible():
                    blocker_parts.append(self._text(candidate, 3_000))
        blocker_text = "；".join(blocker_parts)

        # Catalog-backed fields are implemented by native workbenches and are
        # intentionally omitted from WorkflowFieldChecklist.  Read their
        # visible status cards and the current module blocking reason instead
        # of assuming catalog defaults.
        for direction, field_key, title in (
            ("receivable", "receivable_expenses", "应收费用台账"),
            ("payable", "payable_expenses", "应付费用台账"),
        ):
            section = session.page.locator(".module-business-section").filter(
                has_text=title
            ).first
            if not self._is_visible(section):
                continue
            table_text = self._text(section.locator(".expense-ledger-table tbody"), 5_000)
            present = bool(table_text) and "暂无" not in table_text
            label = FIELD_LABELS[field_key]
            result[field_key] = WorkflowFieldObservation(
                field_key=field_key,
                label=label,
                active=present or label in blocker_text,
                required=label in blocker_text,
                present=present,
            )
            _ = direction

        for field_key, label in (
            ("customer_service_confirmation", "费用确认"),
            ("business_review", "业务审核"),
            ("finance_review", "财务审核"),
        ):
            cards = session.page.locator(".expense-parallel-card").filter(has_text=label)
            visible_cards = [
                cards.nth(index)
                for index in range(cards.count())
                if cards.nth(index).is_visible()
            ]
            if not visible_cards:
                continue
            result[field_key] = WorkflowFieldObservation(
                field_key=field_key,
                label=label,
                active=True,
                required=any("必办" in self._text(card, 1_500) for card in visible_cards),
                present=all("已完成并锁定" in self._text(card, 1_500) for card in visible_cards),
            )

        for field_key in (
            "reconciliation_statement",
            "invoice_records",
            "cash_records",
            "writeoff_records",
        ):
            label = FIELD_LABELS[field_key]
            if label in blocker_text:
                result[field_key] = WorkflowFieldObservation(
                    field_key=field_key,
                    label=label,
                    active=True,
                    required=True,
                    present=False,
                )

        for field_key, label in (
            ("document_billing_statement", "账单"),
            ("document_payment_receipt", "收款凭证"),
        ):
            row = self._document_row(session, label)
            if not self._is_visible(row):
                continue
            row_text = self._text(row, 2_000)
            result[field_key] = WorkflowFieldObservation(
                field_key=field_key,
                label=label,
                active=True,
                required=row.locator(".required-mark").count() > 0,
                present="已填" in row_text and "待审核" not in row_text,
            )
        return result

    def _remember_snapshot(
        self, order_key: str, snapshot: Mapping[str, WorkflowFieldObservation]
    ) -> None:
        current = self.artifacts.workflow_gates.setdefault(order_key, {})
        for field_key, item in snapshot.items():
            current[field_key] = asdict(item) | {"configured_mode": item.configured_mode}

    def _record_field_gate(
        self,
        session: RoleBrowserSession,
        order_number: str,
        field_key: str,
        observation: WorkflowFieldObservation | None,
        actual: str,
        *,
        passed: bool = True,
    ) -> None:
        label = FIELD_LABELS.get(field_key, field_key)
        mode = observation.configured_mode if observation else "hidden"
        expectation = _workflow_gate(
            f"{order_number} · {label}",
            mode=mode,
            ui=(
                "必办项显示控件和待办提示。"
                if mode == "required"
                else "选办项可见但不得阻断推进。"
                if mode == "optional"
                else "隐藏项不显示控件、红色提示或占位门禁。"
            ),
            server=(
                "只校验当前实例必办项。"
                if mode == "required"
                else "未办理选填项仍允许继续。"
                if mode == "optional"
                else "隐藏字段不参与完成门禁，提交隐藏动作应被拒绝。"
            ),
            owner="工作流配置维护人",
        )
        session.record_gate(
            name=expectation.name,
            expected=f"UI：{expectation.ui_expectation}；服务端：{expectation.server_expectation}",
            passed=passed,
            actual=actual,
            owner=expectation.owner_role,
            remediation=expectation.remediation,
            expectation=expectation,
            case_id=f"P4-GATE-{safe_artifact_name(order_number)}-{safe_artifact_name(field_key)}",
        )

    def _fill_visible(self, session: RoleBrowserSession, form: Locator, name: str, value: str, target: str) -> bool:
        control = form.locator(f'[name="{name}"]')
        if not self._is_visible(control):
            return False
        control_type = str(control.first.get_attribute("type") or "").lower()
        if control_type in {"checkbox", "radio"}:
            return False
        if control_type == "date":
            session.type_date(control.first, value, target)
        elif control_type == "datetime-local":
            session.type_datetime_local(control.first, value, target)
        else:
            session.type_text(control.first, value, target)
        return True

    def _select_visible(
        self,
        session: RoleBrowserSession,
        form: Locator,
        name: str,
        *,
        value: str,
        target: str,
    ) -> bool:
        control = form.locator(f'select[name="{name}"]')
        if not self._is_visible(control):
            return False
        values = {
            str(control.locator("option").nth(index).get_attribute("value") or "")
            for index in range(control.locator("option").count())
        }
        if value not in values:
            raise BusinessBlocker(
                f"{target} 没有值 {value}",
                owner="工作流字段配置维护人",
                remediation="核对当前实例字段选项与费用表单支持值。",
            )
        session.select(control.first, target, value=value)
        return True

    def _create_missing_expense(
        self,
        order_key: str,
        direction: str,
        sequence: int,
    ) -> None:
        order = self.phase3.orders[order_key]
        self._open_costs(self.customer_service, order.order_number, "费用")
        disclosure = self.customer_service.page.locator("details.module-create-dialog")
        if not self._is_visible(disclosure):
            raise BusinessBlocker(
                f"{order.order_number} 缺少{FIELD_LABELS[direction + '_expenses']}，但页面没有新增费用入口",
                owner="客服负责人或工作流维护人",
                remediation="核对客服是否为本单费用负责人，以及当前费用字段是否真的必办。",
            )
        if disclosure.first.get_attribute("open") is None:
            self.customer_service.click(
                disclosure.first.locator("summary"), f"展开 {order.order_number} 新增费用"
            )
        form = disclosure.first.locator("form.expense-create-form")
        if not self._is_visible(form):
            raise BusinessBlocker(
                "新增费用表单未展开",
                owner="费用页面维护人",
                remediation="核对新增费用 disclosure 和表单可见性。",
            )
        if not self._select_visible(
            self.customer_service,
            form,
            "direction",
            value=direction,
            target="费用方向",
        ):
            hidden_direction = form.locator('input[type="hidden"][name="direction"]')
            hidden_value = str(hidden_direction.get_attribute("value") or "") if hidden_direction.count() else ""
            if hidden_value != direction:
                raise BusinessBlocker(
                    f"工作流要求{FIELD_LABELS[direction + '_expenses']}，但费用方向字段隐藏且固定为 {hidden_value or '空'}",
                    owner="工作流配置维护人",
                    remediation="不要让必办的应付费用与隐藏且固定为应收的方向字段互相矛盾。",
                )
        self._fill_visible(self.customer_service, form, "chargeCode", f"P4-{direction[:3].upper()}", "费用代码")
        self._fill_visible(self.customer_service, form, "chargeName", "Phase4全流程结算费用", "费用名称")
        counterparty = (
            self.phase3.customer_name or "Phase4验收客户"
            if direction == "receivable"
            else "Phase4验收供应商"
        )
        self._fill_visible(self.customer_service, form, "counterpartyName", counterparty, "费用往来单位")
        self._select_visible(self.customer_service, form, "currency", value="CNY", target="费用币种")
        self._fill_visible(self.customer_service, form, "exchangeRate", "1", "费用汇率")
        self._fill_visible(self.customer_service, form, "quantity", "1", "费用数量")
        self._fill_visible(self.customer_service, form, "unitPrice", str(20 + sequence), "费用单价")
        self._fill_visible(self.customer_service, form, "taxRate", "0", "费用税率")
        self._fill_visible(self.customer_service, form, "occurredOn", date.today().isoformat(), "费用发生日期")
        self._fill_visible(self.customer_service, form, "foreignAccountNo", f"P4-{order.order_number[-8:]}", "国外账单号")
        self._select_visible(self.customer_service, form, "isInternal", value="0", target="内部费用")
        self._fill_visible(self.customer_service, form, "notes", "Phase4 纯UI全流程验收补录", "费用备注")
        self.customer_service.click(form.get_by_role("button", name=re.compile(r"保存费用|正在保存")), "保存费用")
        self.customer_service.page.wait_for_timeout(300)
        self._assert_no_error_page(self.customer_service)

    def _ensure_required_expenses(self, order_key: str, sequence: int) -> None:
        order = self.phase3.orders[order_key]
        with self.customer_service.step(
            f"客服核对 {order.order_number} 应收应付费用",
            case_id=f"P4-COST-PREP-{order_key.upper()}",
            stage="三方结算",
            priority="P0",
            preconditions=("订单已完成自提签收", "客服为本单结算负责人"),
            inputs={"order_number": order.order_number},
            expected_result="只补当前工作流实例明确要求且尚未存在的费用方向",
            gate=_workflow_gate(
                f"{order.order_number} 费用模块门禁",
                mode="required",
                source="workflow_instance_module_state",
                ui="应收/应付是否必办由当前实例字段状态标识。",
                server="隐藏或选填费用方向不被脚本构造为必办。",
                owner="客服岗",
            ),
        ) as step:
            self._open_costs(self.customer_service, order.order_number, "费用")
            snapshot = self._read_workflow_snapshot(self.customer_service)
            self._remember_snapshot(order_key, snapshot)
            created: list[str] = []
            for direction in ("receivable", "payable"):
                field_key = f"{direction}_expenses"
                observation = snapshot.get(field_key)
                if observation and observation.required and not observation.present:
                    self._create_missing_expense(order_key, direction, sequence)
                    created.append(FIELD_LABELS[field_key])
                    self._open_costs(self.customer_service, order.order_number, "费用")
                    snapshot = self._read_workflow_snapshot(self.customer_service)
                    self._remember_snapshot(order_key, snapshot)
                    refreshed = snapshot.get(field_key)
                    if not refreshed or not refreshed.present:
                        raise BusinessBlocker(
                            f"{order.order_number} 新增{FIELD_LABELS[field_key]}后页面仍显示缺失",
                            owner="费用状态同步维护人",
                            remediation="检查费用保存后 workflow field presence 与 costs 模块状态同步。",
                        )
                elif observation and observation.required and observation.present:
                    self._record_field_gate(
                        self.customer_service,
                        order.order_number,
                        field_key,
                        observation,
                        "上游业务已生成既有费用，未重复创建",
                    )
                else:
                    self._record_field_gate(
                        self.customer_service,
                        order.order_number,
                        field_key,
                        observation,
                        "字段隐藏/选填时未构造费用" if not observation or not observation.required else "既有费用已满足",
                    )
            step.observe(
                "已补录：" + "、".join(created) if created else "既有应收应付已满足当前必办配置",
                gate_passed=True,
            )

    def _perform_required_signoff(
        self,
        session: RoleBrowserSession,
        order_key: str,
        field_key: str,
        action_label: str,
        role_label: str,
    ) -> None:
        order = self.phase3.orders[order_key]
        with session.step(
            f"{role_label}核对并签核 {order.order_number}",
            case_id=f"P4-SIGN-{safe_artifact_name(field_key).upper()}-{order_key.upper()}",
            stage="三方结算",
            priority="P0",
            preconditions=("订单位于费用结算节点", f"当前账号是本单{role_label}负责人"),
            inputs={"order_number": order.order_number, "workflow_field": field_key},
            expected_result="只完成页面当前标记为必办的签核；选办或隐藏动作不阻断",
        ) as step:
            self._open_costs(session, order.order_number, "费用")
            snapshot = self._read_workflow_snapshot(session)
            self._remember_snapshot(order_key, snapshot)
            observation = snapshot.get(field_key)
            if not observation or not observation.active:
                self._record_field_gate(session, order.order_number, field_key, None, "当前实例隐藏，未办理")
                step.observe("当前实例隐藏该签核，未构造操作", gate_passed=True)
                return
            if not observation.required:
                self._record_field_gate(session, order.order_number, field_key, observation, "当前实例为选办，按最少动作跳过")
                step.observe("当前实例为选办，未阻断后续", gate_passed=True)
                return
            completed = 0
            recovery_mode = (
                self.phase3.certification_lineage.get("recovery_branches_used") is True
            )
            for direction_title in ("应收费用台账", "应付费用台账"):
                clicked_in_this_direction = False
                for _ in range(3):
                    section = session.page.locator(".module-business-section").filter(
                        has_text=direction_title
                    ).first
                    card = section.locator(".expense-parallel-card").filter(has_text=action_label).first
                    if not self._is_visible(card):
                        raise BusinessBlocker(
                            f"{order.order_number} 工作流要求{action_label}，但{direction_title}未显示对应卡片",
                            owner="费用工作流页面维护人",
                            remediation="确保签核卡片、必办标签与 workflow instance field 使用同一配置。",
                        )
                    card_text = self._text(card, 2_000)
                    if "已完成并锁定" in card_text:
                        if not clicked_in_this_direction and not recovery_mode:
                            raise BusinessBlocker(
                                f"{order.order_number} 的{direction_title}{action_label}在本轮到达前已经完成，不能作为 fresh 全流程认证数据",
                                owner="全流程认证数据隔离维护人",
                                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                            )
                        completed += 1
                        break
                    button = card.get_by_role("button", name=f"{action_label}通过", exact=True)
                    if not self._is_visible(button):
                        raise BusinessBlocker(
                            f"{order.order_number} 的{direction_title}{action_label}为必办，但当前账号没有办理按钮：{card_text[:400]}",
                            owner=role_label,
                            remediation="核对任务分配到的具体个人账号、岗位权限和页面 access.canEdit。",
                        )
                    clicked_in_this_direction = True
                    try:
                        session.click(
                            button.first,
                            f"{order.order_number} {direction_title} {action_label}通过",
                            no_wait_after=True,
                        )
                        completed_card = session.page.locator(
                            ".module-business-section"
                        ).filter(has_text=direction_title).first.locator(
                            ".expense-parallel-card"
                        ).filter(has_text=action_label).filter(
                            has_text="已完成并锁定"
                        ).first
                        session.expect_visible(
                            completed_card,
                            f"{order.order_number} {direction_title} {action_label}提交结果可见",
                        )
                    except Exception as original:
                        self._assert_no_error_page(session)
                        self._open_costs(session, order.order_number, "费用")
                        completed_card = session.page.locator(
                            ".module-business-section"
                        ).filter(has_text=direction_title).first.locator(
                            ".expense-parallel-card"
                        ).filter(has_text=action_label).filter(
                            has_text="已完成并锁定"
                        ).first
                        try:
                            session.expect_visible(
                                completed_card,
                                f"{order.order_number} {direction_title} {action_label}持久完成状态",
                            )
                        except Exception:
                            raise original
                    self._assert_no_error_page(session)
                else:
                    raise BusinessBlocker(
                        f"{order.order_number} {action_label}提交后状态未收敛",
                        owner="费用状态同步维护人",
                        remediation="检查签核 action、方向控制表和页面实时刷新。",
                    )
            self._open_costs(session, order.order_number, "费用")
            refreshed = self._read_workflow_snapshot(session).get(field_key)
            if not refreshed or not refreshed.present:
                raise BusinessBlocker(
                    f"{order.order_number} 两个方向{action_label}完成后字段仍显示未完成",
                    owner="费用状态同步维护人",
                    remediation="检查两方向签核汇总 presence 与 costs 模块同步。",
                )
            self._remember_snapshot(order_key, {field_key: refreshed})
            self._record_field_gate(session, order.order_number, field_key, refreshed, f"应收与应付{action_label}均已完成")
            step.observe(f"应收与应付{action_label}均已完成并锁定", gate_passed=True)

    def _open_billing_tab(self, session: RoleBrowserSession, label: str) -> None:
        self._click_navigation(session, "费用结算")
        tabs = session.page.get_by_role("navigation", name="费用结算工作区")
        link = tabs.get_by_role("link", name=re.compile(rf"^{re.escape(label)}"))
        if not self._is_visible(link):
            raise BusinessBlocker(
                f"费用结算工作区未显示“{label}”页签",
                owner="结算工作台维护人",
                remediation="核对岗位菜单、billing 权限和同级页签配置。",
            )
        session.click(link.first, f"切换费用结算 {label}")
        session.page.wait_for_timeout(160)
        self._assert_no_error_page(session)

    def _filter_billing(
        self,
        session: RoleBrowserSession,
        query: str,
        *,
        direction: str = "",
    ) -> None:
        form = session.page.get_by_role("form", name="结算记录筛选")
        if not self._is_visible(form):
            form = session.page.locator("form.billing-workspace-filters")
        if not self._is_visible(form):
            raise BusinessBlocker(
                "费用结算页缺少筛选表单",
                owner="结算工作台维护人",
                remediation="确保每个结算同级页签提供统一筛选表单。",
            )
        session.type_text(form.locator('input[name="q"]'), query, f"筛选结算记录 {query}")
        direction_select = form.locator('select[name="direction"]')
        if direction and self._is_visible(direction_select):
            session.select(direction_select.first, "结算方向", value=direction)
        session.click(form.get_by_role("button", name="筛选", exact=True), "提交结算筛选")
        session.page.wait_for_timeout(180)
        self._assert_no_error_page(session)

    def _remember_reconciliation(
        self, document_number: str, direction: str, order_key: str
    ) -> ReconciliationArtifact:
        artifact = self.artifacts.reconciliations.get(document_number)
        if artifact is None:
            artifact = ReconciliationArtifact(document_number, direction)
            self.artifacts.reconciliations[document_number] = artifact
            self.harness.journal.register_entity(
                "reconciliation", document_number, document_number
            )
        if order_key not in artifact.order_keys:
            artifact.order_keys.append(order_key)
        return artifact

    def _create_pending_reconciliations(self, order_key: str, direction: str) -> None:
        order_number = self.phase3.orders[order_key].order_number
        self._open_billing_tab(self.finance, "待对账")
        self._filter_billing(self.finance, order_number, direction=direction)
        for _ in range(12):
            groups = self.finance.page.locator("section.settlement-selector")
            target_form: Locator | None = None
            target_boxes: list[Locator] = []
            for group_index in range(groups.count()):
                group = groups.nth(group_index)
                if not group.is_visible():
                    continue
                boxes: list[Locator] = []
                labels = group.locator("label").filter(has_text=order_number)
                for label_index in range(labels.count()):
                    box = labels.nth(label_index).locator('input[name="expenseId"]')
                    if self._is_visible(box):
                        boxes.append(box.first)
                if boxes:
                    target_form = group.locator("form")
                    target_boxes = boxes
                    break
            if target_form is None:
                break
            for box in target_boxes:
                self.finance.set_checked(box, True, f"勾选 {order_number} 已确认费用")
            self.finance.click(
                target_form.get_by_role("button", name="生成对账草稿", exact=True),
                f"为 {order_number} 生成{direction}对账草稿",
            )
            self._generated_reconciliation_orders.add(order_number)
            self.finance.page.wait_for_timeout(220)
            feedback = self._text(self.finance.page.locator(".alert"), 1_000)
            matched = RECONCILIATION_NUMBER_RE.search(feedback)
            if matched:
                self._remember_reconciliation(matched.group(0).upper(), direction, order_key)
            self._filter_billing(self.finance, order_number, direction=direction)
        else:
            raise BusinessBlocker(
                f"{order_number} 待对账费用连续生成超过 12 张对账单",
                owner="财务会计岗",
                remediation="检查重复费用、分页筛选和对账生成后的列表移除状态。",
            )

    def _collect_and_confirm_reconciliations(self, order_key: str) -> list[str]:
        order_number = self.phase3.orders[order_key].order_number
        self._open_billing_tab(self.finance, "对账单")
        self._filter_billing(self.finance, order_number)
        documents: list[str] = []
        for _ in range(20):
            changed = False
            cards = self.finance.page.locator("article.reconciliation-card")
            for index in range(cards.count()):
                card = cards.nth(index)
                text = self._text(card, 4_000)
                if order_number not in text:
                    continue
                match = RECONCILIATION_NUMBER_RE.search(text)
                if not match:
                    continue
                number = match.group(0).upper()
                direction = "receivable" if "客户应收" in text else "payable"
                self._remember_reconciliation(number, direction, order_key)
                if number not in documents:
                    documents.append(number)
                confirm = card.get_by_role("button", name="确认对账单", exact=True)
                if self._is_visible(confirm):
                    self.finance.click(confirm.first, f"确认对账单 {number}")
                    self.finance.page.wait_for_timeout(220)
                    self._filter_billing(self.finance, order_number)
                    changed = True
                    break
            if not changed:
                break
        else:
            raise BusinessBlocker(
                f"{order_number} 对账单确认状态未收敛",
                owner="结算工作台维护人",
                remediation="检查草稿确认后的状态刷新与筛选结果。",
            )
        return documents

    def _invoice_reconciliation(self, document_number: str) -> None:
        artifact = self.artifacts.reconciliations[document_number]
        self._open_billing_tab(self.finance, "发票")
        self._filter_billing(self.finance, document_number)
        card = self.finance.page.locator("article.reconciliation-card").filter(
            has_text=document_number
        ).first
        if not self._is_visible(card):
            raise BusinessBlocker(
                f"{document_number} 在本轮发票办理前已经离开待办理列表，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        operation = card.locator("details.billing-card-operation")
        if not self._is_visible(operation):
            raise BusinessBlocker(
                f"{document_number} 没有本轮可见发票办理入口，疑似沿用了已完成数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        if operation.get_attribute("open") is None:
            self.finance.click(operation.locator("summary"), f"展开 {document_number} 发票办理")
        form = operation.locator("form.billing-invoice-form")
        amount = form.locator('input[name="amount"]')
        maximum = str(amount.get_attribute("max") or "").strip()
        if not maximum or float(maximum) <= 0:
            raise BusinessBlocker(
                f"{document_number} 发票剩余金额无效",
                owner="财务会计岗",
                remediation="核对对账单金额和既有发票分配记录。",
            )
        invoice_number = f"P4INV{document_number[-10:]}"
        self.finance.type_text(amount, maximum, f"{document_number} 本次发票金额")
        for name, value, target in (
            ("invoiceNumber", invoice_number, "发票号码"),
            ("invoiceCode", f"P4{document_number[-8:]}", "发票代码"),
            ("invoiceDate", date.today().isoformat(), "开票日期"),
            ("taxRate", "0", "税率"),
            ("exchangeRate", "1", "发票汇率"),
            ("attachmentReference", self.fixture_file.name, "发票凭证编号"),
            ("invoiceNotes", "Phase4 纯UI结算验收", "发票备注"),
        ):
            self._fill_visible(self.finance, form, name, value, target)
        for name, fallback, target in (
            ("invoiceCompany", "Phase4结算主体", "开票/收票公司"),
            ("invoiceType", "增值税发票", "发票类别"),
            ("titleName", "Phase4结算抬头", "抬头/销方"),
        ):
            control = form.locator(f'[name="{name}"]')
            if self._is_visible(control) and not str(control.first.input_value()).strip():
                self.finance.type_text(control.first, fallback, target)
        self.finance.click(form.get_by_role("button", name="保存发票记录", exact=True), f"保存 {document_number} 发票记录")
        self.finance.page.wait_for_timeout(220)
        feedback = self._text(self.finance.page.locator(".alert"), 1_200)
        matched = INVOICE_RECORD_RE.search(feedback)
        artifact.invoice_record_number = matched.group(0).upper() if matched else "RECORDED"
        artifact.invoice_number = invoice_number
        if matched:
            self.harness.journal.register_entity("invoice_record", document_number, matched.group(0).upper())

    def _document_row(self, session: RoleBrowserSession, label: str) -> Locator:
        return session.page.locator(".source-document-row").filter(has_text=label).first

    def _upload_cost_document(self, order_key: str, label: str) -> bool:
        order_number = self.phase3.orders[order_key].order_number
        self._open_costs(self.customer_service, order_number, "文件")
        row = self._document_row(self.customer_service, label)
        if not self._is_visible(row):
            return False
        text = self._text(row, 2_000)
        if "已填" in text or "已上传待审核" in text:
            if self.phase3.certification_lineage.get("recovery_branches_used") is True:
                if label not in self.artifacts.document_evidence[order_key]:
                    self.artifacts.document_evidence[order_key].append(label)
                return True
            raise BusinessBlocker(
                f"{order_number} 的{label}在本轮上传前已经存在，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        if "审核退回" in text:
            edit = row.get_by_role("button", name="编辑", exact=True)
            if not self._is_visible(edit):
                raise BusinessBlocker(
                    f"{order_number} {label}审核退回但没有替换入口",
                    owner="客服结算负责人",
                    remediation="核对结算文件编辑权限和退回后的可替换状态。",
                )
            self.customer_service.click(edit.first, f"编辑 {order_number} {label}")
            dialog = self.customer_service.page.get_by_role("dialog", name=f"编辑文件 · {label}")
            replace_form = dialog.locator("form.document-replace-form")
            trigger = replace_form.locator("label.field")
            self.customer_service.choose_files(trigger, self.fixture_file, f"替换 {order_number} {label}")
            self.customer_service.click(replace_form.get_by_role("button", name="上传替换文件", exact=True), f"上传替换 {label}")
        else:
            trigger = row.locator("label.document-upload-button")
            if not self._is_visible(trigger):
                raise BusinessBlocker(
                    f"{order_number} 显示 {label} 文件项但客服没有上传入口",
                    owner="客服结算负责人",
                    remediation="核对 costs 文件阶段、负责人分配和上传权限。",
                )
            self.customer_service.choose_files(trigger.first, self.fixture_file, f"上传 {order_number} {label}")
        self.customer_service.page.wait_for_timeout(450)
        self._assert_no_error_page(self.customer_service)
        if label not in self.artifacts.document_evidence[order_key]:
            self.artifacts.document_evidence[order_key].append(label)
        return True

    def _review_cost_document(self, order_key: str, label: str) -> bool:
        order_number = self.phase3.orders[order_key].order_number
        self._open_costs(self.finance, order_number, "文件")
        row = self._document_row(self.finance, label)
        if not self._is_visible(row):
            return False
        text = self._text(row, 2_000)
        if "已填" in text and "待审核" not in text:
            if label in self.artifacts.document_evidence[order_key]:
                return True
            raise BusinessBlocker(
                f"{order_number} 的{label}在本轮审核前已经通过，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        review = row.get_by_role("button", name="审核", exact=True)
        if not self._is_visible(review):
            raise BusinessBlocker(
                f"{order_number} {label}待审核但财务没有审核入口",
                owner="财务审核负责人",
                remediation="核对 review 模块负责人、结算文件审核权限和当前节点。",
            )
        self.finance.click(review.first, f"审核 {order_number} {label}")
        dialog = self.finance.page.get_by_role("dialog", name=f"审核文件 · {label}")
        select = dialog.locator('select[name="reviewStatus"]')
        self.finance.select(select, f"{label}审核结果", value="approved")
        self.finance.click(dialog.get_by_role("button", name="确认审核结果", exact=True), f"确认 {label} 审核通过")
        self.finance.page.wait_for_timeout(260)
        self._assert_no_error_page(self.finance)
        return True

    def _handle_document_stage(self, label: str, stage_name: str) -> None:
        for order_key in ORDER_KEYS:
            order_number = self.phase3.orders[order_key].order_number
            with self.customer_service.step(
                f"上传并审核 {order_number} {label}",
                case_id=f"P4-DOC-{safe_artifact_name(label).upper()}-{order_key.upper()}",
                stage=stage_name,
                priority="P0",
                preconditions=("结算业务已经产生对应文件", "文件通过原生文件选择器上传"),
                inputs={"order_number": order_number, "document": label},
                expected_result="文件项可见时完成上传和财务审核；隐藏时不制造占位或门禁",
            ) as step:
                visible = self._upload_cost_document(order_key, label)
                if not visible:
                    self._record_field_gate(
                        self.customer_service,
                        order_number,
                        "document_billing_statement" if label == "账单" else "document_payment_receipt",
                        None,
                        "当前实例隐藏该结算文件，未上传",
                    )
                    step.observe("当前工作流隐藏该文件项，未构造上传", gate_passed=True)
                    continue
                self._review_cost_document(order_key, label)
                step.observe(f"{label}已通过原生文件选择器上传并由财务审核", gate_passed=True)

    def _reconciliation_requirements(self, order_key: str) -> dict[str, bool]:
        order_number = self.phase3.orders[order_key].order_number
        self._open_costs(self.finance, order_number, "费用")
        snapshot = self._read_workflow_snapshot(self.finance)
        self._remember_snapshot(order_key, snapshot)
        return {
            key: workflow_action_required(snapshot, key)
            for key in ("reconciliation_statement", "invoice_records", "cash_records", "writeoff_records")
        }

    def _process_finance_settlement(self) -> None:
        requirement_by_order = {
            order_key: self._reconciliation_requirements(order_key)
            for order_key in ORDER_KEYS
        }
        for order_key, requirements in requirement_by_order.items():
            order_number = self.phase3.orders[order_key].order_number
            needs_settlement = any(requirements.values())
            if not needs_settlement:
                self._record_field_gate(
                    self.finance,
                    order_number,
                    "reconciliation_statement",
                    None,
                    "当前页面没有未完成的必办对账/发票/流水/核销门禁，未重复办理",
                )
                continue
            with self.finance.step(
                f"财务为 {order_number} 生成并确认对账单",
                case_id=f"P4-RECON-{order_key.upper()}",
                stage="三方结算",
                priority="P0",
                preconditions=("当前实例仍有结算必办项", "应收应付费用已完成必办签核"),
                inputs={"order_number": order_number},
                expected_result="目标订单全部待对账费用按方向和往来单位生成并确认",
            ) as step:
                self._create_pending_reconciliations(order_key, "receivable")
                self._create_pending_reconciliations(order_key, "payable")
                if order_number not in self._generated_reconciliation_orders:
                    raise BusinessBlocker(
                        f"{order_number} 本轮没有生成任何对账草稿，不能把既有对账单作为 fresh 认证结果",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                documents = self._collect_and_confirm_reconciliations(order_key)
                if not documents:
                    raise BusinessBlocker(
                        f"{order_number} 要求对账单，但待对账和对账单页面均无记录",
                        owner="财务会计岗",
                        remediation="核对费用是否已确认、金额是否大于零及结算工作台筛选范围。",
                    )
                step.observe(f"确认 {len(documents)} 张对账单", gate_passed=True)
            if requirements["invoice_records"]:
                for document in documents:
                    self._invoice_reconciliation(document)
            else:
                self._record_field_gate(
                    self.finance,
                    order_number,
                    "invoice_records",
                    None,
                    "当前实例未将发票记录设为必办，按最少动作跳过",
                )

    def _cash_card(self, document_number: str) -> Locator:
        return self.cashier.page.locator("article.reconciliation-card").filter(
            has_text=document_number
        ).first

    def _record_cash_for_reconciliation(self, document_number: str) -> None:
        artifact = self.artifacts.reconciliations[document_number]
        self._open_billing_tab(self.cashier, "收付款核销")
        self._filter_billing(self.cashier, document_number)
        card = self._cash_card(document_number)
        if not self._is_visible(card):
            raise BusinessBlocker(
                f"{document_number} 在本轮流水登记前已离开核销列表，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        text = self._text(card, 4_000)
        direction = "receipt" if "客户应收" in text else "payment"
        header = self._text(card.locator("header small"), 1_000)
        parts = [part.strip() for part in header.split("·")]
        if len(parts) < 2:
            raise BusinessBlocker(
                f"{document_number} 卡片没有可识别的往来单位与币种",
                owner="结算工作台维护人",
                remediation="保持对账卡片的往来单位、币种可见。",
            )
        counterparty, currency = parts[0], parts[1]
        operation = card.locator("details.billing-card-operation")
        if not self._is_visible(operation):
            raise BusinessBlocker(
                f"{document_number} 在本轮流水登记前没有可见核销入口，疑似沿用了已结清数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        if operation.get_attribute("open") is None:
            self.cashier.click(operation.locator("summary"), f"展开 {document_number} 核销")
        allocation = operation.locator("form.billing-allocation-form")
        maximum = str(allocation.locator('input[name="amount"]').get_attribute("max") or "").strip()
        if not maximum or float(maximum) <= 0:
            raise BusinessBlocker(
                f"{document_number} 在本轮流水登记前已无待核销金额，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )

        entry = self.cashier.page.locator("details.billing-entry-disclosure")
        if entry.get_attribute("open") is None:
            self.cashier.click(entry.locator("summary"), "展开登记一笔新流水")
        form = entry.locator("form.settlement-cash-form")
        self.cashier.select(form.locator('select[name="direction"]'), "收付款方向", value=direction)
        self.cashier.type_text(form.locator('input[name="counterpartyName"]'), counterparty, "流水往来单位")
        self.cashier.type_text(form.locator('input[name="currency"]'), currency, "流水币种")
        self.cashier.type_text(form.locator('input[name="amount"]'), maximum, "流水金额")
        self.cashier.type_text(form.locator('input[name="occurredOn"]'), date.today().isoformat(), "收付款日期")
        settlement_entity = form.locator('input[name="settlementEntity"]')
        if not str(settlement_entity.input_value()).strip():
            self.cashier.type_text(settlement_entity, "Phase4结算主体", "流水所属公司")
        self.cashier.type_text(form.locator('input[name="accountName"]'), "Phase4验收银行账户", "银行或现金账户")
        handled = form.locator('select[name="handledByUserId"]')
        values = [
            str(handled.locator("option").nth(index).get_attribute("value") or "")
            for index in range(handled.locator("option").count())
        ]
        selected = next((value for value in values if value), "")
        if not selected:
            raise BusinessBlocker(
                "收付款流水没有可选经办人",
                owner="组织与用户管理员",
                remediation="为当前组织配置至少一个有效成员。",
            )
        self.cashier.select(handled, "流水经办人", value=selected)
        self._fill_visible(self.cashier, form, "evidenceReference", self.fixture_file.name, "流水凭证编号")
        self._fill_visible(self.cashier, form, "cashNotes", f"Phase4 对账单 {document_number}", "流水备注")
        self.cashier.click(form.get_by_role("button", name="登记收付款流水", exact=True), f"登记 {document_number} 收付款流水")
        self.cashier.page.wait_for_timeout(220)
        feedback = self._text(self.cashier.page.locator(".alert"), 1_200)
        match = CASH_TRANSACTION_RE.search(feedback)
        artifact.cash_transaction_number = match.group(0).upper() if match else "RECORDED"
        if match:
            self.harness.journal.register_entity("cash_transaction", document_number, match.group(0).upper())

    def _allocate_cash_for_reconciliation(self, document_number: str) -> None:
        artifact = self.artifacts.reconciliations[document_number]
        if artifact.settled:
            return
        self._open_billing_tab(self.cashier, "收付款核销")
        self._filter_billing(self.cashier, document_number)
        card = self._cash_card(document_number)
        if not self._is_visible(card):
            raise BusinessBlocker(
                f"{document_number} 在本轮核销前已离开待核销列表，不能作为 fresh 全流程认证数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        operation = card.locator("details.billing-card-operation")
        if not self._is_visible(operation):
            raise BusinessBlocker(
                f"{document_number} 在本轮核销前没有可见办理入口，疑似沿用了已结清数据",
                owner="全流程认证数据隔离维护人",
                remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
            )
        if operation.get_attribute("open") is None:
            self.cashier.click(operation.locator("summary"), f"展开 {document_number} 流水核销")
        form = operation.locator("form.billing-allocation-form")
        transaction = form.locator('select[name="transactionId"]')
        options = transaction.locator("option")
        preferred = ""
        fallback = ""
        for index in range(options.count()):
            option = options.nth(index)
            value = str(option.get_attribute("value") or "")
            text = self._text(option, 500)
            if not value:
                continue
            fallback = fallback or value
            if artifact.cash_transaction_number not in {"", "RECORDED"} and artifact.cash_transaction_number in text:
                preferred = value
                break
        selected = preferred or fallback
        if not selected:
            raise BusinessBlocker(
                f"{document_number} 没有同方向、同往来单位、同币种的可用流水",
                owner="出纳岗",
                remediation="核对新登记流水的方向、往来单位和币种是否与对账单完全一致。",
            )
        maximum = str(form.locator('input[name="amount"]').get_attribute("max") or "").strip()
        self.cashier.select(transaction, f"{document_number} 可用流水", value=selected)
        self.cashier.type_text(form.locator('input[name="amount"]'), maximum, f"{document_number} 本次核销金额")
        self.cashier.click(form.get_by_role("button", name="确认核销", exact=True), f"确认核销 {document_number}")
        self.cashier.page.wait_for_timeout(250)
        self._assert_no_error_page(self.cashier)
        artifact.settled = True

    def _cash_required_documents(self) -> list[str]:
        result: list[str] = []
        for document, artifact in self.artifacts.reconciliations.items():
            if any(
                self.artifacts.workflow_gates.get(order_key, {}).get(field_key, {}).get("required")
                for order_key in artifact.order_keys
                for field_key in ("cash_records", "writeoff_records")
            ):
                result.append(document)
        return result

    def _process_cash(self) -> None:
        documents = self._cash_required_documents()
        for document in documents:
            self._record_cash_for_reconciliation(document)
        self._handle_document_stage("收款凭证", "收付款与凭证")
        for document in documents:
            self._allocate_cash_for_reconciliation(document)

    def _confirm_warehouse_differences(self) -> None:
        session = next(
            (
                item
                for item in self.warehouse_sessions
                if item.role == "overseas_warehouse"
            ),
            None,
        )
        if session is None:
            raise BusinessBlocker(
                "缺少产生境外实收差异的仓库账号",
                owner="仓库账号维护人",
                remediation="Phase 4 必须提供绑定目的仓的仓库作业账号。",
            )
        self._click_navigation(session, "异常处理")
        for order_key in ORDER_KEYS:
            order_number = self.phase3.orders[order_key].order_number
            with session.step(
                f"境外仓核对 {order_number} 实收差异及费用影响",
                case_id=f"P4-WAREHOUSE-DIFF-{order_key.upper()}",
                stage="仓库差异确认",
                priority="P0",
                preconditions=("目的仓已完成扫码清点", "账号仅查看本仓产生差异的订单"),
                inputs={"order_number": order_number},
                expected_result="存在差异时明确确认费用影响；无差异时不增加操作",
                gate=_workflow_gate(
                    f"{order_number} 仓库差异确认门禁",
                    mode="required",
                    source="workflow_instance_module_state",
                    ui="仓库模块必办且本仓存在待确认差异时显示确认按钮。",
                    server="只允许当前工作流仓库责任岗和本仓订单范围提交。",
                    owner="境外仓岗",
                ),
            ) as step:
                row = session.page.locator(
                    ".warehouse-difference-confirmation-table tbody tr"
                ).filter(has_text=order_number).first
                if not self._is_visible(row):
                    step.observe("本仓无待确认实收差异，未增加操作", gate_passed=True)
                    continue
                button = row.get_by_role(
                    "button", name="确认差异及费用影响", exact=True
                )
                if self._is_visible(button):
                    session.click(button.first, f"确认 {order_number} 实收差异及费用影响")
                    session.expect_visible(
                        session.page.get_by_text(
                            "仓库实收差异及费用影响已确认", exact=False
                        ),
                        f"{order_number} 差异确认成功提示",
                    )
                    step.observe("已确认本仓实收差异及费用影响", gate_passed=True)
                else:
                    raise BusinessBlocker(
                        f"{order_number} 存在待确认差异但当前仓库账号没有确认按钮",
                        owner="仓库模块权限维护人",
                        remediation="核对本仓订单范围、warehouse 模块责任岗位和 manage 权限。",
                    )

    def _find_target_exception_row(self, session: RoleBrowserSession) -> Locator | None:
        for _ in range(30):
            rows = session.page.locator(".warehouse-exception-table tbody tr")
            for index in range(rows.count()):
                row = rows.nth(index)
                text = self._text(row, 3_000)
                if any(item.order_number in text for item in self.phase3.orders.values()):
                    return row
            next_page = session.page.get_by_role("link", name="下一页", exact=True)
            if not self._is_visible(next_page):
                return None
            session.click(next_page.first, "查看下一页未结异常")
            session.page.wait_for_timeout(160)
        raise BusinessBlocker(
            "异常列表分页超过 30 页仍未收敛",
            owner="仓库异常工作台维护人",
            remediation="增加订单筛选并核对分页链接状态。",
        )

    def _close_target_exceptions(self, session: RoleBrowserSession) -> None:
        self._click_navigation(session, "异常处理")
        active = session.page.get_by_role("link", name="未结案", exact=True)
        if self._is_visible(active):
            session.click(active.first, "查看未结案异常")
        for _ in range(24):
            row = self._find_target_exception_row(session)
            if row is None:
                return
            text = self._text(row, 4_000)
            number_match = re.search(r"\bEX-[0-9A-Z-]+\b", text, re.I)
            number = number_match.group(0).upper() if number_match else "目标订单异常"
            start = row.get_by_role("button", name="开始处理", exact=True)
            if self._is_visible(start):
                session.click(start.first, f"开始处理 {number}")
                session.page.wait_for_timeout(220)
                self._click_navigation(session, "异常处理")
                row = self._find_target_exception_row(session)
                if row is None:
                    continue
            close = row.get_by_role("button", name="处理结案", exact=True)
            if not self._is_visible(close):
                raise BusinessBlocker(
                    f"{number} 未结案但当前仓库账号没有结案入口",
                    owner=session.role,
                    remediation="核对异常所属仓库、仓库操作权限和当前异常状态。",
                )
            session.click(close.first, f"打开 {number} 结案弹窗")
            dialog = session.page.get_by_role("dialog", name=f"结案 {number}")
            session.type_text(
                dialog.locator('textarea[name="resolution"]'),
                "现场复核完成，责任和费用影响已确认，Phase4 验收结案。",
                "异常处理结果",
            )
            session.click(dialog.get_by_role("button", name="确认结案并解除冻结", exact=True), f"确认 {number} 结案")
            session.page.wait_for_timeout(240)
            if number not in self.artifacts.closed_exceptions:
                self.artifacts.closed_exceptions.append(number)
        raise BusinessBlocker(
            "目标订单未结异常超过 24 条",
            owner="仓库异常负责人",
            remediation="分批核对异常来源和重复生成逻辑。",
        )

    def _complete_reviews(self) -> None:
        for order_key in ORDER_KEYS:
            order_number = self.phase3.orders[order_key].order_number
            with self.finance.step(
                f"财务完成 {order_number} 复盘并归档",
                case_id=f"P4-REVIEW-{order_key.upper()}",
                stage="复盘归档",
                priority="P0",
                preconditions=("当前实例所有必办费用与结算字段已完成", "未结异常已闭环"),
                inputs={"order_number": order_number},
                expected_result="按当前实例可见复盘字段生成复盘，订单进入已完成并结清",
            ) as step:
                self._open_order(self.finance, order_number)
                body = self._text(self.finance.page.locator("body"), 14_000)
                if "订单已归档" in body or "订单已完成" in body:
                    if self.phase3.certification_lineage.get("recovery_branches_used") is True:
                        if order_number not in self.artifacts.archived_orders:
                            self.artifacts.archived_orders.append(order_number)
                        step.observe("恢复链复用既有归档结果", gate_passed=True)
                        continue
                    raise BusinessBlocker(
                        f"{order_number} 在本轮到达前已经完成归档，不能作为 fresh 全流程认证数据",
                        owner="全流程认证数据隔离维护人",
                        remediation="废弃本轮续跑，从 Phase 1 创建全新客户和全新订单后重新认证。",
                    )
                if not self._click_business_tab(self.finance, "订单复盘"):
                    raise BusinessBlocker(
                        f"{order_number} 未完成但当前节点没有订单复盘页签",
                        owner="工作流配置维护人",
                        remediation="若复盘模块隐藏，应由工作流自动跳过；若启用，应显示同级订单复盘页。",
                    )
                blockers = self.finance.page.locator(".review-blocker-list")
                if self._is_visible(blockers):
                    raise BusinessBlocker(
                        f"{order_number} 复盘仍有门禁：{self._text(blockers, 3_000)}",
                        owner="门禁提示中标明的责任岗位",
                        remediation="按页面门禁返回对应同级页面处理，不允许绕过后直接归档。",
                    )
                form = self.finance.page.locator("form.review-generation-form")
                if not self._is_visible(form):
                    raise BusinessBlocker(
                        f"{order_number} 复盘无阻断但没有生成表单",
                        owner="财务审核负责人或复盘页面维护人",
                        remediation="核对 review 模块负责人、当前步骤 access.canEdit 和工作流显隐。",
                    )
                self._fill_visible(self.finance, form, "customerDisputeSummary", "无未结客户异议，已完成闭环核对。", "客户异议摘要")
                self._fill_visible(self.finance, form, "reviewConclusion", "业务、时效、货量、费用、凭证和异常均已按当前工作流完成。", "复盘结论")
                self._fill_visible(self.finance, form, "improvementNotes", "持续保持岗位待办与工作流配置实时同步。", "改进建议")
                self.finance.click(
                    form.get_by_role("button", name="生成 / 更新复盘草稿", exact=True),
                    f"生成 {order_number} 订单复盘草稿",
                )
                self.finance.expect_hidden(
                    self.finance.page.get_by_role(
                        "progressbar", name="系统正在处理请求"
                    ),
                    f"{order_number} 复盘草稿保存完成",
                )
                final_form = self.finance.page.locator(
                    'form.review-generation-form:has(input[name="confirmFinalReview"])'
                )
                self._expect_visible_or_block(
                    self.finance,
                    final_form,
                    f"{order_number} 最终确认归档表单",
                    owner="复盘与归档页面维护人",
                    remediation="复盘草稿生成后应显示独立的最终确认归档动作。",
                )
                self.finance.set_checked(
                    final_form.locator('input[name="confirmFinalReview"]'),
                    True,
                    f"核对 {order_number} 复盘与归档门禁",
                )
                try:
                    self.finance.click(
                        final_form.get_by_role("button", name="最终确认并归档订单", exact=True),
                        f"最终确认并归档 {order_number}",
                    )
                    self.finance.expect_visible(
                        self.finance.page.get_by_text("订单已完成", exact=True),
                        f"{order_number} 最终归档结果可见",
                    )
                except Exception as original:
                    self._assert_no_error_page(self.finance)
                    self._open_order(self.finance, order_number)
                    persisted_body = self._text(
                        self.finance.page.locator("body"), 16_000
                    )
                    if not any(
                        value in persisted_body
                        for value in ("已完成并结清", "订单已完成", "订单已归档")
                    ):
                        raise original
                self.finance.page.wait_for_timeout(300)
                body = self._text(self.finance.page.locator("body"), 16_000)
                if not any(value in body for value in ("已完成并结清", "订单已完成", "订单已归档")):
                    raise BusinessBlocker(
                        f"{order_number} 生成复盘后未进入完成归档：{body[:700]}",
                        owner="复盘与订单状态同步维护人",
                        remediation="核对复盘判定、余额、模块状态和 transport order 完成状态同步。",
                    )
                if order_number not in self.artifacts.archived_orders:
                    self.artifacts.archived_orders.append(order_number)
                step.observe("复盘草稿已生成并完成独立最终确认，订单已归档", gate_passed=True)

    def run(self) -> Phase4Artifacts:
        self._login(self.customer_service, "客服岗")
        self._login(self.sales, "业务岗")
        self._login(self.finance, "财务会计岗")
        self._login(self.cashier, "出纳岗")
        for session in self.warehouse_sessions:
            self._login(session, "国内仓岗" if session.role == "domestic_warehouse" else "境外仓岗")

        self._confirm_warehouse_differences()

        for sequence, order_key in enumerate(ORDER_KEYS, start=1):
            self._ensure_required_expenses(order_key, sequence)
            self._perform_required_signoff(
                self.customer_service,
                order_key,
                "customer_service_confirmation",
                "费用确认",
                "客服结算",
            )
        for order_key in ORDER_KEYS:
            self._perform_required_signoff(
                self.sales, order_key, "business_review", "业务审核", "业务员"
            )
        for order_key in ORDER_KEYS:
            self._perform_required_signoff(
                self.finance, order_key, "finance_review", "财务审核", "财务会计"
            )

        self._process_finance_settlement()
        self._handle_document_stage("账单", "对账与发票")
        self._process_cash()
        for session in self.warehouse_sessions:
            with session.step(
                f"{session.role} 核对并关闭目标订单未结异常",
                case_id=f"P4-EXCEPTION-{session.role.upper()}",
                stage="异常闭环",
                priority="P0",
                preconditions=("只处理本轮四票订单", "不创建人为异常"),
                inputs={"orders": [item.order_number for item in self.phase3.orders.values()]},
                expected_result="目标订单存在未结异常时逐条结案；无异常时不增加操作",
            ) as step:
                before = len(self.artifacts.closed_exceptions)
                self._close_target_exceptions(session)
                step.observe(
                    f"关闭 {len(self.artifacts.closed_exceptions) - before} 条目标异常",
                    gate_passed=True,
                )
        self._complete_reviews()
        if set(self.artifacts.archived_orders) != {
            item.order_number for item in self.phase3.orders.values()
        }:
            raise BusinessBlocker(
                "四票订单没有全部进入完成归档",
                owner="财务审核负责人",
                remediation="逐票核对复盘、余额和工作流完成状态。",
            )
        self.harness.assert_certifiable()
        return self.artifacts


def _redact_reason(reason: str, records: Sequence[CredentialRecord]) -> str:
    result = reason
    for record in records:
        for secret in (record.email, record.password):
            if secret:
                result = result.replace(secret, "[REDACTED]")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="承接 Phase 3，通过可见浏览器交互完成费用结算、异常闭环与复盘归档。"
    )
    parser.add_argument("--phase3-summary", type=Path, required=True)
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument(
        "--output-root", type=Path, default=HERE / "artifacts" / "tms-ui-e2e"
    )
    parser.add_argument(
        "--fixture-file",
        type=Path,
        default=HERE / "fixtures" / "tms-phase4-settlement-document.pdf",
    )
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--slow-mo", type=int, default=40)
    parser.add_argument("--timeout-ms", type=int, default=20_000)
    parser.add_argument("--navigation-timeout-ms", type=int, default=35_000)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="显式允许通过可见 UI 接续既有业务；未传入时只做无写入预检。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    phase3 = load_phase3_handoff(args.phase3_summary)
    vault = load_credentials(args.credentials_file)
    required = vault.select(REQUIRED_ACCOUNT_ALIASES)
    preflight = _public_preflight(
        vault,
        phase3,
        base_url=args.base_url,
        fixture_file=args.fixture_file,
    )
    if not args.execute:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0

    credentials = {item.alias: item for item in vault.records}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    run_id = (
        f"phase4-{safe_artifact_name(phase3.source_run_id)}-"
        f"{stamp}-{uuid.uuid4().hex[:8]}"
    )
    output_dir = args.output_root.resolve() / "phase4-resume" / run_id
    status = "failed"
    reason = ""
    summary_path: Path | None = None
    artifacts = Phase4Artifacts()

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
                scenario_name="1 FTL + 3 LTL 全流程第四阶段：费用、结算、异常闭环与复盘归档",
            )
            flow = Phase4Flow(
                harness=harness,
                credentials=credentials,
                phase3=phase3,
                fixture_file=args.fixture_file,
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
                reason = _redact_reason(reason, required)
                summary_path = harness.close(status=status)  # type: ignore[arg-type]
                if harness.last_status != status:
                    status = str(harness.last_status)
                    if not reason:
                        reason = harness.finalization_error or "步骤、门禁或证据汇总未通过"
    except Exception as error:
        status = "failed"
        reason = _redact_reason(f"{type(error).__name__}: {error}", required)

    handoff = build_handoff_payload(
        phase3,
        artifacts,
        ready_for_final_acceptance=status == "passed",
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
