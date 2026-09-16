import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translateSqliteSql } from "./mysql-d1.server";

describe("MySQL SQL compatibility translation", () => {
  it("translates SQLite scalar MAX and MIN calls", () => {
    expect(
      translateSqliteSql(
        "UPDATE orders SET retry_count=MAX(retry_count, ?), sort_order=MIN(sort_order, ?)",
      ),
    ).toBe(
      "UPDATE orders SET retry_count=GREATEST(retry_count, ?), sort_order=LEAST(sort_order, ?)",
    );
  });

  it("preserves aggregate MAX and MIN calls", () => {
    expect(
      translateSqliteSql(
        "SELECT MAX(created_at) AS latest, MIN(created_at) AS earliest FROM orders",
      ),
    ).toBe(
      "SELECT MAX(created_at) AS latest, MIN(created_at) AS earliest FROM orders",
    );
  });

  it("handles nested expressions without changing their arguments", () => {
    expect(
      translateSqliteSql(
        "UPDATE orders SET quantity=MAX(COALESCE(quantity, 0), CAST(? AS INTEGER))",
      ),
    ).toBe(
      "UPDATE orders SET quantity=GREATEST(COALESCE(quantity, 0), CAST(? AS SIGNED))",
    );
  });

  it("translates SQLite integer casts inside aggregate expressions", () => {
    expect(
      translateSqliteSql(
        "SELECT CAST(ROUND(AVG(progress_percent)) AS INTEGER) FROM order_module_instances",
      ),
    ).toBe(
      "SELECT CAST(ROUND(AVG(progress_percent)) AS SIGNED) FROM order_module_instances",
    );
  });

  it("translates json_each without treating the JSON path as a replacement token", () => {
    const translated = translateSqliteSql(
      "SELECT CAST(key AS INTEGER),json_extract(value,'$.milestone_code') FROM json_each(?)",
    );
    expect(translated).toContain("JSON_TABLE(?, '$[*]' COLUMNS(");
    expect(translated).toContain("value_json JSON PATH '$'");
    expect(translated).toContain(
      "JSON_EXTRACT(value_json, '$.milestone_code')",
    );
    expect(translated).not.toContain("PATH '\n");
  });
});

const jsonTableCall =
  "JSON_TABLE(?, '$[*]' COLUMNS(`key` FOR ORDINALITY, value VARCHAR(255) PATH '$', value_json JSON PATH '$')) AS json_each";

