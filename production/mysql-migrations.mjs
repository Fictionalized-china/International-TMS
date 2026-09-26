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
  {
    version: 159,
    name: "tracking_center_and_analytics_permissions",
    definition: [
      "permissions.menu.admin.tracking_center.view",
      "permissions.menu.admin.analytics.view",
      "permissions.analytics.receivable.view",
      "permissions.analytics.payable.view",
      "role_permissions.analytics_navigation",
    ].join("\n"),
    async up(connection) {
      await connection.query(`INSERT INTO permissions(code,module,name,description)
        VALUES ('menu.admin.tracking_center.view','navigation','显示调度与运踪菜单','在管理端侧栏显示调度、运踪与时效预警入口'),
               ('menu.admin.analytics.view','navigation','显示汇总分析菜单','在管理端侧栏显示汇总分析入口'),
               ('analytics.receivable.view','analytics','查看应收汇总','查看汇总分析中的应收金额，不包含应付、毛利或导出'),
               ('analytics.payable.view','analytics','查看应付与成本汇总','查看汇总分析中的应付及成本金额，不包含应收、毛利或导出')
        ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description)`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT role_id,'menu.admin.tracking_center.view' FROM role_permissions WHERE permission_code='shipment.view'`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT role_id,'menu.admin.analytics.view' FROM role_permissions WHERE permission_code='analytics.business.view'`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'analytics.receivable.view' FROM roles WHERE status='active' AND code IN ('owner','boss','pos_finance')`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'analytics.payable.view' FROM roles WHERE status='active' AND code IN ('owner','boss','pos_finance')`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'menu.admin.tracking_center.view' FROM roles WHERE status='active' AND code IN ('owner','boss')`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'menu.admin.analytics.view' FROM roles WHERE status='active' AND code IN ('owner','boss')`);
    },
  },
  {
    version: 160,
    name: "financial_analytics_configuration",
    definition: [
      "permissions.analytics.config.manage",
      "permissions.analytics.manual.fill",
      "analytics_metric_configs",
      "analytics_manual_metric_values",
      "analytics_report_snapshots",
      "analytics_port_settings",
    ].join("\n"),
    async up(connection) {
      await connection.query(`CREATE TABLE IF NOT EXISTS analytics_metric_configs (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id VARCHAR(128) NOT NULL,
        metric_code VARCHAR(128) NOT NULL,
        calculation_mode VARCHAR(24) NOT NULL DEFAULT 'automatic',
        assigned_position_id VARCHAR(128) NULL,
        start_date_source VARCHAR(40) NOT NULL DEFAULT 'settlement_confirmed',
        target_value DECIMAL(20,4) NULL,
        warning_value DECIMAL(20,4) NULL,
        danger_value DECIMAL(20,4) NULL,
        config_json JSON NULL,
        effective_from DATE NOT NULL,
        updated_by_user_id VARCHAR(128) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_analytics_metric_config (organization_id,metric_code),
        KEY idx_analytics_metric_configs_org (organization_id,metric_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await connection.query(`CREATE TABLE IF NOT EXISTS analytics_manual_metric_values (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id VARCHAR(128) NOT NULL,
        metric_code VARCHAR(128) NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        dimension_key VARCHAR(255) NOT NULL DEFAULT '',
        dimension_label VARCHAR(255) NULL,
        numeric_value DECIMAL(20,4) NULL,
        text_value TEXT NULL,
        source_note TEXT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'confirmed',
        entered_by_user_id VARCHAR(128) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_analytics_manual_value (organization_id,metric_code,period_start,period_end,dimension_key),
        KEY idx_analytics_manual_values_period (organization_id,period_start,period_end,metric_code,status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await connection.query(`CREATE TABLE IF NOT EXISTS analytics_report_snapshots (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id VARCHAR(128) NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        generated_at DATETIME(3) NOT NULL,
        generation_mode VARCHAR(24) NOT NULL DEFAULT 'scheduled',
        payload_json JSON NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_analytics_snapshot (organization_id,period_start,period_end,generated_at),
        KEY idx_analytics_snapshots_period (organization_id,period_start,period_end,generated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await connection.query(`CREATE TABLE IF NOT EXISTS analytics_port_settings (
        organization_id VARCHAR(128) NOT NULL,
        port_name VARCHAR(255) NOT NULL,
        is_visible TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 100,
        updated_by_user_id VARCHAR(128) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY (organization_id,port_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      await connection.query(`INSERT INTO permissions(code,module,name,description)
        VALUES ('analytics.config.manage','analytics','配置财务分析口径','配置指标计算方式、岗位、日期来源、目标和预警阈值'),
               ('analytics.manual.fill','analytics','填写财务分析指标','按获授权岗位填写或导入人工统计值')
        ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description)`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'analytics.config.manage' FROM roles WHERE status='active' AND code IN ('owner','boss','pos_finance')`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'analytics.manual.fill' FROM roles WHERE status='active' AND code IN ('owner','boss','pos_finance')`);
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
  ["analytics_metric_configs", "metric_code"],
  ["analytics_manual_metric_values", "numeric_value"],
  ["analytics_report_snapshots", "payload_json"],
  ["analytics_port_settings", "port_name"],
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
            OR (table_name='transport_orders' AND column_name='mark_contacts_snapshot_json')
            OR (table_name='analytics_metric_configs' AND column_name='metric_code')
            OR (table_name='analytics_manual_metric_values' AND column_name='numeric_value')
            OR (table_name='analytics_report_snapshots' AND column_name='payload_json')
            OR (table_name='analytics_port_settings' AND column_name='port_name'))`,
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
