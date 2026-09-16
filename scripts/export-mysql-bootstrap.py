#!/usr/bin/env python3
"""Export the local D1/SQLite schema and production-safe seed data for MySQL 8.

The generated JSON is deliberately deterministic.  It contains every application
table/foreign key/index/guard trigger, but only configuration and internal test
account rows.  Customer and transaction data are never exported.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable


DEFAULT_SQLITE = Path(
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/"
    "862aad4ce9c558bbdcfd51e8c60b582ebd770f50e865f6e659711dbe9126e07a.sqlite"
)
DEFAULT_OUTPUT = Path("production/mysql-bootstrap.json")

SEED_TABLES = (
    "organizations",
    "users",
    "departments",
    "positions",
    "memberships",
    "roles",
    "permissions",
    "role_permissions",
    "membership_roles",
    "position_portal_settings",
    "membership_permission_overrides",
    "warehouses",
    "warehouse_locations",
    "warehouse_zones",
    "warehouse_user_access",
    "reference_data",
    "logistics_products",
    "logistics_product_price_tiers",
    "carriers",
    "carrier_drivers",
    "carrier_vehicles",
    "workflow_definitions",
    "workflow_steps",
    "workflow_step_modules",
    "workflow_module_tasks",
    "workflow_step_fields",
    "order_workflow_transitions",
)

TRANSACTION_TABLES = (
    "transport_orders",
    "transport_batches",
    "quotations",
    "shipments",
    "warehouse_receipts",
    "warehouse_dispatches",
    "business_expenses",
    "invoices",
)


def quote(identifier: str) -> str:
    return "`" + identifier.replace("`", "``") + "`"


def safe_name(prefix: str, *parts: str) -> str:
    raw = "_".join((prefix, *parts))
    clean = re.sub(r"[^A-Za-z0-9_$]", "_", raw)
    if len(clean) <= 64:
        return clean
    digest = hashlib.sha1(clean.encode("utf-8")).hexdigest()[:10]
    return f"{clean[:53]}_{digest}"


def split_top_level(source: str, delimiter: str = ",") -> list[str]:
    parts: list[str] = []
    depth = 0
    quote_char = ""
    start = 0
    index = 0
    while index < len(source):
        char = source[index]
        if quote_char:
            if char == quote_char:
                if index + 1 < len(source) and source[index + 1] == quote_char:
                    index += 1
                else:
                    quote_char = ""
        elif char in "'\"`":
            quote_char = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == delimiter and depth == 0:
            parts.append(source[start:index].strip())
            start = index + 1
        index += 1
    parts.append(source[start:].strip())
    return [part for part in parts if part]


def closing_paren(source: str, opening: int) -> int:
    depth = 0
    quote_char = ""
    index = opening
    while index < len(source):
        char = source[index]
        if quote_char:
            if char == quote_char:
                if index + 1 < len(source) and source[index + 1] == quote_char:
                    index += 1
                else:
                    quote_char = ""
        elif char in "'\"`":
            quote_char = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("Unbalanced SQL parentheses")


def extract_checks(create_sql: str) -> list[str]:
    checks: list[str] = []
    for match in re.finditer(r"\bCHECK\s*\(", create_sql, re.IGNORECASE):
        opening = create_sql.find("(", match.start())
        ending = closing_paren(create_sql, opening)
        checks.append(create_sql[opening + 1 : ending].strip())
    return checks


def mysql_condition(expression: str) -> str:
    value = expression.strip()
    value = re.sub(r"\s+COLLATE\s+NOCASE\b", "", value, flags=re.IGNORECASE)
    value = re.sub(
        r"(NEW\.`?[A-Za-z0-9_]+`?)\s+IS\s+NOT\s+(OLD\.`?[A-Za-z0-9_]+`?)",
        r"NOT (\1 <=> \2)",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"(NEW\.`?[A-Za-z0-9_]+`?)\s+IS\s+(OLD\.`?[A-Za-z0-9_]+`?)",
        r"(\1 <=> \2)",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"([^\s()]+)\s+NOT\s+GLOB\s+'\*\[([^]]+)]\*'",
        r"\1 NOT REGEXP '[\2]'",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"([^\s()]+)\s+GLOB\s+'\*\[\^([^]]+)]\*'",
        r"\1 REGEXP '[^\2]'",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"([^\s()]+)\s+GLOB\s+'\*\[([^]]+)]\*'",
        r"\1 REGEXP '[\2]'",
        value,
        flags=re.IGNORECASE,
    )
    return value


def mysql_default(value: str | None) -> str:
    if value is None:
        return ""
    if value.upper() == "CURRENT_TIMESTAMP":
        return " DEFAULT CURRENT_TIMESTAMP(3)"
    return f" DEFAULT {value}"


def encode_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"$binary": base64.b64encode(value).decode("ascii")}
    return value


def rows_as_dicts(connection: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    cursor = connection.execute(sql, tuple(params))
    names = [description[0] for description in cursor.description or ()]
    return [dict(zip(names, (encode_value(value) for value in row))) for row in cursor.fetchall()]


def table_names(connection: sqlite3.Connection) -> list[str]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "AND name NOT IN ('_cf_METADATA','d1_migrations') ORDER BY name"
        )
    ]


def table_columns(connection: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
    return list(connection.execute(f"PRAGMA table_info({quote(table)})"))


def index_catalog(connection: sqlite3.Connection, tables: list[str]) -> tuple[dict[str, set[str]], list[dict[str, Any]]]:
    indexed: dict[str, set[str]] = {table: set() for table in tables}
    indexes: list[dict[str, Any]] = []
    seen_signatures: set[tuple[str, bool, tuple[tuple[str, bool], ...]]] = set()

    for table in tables:
        for column in table_columns(connection, table):
            if column[5]:
                indexed[table].add(column[1])
        for entry in connection.execute(f"PRAGMA index_list({quote(table)})"):
            name = entry[1]
            unique = bool(entry[2])
            origin = entry[3]
            partial = bool(entry[4])
            key_parts = [row for row in connection.execute(f"PRAGMA index_xinfo({quote(name)})") if row[5]]
            for part in key_parts:
                if part[1] >= 0 and part[2] is not None:
                    indexed[table].add(part[2])
            if origin == "pk" or partial:
                continue
            columns = [(part[2], bool(part[3])) for part in key_parts if part[1] >= 0 and part[2] is not None]
            signature = (table, unique, tuple(columns))
            if not columns or signature in seen_signatures:
                continue
            seen_signatures.add(signature)
            rendered = ", ".join(f"{quote(column)}{' DESC' if descending else ''}" for column, descending in columns)
            mysql_name = safe_name("idx", table, name if not name.startswith("sqlite_autoindex") else "unique", str(len(indexes)))
            indexes.append(
                {
                    "table": table,
                    "name": mysql_name,
                    "unique": unique,
                    "sql": f"ALTER TABLE {quote(table)} ADD {'UNIQUE ' if unique else ''}INDEX {quote(mysql_name)} ({rendered})",
                }
            )

    for table in tables:
        grouped: dict[int, list[sqlite3.Row]] = {}
        for foreign_key in connection.execute(f"PRAGMA foreign_key_list({quote(table)})"):
            grouped.setdefault(foreign_key[0], []).append(foreign_key)
            indexed[table].add(foreign_key[3])
            if foreign_key[2] in indexed:
                indexed[foreign_key[2]].add(foreign_key[4])
    return indexed, indexes


def partial_indexes(connection: sqlite3.Connection, tables: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table in tables:
        for entry in connection.execute(f"PRAGMA index_list({quote(table)})"):
            if not entry[4]:
                continue
            name = entry[1]
            sql_row = connection.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (name,)).fetchone()
            if not sql_row or not sql_row[0]:
                continue
            sql = sql_row[0]
            on_match = re.search(r"\bON\s+[^\s(]+\s*\(", sql, re.IGNORECASE)
            where_match = re.search(r"\bWHERE\b", sql, re.IGNORECASE)
            if not on_match or not where_match:
                raise ValueError(f"Cannot parse partial index {name}")
            opening = sql.find("(", on_match.start())
            ending = closing_paren(sql, opening)
            expressions = split_top_level(sql[opening + 1 : ending])
            predicate = mysql_condition(sql[where_match.end() :].strip())
            shadow_columns: list[str] = []
            statements: list[str] = []
            for position, expression in enumerate(expressions, start=1):
                shadow = safe_name("_px", name, str(position))
                shadow_columns.append(shadow)
                statements.append(
                    f"ALTER TABLE {quote(table)} ADD COLUMN {quote(shadow)} VARCHAR(128) "
                    f"GENERATED ALWAYS AS (CASE WHEN {predicate} THEN CAST({expression} AS CHAR(128)) ELSE NULL END) STORED"
                )
            mysql_name = safe_name("uidx", table, name)
            statements.append(
                f"ALTER TABLE {quote(table)} ADD UNIQUE INDEX {quote(mysql_name)} "
                f"({', '.join(quote(column) for column in shadow_columns)})"
            )
            result.append({"table": table, "name": mysql_name, "sql": statements})
    return result


def foreign_keys(connection: sqlite3.Connection, tables: list[str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for table in tables:
        grouped: dict[int, list[sqlite3.Row]] = {}
        for row in connection.execute(f"PRAGMA foreign_key_list({quote(table)})"):
            grouped.setdefault(row[0], []).append(row)
        for fk_id, rows in grouped.items():
            rows.sort(key=lambda row: row[1])
            parent = rows[0][2]
            child_columns = [row[3] for row in rows]
            parent_columns = [row[4] for row in rows]
            on_update = rows[0][5]
            on_delete = rows[0][6]
            name = safe_name("fk", table, parent, str(fk_id))
            statement = (
                f"ALTER TABLE {quote(table)} ADD CONSTRAINT {quote(name)} FOREIGN KEY "
                f"({', '.join(quote(column) for column in child_columns)}) REFERENCES {quote(parent)} "
                f"({', '.join(quote(column) for column in parent_columns)}) "
                f"ON UPDATE {on_update} ON DELETE {on_delete}"
            )
            result.append({"table": table, "parent": parent, "name": name, "sql": statement})
    return result


def triggers(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    rows = connection.execute(
        "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name"
    ).fetchall()
    pattern = re.compile(
        r"^\s*CREATE\s+TRIGGER\s+\S+\s+BEFORE\s+"
        r"(INSERT|DELETE|UPDATE(?:\s+OF\s+(.+?))?)\s+ON\s+(\S+)\s*"
        r"(?:(?:WHEN)\s+(.+?))?\s*BEGIN\s+(.+?)\s*END\s*;?\s*$",
        re.IGNORECASE | re.DOTALL,
    )
    for name, table, sql in rows:
        match = pattern.match(sql)
        if not match:
            raise ValueError(f"Cannot parse trigger {name}")
        event_source, update_columns, parsed_table, condition, body = match.groups()
        event = "UPDATE" if event_source.upper().startswith("UPDATE") else event_source.upper()
        predicates: list[str] = []
        if update_columns:
            changed = [
                f"NOT (NEW.{quote(column.strip().strip('`\"'))} <=> OLD.{quote(column.strip().strip('`\"'))})"
                for column in split_top_level(update_columns)
            ]
            predicates.append("(" + " OR ".join(changed) + ")")
        if condition:
            predicates.append("(" + mysql_condition(condition) + ")")
        predicate = " AND ".join(predicates) if predicates else "TRUE"
        message_match = re.search(r"RAISE\s*\(\s*ABORT\s*,\s*'((?:''|[^'])*)'\s*\)", body, re.IGNORECASE | re.DOTALL)
        if not message_match:
            raise ValueError(f"Cannot find RAISE message in trigger {name}")
        message = message_match.group(1).replace("''", "'").replace("'", "''")
        mysql_name = safe_name("trg", name)
        statement = (
            f"CREATE TRIGGER {quote(mysql_name)} BEFORE {event} ON {quote(parsed_table.strip('`\"'))} "
            "FOR EACH ROW BEGIN "
            f"IF {predicate} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '{message}'; END IF; "
            "END"
        )
        result.append({"table": table, "name": mysql_name, "sql": statement})
    return result


def build_manifest(source: Path) -> dict[str, Any]:
    connection = sqlite3.connect(source)
    connection.row_factory = sqlite3.Row
    tables = table_names(connection)
    indexed, regular_indexes = index_catalog(connection, tables)
    fks = foreign_keys(connection, tables)

    create_statements: list[dict[str, Any]] = []
    for table in tables:
        create_row = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        columns = table_columns(connection, table)
        primary = sorted((column for column in columns if column[5]), key=lambda column: column[5])
        definitions: list[str] = []
        for column in columns:
            declared = (column[2] or "TEXT").upper()
            if "BLOB" in declared:
                mysql_type = "LONGBLOB"
            elif "INT" in declared:
                mysql_type = "BIGINT"
            elif any(token in declared for token in ("REAL", "FLOA", "DOUB")):
                mysql_type = "DOUBLE"
            elif any(token in declared for token in ("DATE", "TIME")):
                mysql_type = "DATETIME(3)"
            elif column[1] in indexed[table] or column[4] is not None:
                mysql_type = "VARCHAR(128)"
            else:
                mysql_type = "LONGTEXT"
            required = bool(column[3]) or bool(column[5])
            definition = f"{quote(column[1])} {mysql_type}{' NOT NULL' if required else ' NULL'}{mysql_default(column[4])}"
            definitions.append(definition)
        if not primary:
            definitions.insert(0, "`_mysql_row_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT")
            definitions.append("PRIMARY KEY (`_mysql_row_id`)")
        else:
            definitions.append("PRIMARY KEY (" + ", ".join(quote(column[1]) for column in primary) + ")")
        for position, check in enumerate(extract_checks(create_row[0]), start=1):
            name = safe_name("ck", table, str(position))
            definitions.append(f"CONSTRAINT {quote(name)} CHECK ({mysql_condition(check)})")
        sql = (
            f"CREATE TABLE {quote(table)} (\n  "
            + ",\n  ".join(definitions)
            + "\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC"
        )
        create_statements.append({"table": table, "sql": sql})

    partial = partial_indexes(connection, tables)

    user_ids: set[str] = {
        row[0]
        for row in connection.execute("SELECT DISTINCT user_id FROM memberships WHERE user_id IS NOT NULL")
    }
    for table in SEED_TABLES:
        if table == "users" or table not in tables:
            continue
        for fk in connection.execute(f"PRAGMA foreign_key_list({quote(table)})"):
            if fk[2] != "users":
                continue
            for row in connection.execute(f"SELECT DISTINCT {quote(fk[3])} FROM {quote(table)} WHERE {quote(fk[3])} IS NOT NULL"):
                user_ids.add(row[0])

    seed: list[dict[str, Any]] = []
    expected_seed_counts: dict[str, int] = {}
    for table in SEED_TABLES:
        if table not in tables:
            raise ValueError(f"Seed table missing: {table}")
        if table == "users":
            placeholders = ",".join("?" for _ in sorted(user_ids))
            rows = rows_as_dicts(connection, f"SELECT * FROM users WHERE id IN ({placeholders}) ORDER BY id", sorted(user_ids))
        else:
            rows = rows_as_dicts(connection, f"SELECT * FROM {quote(table)} ORDER BY rowid")
        expected_seed_counts[table] = len(rows)
        seed.append({"table": table, "rows": rows})

    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    schema_fingerprint = json.dumps(
        {
            "tables": create_statements,
            "indexes": regular_indexes,
            "partial": partial,
            "foreignKeys": fks,
            "triggers": triggers(connection),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    schema_hash = hashlib.sha256(schema_fingerprint.encode("utf-8")).hexdigest()
    manifest = {
        "formatVersion": 1,
        "sourceSha256": source_hash,
        "schemaSha256": schema_hash,
        "tables": create_statements,
        "indexes": regular_indexes,
        "partialIndexes": partial,
        "foreignKeys": fks,
        "triggers": triggers(connection),
        "seed": seed,
        "expected": {
            "applicationTables": len(tables),
            "foreignKeys": len(fks),
            "triggers": len(triggers(connection)),
            "seedCounts": expected_seed_counts,
            "transactionTables": [table for table in TRANSACTION_TABLES if table in tables],
        },
    }
    connection.close()
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SQLITE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if not args.source.is_file():
        raise SystemExit(f"SQLite source not found: {args.source}")
    manifest = build_manifest(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"Exported {manifest['expected']['applicationTables']} tables, "
        f"{manifest['expected']['foreignKeys']} foreign keys, "
        f"{manifest['expected']['triggers']} triggers to {args.output}"
    )
    print("Seed rows:", sum(manifest["expected"]["seedCounts"].values()))


if __name__ == "__main__":
    main()
