import mysql, {
  type ExecuteValues,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import {
  isRetryableMysqlTransactionError,
  mysqlPoolQueueLimit,
  mysqlTransactionRetryDelayMs,
  readBoundedInteger,
} from "./mysql-transaction-policy";

type BoundValue = string | number | null | ArrayBuffer | ArrayBufferView;

let pool: Pool | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少生产环境变量 ${name}`);
  return value;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function getPool(): Pool {
  if (pool) return pool;
  pool = mysql.createPool({
    host: required("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: required("MYSQL_DATABASE"),
    user: required("MYSQL_USER"),
    password: required("MYSQL_PASSWORD"),
    connectionLimit: readBoundedInteger(process.env.MYSQL_POOL_SIZE, 6, 1, 32),
    waitForConnections: true,
    queueLimit: mysqlPoolQueueLimit(process.env.MYSQL_QUEUE_LIMIT),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    decimalNumbers: true,
    namedPlaceholders: false,
    multipleStatements: false,
  });
  pool.pool.on("connection", (connection) => {
    // Registered on the underlying callback pool so every initialization query is
    // queued before the connection is handed to a promise-pool caller. Calling
    // `.catch()` on these query objects instead stalls the first pooled request.
    //
    // `charset: "utf8mb4"` only sets the handshake collation, and mysql2 resolves
    // it to utf8mb4_general_ci — while every table in this schema is
    // utf8mb4_0900_ai_ci. A comparison between a column and an expression that
    // inherits the connection collation (a JSON_TABLE VARCHAR column, or
    // `CAST(value AS CHAR)` built from one) is IMPLICIT on both sides, so MySQL
    // raises ER_CANT_AGGREGATE_2COLLATIONS (1267) instead of coercing the
    // literal-like side. Following the database default keeps the session
    // aligned with the schema without hard-coding a collation name here.
    connection.query(
      "SET collation_connection = @@collation_database",
      (error) => {
        if (error) console.error("Unable to initialize MySQL collation", error);
      },
    );
    connection.query(
      "SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'PIPES_AS_CONCAT')",
      (error) => {
        if (error) console.error("Unable to initialize MySQL sql_mode", error);
      },
    );
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) console.error("Unable to initialize MySQL time zone", error);
    });
  });
  return pool;
}

async function runInTransaction<T>(
  work: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const retryLimit = readBoundedInteger(
    process.env.MYSQL_TRANSACTION_RETRIES,
    2,
    0,
    5,
  );
  for (let attempt = 0; ; attempt += 1) {
    const connection = await getPool().getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(
          "MYSQL_ROLLBACK_FAILED",
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }
      if (attempt >= retryLimit || !isRetryableMysqlTransactionError(error))
        throw error;
    } finally {
      connection.release();
    }
    await wait(mysqlTransactionRetryDelayMs(attempt));
  }
}

function normalizeBinding(value: BoundValue): ExecuteValues {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function findClosingParen(source: string, opening: number): number {
  let depth = 0;
  let quote = "";
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function replaceFunctions(
  source: string,
  name: string,
  convert: (args: string[]) => string,
): string {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "ig");
  let cursor = 0;
  let output = "";
  for (;;) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) return output + source.slice(cursor);
    const opening = source.indexOf("(", match.index);
    const closing = findClosingParen(source, opening);
    if (closing < 0) return output + source.slice(cursor);
    output += source.slice(cursor, match.index);
    output += convert(splitArguments(source.slice(opening + 1, closing)));
    cursor = closing + 1;
  }
}

function translatePrintf(args: string[]): string {
  const format = args[0]?.replace(/^['"]|['"]$/g, "");
  if (format === "%.2f" && args[1]) {
    return `REPLACE(FORMAT(${args[1]}, 2), ',', '')`;
  }
  if (format === "%03d" && args[1]) {
    return `LPAD(CAST(${args[1]} AS CHAR), 3, '0')`;
  }
  if (format === "%g × %g × %g" && args.length >= 4) {
    return `CONCAT(CAST(${args[1]} AS CHAR), ' × ', CAST(${args[2]} AS CHAR), ' × ', CAST(${args[3]} AS CHAR))`;
  }
  throw new Error(`MySQL 运行层尚不支持 printf 格式: ${args[0] ?? ""}`);
}

function translateGroupConcat(args: string[]): string {
  if (args.length === 1) return `GROUP_CONCAT(${args[0]})`;
  return `GROUP_CONCAT(${args[0]} SEPARATOR ${args[1]})`;
}

function translateScalarExtrema(name: "MAX" | "MIN", args: string[]): string {
  if (args.length <= 1) return `${name}(${args[0] ?? ""})`;
  return `${name === "MAX" ? "GREATEST" : "LEAST"}(${args.join(", ")})`;
}

/**
 * MySQL rejects a leading `WITH` clause in front of `INSERT`
 * (`WITH ... INSERT INTO ...` is SQLite/PostgreSQL syntax). It requires the CTE
 * list to follow the insert target instead:
 * `INSERT INTO t (cols) WITH cte AS (...) SELECT ...`.
 */
function moveLeadingWithClauseIntoInsert(sql: string): string {
  if (!/^WITH\s/i.test(sql)) return sql;
  const insertIndex = findTopLevelKeyword(sql, "INSERT", 0);
  if (insertIndex < 0) return sql;
  const targetEnd = findInsertTargetEnd(sql, insertIndex);
  if (targetEnd < 0) return sql;
  const insertTarget = sql.slice(insertIndex, targetEnd).trimEnd();
  const cteClause = sql.slice(0, insertIndex).trim();
  return `${insertTarget} ${cteClause} ${sql.slice(targetEnd).trimStart()}`;
}

function findTopLevelKeyword(
  source: string,
  keyword: string,
  from: number,
): number {
  let depth = 0;
  let quote = "";
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (
      depth === 0 &&
      source.slice(index, index + keyword.length).toUpperCase() === keyword
    ) {
      const before = source[index - 1] ?? " ";
      const after = source[index + keyword.length] ?? " ";
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after))
        return index;
    }
  }
  return -1;
}

function findInsertTargetEnd(source: string, insertIndex: number): number {
  const rest = source.slice(insertIndex);
  const match = /^INSERT\s+(?:IGNORE\s+)?INTO\s+/i.exec(rest);
  if (!match) return -1;
  let cursor = insertIndex + match[0].length;
  while (cursor < source.length && /[A-Za-z0-9_$.`]/.test(source[cursor]))
    cursor += 1;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] === "(") {
    const closing = findClosingParen(source, cursor);
    if (closing < 0) return -1;
    cursor = closing + 1;
  }
  return cursor;
}

