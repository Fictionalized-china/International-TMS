function isIdentifierCharacter(char) {
  return Boolean(char && /[A-Za-z0-9_]/.test(char));
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function readQuoted(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] !== quote) continue;
    if (source[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return source.length;
}

function findClosingParen(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      index = readQuoted(source, index) - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function containsTopLevelKeyword(source, keyword) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === "`") {
      index = readQuoted(source, index) - 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || source.slice(index, index + keyword.length).toUpperCase() !== keyword) continue;
    if (!isIdentifierCharacter(source[index - 1]) && !isIdentifierCharacter(source[index + keyword.length])) return true;
  }
  return false;
}

export function findUnsupportedLimitInSubqueries(source) {
  const failures = [];
  const pattern = /\bIN\s*\(/gi;
  for (const match of source.matchAll(pattern)) {
    const opening = source.indexOf("(", match.index);
    const closing = findClosingParen(source, opening);
    if (closing < 0) continue;
    const bodyStart = skipWhitespace(source, opening + 1);
    if (source.slice(bodyStart, bodyStart + 6).toUpperCase() !== "SELECT") continue;
    const body = source.slice(bodyStart, closing);
    if (!containsTopLevelKeyword(body, "LIMIT")) continue;
    failures.push({ index: match.index, line: source.slice(0, match.index).split(/\r?\n/).length });
  }
  return failures;
}

const derivedTableClauseKeywords = new Set([
  "WHERE", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET", "JOIN", "LEFT", "RIGHT",
  "INNER", "OUTER", "CROSS", "ON", "UNION", "EXCEPT", "INTERSECT",
]);

export function findUnaliasedDerivedTables(source) {
  const failures = [];
  const pattern = /\b(?:FROM|JOIN)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const opening = source.indexOf("(", match.index);
    const closing = findClosingParen(source, opening);
    if (closing < 0) continue;
    const next = skipWhitespace(source, closing + 1);
    if (/^AS\s+[A-Za-z_][A-Za-z0-9_]*/i.test(source.slice(next))) continue;
    const alias = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(next))?.[0];
    if (alias && !derivedTableClauseKeywords.has(alias.toUpperCase())) continue;
    failures.push({ index: match.index, line: source.slice(0, match.index).split(/\r?\n/).length });
  }
  return failures;
}

// SQLite accepts VALUES directly as a CTE body. MySQL requires the equivalent
// rows to be expressed with SELECT / UNION ALL.
export function findValuesTableCtes(source) {
  const failures = [];
  const pattern = /\b[A-Za-z_][A-Za-z0-9_]*\s*(?:\([^)]*\))?\s+AS\s*\(\s*VALUES\s*\(/gi;
  for (const match of source.matchAll(pattern)) {
    failures.push({
      index: match.index,
      line: source.slice(0, match.index).split(/\r?\n/).length,
    });
  }
  return failures;
}

// Extract string literals that carry SQL, so the self-reference check cannot be
// confused by prose in comments or identifiers elsewhere in the TypeScript
// source.  Template literals skip ${...} interpolations (replaced by "?"),
// which also prevents nested backticks from corrupting the pairing.
function extractSqlStrings(source) {
  const out = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "`") {
      let cursor = index + 1;
      let buffer = "";
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === "\\") {
          buffer += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (inner === "$" && source[cursor + 1] === "{") {
          let depth = 1;
          let scan = cursor + 2;
          while (scan < source.length && depth > 0) {
            if (source[scan] === "{") depth += 1;
            else if (source[scan] === "}") depth -= 1;
            scan += 1;
          }
          buffer += "?";
          cursor = scan;
          continue;
        }
        if (inner === "`") break;
        buffer += inner;
        cursor += 1;
      }
      if (cursor < source.length && /^\s*(?:UPDATE\b|DELETE\s+FROM\b)/i.test(buffer)) {
        out.push({ sql: buffer, index });
      }
      if (cursor >= source.length) break;
      index = cursor + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      let buffer = "";
      while (cursor < source.length) {
        const inner = source[cursor];
        if (inner === "\\") {
          buffer += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (inner === char) break;
        buffer += inner;
        cursor += 1;
      }
      if (cursor < source.length && /^\s*(?:UPDATE\b|DELETE\s+FROM\b)/i.test(buffer)) {
        out.push({ sql: buffer, index });
      }
      if (cursor >= source.length) break;
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return out;
}

const mutationTargetPattern = /^\s*(?:UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i;

// MySQL ERROR 1093 (ER_UPDATE_TABLE_USED): an UPDATE/DELETE may not re-read its
// own target table from a subquery FROM/JOIN.  SQLite (D1) allows it, so the
// pattern must be caught before it reaches a MySQL build.
export function findSelfReferencingMutations(source) {
  const failures = [];
  for (const { sql, index } of extractSqlStrings(source)) {
    const match = mutationTargetPattern.exec(sql);
    if (!match) continue;
    const table = match[1];
    // Ignore SQL string literals so VALUES like 'FROM shipments' cannot false-positive.
    const body = sql.slice(match[0].length).replace(/'(?:[^']|'')*'/g, "'?'");
    const referencePattern = new RegExp(`\\b(?:FROM|JOIN)\\s+${table}(?![A-Za-z0-9_])`, "i");
    if (referencePattern.test(body)) {
      failures.push({ index, line: source.slice(0, index).split(/\r?\n/).length });
    }
  }
  return failures;
}
