"""Reusable browser-only harness for International TMS acceptance scenarios.

This module deliberately accepts Playwright objects by duck typing so its
journal and policy helpers stay unit-testable without launching a browser.
Business scenarios should use ``RoleBrowserSession`` methods instead of raw
page mutation APIs.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
import uuid
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Mapping, Sequence
from urllib.parse import urljoin, urlparse


Site = Literal["admin", "portal", "warehouse"]
LOGIN_PATH_BY_SITE: dict[Site, str] = {
    "admin": "/login",
    "portal": "/portal/login",
    "warehouse": "/warehouse/login",
}
LOGIN_BUTTON_BY_SITE: dict[Site, str] = {
    "admin": "登录后台",
    "portal": "进入客户门户",
    "warehouse": "进入仓库作业",
}
LANDING_PATTERN_BY_SITE: dict[Site, re.Pattern[str]] = {
    "admin": re.compile(r"/admin(?:/|$|\?)"),
    "portal": re.compile(r"/portal/?(?:\?.*)?$"),
    "warehouse": re.compile(r"/warehouse/?(?:\?.*)?$"),
}
SENSITIVE_TARGET = re.compile(r"(?i)(?:password|secret|token|密码|凭证)")
SENSITIVE_INPUT_KEY = re.compile(r"(?i)(?:password|secret|token|email|account|密码|凭证|邮箱|账号)")
EMAIL_TEXT = re.compile(r"(?i)(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,}(?![\w.-])")

GateSource = Literal[
    "workflow_instance_field_configuration",
    "workflow_instance_module_state",
    "role_permission_configuration",
    "system_integrity_invariant",
]
GateMode = Literal["required", "optional", "hidden", "read_only", "not_applicable"]
ExpectedGateBehavior = Literal["allow", "block", "hide", "read_only"]
CasePriority = Literal["P0", "P1", "P2", "P3"]
RunStatus = Literal["running", "passed", "failed", "blocked", "aborted", "planned"]


@dataclass(frozen=True, slots=True)
class GateExpectation:
    """Expected UI and server behavior derived from one authoritative source.

    Workflow gates must point at the order's workflow-instance field/module
    configuration.  Permission-only checks use the role permission source, and
    non-configurable uniqueness/safety rules use the integrity source.
    """

    name: str
    source: GateSource
    configured_mode: GateMode
    expected_behavior: ExpectedGateBehavior
    ui_expectation: str
    server_expectation: str
    owner_role: str = ""
    remediation: str = ""

    def __post_init__(self) -> None:
        required = {
            "name": self.name,
            "ui_expectation": self.ui_expectation,
            "server_expectation": self.server_expectation,
        }
        missing = [name for name, value in required.items() if not value.strip()]
        if missing:
            raise ValueError("门禁期望缺少字段：" + "、".join(missing))
        workflow_sources = {
            "workflow_instance_field_configuration",
            "workflow_instance_module_state",
        }
        if self.source in workflow_sources and self.configured_mode == "not_applicable":
            raise ValueError("工作流门禁必须记录实例中的字段/模块配置模式")


@dataclass(slots=True)
class StepObservation:
    """Mutable result supplied by a scenario while a case step is running."""

    actual_result: str = ""
    gate_passed: bool | None = None
    notes: list[str] = field(default_factory=list)

    def observe(self, actual_result: str, *, gate_passed: bool | None = None) -> None:
        if actual_result.strip():
            self.actual_result = actual_result.strip()
        if gate_passed is not None:
            self.gate_passed = gate_passed

    def add_note(self, note: str) -> None:
        if note.strip():
            self.notes.append(note.strip())


@dataclass(frozen=True, slots=True)
class AttemptIdentity:
    """Unique, non-reusable identity for one end-to-end business-data attempt."""

    series_id: str
    attempt: int
    run_id: str
    entity_prefix: str
    output_dir: Path


class AttemptSeries:
    """Persists a retry ledger and guarantees fresh entity names after failure.

    This ledger only writes test evidence under the output directory.  It never
    reads or mutates TMS business storage.
    """

    schema = "international-tms-ui-attempt-series/v1"

    def __init__(self, series_id: str, output_root: Path | str) -> None:
        if not series_id.strip():
            raise ValueError("series_id 不能为空")
        self.series_id = safe_artifact_name(series_id)
        self.root = Path(output_root).resolve() / self.series_id
        self.root.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.root / "attempts.json"
        self._manifest = self._read_manifest()

    def _read_manifest(self) -> dict[str, Any]:
        if not self.manifest_path.exists():
            return {"schema": self.schema, "series_id": self.series_id, "attempts": []}
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8-sig"))
        if payload.get("schema") != self.schema or payload.get("series_id") != self.series_id:
            raise ValueError("attempts.json 与当前测试系列不匹配")
        if not isinstance(payload.get("attempts"), list):
            raise ValueError("attempts.json 缺少 attempts 数组")
        return payload

    def _flush(self) -> None:
        temporary = self.root / ".attempts.json.tmp"
        temporary.write_text(
            json.dumps(self._manifest, ensure_ascii=False, indent=2),
            encoding="utf-8-sig",
        )
        temporary.replace(self.manifest_path)

    def begin_attempt(self) -> AttemptIdentity:
        attempts = self._manifest["attempts"]
        if attempts and attempts[-1].get("status") == "running":
            raise RuntimeError("上一轮 attempt 仍为 running，必须先明确结束状态")
        attempt = len(attempts) + 1
        nonce = uuid.uuid4().hex[:8]
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        run_id = f"{self.series_id}-a{attempt:03d}-{stamp}-{nonce}"
        entity_prefix = f"UIE2E-{stamp}-A{attempt:03d}-{nonce.upper()}"
        output_dir = self.root / run_id
        output_dir.mkdir(parents=True, exist_ok=False)
        attempts.append(
            {
                "attempt": attempt,
                "run_id": run_id,
                "entity_prefix": entity_prefix,
                "output_dir": str(output_dir),
                "status": "running",
                "started_at": utc_now(),
                "finished_at": "",
                "reason": "",
            }
        )
        self._flush()
        return AttemptIdentity(self.series_id, attempt, run_id, entity_prefix, output_dir)

    def finish_attempt(
        self,
        identity: AttemptIdentity,
        *,
        status: Literal["passed", "failed", "blocked", "aborted"],
        reason: str = "",
    ) -> None:
        attempts = self._manifest["attempts"]
        row = next((item for item in attempts if item.get("run_id") == identity.run_id), None)
        if row is None:
            raise ValueError("attempt 不属于当前测试系列")
        if row.get("status") != "running":
            raise RuntimeError("attempt 已结束，不能重复写入结果")
        row.update(status=status, finished_at=utc_now(), reason=reason.strip()[:2000])
        self._flush()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def safe_artifact_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^0-9A-Za-z._-]+", "-", normalized).strip("-.").lower() or "artifact"


def login_path_for_site(site: Site) -> str:
    try:
        return LOGIN_PATH_BY_SITE[site]
    except KeyError as error:
        raise ValueError(f"未知站点：{site}") from error


def _safe_detail(detail: Mapping[str, Any] | None) -> dict[str, Any]:
    result = dict(detail or {})
    if result.pop("sensitive", False):
        value = str(result.pop("value", ""))
        result["value_length"] = len(value)
        result["redacted"] = True
    return result


def _safe_case_inputs(inputs: Mapping[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in dict(inputs or {}).items():
        if SENSITIVE_INPUT_KEY.search(str(key)):
            result[str(key)] = {
                "redacted": True,
                "value_length": len(str(value)) if value is not None else 0,
            }
        elif isinstance(value, Mapping):
            result[str(key)] = _safe_case_inputs(value)
        elif isinstance(value, (list, tuple)):
            result[str(key)] = ["<redacted>" if SENSITIVE_TARGET.search(str(item)) else item for item in value]
        else:
            result[str(key)] = value
    return result


def redact_evidence_text(value: str) -> str:
    """Remove login identifiers from failure text before it reaches disk."""

    return EMAIL_TEXT.sub("<redacted-email>", value)


class RunJournal:
    """Append-only in-memory journal with atomic JSON snapshots."""

    schema = "international-tms-ui-only-run/v2"

    def __init__(
        self,
        run_id: str,
        output_dir: Path | str,
        *,
        attempt: AttemptIdentity | None = None,
        scenario_name: str = "",
        base_url: str = "",
    ) -> None:
        if not run_id.strip():
            raise ValueError("run_id 不能为空")
        self.run_id = run_id.strip()
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.started_at = utc_now()
        self.attempt = attempt
        self.scenario_name = scenario_name.strip()
        self.base_url = base_url.rstrip("/")
        self.actions: list[dict[str, Any]] = []
        self.steps: list[dict[str, Any]] = []
        self.gates: list[dict[str, Any]] = []
        self.thought_events: list[dict[str, Any]] = []
        self.evidence: list[dict[str, Any]] = []
        self.entities: dict[str, dict[str, str]] = {}
        self.notes: list[str] = []

    def record_action(
        self,
        *,
        role: str,
        kind: str,
        target: str,
        status: str,
        started_at: str,
        ended_at: str,
        duration_ms: int,
        url_before: str,
        url_after: str,
        detail: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        event = {
            "sequence": len(self.actions) + 1,
            "role": role,
            "kind": kind,
            "target": target,
            "status": status,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_ms": duration_ms,
            "url_before": url_before,
            "url_after": url_after,
            "detail": _safe_detail(detail),
        }
        self.actions.append(event)
        return event

    def record_gate(
        self,
        *,
        role: str,
        name: str,
        expected: str,
        passed: bool,
        actual: str,
        owner: str = "",
        remediation: str = "",
        url: str = "",
        source: GateSource | str = "",
        configured_mode: GateMode | str = "",
        expected_behavior: ExpectedGateBehavior | str = "",
        ui_expectation: str = "",
        server_expectation: str = "",
        case_id: str = "",
    ) -> None:
        self.gates.append(
            {
                "sequence": len(self.gates) + 1,
                "at": utc_now(),
                "role": role,
                "name": name,
                "expected": expected,
                "passed": passed,
                "actual": actual,
                "owner": owner,
                "remediation": remediation,
                "url": url,
                "source": source,
                "configured_mode": configured_mode,
                "expected_behavior": expected_behavior,
                "ui_expectation": ui_expectation,
                "server_expectation": server_expectation,
                "case_id": case_id,
            }
        )

    def record_thought_event(
        self,
        *,
        role: str,
        stage: str,
        kind: str,
        description: str,
        avoidable: bool = True,
    ) -> None:
        self.thought_events.append(
            {
                "sequence": len(self.thought_events) + 1,
                "at": utc_now(),
                "role": role,
                "stage": stage,
                "kind": kind,
                "description": description,
                "avoidable": avoidable,
            }
        )

    def record_step(self, item: Mapping[str, Any]) -> None:
        self.steps.append(dict(item))

    def register_entity(self, kind: str, key: str, display: str) -> None:
        self.entities.setdefault(kind, {})[key] = display

    def add_evidence(self, *, role: str, kind: str, label: str, path: Path) -> None:
        self.evidence.append(
            {
                "at": utc_now(),
                "role": role,
                "kind": kind,
                "label": label,
                "path": str(path.resolve()),
            }
        )

    def add_note(self, note: str) -> None:
        if note.strip():
            self.notes.append(note.strip())

    def payload(self, status: str) -> dict[str, Any]:
        by_role = Counter(item["role"] for item in self.actions)
        by_kind = Counter(item["kind"] for item in self.actions)
        navigation_hops = sum(
            bool(item["url_before"] and item["url_after"] and item["url_before"] != item["url_after"])
            for item in self.actions
        )
        return {
            "schema": self.schema,
            "run_id": self.run_id,
            "status": status,
            "started_at": self.started_at,
            "generated_at": utc_now(),
            "scenario": {
                "name": self.scenario_name,
                "base_url": self.base_url,
                "methodology_reference": "https://blog.csdn.net/IGGIRing/article/details/106093982",
                "attempt": (
                    {
                        **asdict(self.attempt),
                        "output_dir": str(self.attempt.output_dir),
                    }
                    if self.attempt
                    else None
                ),
            },
            "certification_constraints": {
                "business_write_channel": "visible-browser-ui-only",
                "direct_database_write": False,
                "direct_http_api": False,
                "dom_or_storage_injection": False,
                "happy_path_deep_link_navigation": False,
                "failure_requires_fresh_entities": True,
            },
            "metrics": {
                "actions_total": len(self.actions),
                "actions_by_role": dict(sorted(by_role.items())),
                "actions_by_kind": dict(sorted(by_kind.items())),
                "navigation_hops": navigation_hops,
                "gates_total": len(self.gates),
                "gates_failed": sum(not item["passed"] for item in self.gates),
                "steps_total": len(self.steps),
                "steps_failed": sum(item.get("status") == "failed" for item in self.steps),
                "steps_blocked": sum(item.get("status") == "blocked" for item in self.steps),
                "thought_events": len(self.thought_events),
                "avoidable_thought_events": sum(item["avoidable"] for item in self.thought_events),
            },
            "entities": self.entities,
            "actions": self.actions,
            "steps": self.steps,
            "gates": self.gates,
            "thought_events": self.thought_events,
            "evidence": self.evidence,
            "notes": self.notes,
        }

    def flush(self, *, status: str) -> Path:
        destination = self.output_dir / "summary.json"
        temporary = self.output_dir / ".summary.json.tmp"
        temporary.write_text(
            json.dumps(self.payload(status), ensure_ascii=False, indent=2),
            # UTF-8 BOM keeps Chinese readable in Windows PowerShell 5 and
            # Notepad while remaining valid for normal JSON consumers.
            encoding="utf-8-sig",
        )
        temporary.replace(destination)
        return destination


class RoleBrowserSession:
    """One isolated browser context representing one human account."""

    def __init__(
        self,
        *,
        role: str,
        email: str,
        site: Site,
        base_url: str,
        context: Any,
        page: Any,
        journal: RunJournal,
        action_timeout_ms: int = 15_000,
        navigation_timeout_ms: int = 30_000,
    ) -> None:
        self.role = role
        self.email = email
        self.site = site
        self.base_url = base_url.rstrip("/")
        self.context = context
        self.page = page
        self.journal = journal
        self.action_timeout_ms = action_timeout_ms
        self.navigation_timeout_ms = navigation_timeout_ms
        self._trace_active = False
        self._trace_label = ""
        self._authenticated = False

    def locator(self, selector: str) -> Any:
        return self.page.locator(selector)

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            raise ValueError("站内路径必须以 / 开头")
        return urljoin(f"{self.base_url}/", path.lstrip("/"))

    def _perform(
        self,
        *,
        kind: str,
        target: str,
        operation: Callable[[], Any],
        detail: Mapping[str, Any] | None = None,
    ) -> Any:
        started_at = utc_now()
        started = time.perf_counter()
        before = str(getattr(self.page, "url", ""))
        safe_detail = _safe_detail(detail)
        status = "passed"
        try:
            return operation()
        except Exception as caught:
            status = "failed"
            self.capture_failure(
                f"action-{len(self.journal.actions)+1}-{kind}-{target}",
                include_screenshot=not bool(safe_detail.get("redacted")),
            )
            if safe_detail.get("redacted"):
                raise RuntimeError(f"{target}失败（{type(caught).__name__}）") from None
            raise
        finally:
            self.journal.record_action(
                role=self.role,
                kind=kind,
                target=target,
                status=status,
                started_at=started_at,
                ended_at=utc_now(),
                duration_ms=max(0, round((time.perf_counter() - started) * 1000)),
                url_before=before,
                url_after=str(getattr(self.page, "url", "")),
                detail=safe_detail,
            )

    def open_login(self, site: Site | None = None) -> Any:
        selected = site or self.site
        path = login_path_for_site(selected)
        return self._perform(
            kind="open_login",
            target=path,
            operation=lambda: self.page.goto(
                self._url(path), wait_until="domcontentloaded", timeout=self.navigation_timeout_ms
            ),
        )

    def login(self, password: str) -> None:
        if not password:
            raise ValueError(f"{self.role} 缺少登录密码")
        self.open_login()
        email = self.page.locator('input[name="email"]')
        if email.count() == 0:
            # An isolated role context may already be authenticated when login
            # is retried in the same run.  Never trace the credential entry.
            self._authenticated = True
            return
        if self.site == "warehouse":
            self.page.wait_for_timeout(400)
        self.type_text(email, self.email, "登录邮箱", sensitive=True)
        self.type_text(
            self.page.locator('input[name="password"]'),
            password,
            "登录密码",
            sensitive=True,
        )
        button = self.page.get_by_role("button", name=LOGIN_BUTTON_BY_SITE[self.site])
        self.click(button, LOGIN_BUTTON_BY_SITE[self.site], sensitive=True)
        self.page.wait_for_url(
            LANDING_PATTERN_BY_SITE[self.site], timeout=self.navigation_timeout_ms
        )
        self._authenticated = True

    def click(self, locator: Any, target: str, *, sensitive: bool = False) -> Any:
        return self._perform(
            kind="click",
            target=target,
            operation=lambda: locator.click(timeout=self.action_timeout_ms),
            detail={"sensitive": sensitive},
        )

    def fill(
        self,
        locator: Any,
        value: str,
        target: str,
        *,
        sensitive: bool | None = None,
    ) -> Any:
        masked = bool(SENSITIVE_TARGET.search(target)) if sensitive is None else sensitive
        return self._perform(
            kind="fill",
            target=target,
            operation=lambda: locator.fill(value, timeout=self.action_timeout_ms),
            detail={"value": value, "sensitive": masked},
        )

    def type_text(
        self,
        locator: Any,
        value: str,
        target: str,
        *,
        sensitive: bool | None = None,
        delay_ms: int = 12,
    ) -> Any:
        """Enter text with visible focus and keyboard events, never DOM mutation."""

        if delay_ms < 0:
            raise ValueError("delay_ms 不能为负数")
        masked = bool(SENSITIVE_TARGET.search(target)) if sensitive is None else sensitive

        def operation() -> None:
            locator.click(timeout=self.action_timeout_ms)
            locator.press("Control+A", timeout=self.action_timeout_ms)
            locator.type(value, delay=delay_ms, timeout=self.action_timeout_ms)

        return self._perform(
            kind="type_text",
            target=target,
            operation=operation,
            detail={
                "value": value,
                "sensitive": masked,
                "pointer_clicks": 1,
                "key_chords": 1,
                "keystrokes": len(value),
            },
        )

    def select(
        self,
        locator: Any,
        target: str,
        *,
        value: str | None = None,
        label: str | None = None,
        index: int | None = None,
    ) -> Any:
        supplied = sum(item is not None for item in (value, label, index))
        if supplied != 1:
            raise ValueError("select 必须且只能指定 value、label 或 index 中的一项")
        options = {key: item for key, item in {"value": value, "label": label, "index": index}.items() if item is not None}
        return self._perform(
            kind="select",
            target=target,
            operation=lambda: locator.select_option(timeout=self.action_timeout_ms, **options),
            detail=options,
        )

    def press(self, key: str, target: str, locator: Any | None = None) -> Any:
        keyboard_target = locator if locator is not None else self.page.keyboard
        return self._perform(
            kind="keypress",
            target=target,
            operation=lambda: keyboard_target.press(key),
            detail={"key": key},
        )

    def set_checked(self, locator: Any, checked: bool, target: str) -> None:
        def operation() -> None:
            if bool(locator.is_checked()) != checked:
                locator.click(timeout=self.action_timeout_ms)
            if bool(locator.is_checked()) != checked:
                raise AssertionError(f"{target} 未切换到期望状态")

        self._perform(
            kind="toggle",
            target=target,
            operation=operation,
            detail={"checked": checked},
        )

    def expect_visible(self, locator: Any, target: str) -> None:
        def operation() -> None:
            locator.first.wait_for(state="visible", timeout=self.action_timeout_ms)
            if not bool(locator.first.is_visible()):
                raise AssertionError(f"{target} 应可见")

        self._perform(kind="assert_visible", target=target, operation=operation)

    def expect_hidden(self, locator: Any, target: str) -> None:
        def operation() -> None:
            if locator.count() > 0 and bool(locator.first.is_visible()):
                raise AssertionError(f"{target} 应隐藏，而不是只禁用")

        self._perform(kind="assert_hidden", target=target, operation=operation)

    def expect_url_path(self, pattern: re.Pattern[str], target: str) -> None:
        def operation() -> None:
            path = urlparse(str(getattr(self.page, "url", ""))).path
            if not pattern.search(path):
                raise AssertionError(f"{target} 路径不符合预期")

        self._perform(kind="assert_url", target=target, operation=operation)

    def choose_files(
        self,
        trigger: Any,
        files: Path | str | Sequence[Path | str],
        target: str,
    ) -> None:
        raw_files = [files] if isinstance(files, (str, Path)) else list(files)
        resolved = [Path(item).resolve() for item in raw_files]
        missing = [str(path) for path in resolved if not path.is_file()]
        if missing:
            raise FileNotFoundError("测试附件不存在：" + "、".join(missing))

        def operation() -> None:
            with self.page.expect_file_chooser(timeout=self.action_timeout_ms) as chooser:
                trigger.click(timeout=self.action_timeout_ms)
            chooser.value.set_files([str(path) for path in resolved])

        self._perform(
            kind="file_chooser",
            target=target,
            operation=operation,
            detail={"files": [path.name for path in resolved]},
        )

    def reload(self, target: str = "刷新当前页") -> Any:
        return self._perform(
            kind="reload",
            target=target,
            operation=lambda: self.page.reload(
                wait_until="domcontentloaded", timeout=self.navigation_timeout_ms
            ),
        )

    def goto_for_negative_gate(
        self,
        path: str,
        *,
        reason: str,
        expected_status: int | Sequence[int] | None = None,
    ) -> Any:
        if len(reason.strip()) < 12:
            raise ValueError("负向深链必须记录具体门禁目的")
        parsed = urlparse(path)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
            raise ValueError("负向深链只允许当前 TMS 站内路径")

        response = self._perform(
            kind="negative_deep_link",
            target=parsed.path,
            operation=lambda: self.page.goto(
                self._url(path), wait_until="domcontentloaded", timeout=self.navigation_timeout_ms
            ),
            detail={"reason": reason},
        )
        if expected_status is not None and response is not None:
            allowed = {expected_status} if isinstance(expected_status, int) else set(expected_status)
            if response.status not in allowed:
                raise AssertionError(
                    f"负向门禁返回 HTTP {response.status}，期望 {sorted(allowed)}"
                )
        return response

    def record_gate(
        self,
        *,
        name: str,
        expected: str,
        passed: bool,
        actual: str,
        owner: str = "",
        remediation: str = "",
        expectation: GateExpectation | None = None,
        case_id: str = "",
    ) -> None:
        self.journal.record_gate(
            role=self.role,
            name=name,
            expected=expected,
            passed=passed,
            actual=actual,
            owner=owner,
            remediation=remediation,
            url=str(getattr(self.page, "url", "")),
            source=expectation.source if expectation else "",
            configured_mode=expectation.configured_mode if expectation else "",
            expected_behavior=expectation.expected_behavior if expectation else "",
            ui_expectation=expectation.ui_expectation if expectation else "",
            server_expectation=expectation.server_expectation if expectation else "",
            case_id=case_id,
        )

    def record_thought_event(
        self, *, stage: str, kind: str, description: str, avoidable: bool = True
    ) -> None:
        self.journal.record_thought_event(
            role=self.role,
            stage=stage,
            kind=kind,
            description=description,
            avoidable=avoidable,
        )

    def screenshot(self, label: str, *, full_page: bool = True) -> Path:
        path = self.journal.output_dir / (
            f"{len(self.journal.evidence)+1:04d}-{safe_artifact_name(self.role)}-"
            f"{safe_artifact_name(label)}.png"
        )
        masks = [
            self.page.locator('input[type="email"]'),
            self.page.locator('input[name="password"]'),
            self.page.locator(".sidebar-user small"),
            self.page.locator(".warehouse-user small"),
        ]
        self.page.screenshot(path=str(path), full_page=full_page, mask=masks)
        self.journal.add_evidence(role=self.role, kind="screenshot", label=label, path=path)
        return path

    def capture_failure(self, label: str, *, include_screenshot: bool = True) -> None:
        safe = safe_artifact_name(label)
        if include_screenshot:
            try:
                self.screenshot(f"failure-{safe}")
            except Exception:
                pass
        text_path = self.journal.output_dir / (
            f"{len(self.journal.evidence)+1:04d}-{safe_artifact_name(self.role)}-failure-{safe}.txt"
        )
        try:
            body = redact_evidence_text(
                self.page.locator("body").inner_text(timeout=3_000)
            )
            safe_url = redact_evidence_text(str(getattr(self.page, "url", "")))
            text_path.write_text(
                f"URL: {safe_url}\n\n{body[:20000]}\n",
                encoding="utf-8",
            )
            self.journal.add_evidence(
                role=self.role, kind="page_text", label=f"failure-{safe}", path=text_path
            )
        except Exception:
            pass

    def start_trace(self, label: str) -> None:
        if self._trace_active:
            raise RuntimeError(f"{self.role} trace 已在进行")
        if not self._authenticated:
            raise RuntimeError(
                f"{self.role} 必须先完成登录再开始 trace，避免密码进入截图或快照"
            )
        # Account identifiers are visible in the authenticated shell.  Keep the
        # trace event timeline and sources, but disable DOM snapshots/screenshots
        # so the runtime-only login identifier cannot leak into the trace zip.
        self.context.tracing.start(screenshots=False, snapshots=False, sources=True)
        self._trace_active = True
        self._trace_label = label

    def stop_trace(self) -> Path | None:
        if not self._trace_active:
            return None
        path = self.journal.output_dir / (
            f"{safe_artifact_name(self.role)}-{safe_artifact_name(self._trace_label)}-trace.zip"
        )
        self.context.tracing.stop(path=str(path))
        self._trace_active = False
        self.journal.add_evidence(
            role=self.role, kind="trace", label=self._trace_label, path=path
        )
        return path

    @contextmanager
    def step(
        self,
        title: str,
        *,
        case_id: str = "",
        stage: str = "",
        priority: CasePriority = "P1",
        preconditions: Sequence[str] = (),
        inputs: Mapping[str, Any] | None = None,
        expected_result: str = "",
        gate: GateExpectation | None = None,
        sensitive: bool = False,
        screenshot_on_pass: bool = True,
    ) -> Iterator[StepObservation]:
        """Record one auditable test case using the reference methodology fields."""

        resolved_case_id = case_id.strip() or f"STEP-{len(self.journal.steps)+1:04d}"
        if not title.strip() or not expected_result.strip():
            raise ValueError("测试步骤必须填写标题和预期结果")
        started_at = utc_now()
        started = time.perf_counter()
        status = "passed"
        error = ""
        observation = StepObservation()
        action_start = len(self.journal.actions)
        evidence_start = len(self.journal.evidence)
        url_before = str(getattr(self.page, "url", ""))
        try:
            title_before = str(self.page.title()) if url_before else ""
        except Exception:
            title_before = ""
        try:
            yield observation
        except Exception as caught:
            status = "failed"
            error = str(caught)[:6000]
            self.capture_failure(
                f"step-{len(self.journal.steps)+1}-{title}",
                include_screenshot=not sensitive,
            )
            raise
        finally:
            if status == "passed" and screenshot_on_pass:
                try:
                    self.screenshot(f"{resolved_case_id}-{title}")
                except Exception as caught:
                    status = "failed"
                    error = f"步骤证据截图失败：{caught}"[:6000]
            step_actions = self.journal.actions[action_start:]
            action_kinds = Counter(item["kind"] for item in step_actions)
            gate_passed = observation.gate_passed
            if gate is not None:
                if gate_passed is None:
                    gate_passed = status == "passed"
                self.record_gate(
                    name=gate.name,
                    expected=(
                        f"UI：{gate.ui_expectation}；服务端：{gate.server_expectation}"
                    ),
                    passed=bool(gate_passed),
                    actual=observation.actual_result or ("步骤通过" if status == "passed" else error),
                    owner=gate.owner_role,
                    remediation=gate.remediation,
                    expectation=gate,
                    case_id=resolved_case_id,
                )
            url_after = str(getattr(self.page, "url", ""))
            try:
                title_after = str(self.page.title()) if url_after else ""
            except Exception:
                title_after = ""
            self.journal.record_step(
                {
                    "sequence": len(self.journal.steps) + 1,
                    "case_id": resolved_case_id,
                    "role": self.role,
                    "stage": stage,
                    "title": title,
                    "priority": priority,
                    "preconditions": [item for item in preconditions if item.strip()],
                    "inputs": _safe_case_inputs(inputs),
                    "expected_result": expected_result,
                    "gate_expectation": asdict(gate) if gate else None,
                    "actual_result": observation.actual_result,
                    "notes": observation.notes,
                    "status": status,
                    "started_at": started_at,
                    "ended_at": utc_now(),
                    "duration_ms": max(0, round((time.perf_counter() - started) * 1000)),
                    "page_before": {"title": title_before, "url": url_before},
                    "page_after": {"title": title_after, "url": url_after},
                    "action_counts": {
                        "total": len(step_actions),
                        "by_kind": dict(sorted(action_kinds.items())),
                    },
                    "evidence": [
                        item["path"] for item in self.journal.evidence[evidence_start:]
                    ],
                    "error": error,
                }
            )

    def close(self) -> None:
        try:
            self.stop_trace()
        finally:
            self.context.close()


class TmsUIHarness:
    """Owns one browser and one isolated context per human role."""

    def __init__(
        self,
        playwright: Any,
        *,
        run_id: str,
        output_dir: Path | str,
        base_url: str = "http://127.0.0.1:5189",
        headless: bool = False,
        slow_mo: int = 50,
        action_timeout_ms: int = 15_000,
        navigation_timeout_ms: int = 30_000,
        attempt: AttemptIdentity | None = None,
        scenario_name: str = "",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.journal = RunJournal(
            run_id,
            output_dir,
            attempt=attempt,
            scenario_name=scenario_name,
            base_url=self.base_url,
        )
        self.browser = playwright.chromium.launch(headless=headless, slow_mo=slow_mo)
        self.action_timeout_ms = action_timeout_ms
        self.navigation_timeout_ms = navigation_timeout_ms
        self.sessions: dict[str, RoleBrowserSession] = {}

    def add_role(self, role: str, email: str, site: Site = "admin") -> RoleBrowserSession:
        if role in self.sessions:
            raise ValueError(f"角色会话已存在：{role}")
        context = self.browser.new_context(
            locale="zh-CN",
            viewport={"width": 1600, "height": 1000},
            accept_downloads=True,
        )
        context.set_default_timeout(self.action_timeout_ms)
        context.set_default_navigation_timeout(self.navigation_timeout_ms)
        session = RoleBrowserSession(
            role=role,
            email=email,
            site=site,
            base_url=self.base_url,
            context=context,
            page=context.new_page(),
            journal=self.journal,
            action_timeout_ms=self.action_timeout_ms,
            navigation_timeout_ms=self.navigation_timeout_ms,
        )
        self.sessions[role] = session
        return session

    def close(self, *, status: RunStatus) -> Path:
        for session in self.sessions.values():
            try:
                session.close()
            except Exception as error:
                self.journal.add_note(f"{session.role} 关闭失败：{error}")
        self.browser.close()
        return self.journal.flush(status=status)