function translateUpsert(sql: string): string {
  return sql
    .replace(
      /ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+UPDATE\s+SET\s+([\s\S]+)$/i,
      (_match, _keys: string, assignments: string) =>
        `ON DUPLICATE KEY UPDATE ${assignments.replace(/excluded\.([A-Za-z_][A-Za-z0-9_]*)/gi, "VALUES($1)")}`,
    )
    .replace(
      /ON\s+CONFLICT\s*\(([^)]+)\)\s*DO\s+NOTHING\s*$/i,
      (_match, keys: string) => {
        const key = keys.split(",")[0].trim();
        return `ON DUPLICATE KEY UPDATE ${key}=${key}`;
      },
    );
}

export function translateSqliteSql(input: string): string {
  let sql = input.trim().replace(/;\s*$/, "");
  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT IGNORE");
  sql = sql.replace(/\bINSERT\s+OR\s+REPLACE\b/gi, "REPLACE");
  sql = moveLeadingWithClauseIntoInsert(sql);
  sql = sql.replace(/\s+COLLATE\s+NOCASE\b/gi, "");
  sql = sql.replace(/datetime\s*\(\s*'now'\s*\)/gi, "UTC_TIMESTAMP(3)");
  sql = sql.replace(/date\s*\(\s*'now'\s*\)/gi, "UTC_DATE()");
  sql = sql.replace(
    /lower\s*\(\s*hex\s*\(\s*randomblob\s*\(\s*16\s*\)\s*\)\s*\)/gi,
    "LOWER(HEX(RANDOM_BYTES(16)))",
  );
  // SQLite's json_each exposes the array index as `key`, which is a reserved
  // word in MySQL and must be quoted; JSON_TABLE supplies it via FOR ORDINALITY.
  sql = sql.replace(
    /\bCAST\s*\(\s*key\s+AS\s+(?:INTEGER|SIGNED)\s*\)/gi,
    "CAST(`key` AS SIGNED)",
  );
  sql = sql.replace(/\bAS\s+INTEGER\s*\)/gi, "AS SIGNED)");
  sql = sql.replace(
    /CAST\s*\(([^()]+?)\s+AS\s+TEXT\s*\)/gi,
    "CAST($1 AS CHAR)",
  );
  sql = sql.replace(
    /FROM\s+json_each\s*\(\s*\?\s*\)/gi,
    // Must be a replacer function: in a replacement string the `$'` inside the
    // JSON path is a special pattern (the text after the match) and silently
    // truncated the generated SQL, breaking every json_each caller on MySQL.
    // JSON_TABLE declares no columns of its own, so the SQLite readings are
    // reproduced here: `key` (reserved word in MySQL) as the element ordinal,
    // `value` for scalar elements (VARCHAR cannot hold objects) and
    // `value_json` for object elements, which JSON_EXTRACT below reads.
    () =>
      "FROM JSON_TABLE(?, '$[*]' COLUMNS(`key` FOR ORDINALITY, value VARCHAR(255) PATH '$', value_json JSON PATH '$')) AS json_each",
  );
  sql = replaceFunctions(sql, "printf", translatePrintf);
  sql = replaceFunctions(sql, "GROUP_CONCAT", translateGroupConcat);
  sql = replaceFunctions(
    sql,
    "json_extract",
    (args) => `JSON_UNQUOTE(JSON_EXTRACT(${args.join(", ")}))`,
  );
  // json_each elements can also be objects, which the VARCHAR `value` column
  // cannot carry, so object extraction reads the JSON copy of the element.
  sql = sql.replace(
    /\bJSON_EXTRACT\s*\(\s*value\s*,/gi,
    "JSON_EXTRACT(value_json,",
  );
  sql = replaceFunctions(sql, "MAX", (args) =>
    translateScalarExtrema("MAX", args),
  );
  sql = replaceFunctions(sql, "MIN", (args) =>
    translateScalarExtrema("MIN", args),
  );
  sql = sql.replace(
    /CAST\s*\(([\s\S]+?)\s+AS\s+TEXT\s*\)/gi,
    "CAST($1 AS CHAR)",
  );
  return translateUpsert(sql);
}

