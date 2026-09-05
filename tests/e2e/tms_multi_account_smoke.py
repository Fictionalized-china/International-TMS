#!/usr/bin/env python3
"""UI-only multi-account login and navigation-permission smoke scenario.

No account values are embedded here.  Supply ``--credentials-file`` or one of
the environment formats supported by ``tms_ui_credentials``.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from tms_ui_credentials import CredentialRecord, load_credentials
from tms_ui_harness import GateExpectation, RoleBrowserSession, TmsUIHarness


@dataclass(frozen=True, slots=True)
class NavigationContract:
    navigation_name: str
    required: tuple[str, ...]
    forbidden: tuple[str, ...] = ()


PORTAL_CONTRACT = NavigationContract(
    "客户门户导航",
    ("我的首页", "运费试算", "我的订单", "运输轨迹", "账单与文件", "通知", "账户中心"),
)
DOMESTIC_WAREHOUSE_CONTRACT = NavigationContract(
    "仓库作业导航",
    ("通知", "仓库作业总表", "验收收货", "货物配载", "配载文件", "在仓待装", "装车与出库", "仓库货物与盘点", "异常处理", "仓库与库位"),
    ("扫码自提签收",),
)
OVERSEAS_WAREHOUSE_CONTRACT = NavigationContract(
    "仓库作业导航",
    ("通知", "仓库作业总表", "验收收货", "扫码自提签收", "仓库货物与盘点", "异常处理", "仓库与库位"),
    ("货物配载", "配载文件", "在仓待装", "装车与出库"),
)
ADMIN_BASE = ("任务工作台", "通知")

# These are deliberate baseline contracts, derived from the repository's
# published position/permission model.  They are not business workflow gates.
ADMIN_ROLE_CONTRACTS: tuple[tuple[re.Pattern[str], NavigationContract], ...] = (
    (re.compile(r"老板|所有者|owner|boss", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "询价与报价", "运输订单", "费用结算", "客户管理", "业务工作流", "角色权限", "审计日志"),
    )),
    (re.compile(r"开发|developer", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "业务工作流", "基础数据", "角色权限", "审计日志"),
        ("费用结算",),
    )),
    (re.compile(r"业务主管|business_supervisor", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单"),
        ("询价与报价", "费用结算", "客户管理", "角色权限"),
    )),
    (re.compile(r"操作主管|operation_supervisor", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "在途车辆", "配载单跟踪", "承运商管理"),
        ("询价与报价", "费用结算", "客户管理", "角色权限"),
    )),
    (re.compile(r"单证|document", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "在途车辆", "配载单跟踪", "文件中心"),
        ("询价与报价", "费用结算", "客户管理", "角色权限"),
    )),
    (re.compile(r"操作岗|操作员|运踪|operation|tracking", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "在途车辆", "配载单跟踪", "运单列表", "承运商管理"),
        ("询价与报价", "费用结算", "客户管理", "角色权限"),
    )),
    (re.compile(r"客服|customer_service", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "费用结算", "货物信息", "客户管理"),
        ("询价与报价", "角色权限"),
    )),
    (re.compile(r"财务|会计|finance", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "费用结算", "审计日志"),
        ("询价与报价", "客户管理", "角色权限"),
    )),
    (re.compile(r"出纳|cashier", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "运输订单", "费用结算"),
        ("询价与报价", "客户管理", "角色权限"),
    )),
    (re.compile(r"人事|行政|hr_admin", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "部门管理", "岗位管理", "用户管理", "角色权限", "安全中心", "审计日志"),
        ("询价与报价", "运输订单", "费用结算", "客户管理"),
    )),
    (re.compile(r"商务报价|business_route|前端配载|front_loading", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE,
        ("询价与报价", "运输订单", "在途车辆", "配载单跟踪", "费用结算", "客户管理", "角色权限"),
    )),
    (re.compile(r"业务岗|业务员|销售|sales", re.I), NavigationContract(
        "运营管理导航",
        ADMIN_BASE + ("运营总览", "询价与报价", "运输订单", "客户管理", "销售管理"),
        ("费用结算", "角色权限", "用户管理"),
    )),
)


def contract_for(record: CredentialRecord) -> NavigationContract:
    searchable = f"{record.alias} {record.department} {record.role}"
    if record.site == "portal":
        return PORTAL_CONTRACT
    if record.site == "warehouse":
        if re.search(r"境外|海外|overseas", searchable, re.I):
            return OVERSEAS_WAREHOUSE_CONTRACT
        return DOMESTIC_WAREHOUSE_CONTRACT
    for pattern, contract in ADMIN_ROLE_CONTRACTS:
        if pattern.search(searchable):
            return contract
    return NavigationContract("运营管理导航", ADMIN_BASE)


def _landing_pattern(site: str) -> re.Pattern[str]:
    return {
        "admin": re.compile(r"^/admin(?:/|$)"),
        "portal": re.compile(r"^/portal(?:/|$)"),
        "warehouse": re.compile(r"^/warehouse(?:/|$)"),
    }[site]


def _permission_expectation(record: CredentialRecord, title: str) -> GateExpectation:
    return GateExpectation(
        name=title,
        source="role_permission_configuration",
        configured_mode="read_only",
        expected_behavior="allow",
        ui_expectation="站点首页和导航菜单与岗位权限积木、个人覆盖和站点授权一致",
        server_expectation="登录成功；无权菜单不渲染，后续负向深链仍由服务端拒绝",
        owner_role=record.role,
        remediation="核对账号岗位、角色权限、个人允许/拒绝覆盖和仓库绑定",
    )


def _assert_no_error_page(session: RoleBrowserSession) -> None:
    error_text = session.locator("body").get_by_text(
        re.compile(r"请求失败\s*[（(]?403|Forbidden|SYSTEM RECOVERY", re.I)
    )
    session.expect_hidden(error_text, "403/系统恢复错误页")


def _nav_link(nav: object, label: str) -> object:
    if label == "通知":
        return nav.get_by_role(
            "link",
            name=re.compile(r"^通知(?:\s*(?:\d+|99\+))?$"),
        )
    return nav.get_by_role("link", name=label, exact=True)


def run_account_smoke(
    harness: TmsUIHarness,
    records: Sequence[CredentialRecord],
) -> list[dict[str, str]]:
    outcomes: list[dict[str, str]] = []
    for record in records:
        session = harness.add_role(record.alias, record.email, record.site)
        contract = contract_for(record)
        login_case = f"AUTH-{record.alias.upper().replace('-', '_')}"
        try:
            with session.step(
                f"{record.role}登录{record.site}站点",
                case_id=login_case,
                stage="多账号登录冒烟",
                priority="P0",
                preconditions=("服务端可访问", "账号凭据仅从运行时秘密源读取"),
                inputs={"credential_alias": record.alias, "site": record.site},
                expected_result="账号经可见登录页进入正确站点，且页面不是 403/恢复页。",
                gate=_permission_expectation(record, "站点登录权限"),
                sensitive=True,
            ) as observation:
                session.login(record.password)
                session.expect_url_path(_landing_pattern(record.site), "登录后站点")
                _assert_no_error_page(session)
                observation.observe("已进入正确站点首页，未出现 403。", gate_passed=True)
        except Exception as error:
            outcomes.append({"alias": record.alias, "site": record.site, "status": "failed", "stage": "login", "error": type(error).__name__})
            continue

        session.start_trace("导航权限冒烟")
        try:
            with session.step(
                f"{record.role}导航菜单与权限配置一致",
                case_id=f"NAV-{record.alias.upper().replace('-', '_')}",
                stage="菜单可见性冒烟",
                priority="P0",
                preconditions=("登录步骤通过",),
                inputs={"credential_alias": record.alias, "site": record.site},
                expected_result="应有菜单可见；无权菜单完全隐藏而非禁用；页面无 403。",
                gate=_permission_expectation(record, "导航菜单可见性"),
            ) as observation:
                nav = session.locator(f'nav[aria-label="{contract.navigation_name}"]')
                session.expect_visible(nav, contract.navigation_name)
                for label in contract.required:
                    session.expect_visible(_nav_link(nav, label), f"应显示菜单：{label}")
                for label in contract.forbidden:
                    session.expect_hidden(_nav_link(nav, label), f"应隐藏菜单：{label}")
                _assert_no_error_page(session)
                observation.observe(
                    f"核对 {len(contract.required)} 个应显示菜单和 {len(contract.forbidden)} 个应隐藏菜单。",
                    gate_passed=True,
                )
            outcomes.append({"alias": record.alias, "site": record.site, "status": "passed", "stage": "complete", "error": ""})
        except Exception as error:
            outcomes.append({"alias": record.alias, "site": record.site, "status": "failed", "stage": "navigation", "error": type(error).__name__})
        finally:
            session.stop_trace()
    return outcomes


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="TMS 多账号纯 UI 登录与菜单权限冒烟")
    parser.add_argument("--credentials-file", type=Path, help="运行时凭据 Markdown；也可用 TMS_E2E_CREDENTIALS_FILE")
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument("--output-root", type=Path, default=Path("output/playwright"))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--roles", default="", help="逗号分隔的凭据别名；默认全部")
    parser.add_argument("--headless", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--slow-mo", type=int, default=35)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    vault = load_credentials(args.credentials_file)
    aliases = [item.strip() for item in args.roles.split(",") if item.strip()]
    records = vault.select(aliases)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    run_id = args.run_id.strip() or f"multi-account-permission-smoke-{stamp}"
    output_dir = args.output_root.resolve() / run_id

    from playwright.sync_api import sync_playwright

    harness: TmsUIHarness | None = None
    outcomes: list[dict[str, str]] = []
    try:
        with sync_playwright() as playwright:
            harness = TmsUIHarness(
                playwright,
                run_id=run_id,
                output_dir=output_dir,
                base_url=args.base_url,
                headless=args.headless,
                slow_mo=args.slow_mo,
                scenario_name="多账号登录与导航权限纯 UI 冒烟",
            )
            outcomes = run_account_smoke(harness, records)
            failed = [item for item in outcomes if item["status"] != "passed"]
            summary = harness.close(status="failed" if failed else "passed")
            harness = None
    except Exception as error:
        if harness is not None:
            summary = harness.close(status="failed")
            harness = None
        else:
            summary = output_dir / "summary.json"
        print(json.dumps({"status": "FAILED", "error": type(error).__name__, "summary": str(summary)}, ensure_ascii=False))
        return 1

    failed = [item for item in outcomes if item["status"] != "passed"]
    print(json.dumps({
        "status": "FAILED" if failed else "PASSED",
        "accounts": len(outcomes),
        "failed": len(failed),
        "outcomes": outcomes,
        "summary": str(summary),
    }, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