describe("MySQL json_each translation", () => {
  it("keeps the full generated JSON_TABLE call when json_each is the only source", () => {
    const translated = translateSqliteSql(
      "SELECT DISTINCT CAST(value AS TEXT) order_id FROM json_each(?)",
    );
    expect(translated).toBe(
      `SELECT DISTINCT CAST(value AS CHAR) order_id FROM ${jsonTableCall}`,
    );
  });

  it("does not drop the SQL that follows json_each in a CTE", () => {
    const translated = translateSqliteSql(`WITH target_orders AS (
       SELECT DISTINCT CAST(value AS TEXT) order_id
       FROM json_each(?)
     )
     SELECT target.order_id FROM target_orders target WHERE target.order_id IS NOT NULL`);
    expect(translated).toContain(`FROM ${jsonTableCall}\n     )`);
    expect(translated).toContain("WHERE target.order_id IS NOT NULL");
    expect(translated).not.toContain("AS TEXT");
  });

  it("translates every indented json_each occurrence", () => {
    const translated = translateSqliteSql(`SELECT 1 FROM json_each(?)
     UNION ALL
     SELECT 2 FROM json_each(?)
     UNION ALL
     SELECT 3 FROM json_each(?)`);
    expect(translated.match(/JSON_TABLE/g)).toHaveLength(3);
    expect(translated).not.toContain("json_each(?)");
  });

  it("has balanced quotes so MySQL cannot reject the statement with ER_PARSE_ERROR", () => {
    const translated = translateSqliteSql(
      "SELECT DISTINCT CAST(value AS TEXT) order_id FROM json_each(?)",
    );
    expect((translated.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("quotes the reserved `key` column of json_each", () => {
    expect(
      translateSqliteSql(
        "SELECT CAST(key AS INTEGER) AS source_order FROM json_each(?)",
      ),
    ).toBe(
      `SELECT CAST(\`key\` AS SIGNED) AS source_order FROM ${jsonTableCall}`,
    );
  });
});

describe("MySQL CTE placement for INSERT", () => {
  it("moves a leading WITH clause after the insert target", () => {
    expect(
      translateSqliteSql(
        "WITH cte AS (SELECT 1 AS n) INSERT INTO orders (id) SELECT n FROM cte",
      ),
    ).toBe(
      "INSERT INTO orders (id) WITH cte AS (SELECT 1 AS n) SELECT n FROM cte",
    );
  });

  it("keeps INSERT IGNORE and the column list attached to the target", () => {
    expect(
      translateSqliteSql(
        "WITH c AS (SELECT 1 AS n) INSERT OR IGNORE INTO orders (id) SELECT n FROM c",
      ),
    ).toBe(
      "INSERT IGNORE INTO orders (id) WITH c AS (SELECT 1 AS n) SELECT n FROM c",
    );
  });

  it("handles an insert target without a column list", () => {
    expect(
      translateSqliteSql(
        "WITH c AS (SELECT 1 AS n) INSERT INTO orders SELECT n FROM c",
      ),
    ).toBe("INSERT INTO orders WITH c AS (SELECT 1 AS n) SELECT n FROM c");
  });

  it("rewrites the consolidated tracking statement into MySQL shape", () => {
    const translated = translateSqliteSql(`WITH target_orders AS (
       SELECT DISTINCT CAST(value AS TEXT) AS order_id
       FROM json_each(?)
     ),
     shared_milestones AS (
       SELECT CAST(json_extract(value, '$.milestone_code') AS TEXT) AS milestone_code
       FROM json_each(?)
     )
     INSERT INTO order_tracking_milestones(
       id,organization_id,order_id,milestone_code
     )
     SELECT lower(hex(randomblob(16))), ?, target.order_id, milestone.milestone_code
     FROM target_orders target
     CROSS JOIN shared_milestones milestone`);
    expect(
      translated.startsWith("INSERT INTO order_tracking_milestones("),
    ).toBe(true);
    expect(translated).toContain(") WITH target_orders AS (");
    expect(translated).toContain("PATH '$')) AS json_each");
    expect(translated).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(value_json, '$.milestone_code')) AS CHAR",
    );
    expect(translated).toContain("CROSS JOIN shared_milestones milestone");
    expect(translated).not.toMatch(/^WITH /);
  });

  it("leaves a read-only WITH ... SELECT untouched", () => {
    const sql = "WITH c AS (SELECT 1 AS n) SELECT n FROM c";
    expect(translateSqliteSql(sql)).toBe(sql);
  });
});

describe("translateSqliteSql replacement safety", () => {
  const source = readFileSync(
    new URL("./mysql-d1.server.ts", import.meta.url),
    "utf8",
  );

  it("never uses a replacement string containing a special $-pattern", () => {
    expect(findUnsafeReplacementStrings(source)).toEqual([]);
  });

  it("flags the historical json_each replacement that broke production", () => {
    const legacy = `sql = sql.replace(
    /FROM\\s+json_each\\s*\\(\\s*\\?\\s*\\)/gi,
    "FROM JSON_TABLE(?, '$[*]' COLUMNS(value VARCHAR(255) PATH '$')) AS json_each",
  );`;
    expect(findUnsafeReplacementStrings(legacy)).toHaveLength(1);
  });
});

describe("MySQL session collation", () => {
  const source = readFileSync(
    new URL("./mysql-d1.server.ts", import.meta.url),
    "utf8",
  );

  it("aligns every pooled session with the database collation", () => {
    // mysql2 maps `charset: "utf8mb4"` to the utf8mb4_general_ci handshake while
    // this schema is utf8mb4_0900_ai_ci. Without this statement MySQL raises
    // ER_CANT_AGGREGATE_2COLLATIONS (1267) for comparisons between a column and
    // a JSON_TABLE/CAST expression, which broke /admin/orders/<id>.data.
    expect(source).toContain("SET collation_connection = @@collation_database");
  });

  it("does not hard-code a single collation name for the session", () => {
    expect(source).not.toMatch(/collation_connection\s*=\s*utf8mb4_/i);
  });
});

/**
 * The inline statements above are hand-copied shapes. This block reads the real
 * statements out of the source tree so the regression net cannot drift away from
 * the code that actually runs on MySQL — the original `$'` bug reached production
 * precisely because no test ever translated a real call site.
 */
describe("MySQL translation of the real json_each call sites", () => {
  const appRoot = path.resolve(
    path.dirname(
      fileURLToPath(new URL("./mysql-d1.server.test.ts", import.meta.url)),
    ),
    "..",
  );

  const callSites = collectSourceFiles(appRoot).flatMap((file) =>
    extractTemplateLiterals(readFileSync(file, "utf8"))
      .filter((sql) => sql.includes("json_each(") && !sql.includes("${"))
      .map((sql) => ({ file: path.relative(appRoot, file), sql })),
  );

  it("finds the statements that read a JSON array in SQL", () => {
    expect(callSites.length).toBeGreaterThanOrEqual(3);
    expect(
      new Set(callSites.map((site) => site.file)).size,
    ).toBeGreaterThanOrEqual(2);
  });

  it("turns every one of them into MySQL-valid SQL", () => {
    for (const { file, sql } of callSites) {
      const translated = translateSqliteSql(sql);
      expect(translated, file).not.toContain("json_each(?)");
      expect(translated, file).not.toContain("JSON_EXTRACT(value,");
      expect(translated, file).not.toContain("AS TEXT");
      // No leading `WITH` may survive in front of an INSERT: MySQL only accepts
      // the CTE list after the insert target.
      if (/\bINSERT\s/i.test(translated)) {
        expect(translated.startsWith("INSERT"), file).toBe(true);
      }
      // The `$'` bug left an odd number of quotes behind, which MySQL rejects
      // with ER_PARSE_ERROR.
      expect((translated.match(/'/g) ?? []).length % 2, file).toBe(0);
    }
  });
});

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      found.push(full);
  }
  return found;
}

function extractTemplateLiterals(source: string): string[] {
  const literals: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "`") continue;
    let cursor = index + 1;
    let value = "";
    while (cursor < source.length && source[cursor] !== "`") {
      if (source[cursor] === "\\") {
        const escaped = source[cursor + 1] ?? "";
        value +=
          escaped === "n"
            ? "\n"
            : escaped === "t"
              ? "\t"
              : escaped === "r"
                ? "\r"
                : `\\${escaped}`;
        cursor += 2;
        continue;
      }
      value += source[cursor];
      cursor += 1;
    }
    if (source[cursor] === "`") literals.push(value);
    index = cursor;
  }
  return literals;
}

/**
 * `$'`, "$`" and `$&` inside a replacement string are expanded by
 * String.prototype.replace and silently corrupt the generated SQL, so any
 * string-literal replacement must avoid them (use a replacer function instead).
 */
function findUnsafeReplacementStrings(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/\.replace\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const replacement = splitTopLevelArguments(source, start)[1]?.trim();
    if (!replacement || !/^["'`]/.test(replacement)) continue;
    if (/\$(?:'|`|&)/.test(replacement))
      offenders.push(replacement.slice(0, 120));
  }
  return offenders;
}

function splitTopLevelArguments(source: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      current += char;
      if (char === "\\") {
        current += source[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) break;
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  args.push(current);
  return args;
}
