#!/usr/bin/env python3
"""Static guard for certification-grade, browser-only TMS scenarios.

The guard is intentionally conservative.  A certification scenario must create
and advance business data through visible browser controls.  Infrastructure
helpers are excluded from directory scans because they contain the one raw
``page.goto`` implementation used by ``RoleBrowserSession.open_login`` and the
explicit negative-gate helper.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence
from urllib.parse import urlparse


DEFAULT_IGNORES = {
    "__init__.py",
    "tms_ui_harness.py",
    "ui_only_guard.py",
    "test_ui_only_guard.py",
}
LOGIN_PATHS = {"/login", "/portal/login", "/warehouse/login"}
MIN_NEGATIVE_REASON_LENGTH = 12

FORBIDDEN_IMPORTS = {
    "sqlite3": ("IMPORT_DB", "禁止导入 sqlite3 直接读写业务数据"),
    "aiosqlite": ("IMPORT_DB", "禁止导入 aiosqlite 直接读写业务数据"),
    "sqlalchemy": ("IMPORT_DB", "禁止通过 SQLAlchemy 访问业务数据"),
    "psycopg": ("IMPORT_DB", "禁止直接连接 PostgreSQL 构造业务状态"),
    "psycopg2": ("IMPORT_DB", "禁止直接连接 PostgreSQL 构造业务状态"),
    "pymysql": ("IMPORT_DB", "禁止直接连接 MySQL 构造业务状态"),
    "duckdb": ("IMPORT_DB", "禁止使用 DuckDB 绕过页面核对业务数据"),
    "requests": ("IMPORT_HTTP", "禁止使用 requests 绕过页面"),
    "httpx": ("IMPORT_HTTP", "禁止使用 httpx 绕过页面"),
    "aiohttp": ("IMPORT_HTTP", "禁止使用 aiohttp 绕过页面"),
    "urllib3": ("IMPORT_HTTP", "禁止使用 urllib3 绕过页面"),
    "urllib.request": ("IMPORT_HTTP", "禁止使用 urllib.request 绕过页面"),
    "http.client": ("IMPORT_HTTP", "禁止使用 http.client 绕过页面"),
    "subprocess": ("PROCESS_SHORTCUT", "禁止测试例程启动 SQL、D1 或 HTTP 外部快捷命令"),
}

SQL_PATTERN = re.compile(
    r"(?is)\b(?:"
    r"select\s+.+?\s+from|insert\s+(?:or\s+\w+\s+)?into|"
    r"update\s+[\w.\"`\[\]-]+\s+set|delete\s+from|"
    r"pragma\s+|create\s+table|alter\s+table|drop\s+table"
    r")\b"
)
D1_PATTERN = re.compile(
    r"(?i)(?:wrangler\s+d1|\.wrangler[/\\]state|miniflare-D1|D1Database|env\.DB\.prepare)"
)


@dataclass(frozen=True, slots=True)
class Violation:
    path: Path
    line: int
    column: int
    code: str
    message: str

    def to_json(self) -> dict[str, object]:
        item = asdict(self)
        item["path"] = str(self.path)
        return item


def _attribute_chain(node: ast.AST) -> list[str]:
    chain: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        chain.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        chain.append(current.id)
    return list(reversed(chain))


def _literal_string(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr) and all(
        isinstance(item, ast.Constant) and isinstance(item.value, str)
        for item in node.values
    ):
        return "".join(str(item.value) for item in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _literal_string(node.left)
        right = _literal_string(node.right)
        return left + right if left is not None and right is not None else None
    return None


def _login_url_allowed(value: str | None) -> bool:
    if value is None:
        return False
    parsed = urlparse(value)
    return parsed.path.rstrip("/") in LOGIN_PATHS


def _docstring_nodes(tree: ast.AST) -> set[int]:
    result: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if (
            isinstance(body, list)
            and body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            result.add(id(body[0].value))
    return result


class _GuardVisitor(ast.NodeVisitor):
    def __init__(self, path: Path, tree: ast.AST) -> None:
        self.path = path
        self.docstrings = _docstring_nodes(tree)
        self.violations: list[Violation] = []

    def add(self, node: ast.AST, code: str, message: str) -> None:
        self.violations.append(
            Violation(
                path=self.path,
                line=getattr(node, "lineno", 1),
                column=getattr(node, "col_offset", 0) + 1,
                code=code,
                message=message,
            )
        )

    def check_import(self, node: ast.AST, module: str, imported: str = "") -> None:
        candidate = f"{module}.{imported}".strip(".")
        for forbidden, (code, message) in FORBIDDEN_IMPORTS.items():
            if candidate == forbidden or candidate.startswith(f"{forbidden}."):
                self.add(node, code, message)
                return

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.check_import(node, alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            self.check_import(node, module, alias.name)
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if id(node) not in self.docstrings and isinstance(node.value, str):
            if SQL_PATTERN.search(node.value):
                self.add(node, "SQL_TEXT", "禁止在 UI 验收例程中嵌入 SQL 语句")
            if D1_PATTERN.search(node.value):
                self.add(node, "D1_SHORTCUT", "禁止访问 D1/Miniflare 本地数据文件或命令")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        chain = _attribute_chain(node.func)
        name = chain[-1] if chain else ""

        if chain and chain[0] in {"page", "locator", "context", "browser", "keyboard"} and name in {
            "click",
            "dblclick",
            "fill",
            "type",
            "press",
            "insert_text",
            "check",
            "uncheck",
            "set_checked",
            "select_option",
            "tap",
        }:
            self.add(
                node,
                "RAW_PLAYWRIGHT_ACTION",
                "业务场景必须通过 RoleBrowserSession 记录键鼠动作，禁止直接调用原始 Playwright 写操作",
            )

        if "request" in chain and chain[0] in {
            "page",
            "context",
            "browser",
            "playwright",
        }:
            self.add(node, "PW_REQUEST", "禁止使用 Playwright request API 绕过页面")
        if name in {"fetch", "urlopen"}:
            self.add(node, "HTTP_CALL", "禁止直接 HTTP 请求，请通过可见页面交互")
        if name in {"execute", "executemany", "executescript", "prepare"}:
            self.add(node, "DB_CALL", "禁止直接执行数据库语句")
        if name in {"system", "popen", "Popen", "run", "check_call", "check_output"} and (
            chain and chain[0] in {"os", "subprocess"}
        ):
            self.add(node, "PROCESS_SHORTCUT", "禁止例程调用外部进程构造业务状态")
        if name in {"evaluate", "evaluate_handle", "eval_on_selector", "eval_on_selector_all"}:
            self.add(node, "DOM_INJECTION", "禁止注入 JavaScript 操作 DOM 或提交表单")
        if name == "dispatch_event":
            self.add(node, "SYNTHETIC_EVENT", "禁止 dispatch_event，必须使用可见键鼠动作")
        if name == "set_input_files":
            self.add(node, "DIRECT_FILE_SET", "禁止直接给隐藏 input 设文件，请点击可见入口并使用 file chooser")
        if name in {"add_init_script", "add_cookies", "storage_state"}:
            self.add(node, "STORAGE_INJECTION", "禁止注入脚本、Cookie 或会话状态绕过登录")
        if name in {"route", "route_from_har", "fulfill", "continue_", "fallback"}:
            self.add(node, "NETWORK_INTERCEPTION", "禁止拦截或伪造网络响应来构造业务结果")

        if name == "goto":
            target = _literal_string(node.args[0]) if node.args else None
            if not _login_url_allowed(target):
                self.add(
                    node,
                    "DIRECT_DEEP_LINK",
                    "原始 page.goto 只允许打开登录页；正向流程必须点击菜单/下一步，负向门禁请用 goto_for_negative_gate",
                )

        if name == "goto_for_negative_gate":
            reason_node = next(
                (keyword.value for keyword in node.keywords if keyword.arg == "reason"),
                None,
            )
            reason = _literal_string(reason_node)
            if reason is None or len(reason.strip()) < MIN_NEGATIVE_REASON_LENGTH:
                self.add(
                    node,
                    "NEGATIVE_GOTO_REASON",
                    f"负向深链测试必须写明至少 {MIN_NEGATIVE_REASON_LENGTH} 个字符的具体门禁目的",
                )

        for keyword in node.keywords:
            if keyword.arg == "force" and not (
                isinstance(keyword.value, ast.Constant) and keyword.value.value in {False, None}
            ):
                self.add(node, "FORCED_ACTION", "禁止 force 参数穿透遮罩、禁用态或不可见控件")

        self.generic_visit(node)


def scan_source(source: str, path: Path | str = Path("<memory>")) -> list[Violation]:
    source_path = Path(path)
    try:
        tree = ast.parse(source, filename=str(source_path))
    except SyntaxError as error:
        return [
            Violation(
                path=source_path,
                line=error.lineno or 1,
                column=error.offset or 1,
                code="PYTHON_SYNTAX",
                message=error.msg,
            )
        ]
    visitor = _GuardVisitor(source_path, tree)
    visitor.visit(tree)
    return sorted(visitor.violations, key=lambda item: (str(item.path), item.line, item.column, item.code))


def _python_files(path: Path, include_infrastructure: bool) -> Iterable[Path]:
    if path.is_file():
        yield path
        return
    for candidate in sorted(path.rglob("*.py")):
        if "__pycache__" in candidate.parts:
            continue
        if not include_infrastructure and candidate.name in DEFAULT_IGNORES:
            continue
        yield candidate


def scan_path(
    path: Path | str,
    *,
    include_infrastructure: bool = False,
) -> list[Violation]:
    target = Path(path)
    violations: list[Violation] = []
    for file_path in _python_files(target, include_infrastructure):
        try:
            source = file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            violations.append(
                Violation(file_path, 1, 1, "ENCODING", "Python 例程必须使用 UTF-8")
            )
            continue
        violations.extend(scan_source(source, file_path))
    return violations


def scan_paths(paths: Sequence[Path | str]) -> list[Violation]:
    result: list[Violation] = []
    for path in paths:
        result.extend(scan_path(path))
    return sorted(result, key=lambda item: (str(item.path), item.line, item.column, item.code))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="检查 TMS E2E 例程是否只通过可见浏览器键鼠交互写入业务数据。"
    )
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true", help="以 JSON 输出检查结果")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    missing = [str(path) for path in args.paths if not path.exists()]
    if missing:
        print(json.dumps({"status": "CONFIG_ERROR", "missing": missing}, ensure_ascii=False))
        return 2
    violations = scan_paths(args.paths)
    if args.json:
        print(
            json.dumps(
                {
                    "status": "PASSED" if not violations else "FAILED",
                    "violations": [item.to_json() for item in violations],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    elif violations:
        for item in violations:
            print(f"{item.path}:{item.line}:{item.column} [{item.code}] {item.message}")
    else:
        print("通过：未发现数据库、API、DOM 注入或业务深链快捷操作。")
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
