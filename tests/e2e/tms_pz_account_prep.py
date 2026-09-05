#!/usr/bin/env python3
"""Prepare the two independent PZ assignee accounts through visible UI only.

The production PZ gate deliberately requires a new operation owner and a new
document owner.  The credential vault normally contains only the ordinary
order accounts, so this helper derives two runtime-only credentials from those
passwords and uses the HR administrator's visible ``用户管理`` page to create
the accounts.  Existing accounts are reused (and a disabled account is restored)
without creating duplicates.

No password is printed, serialized, written to a fixture, or included in a
Playwright trace.  The only business writes are clicks and keyboard input sent
through :class:`RoleBrowserSession`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from playwright.sync_api import Locator, sync_playwright


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from tms_ui_credentials import CredentialRecord, CredentialVault, load_credentials
from tms_ui_harness import GateExpectation, RoleBrowserSession, TmsUIHarness


RUNTIME_SOURCE_ALIASES = ("operation", "document")
REQUIRED_SOURCE_ALIASES = ("hr_admin", *RUNTIME_SOURCE_ALIASES)


@dataclass(frozen=True, slots=True)
class SecondaryPzAccountSpec:
    alias: str
    source_alias: str
    email: str
    display_name: str
    department_name: str
    position_name: str


SECONDARY_PZ_ACCOUNT_SPECS = (
    SecondaryPzAccountSpec(
        alias="operation_2",
        source_alias="operation",
        email="pz-operation-2@e2e.test",
        display_name="PZ接管操作二号",
        department_name="操作部",
        position_name="操作岗（含运踪）",
    ),
    SecondaryPzAccountSpec(
        alias="document_2",
        source_alias="document",
        email="pz-document-2@e2e.test",
        display_name="PZ接管单证二号",
        department_name="操作部",
        position_name="单证岗",
    ),
)


@dataclass(frozen=True, slots=True)
class AccountPreparationResult:
    alias: str
    display_name: str
    position_name: str
    outcome: str

    def public_summary(self) -> dict[str, str]:
        return {
            "alias": self.alias,
            "display_name": self.display_name,
            "position_name": self.position_name,
            "outcome": self.outcome,
        }


def _credential_mapping(
    credentials: Mapping[str, CredentialRecord] | CredentialVault,
) -> dict[str, CredentialRecord]:
    records = credentials.records if isinstance(credentials, CredentialVault) else credentials.values()
    return {item.alias: item for item in records}


def build_pz_runtime_credentials(
    credentials: Mapping[str, CredentialRecord] | CredentialVault,
) -> dict[str, CredentialRecord]:
    """Add secondary aliases while keeping their passwords only in memory."""

    result = _credential_mapping(credentials)
    missing = [alias for alias in RUNTIME_SOURCE_ALIASES if alias not in result]
    if missing:
        raise ValueError("准备 PZ 独立负责人缺少运行时账号别名：" + "、".join(missing))
    for spec in SECONDARY_PZ_ACCOUNT_SPECS:
        if spec.alias in result:
            continue
        source = result[spec.source_alias]
        result[spec.alias] = CredentialRecord(
            alias=spec.alias,
            site="admin",
            department=source.department,
            role=spec.display_name,
            email=spec.email,
            password=source.password,
            permissions_hint=f"{spec.position_name}；仅用于 PZ 首次换人接管验收",
            source="runtime-derived",
        )
    return result


def public_preflight(
    credentials: Mapping[str, CredentialRecord] | CredentialVault,
    *,
    base_url: str,
) -> dict[str, Any]:
    runtime = build_pz_runtime_credentials(credentials)
    missing = [alias for alias in REQUIRED_SOURCE_ALIASES if alias not in runtime]
    if missing:
        raise ValueError("准备 PZ 独立负责人缺少运行时账号别名：" + "、".join(missing))
    return {
        "status": "READY_NOT_EXECUTED",
        "business_writes": False,
        "base_url": base_url.rstrip("/"),
        "administrator_alias": "hr_admin",
        "accounts": [
            {
                "alias": spec.alias,
                "display_name": runtime[spec.alias].role,
                "position_name": spec.position_name,
                "password_source": spec.source_alias,
            }
            for spec in SECONDARY_PZ_ACCOUNT_SPECS
        ],
        "next_action": "显式传入 --execute 后，才会由人事账号通过用户管理页面幂等准备账号。",
    }


class SecondaryPzAccountPreparer:
    def __init__(
        self,
        *,
        harness: TmsUIHarness,
        credentials: Mapping[str, CredentialRecord] | CredentialVault,
    ) -> None:
        self.harness = harness
        self.credentials = build_pz_runtime_credentials(credentials)
        if "hr_admin" not in self.credentials:
            raise ValueError("准备 PZ 独立负责人缺少运行时账号别名：hr_admin")
        hr = self.credentials["hr_admin"]
        self.session = harness.add_role("hr_admin_account_prep", hr.email, hr.site)

    @staticmethod
    def _is_visible(locator: Locator) -> bool:
        return locator.count() > 0 and locator.first.is_visible()

    def _dismiss_required_notifications(self) -> None:
        for _ in range(8):
            candidates = self.session.page.get_by_role(
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
            self.session.click(visible, "确认人事账号重要通知")
            self.session.page.wait_for_timeout(120)
        raise RuntimeError("人事账号的重要通知确认出现循环")

    def _login_and_open_users(self) -> None:
        hr = self.credentials["hr_admin"]
        with self.session.step(
            "人事行政岗进入用户管理准备 PZ 独立负责人",
            case_id="PZ-ACCOUNT-PREP-LOGIN",
            stage="验收账号准备",
            priority="P0",
            preconditions=("运行时凭据含人事行政岗", "使用独立浏览器上下文"),
            inputs={"account_alias": "hr_admin", "site": hr.site},
            expected_result="人事账号登录成功，用户管理入口和服务端 user.manage 权限一致",
            gate=GateExpectation(
                name="PZ 验收账号的人事维护权限",
                source="role_permission_configuration",
                configured_mode="operate",
                expected_behavior="allow",
                ui_expectation="人事岗可见用户管理和新增/恢复账号控件。",
                server_expectation="只有 user.manage 岗位可创建或恢复组织成员。",
                owner_role="人事行政岗",
                remediation="核对人事岗位的 user.view/user.manage 权限与用户管理路由。",
            ),
            sensitive=True,
            screenshot_on_pass=False,
        ) as observation:
            self.session.login(hr.password)
            self._dismiss_required_notifications()
            navigation = self.session.page.get_by_role("navigation", name="运营管理导航")
            link = navigation.get_by_role("link", name="用户管理", exact=True)
            self.session.expect_visible(link, "用户管理菜单")
            self.session.click(link, "进入用户管理")
            self.session.expect_visible(
                self.session.page.get_by_role("heading", name="用户管理", exact=True),
                "用户管理页面",
            )
            observation.observe("人事行政岗已进入用户管理", gate_passed=True)
        self.session.start_trace("pz-account-preparation-visible-actions")

    @staticmethod
    def _option_value_containing(select: Locator, expected_text: str) -> str:
        options = select.locator("option")
        for index in range(options.count()):
            option = options.nth(index)
            label = str(option.text_content() or "").strip()
            if label == expected_text or label.endswith(expected_text):
                return str(option.get_attribute("value") or "")
        return ""

    def _select_placement(self, form: Locator, spec: SecondaryPzAccountSpec) -> None:
        department = form.locator('select[name="departmentId"]')
        department_value = self._option_value_containing(
            department, spec.department_name
        )
        if not department_value:
            raise RuntimeError(f"用户管理没有可选部门：{spec.department_name}")
        self.session.select(
            department,
            f"{spec.alias} 归属部门",
            value=department_value,
        )
        self.session.page.wait_for_timeout(120)
        position = form.locator('select[name="positionId"]')
        position_value = self._option_value_containing(position, spec.position_name)
        if not position_value:
            raise RuntimeError(f"用户管理没有可选岗位：{spec.position_name}")
        self.session.select(
            position,
            f"{spec.alias} 归属岗位",
            value=position_value,
        )

    def _member_row(self, credential: CredentialRecord) -> Locator:
        return self.session.page.locator("section.panel table tbody tr").filter(
            has_text=credential.email
        )

    @staticmethod
    def _row_position_matches(row: Locator, expected: str) -> bool:
        select = row.first.locator('select[name="positionId"]')
        if select.count() > 0:
            selected_value = str(select.first.input_value() or "")
            options = select.first.locator("option")
            for index in range(options.count()):
                option = options.nth(index)
                if str(option.get_attribute("value") or "") != selected_value:
                    continue
                return str(option.text_content() or "").strip() == expected
            return False
        return expected in row.first.inner_text(timeout=3_000)

    def _ensure_existing_account(
        self,
        spec: SecondaryPzAccountSpec,
        credential: CredentialRecord,
        row: Locator,
    ) -> AccountPreparationResult:
        outcome = "existing"
        row_text = row.first.inner_text(timeout=3_000)
        if "已停用" in row_text:
            restore = row.first.get_by_role("button", name="恢复", exact=True)
            self.session.expect_visible(restore, f"{spec.alias} 恢复按钮")
            self.session.click(restore, f"恢复 {spec.alias}")
            self.session.expect_visible(
                self._member_row(credential).first.get_by_text("有效", exact=True),
                f"{spec.alias} 已恢复有效",
            )
            row = self._member_row(credential)
            outcome = "restored"

        if not self._row_position_matches(row, spec.position_name):
            form = row.first.locator("form.member-placement-form")
            self.session.expect_visible(form, f"{spec.alias} 组织归属表单")
            self._select_placement(form, spec)
            self.session.click(
                form.get_by_role("button", name="保存归属", exact=True),
                f"保存 {spec.alias} 归属",
            )
            self.session.expect_visible(
                self.session.page.locator(".alert.success").filter(
                    has_text="用户的部门和岗位已更新"
                ),
                f"{spec.alias} 岗位校正成功提示",
            )
            if not self._row_position_matches(
                self._member_row(credential), spec.position_name
            ):
                raise AssertionError(f"{spec.alias} 岗位保存后未更新")
            outcome = "placement_corrected" if outcome == "existing" else outcome + "_and_corrected"

        return AccountPreparationResult(
            spec.alias,
            credential.role,
            spec.position_name,
            outcome,
        )

    def _create_account(
        self,
        spec: SecondaryPzAccountSpec,
        credential: CredentialRecord,
    ) -> AccountPreparationResult:
        self.session.click(
            self.session.page.get_by_role("button", name="新增用户", exact=True),
            f"新增 {spec.alias}",
        )
        dialog = self.session.page.get_by_role("dialog", name="创建用户")
        self.session.expect_visible(dialog, f"{spec.alias} 创建用户弹窗")
        self.session.type_text(
            dialog.locator('input[name="displayName"]'),
            credential.role,
            f"{spec.alias} 姓名",
        )
        self.session.type_text(
            dialog.locator('input[name="email"]'),
            credential.email,
            f"{spec.alias} 登录邮箱",
            sensitive=True,
        )
        self._select_placement(dialog.locator("form"), spec)
        self.session.type_text(
            dialog.locator('input[name="password"]'),
            credential.password,
            f"{spec.alias} 初始密码",
            sensitive=True,
        )
        self.session.click(
            dialog.get_by_role("button", name="创建用户", exact=True),
            f"确认创建 {spec.alias}",
            sensitive=True,
        )
        self.session.expect_visible(
            self.session.page.locator(".alert.success").filter(has_text="用户已创建"),
            f"{spec.alias} 创建成功提示",
        )
        created_row = self._member_row(credential)
        self.session.expect_visible(created_row, f"{spec.alias} 成员行")
        if not self._row_position_matches(created_row, spec.position_name):
            raise AssertionError(f"{spec.alias} 创建后岗位不一致")
        return AccountPreparationResult(
            spec.alias,
            credential.role,
            spec.position_name,
            "created",
        )

    def run(self) -> tuple[AccountPreparationResult, ...]:
        self._login_and_open_users()
        results: list[AccountPreparationResult] = []
        for spec in SECONDARY_PZ_ACCOUNT_SPECS:
            credential = self.credentials[spec.alias]
            with self.session.step(
                f"幂等准备 {spec.alias} 并绑定{spec.position_name}",
                case_id=f"PZ-ACCOUNT-PREP-{spec.alias.upper()}",
                stage="验收账号准备",
                priority="P0",
                preconditions=("人事岗已进入用户管理", "账号标识固定且不重复"),
                inputs={
                    "account_alias": spec.alias,
                    "display_name": credential.role,
                    "position_name": spec.position_name,
                },
                expected_result="账号存在、有效且岗位正确；已存在时不创建重复账号",
                gate=GateExpectation(
                    name=f"{spec.alias} 组织岗位完整性",
                    source="system_integrity_invariant",
                    configured_mode="required",
                    expected_behavior="allow",
                    ui_expectation="用户管理表只保留一个有效账号并显示正确岗位。",
                    server_expectation="邮箱唯一，membership、position 和自动角色保持一致。",
                    owner_role="人事行政岗",
                    remediation="通过用户管理恢复或校正账号归属，不得直接修改数据库。",
                ),
                sensitive=True,
                screenshot_on_pass=False,
            ) as observation:
                row = self._member_row(credential)
                result = (
                    self._ensure_existing_account(spec, credential, row)
                    if row.count() > 0
                    else self._create_account(spec, credential)
                )
                results.append(result)
                self.harness.journal.register_entity(
                    "pz_runtime_account", spec.alias, credential.role
                )
                observation.observe(
                    f"{spec.alias}：{result.outcome}，岗位 {spec.position_name}",
                    gate_passed=True,
                )
        return tuple(results)


def prepare_secondary_pz_accounts(
    *,
    harness: TmsUIHarness,
    credentials: Mapping[str, CredentialRecord] | CredentialVault,
) -> tuple[dict[str, CredentialRecord], tuple[AccountPreparationResult, ...]]:
    runtime = build_pz_runtime_credentials(credentials)
    results = SecondaryPzAccountPreparer(
        harness=harness,
        credentials=runtime,
    ).run()
    return runtime, results


def _redact_reason(reason: str, credentials: Sequence[CredentialRecord]) -> str:
    safe = reason
    values = [item.email for item in credentials] + [item.password for item in credentials]
    for value in sorted((item for item in values if item), key=len, reverse=True):
        safe = safe.replace(value, "<redacted>")
    return safe[:2_000]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="通过人事行政岗可见 UI 幂等准备 PZ 独立操作/单证账号。"
    )
    parser.add_argument("--credentials-file", type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:5189")
    parser.add_argument("--output-root", type=Path, default=Path("output/playwright"))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--slow-mo", type=int, default=40)
    parser.add_argument("--timeout-ms", type=int, default=20_000)
    parser.add_argument("--navigation-timeout-ms", type=int, default=35_000)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="显式允许通过用户管理页面创建/恢复账号；未传入时仅做无写入预检。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    vault = load_credentials(args.credentials_file)
    preflight = public_preflight(vault, base_url=args.base_url)
    if not args.execute:
        print(json.dumps(preflight, ensure_ascii=False, indent=2))
        return 0

    credentials = build_pz_runtime_credentials(vault)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    run_id = f"pz-account-prep-{stamp}-{uuid.uuid4().hex[:8]}"
    output_dir = args.output_root.resolve() / "pz-account-prep" / run_id
    status = "failed"
    reason = ""
    results: tuple[AccountPreparationResult, ...] = ()
    summary_path: Path | None = None

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
                scenario_name="PZ 首次换人：纯 UI 准备独立操作与单证账号",
            )
            try:
                credentials, results = prepare_secondary_pz_accounts(
                    harness=harness,
                    credentials=credentials,
                )
                status = "passed"
            except Exception as error:
                reason = _redact_reason(
                    f"{type(error).__name__}: {error}", tuple(credentials.values())
                )
                harness.journal.add_note("账号准备失败：" + reason)
            finally:
                summary_path = harness.close(status=status)  # type: ignore[arg-type]
                if harness.last_status != status:
                    status = str(harness.last_status)
                    if not reason:
                        reason = harness.finalization_error or "步骤、门禁或证据汇总未通过"
    except Exception as error:
        reason = _redact_reason(
            f"{type(error).__name__}: {error}", tuple(credentials.values())
        )

    output = {
        "status": status,
        "run_id": run_id,
        "summary": str(summary_path) if summary_path else "",
        "accounts": [item.public_summary() for item in results],
        "reason": reason,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