function d1Meta(header?: ResultSetHeader) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: header?.affectedRows ?? 0,
    last_row_id: header?.insertId ?? 0,
    changed_db: Boolean(header?.affectedRows),
    changes: header?.affectedRows ?? 0,
  };
}

async function tableInfo(connection: Pool | PoolConnection, table: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT column_name AS name, ordinal_position - 1 AS cid,
            data_type AS type, IF(is_nullable='NO',1,0) AS notnull,
            column_default AS dflt_value,
            IF(column_key='PRI',1,0) AS pk
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}

class MysqlPreparedStatement {
  private values: ExecuteValues[] = [];

  constructor(
    private readonly db: MysqlD1Database,
    private readonly sourceSql: string,
  ) {}

  bind(...values: BoundValue[]) {
    this.values = values.map(normalizeBinding);
    return this;
  }

  private async withConnection<T>(
    existing: PoolConnection | undefined,
    callback: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    if (existing) return callback(existing);
    const connection = await getPool().getConnection();
    try {
      return await callback(connection);
    } finally {
      connection.release();
    }
  }

  private isDocumentSequenceReturning() {
    return /^\s*UPDATE\s+document_sequences\b[\s\S]+\bRETURNING\s+next_value\s*-\s*1\s+AS\s+value\s*;?\s*$/i.test(
      this.sourceSql,
    );
  }

  private isNotificationClaimReturning() {
    return /^\s*UPDATE\s+internal_notifications\b[\s\S]+\bRETURNING\s+id\s*,/i.test(
      this.sourceSql,
    );
  }

  private async executeDocumentSequenceReturning(connection?: PoolConnection) {
    return this.withConnection(connection, async (activeConnection) => {
      const [header] = await activeConnection.execute<ResultSetHeader>(
        `UPDATE document_sequences
            SET next_value = LAST_INSERT_ID(next_value + 1)
          WHERE organization_id = ? AND document_type = ?`,
        this.values,
      );
      if (header.affectedRows === 0) return { rows: [], header };
      const [rows] = await activeConnection.query<RowDataPacket[]>(
        "SELECT LAST_INSERT_ID() - 1 AS value",
      );
      return { rows, header };
    });
  }

