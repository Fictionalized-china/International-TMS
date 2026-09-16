import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { inspectMysqlSchema } from "../production/mysql-migrations.mjs";

const manifestPath = resolve(process.argv[2] ?? "production/mysql-bootstrap.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const connection = await mysql.createConnection({
  host: required("MYSQL_HOST"),
  port: Number(process.env.MYSQL_PORT ?? 3306),
  database: required("MYSQL_DATABASE"),
  user: required("MYSQL_USER"),
  password: required("MYSQL_PASSWORD"),
  charset: "utf8mb4",
  timezone: "Z",
  dateStrings: true,
  ssl: (process.env.MYSQL_SSL_MODE ?? "preferred").toLowerCase() === "required" ? { rejectUnauthorized: true } : undefined,
});

const failures = [];
try {
  const [stateRows] = await connection.query("SELECT schema_sha256,status FROM `_tms_mysql_bootstrap` WHERE id=1");
  const state = stateRows[0];
  if (!state || state.status !== "ready" || state.schema_sha256 !== manifest.schemaSha256) {
    failures.push("bootstrap state/hash is not ready");
  }
  const [[tableCount]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
  );
  if (Number(tableCount.count) !== manifest.expected.applicationTables + 2) {
    failures.push(`table count ${tableCount.count} != ${manifest.expected.applicationTables + 2}`);
  }
  const [[fkCount]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE()",
  );
  if (Number(fkCount.count) !== manifest.expected.foreignKeys) {
    failures.push(`foreign key count ${fkCount.count} != ${manifest.expected.foreignKeys}`);
  }
  const [[triggerCount]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.triggers WHERE trigger_schema=DATABASE()",
  );
  if (Number(triggerCount.count) !== manifest.expected.triggers) {
    failures.push(`trigger count ${triggerCount.count} != ${manifest.expected.triggers}`);
  }
  for (const [table, expected] of Object.entries(manifest.expected.seedCounts)) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table.replaceAll("`", "``")}\``);
    const migrationRows = table === "workflow_step_fields"
      ? Number((await connection.query("SELECT COUNT(*) AS count FROM workflow_step_fields WHERE field_key='quotation_mark_contacts'"))[0][0].count)
      : 0;
    if (Number(row.count) !== expected + migrationRows) {
      failures.push(`${table} rows ${row.count} != ${expected + migrationRows}`);
    }
  }
  for (const table of manifest.expected.transactionTables) {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table.replaceAll("`", "``")}\``);
    if (Number(row.count) !== 0) failures.push(`${table} must be empty but has ${row.count} rows`);
  }
  const [[workflowCount]] = await connection.query("SELECT COUNT(*) AS count FROM workflow_definitions");
  if (Number(workflowCount.count) !== 2) failures.push(`workflow_definitions rows ${workflowCount.count} != 2`);
  const runtimeSchema = await inspectMysqlSchema(connection);
  if (!runtimeSchema.ready) failures.push(`runtime schema is not ready: ${JSON.stringify(runtimeSchema)}`);
  if (failures.length) throw new Error("MySQL verification failed: " + failures.join("; "));
  console.log(
    `MySQL verification passed: ${manifest.expected.applicationTables} application tables, ` +
      `${manifest.expected.foreignKeys} foreign keys, ${manifest.expected.triggers} triggers, ` +
      `${workflowCount.count} workflow definitions.`,
  );
} finally {
  await connection.end();
}
