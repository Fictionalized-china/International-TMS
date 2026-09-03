from __future__ import annotations

import base64
import hashlib
import hmac
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROVISION_SQL = ROOT / ".local-secrets" / "aliyun-production-accounts.sql"
AUDIT_SQL = ROOT / ".local-secrets" / "aliyun-production-access-audit.sql"
CREDENTIALS = Path.home() / "Desktop" / "International-TMS-阿里云测试账密.md"


def find_local_database() -> Path:
    candidates = [
        path
        for path in (ROOT / ".wrangler" / "state" / "v3").rglob("*.sqlite")
        if path.name != "metadata.sqlite" and path.stat().st_size > 0
    ]
    if not candidates:
        raise RuntimeError("未找到可用于隔离审计的本地 D1 数据库")
    return max(candidates, key=lambda path: path.stat().st_size)


def split_sql_statements(source: str) -> list[str]:
    statements: list[str] = []
    buffer = ""
    for line in source.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                statements.append(statement)
            buffer = ""
    if buffer.strip():
        raise RuntimeError("审计 SQL 末尾存在不完整语句")
    return statements


def credential_rows() -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for line in CREDENTIALS.read_text(encoding="utf-8-sig").splitlines():
        if "@e2e.test" not in line or not line.startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.split("|")[1:-1]]
        if len(cells) >= 5:
            rows.append((cells[3].lower(), cells[4]))
    return rows


def password_matches(password: str, encoded: str) -> bool:
    scheme, iterations, salt, expected = encoded.split("$", 3)
    if scheme != "pbkdf2_sha256":
        return False
    expected_bytes = base64.b64decode(expected)
    actual = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        base64.b64decode(salt),
        int(iterations),
        dklen=len(expected_bytes),
    )
    return hmac.compare_digest(actual, expected_bytes)


def main() -> None:
    for required in (PROVISION_SQL, AUDIT_SQL, CREDENTIALS):
        if not required.is_file():
            raise RuntimeError(f"缺少账号审计产物：{required}")

    provision_sql = PROVISION_SQL.read_text(encoding="utf-8")
    target_match = re.search(
        r"^-- Target organization code: ([A-Za-z0-9_-]+)$",
        provision_sql,
        flags=re.MULTILINE,
    )
    if not target_match:
        raise RuntimeError("账号初始化 SQL 缺少目标组织代码标记，请重新运行账号生成器")
    target_organization_code = target_match.group(1)

    credentials = credential_rows()
    if len(credentials) != 16 or len({email for email, _ in credentials}) != 16:
        raise RuntimeError("桌面账密本必须包含 16 个唯一账号")
    if len({password for _, password in credentials}) != 16:
        raise RuntimeError("16 个账号必须使用互不相同的密码")

    temp_root = Path(tempfile.mkdtemp(prefix="international-tms-account-audit-"))
    isolated_database = temp_root / "audit.sqlite"
    try:
        with closing(sqlite3.connect(f"file:{find_local_database()}?mode=ro", uri=True)) as source:
            with closing(sqlite3.connect(isolated_database)) as target:
                source.backup(target)

        with closing(sqlite3.connect(isolated_database)) as connection:
            organization_count = connection.execute(
                "SELECT COUNT(*) FROM organizations WHERE lower(code)=lower(?)",
                (target_organization_code,),
            ).fetchone()[0]
            if organization_count != 1:
                raise RuntimeError(
                    "隔离库中不存在唯一的目标组织 "
                    f"{target_organization_code!r}；请用正确的 --organization-code 重新生成产物"
                )

            connection.executescript(provision_sql)
            statements = split_sql_statements(AUDIT_SQL.read_text(encoding="utf-8"))
            if len(statements) < 2:
                raise RuntimeError("账号审计 SQL 内容不足")
            for index, statement in enumerate(statements[:-1], start=1):
                findings = connection.execute(statement).fetchall()
                if findings:
                    raise RuntimeError(f"账号审计第 {index} 项发现 {len(findings)} 条异常")

            account_matrix = connection.execute(statements[-1]).fetchall()
            if len(account_matrix) != 16:
                raise RuntimeError(f"账号矩阵应为 16 行，实际为 {len(account_matrix)} 行")

            password_rows = dict(
                connection.execute(
                    "SELECT lower(email),password_hash FROM users WHERE lower(email) IN (%s)"
                    % ",".join("?" for _ in credentials),
                    [email for email, _ in credentials],
                ).fetchall()
            )
            verified = sum(
                password_matches(password, password_rows.get(email, ""))
                for email, password in credentials
            )
            if verified != 16:
                raise RuntimeError(f"密码哈希兼容校验应为 16 个，实际通过 {verified} 个")
            connection.commit()

        print(
            "ACCOUNT_ARTIFACT_AUDIT_OK "
            f"finding_queries={len(statements) - 1} accounts=16 passwords=16"
        )
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
