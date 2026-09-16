import { createHash } from "node:crypto";

const migrations = [
  {
    version: 157,
    name: "mark_contact_snapshots",
    definition: [
      "quotations.mark_contact_ids_json TEXT NULL",
      "transport_orders.mark_contacts_snapshot_json TEXT NULL",
      "workflow_step_fields.quotation_mark_contacts",
    ].join("\n"),
    async up(connection) {
      await addColumnIfMissing(connection, "quotations", "mark_contact_ids_json", "TEXT NULL");
      await addColumnIfMissing(connection, "transport_orders", "mark_contacts_snapshot_json", "TEXT NULL");
      await connection.query(
        `INSERT INTO workflow_step_fields(
           id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
           sort_order,options_text,help_text,module_code,handler_position_codes,created_at,updated_at
         )
         SELECT CONCAT(wd.id, ':catalog:consignment:quotation_mark_contacts'),wd.id,s.id,
                'quotation_mark_contacts','我方唛头联系人','multiselect',0,1,25,NULL,
                '按部门与岗位从组织账号中选择 0 至 3 名我方联系人；订单生成时冻结姓名、岗位和电话快照。',
                'consignment','SALES',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)
           FROM workflow_definitions wd
           JOIN workflow_steps s ON s.workflow_id=wd.id AND s.step_key='quotation' AND s.is_active=1
          WHERE wd.road_load_type IN ('ftl','ltl')
         ON DUPLICATE KEY UPDATE id=VALUES(id)`,
      );
    },
  },
];

for (const migration of migrations) {
  migration.checksum = createHash("sha256")
    .update(`${migration.version}:${migration.name}\n${migration.definition}`)
    .digest("hex");
}

export const requiredMysqlSchemaVersion = migrations.at(-1)?.version ?? 0;
export const requiredMysqlSchemaChecksum = migrations.at(-1)?.checksum ?? "";
export const requiredMysqlSchemaColumns = [
  ["quotations", "mark_contact_ids_json"],
  ["transport_orders", "mark_contacts_snapshot_json"],
];

async function addColumnIfMissing(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=? AND column_name=?
      LIMIT 1`,
    [table, column],
  );
  if (rows.length) return;
  await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function ensureMigrationTable(connection) {
  await connection.query(
    `CREATE TABLE IF NOT EXISTS _tms_mysql_migrations (
       version INT NOT NULL PRIMARY KEY,
       name VARCHAR(128) NOT NULL,
       checksum CHAR(64) NOT NULL,
       applied_at DATETIME(3) NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );
}

export function evaluateMysqlSchema({ appliedMigrations, columns }) {
  const expectedMigration = migrations.find((migration) => migration.version === requiredMysqlSchemaVersion);
  const applied = appliedMigrations.find((migration) => Number(migration.version) === requiredMysqlSchemaVersion);
  const available = new Set(columns.map((column) =>
    `${column.table_name ?? column.TABLE_NAME}.${column.column_name ?? column.COLUMN_NAME}`,
  ));
  const missingColumns = requiredMysqlSchemaColumns
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !available.has(column));
  const migrationReady = Boolean(applied && applied.checksum === expectedMigration?.checksum);
  return {
    ready: migrationReady && missingColumns.length === 0,
    version: appliedMigrations.reduce((highest, migration) => Math.max(highest, Number(migration.version) || 0), 0),
    requiredVersion: requiredMysqlSchemaVersion,
    missingColumns,
    migrationState: !applied ? "missing" : migrationReady ? "ready" : "checksum_mismatch",
  };
}

export async function inspectMysqlSchema(connection) {
  const [tableRows] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='_tms_mysql_migrations'",
  );
  const hasMigrationTable = Number(tableRows[0]?.count ?? 0) > 0;
  const [appliedMigrations, columns] = await Promise.all([
    hasMigrationTable
      ? connection.query("SELECT version,name,checksum FROM _tms_mysql_migrations ORDER BY version").then(([rows]) => rows)
      : [],
    connection.query(
      `SELECT table_name,column_name
         FROM information_schema.columns
        WHERE table_schema=DATABASE()
          AND ((table_name='quotations' AND column_name='mark_contact_ids_json')
            OR (table_name='transport_orders' AND column_name='mark_contacts_snapshot_json'))`,
    ).then(([rows]) => rows),
  ]);
  return evaluateMysqlSchema({ appliedMigrations, columns });
}

export async function migrateMysql(connection) {
  const [[lock]] = await connection.query("SELECT GET_LOCK('international_tms_mysql_migrations', 30) AS acquired");
  if (Number(lock?.acquired) !== 1) throw new Error("Unable to acquire MySQL migration lock");
  const appliedVersions = [];
  try {
    await ensureMigrationTable(connection);
    const [rows] = await connection.query("SELECT version,name,checksum FROM _tms_mysql_migrations ORDER BY version");
    const existing = new Map(rows.map((row) => [Number(row.version), row]));
    for (const migration of migrations) {
      const applied = existing.get(migration.version);
      if (applied) {
        if (applied.name !== migration.name || applied.checksum !== migration.checksum) {
          throw new Error(`MySQL migration ${migration.version} checksum mismatch`);
        }
        continue;
      }
      await migration.up(connection);
      await connection.execute(
        "INSERT INTO _tms_mysql_migrations(version,name,checksum,applied_at) VALUES (?,?,?,UTC_TIMESTAMP(3))",
        [migration.version, migration.name, migration.checksum],
      );
      appliedVersions.push(migration.version);
    }
    const status = await inspectMysqlSchema(connection);
    if (!status.ready) throw new Error(`MySQL schema verification failed: ${JSON.stringify(status)}`);
    return { ...status, appliedVersions };
  } finally {
    await connection.query("SELECT RELEASE_LOCK('international_tms_mysql_migrations')").catch(() => undefined);
  }
}
