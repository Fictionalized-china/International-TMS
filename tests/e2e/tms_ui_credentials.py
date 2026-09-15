"""Runtime-only credential loading for TMS browser acceptance tests.

Credentials are accepted from an explicitly supplied Markdown file or from
environment variables.  Secret values are never placed in dataclass reprs,
exceptions, journals, or repository-owned configuration.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Mapping, Sequence


Site = Literal["admin", "portal", "warehouse"]
FILE_ENV = "TMS_E2E_CREDENTIALS_FILE"
JSON_ENV = "TMS_E2E_CREDENTIALS_JSON"
ALIASES_ENV = "TMS_E2E_ROLE_ALIASES"

REQUIRED_HEADERS = ("端", "部门", "岗位/客户", "登录邮箱", "密码", "权限说明")
SITE_KEYWORDS: tuple[tuple[str, Site], ...] = (
    ("客户", "portal"),
    ("门户", "portal"),
    ("仓库", "warehouse"),
    ("管理", "admin"),
    ("后台", "admin"),
)
ROLE_ALIAS_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"老板|所有者|BOSS", re.I), "owner"),
    (re.compile(r"开发", re.I), "developer"),
    (re.compile(r"业务主管", re.I), "business_supervisor"),
    (re.compile(r"操作主管", re.I), "operation_supervisor"),
    (re.compile(r"境外.*仓|海外.*仓", re.I), "overseas_warehouse"),
    (re.compile(r"国内.*仓|仓库岗|仓库作业", re.I), "domestic_warehouse"),
    (re.compile(r"财务|会计", re.I), "finance"),
    (re.compile(r"出纳", re.I), "cashier"),
    (re.compile(r"人事|行政", re.I), "hr_admin"),
    (re.compile(r"客服", re.I), "customer_service"),
    (re.compile(r"单证", re.I), "document"),
    (re.compile(r"运踪", re.I), "tracking"),
    (re.compile(r"操作岗|操作员", re.I), "operation"),
    (re.compile(r"商务报价", re.I), "business_route"),
    (re.compile(r"前端配载|配载岗", re.I), "front_loading"),
    (re.compile(r"业务岗|业务员|销售", re.I), "sales"),
    (re.compile(r"客户", re.I), "customer"),
)


@dataclass(frozen=True, slots=True)
class CredentialRecord:
    alias: str
    site: Site
    department: str
    role: str
    email: str = field(repr=False)
    password: str = field(repr=False)
    permissions_hint: str = ""
    source: str = field(default="runtime", repr=False)

    def public_summary(self) -> dict[str, str]:
        return {
            "alias": self.alias,
            "site": self.site,
            "department": self.department,
            "role": self.role,
            "permissions_hint": self.permissions_hint,
        }


class CredentialVault:
    def __init__(self, records: Sequence[CredentialRecord]) -> None:
        if not records:
            raise ValueError("未加载到任何测试账号")
        aliases = [item.alias for item in records]
        if len(set(aliases)) != len(aliases):
            raise ValueError("测试账号别名必须唯一")
        self._records = tuple(records)
        self._by_alias = {item.alias: item for item in records}

    @property
    def records(self) -> tuple[CredentialRecord, ...]:
        return self._records

    @property
    def aliases(self) -> tuple[str, ...]:
        return tuple(item.alias for item in self._records)

    def select(self, aliases: Sequence[str] | None = None) -> tuple[CredentialRecord, ...]:
        if not aliases:
            return self.records
        missing = [alias for alias in aliases if alias not in self._by_alias]
        if missing:
            raise ValueError(
                "未找到测试账号别名："
                + "、".join(missing)
                + "；可用别名："
                + "、".join(self.aliases)
            )
        return tuple(self._by_alias[alias] for alias in aliases)


def _strip_markdown(value: str) -> str:
    result = value.strip()
    if len(result) >= 2 and result[0] == result[-1] == "`":
        return result[1:-1].strip()
    return result


def _table_cells(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [_strip_markdown(item.replace(r"\|", "|")) for item in value.split("|")]


def _is_separator(cells: Sequence[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", item.replace(" ", "")) for item in cells)


def _site_from(value: str) -> Site:
    for keyword, site in SITE_KEYWORDS:
        if keyword in value:
            return site
    raise ValueError("凭据表存在无法识别的登录端类型")


def _base_alias(site: Site, department: str, role: str) -> str:
    searchable = f"{site} {department} {role}"
    for pattern, alias in ROLE_ALIAS_RULES:
        if pattern.search(searchable):
            return alias
    safe = re.sub(r"[^a-z0-9]+", "_", searchable.lower()).strip("_")
    return safe or f"{site}_account"


def _unique_alias(base: str, counts: dict[str, int]) -> str:
    counts[base] = counts.get(base, 0) + 1
    return base if counts[base] == 1 else f"{base}_{counts[base]}"


def parse_markdown_credentials(text: str, *, source: str = "markdown") -> CredentialVault:
    rows = [_table_cells(line) for line in text.splitlines() if line.strip().startswith("|")]
    if len(rows) < 3:
        raise ValueError("凭据 Markdown 中没有可解析的账号表")
    header_index = next(
        (index for index, cells in enumerate(rows) if all(name in cells for name in REQUIRED_HEADERS)),
        None,
    )
    if header_index is None:
        raise ValueError("凭据表缺少标准表头")
    headers = rows[header_index]
    indexes = {name: headers.index(name) for name in REQUIRED_HEADERS}
    records: list[CredentialRecord] = []
    counts: dict[str, int] = {}
    for cells in rows[header_index + 1 :]:
        if _is_separator(cells):
            continue
        if len(cells) < len(headers):
            continue
        site = _site_from(cells[indexes["端"]])
        department = cells[indexes["部门"]]
        role = cells[indexes["岗位/客户"]]
        email = cells[indexes["登录邮箱"]].strip()
        password = cells[indexes["密码"]]
        if "@" not in email:
            raise ValueError(f"{_base_alias(site, department, role)} 缺少有效登录邮箱")
        if not password:
            raise ValueError(f"{_base_alias(site, department, role)} 缺少密码")
        alias = _unique_alias(_base_alias(site, department, role), counts)
        records.append(
            CredentialRecord(
                alias=alias,
                site=site,
                department=department,
                role=role,
                email=email,
                password=password,
                permissions_hint=cells[indexes["权限说明"]],
                source=source,
            )
        )
    return CredentialVault(records)


def load_markdown_credentials(path: Path | str) -> CredentialVault:
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError("指定的凭据文件不存在")
    return parse_markdown_credentials(source.read_text(encoding="utf-8-sig"), source="markdown-file")


def _records_from_json(raw: str) -> CredentialVault:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("凭据环境变量不是有效 JSON") from error
    if isinstance(payload, Mapping):
        items: Iterable[Mapping[str, object]] = (
            {"alias": alias, **dict(value)}
            for alias, value in payload.items()
            if isinstance(value, Mapping)
        )
    elif isinstance(payload, list):
        items = (item for item in payload if isinstance(item, Mapping))
    else:
        raise ValueError("凭据 JSON 必须为对象或数组")
    records: list[CredentialRecord] = []
    for item in items:
        alias = str(item.get("alias", "")).strip()
        site = str(item.get("site", "admin")).strip()
        email = str(item.get("email", "")).strip()
        password = str(item.get("password", ""))
        if not alias or site not in {"admin", "portal", "warehouse"}:
            raise ValueError("凭据 JSON 存在无效别名或站点")
        if "@" not in email or not password:
            raise ValueError(f"{alias} 缺少有效登录凭据")
        records.append(
            CredentialRecord(
                alias=alias,
                site=site,  # type: ignore[arg-type]
                department=str(item.get("department", "")),
                role=str(item.get("role", alias)),
                email=email,
                password=password,
                permissions_hint=str(item.get("permissions_hint", "")),
                source="environment-json",
            )
        )
    return CredentialVault(records)


def _records_from_individual_env(environment: Mapping[str, str]) -> CredentialVault:
    aliases = [item.strip() for item in environment.get(ALIASES_ENV, "").split(",") if item.strip()]
    if not aliases:
        raise ValueError(
            f"未提供凭据；请使用 --credentials-file、{FILE_ENV}、{JSON_ENV} 或 {ALIASES_ENV}"
        )
    records: list[CredentialRecord] = []
    for alias in aliases:
        env_prefix = "TMS_E2E_" + re.sub(r"[^A-Za-z0-9]", "_", alias).upper()
        site = environment.get(f"{env_prefix}_SITE", "admin").strip()
        email = environment.get(f"{env_prefix}_EMAIL", "").strip()
        password = environment.get(f"{env_prefix}_PASSWORD", "")
        if site not in {"admin", "portal", "warehouse"}:
            raise ValueError(f"{alias} 的站点配置无效")
        if "@" not in email or not password:
            raise ValueError(f"{alias} 缺少有效登录凭据")
        records.append(
            CredentialRecord(
                alias=alias,
                site=site,  # type: ignore[arg-type]
                department=environment.get(f"{env_prefix}_DEPARTMENT", ""),
                role=environment.get(f"{env_prefix}_ROLE", alias),
                email=email,
                password=password,
                permissions_hint=environment.get(f"{env_prefix}_PERMISSIONS", ""),
                source="individual-environment",
            )
        )
    return CredentialVault(records)


def load_credentials(
    credentials_file: Path | str | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> CredentialVault:
    env = os.environ if environment is None else environment
    file_value = str(credentials_file or env.get(FILE_ENV, "")).strip()
    if file_value:
        return load_markdown_credentials(file_value)
    if env.get(JSON_ENV, "").strip():
        return _records_from_json(env[JSON_ENV])
    return _records_from_individual_env(env)


__all__ = [
    "CredentialRecord",
    "CredentialVault",
    "load_credentials",
    "load_markdown_credentials",
    "parse_markdown_credentials",
]
