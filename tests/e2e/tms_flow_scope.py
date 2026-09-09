"""Shared execution scope for the split visible-browser demonstrations."""

from __future__ import annotations

from typing import Literal


FlowScope = Literal["combined", "ftl", "pz"]


def normalize_flow_scope(value: str | None) -> FlowScope:
    rendered = str(value or "combined").strip().lower()
    aliases = {
        "combined": "combined",
        "all": "combined",
        "ftl": "ftl",
        "full-truck": "ftl",
        "pz": "pz",
        "ltl": "pz",
        "consolidation": "pz",
    }
    try:
        return aliases[rendered]  # type: ignore[return-value]
    except KeyError as error:
        raise ValueError(f"不支持的演示范围：{value}") from error


def order_keys_for_scope(scope: FlowScope) -> tuple[str, ...]:
    if scope == "ftl":
        return ("ftl",)
    if scope == "pz":
        return ("ltl1", "ltl2", "ltl3")
    return ("ftl", "ltl1", "ltl2", "ltl3")


def ltl_keys_for_scope(scope: FlowScope) -> tuple[str, ...]:
    return () if scope == "ftl" else ("ltl1", "ltl2", "ltl3")


def dispatch_keys_for_scope(scope: FlowScope) -> tuple[str, ...]:
    if scope == "ftl":
        return ("ftl",)
    if scope == "pz":
        return ("ltl_batch",)
    return ("ftl", "ltl_batch")


def phase2_stages_for_scope(scope: FlowScope) -> tuple[str, ...]:
    common = ("domestic_transport", "domestic_receiving")
    if scope == "ftl":
        return (*common, "ftl_loading_outbound")
    pz = (
        "secondary_pz_account_preparation",
        *common,
        "ltl_consolidation",
        "batch_assignment",
        "batch_loading_outbound",
        "batch_sync_and_drawer_assertions",
    )
    if scope == "pz":
        return pz
    return (
        "secondary_pz_account_preparation",
        *common,
        "ftl_loading_outbound",
        "ltl_consolidation",
        "batch_assignment",
        "batch_loading_outbound",
        "batch_sync_and_drawer_assertions",
    )


def phase3_stages_for_scope(scope: FlowScope) -> tuple[str, ...]:
    shared_tail = (
        "overseas_original_label_inbound",
        "customer_notification_and_optional_appointment",
        "overseas_pickup_scan_and_signoff",
    )
    if scope == "ftl":
        return ("ftl_customs_release", "ftl_actual_exit_and_tracking", *shared_tail)
    if scope == "pz":
        return ("batch_customs_release", "batch_actual_exit_and_tracking", *shared_tail)
    return (
        "customs_permission_alignment",
        "ftl_customs_release",
        "batch_customs_release",
        "ftl_actual_exit_and_tracking",
        "batch_actual_exit_and_tracking",
        *shared_tail,
    )