  private async executeNotificationClaimReturning(connection?: PoolConnection) {
    return this.withConnection(connection, async (activeConnection) => {
      const ownsTransaction = !connection;
      if (ownsTransaction) await activeConnection.beginTransaction();
      try {
        const [now, organizationId, userId] = this.values;
        const [candidates] = await activeConnection.execute<RowDataPacket[]>(
          `SELECT id
             FROM internal_notifications
            WHERE organization_id = ? AND user_id = ? AND popup_shown_at IS NULL
              AND category != 'order_assignment'
            ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                     created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [organizationId, userId],
        );
        const id = candidates[0]?.id;
        if (!id) {
          if (ownsTransaction) await activeConnection.commit();
          return { rows: [], header: undefined };
        }
        const [header] = await activeConnection.execute<ResultSetHeader>(
          `UPDATE internal_notifications
              SET popup_shown_at = ?
            WHERE id = ? AND organization_id = ? AND user_id = ? AND popup_shown_at IS NULL`,
          [now, id, organizationId, userId],
        );
        let rows: RowDataPacket[] = [];
        if (header.affectedRows) {
          const [selected] = await activeConnection.execute<RowDataPacket[]>(
            `SELECT id,category,severity,title,message,link,requires_ack,is_read,
                    popup_shown_at,acknowledged_at,created_at
               FROM internal_notifications
              WHERE id = ?`,
            [id],
          );
          rows = selected;
        }
        if (ownsTransaction) await activeConnection.commit();
        return { rows, header };
      } catch (error) {
        if (ownsTransaction) await activeConnection.rollback();
        throw error;
      }
    });
  }

  private async execute(connection?: PoolConnection) {
    const pragma = this.sourceSql.match(
      /^\s*PRAGMA\s+table_info\s*\(\s*([A-Za-z0-9_]+)\s*\)\s*;?\s*$/i,
    );
    if (pragma)
      return {
        rows: await tableInfo(connection ?? getPool(), pragma[1]),
        header: undefined,
      };

    if (/\bsqlite_master\b/i.test(this.sourceSql)) {
      const [rows] = await (connection ?? getPool()).query<RowDataPacket[]>(
        `SELECT table_name AS name
           FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ?`,
        this.values,
      );
      return { rows, header: undefined };
    }

    if (this.isDocumentSequenceReturning()) {
      return this.executeDocumentSequenceReturning(connection);
    }
    if (this.isNotificationClaimReturning()) {
      return this.executeNotificationClaimReturning(connection);
    }

    const translated = translateSqliteSql(this.sourceSql);
    const [result] = await (connection ?? getPool()).execute(
      translated,
      this.values,
    );
    if (Array.isArray(result))
      return { rows: result as RowDataPacket[], header: undefined };
    return { rows: [], header: result as ResultSetHeader };
  }

  async all<T>() {
    const { rows, header } = await this.execute();
    return { results: rows as T[], success: true, meta: d1Meta(header) };
  }

  async first<T>(columnName?: string) {
    const { rows } = await this.execute();
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (columnName ? row[columnName] : row) as T;
  }

  async run() {
    const { rows, header } = await this.execute();
    return { results: rows, success: true, meta: d1Meta(header) };
  }

  async executeOn(connection: PoolConnection) {
    const { rows, header } = await this.execute(connection);
    return { results: rows, success: true, meta: d1Meta(header) };
  }
}

class MysqlD1Database {
  prepare(sql: string) {
    return new MysqlPreparedStatement(this, sql);
  }

  async batch(statements: MysqlPreparedStatement[]) {
    return runInTransaction(async (connection) => {
      const results = [];
      for (const statement of statements)
        results.push(await statement.executeOn(connection));
      return results;
    });
  }

  async exec(script: string) {
    const statements = script
      .split(/;\s*(?:\r?\n|$)/)
      .map((value) => value.trim())
      .filter(Boolean);
    return runInTransaction(async (connection) => {
      for (const statement of statements)
        await connection.query(translateSqliteSql(statement));
      return { count: statements.length, duration: 0 };
    });
  }
}

export function createMysqlD1Database(): D1Database {
  return new MysqlD1Database() as unknown as D1Database;
}
