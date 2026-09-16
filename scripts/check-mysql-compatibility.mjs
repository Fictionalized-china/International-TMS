import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import {
  findSelfReferencingMutations,
  findUnaliasedDerivedTables,
  findUnsupportedLimitInSubqueries,
  findValuesTableCtes,
} from "./mysql-compatibility.mjs";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")) files.push(path);
  }
  return files;
}

const failures = [];
for (const path of await sourceFiles(join(process.cwd(), "app"))) {
  const source = await readFile(path, "utf8");
  for (const failure of findUnsupportedLimitInSubqueries(source)) {
    failures.push(`${relative(process.cwd(), path)}:${failure.line} IN 子查询中直接使用 LIMIT`);
  }
  for (const failure of findUnaliasedDerivedTables(source)) {
    failures.push(`${relative(process.cwd(), path)}:${failure.line} 派生表缺少别名`);
  }
  for (const failure of findSelfReferencingMutations(source)) {
    failures.push(`${relative(process.cwd(), path)}:${failure.line} UPDATE/DELETE 子查询引用了目标表（MySQL 1093）`);
  }
  for (const failure of findValuesTableCtes(source)) {
    failures.push(`${relative(process.cwd(), path)}:${failure.line} CTE 中直接使用 VALUES（MySQL 不支持）`);
  }
}

if (failures.length) {
  console.error("MySQL 兼容检查失败：发现 MySQL 不支持的 SQL 结构。");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("MySQL 兼容检查通过");
