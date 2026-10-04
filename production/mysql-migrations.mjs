import { createHash } from "node:crypto";
import { applyLoadingIntegrityMigration, loadingIntegrityTriggers } from "./loading-integrity-migration.mjs";
import { applyMeetingFlowMigration } from './meeting-flow-migration.mjs';

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
  {
    version: 161,
    name: "operational_rule_configuration",
    definition: [
      "operational_rule_configs",
      "operational_rule_configs.rule_code",
      "operational_rule_configs.numeric_value",
    ].join("\n"),
    async up(connection) {
      await connection.query(`CREATE TABLE IF NOT EXISTS operational_rule_configs (
        id VARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id VARCHAR(128) NOT NULL,
        rule_code VARCHAR(128) NOT NULL,
        numeric_value DECIMAL(20,4) NOT NULL,
        updated_by_user_id VARCHAR(128) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_operational_rule_config (organization_id,rule_code),
        KEY idx_operational_rule_configs_org (organization_id,rule_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    },
  },
  {
    version: 162,
    name: "sales_to_operation_intake_flow",
    definition: [
      "workflow_step_modules.sales_to_operation",
      "workflow_module_tasks.sales_to_operation",
      "role_permissions.intake_costs_loading",
    ].join("\n"),
    async up(connection) {
      await connection.query(`UPDATE workflow_step_modules module
        JOIN workflow_steps step ON step.id=module.step_id
        SET module.is_required=0,module.responsibility_position_code='SALES',module.updated_at=UTC_TIMESTAMP(3)
        WHERE step.step_key='quotation' AND module.module_code='consignment'`);
      await connection.query(`UPDATE workflow_module_tasks task
        JOIN workflow_step_modules module ON module.id=task.step_module_id
        JOIN workflow_steps step ON step.id=module.step_id
        SET task.is_required=0,task.responsibility_position_code='SALES',
            task.instructions='询价报价是可选销售工具；线下确认的业务可直接录单。',task.updated_at=UTC_TIMESTAMP(3)
        WHERE step.step_key='quotation' AND module.module_code='consignment'`);
      await connection.query(`UPDATE workflow_step_modules module
        JOIN workflow_steps step ON step.id=module.step_id
        SET module.is_required=0,module.responsibility_position_code='SALES',module.updated_at=UTC_TIMESTAMP(3)
        WHERE step.step_key='order_creation' AND module.module_code='costs'`);
      await connection.query(`UPDATE workflow_module_tasks task
        JOIN workflow_step_modules module ON module.id=task.step_module_id
        JOIN workflow_steps step ON step.id=module.step_id
        SET task.responsibility_position_code='SALES',
            task.instructions='整车补齐六类开单费用，拼车至少补齐提货费；明确为零也必须录入。',task.updated_at=UTC_TIMESTAMP(3)
        WHERE step.step_key='order_creation' AND module.module_code='costs'`);
      await connection.query(`UPDATE workflow_step_modules module
        JOIN workflow_steps step ON step.id=module.step_id
        SET module.responsibility_position_code='OPERATION_SUPERVISOR',module.updated_at=UTC_TIMESTAMP(3)
        WHERE (step.step_key='consignment_approval' AND module.module_code='consignment')
           OR (step.step_key='port_loading' AND module.module_code='loading')`);
      await connection.query(`UPDATE workflow_module_tasks task
        JOIN workflow_step_modules module ON module.id=task.step_module_id
        JOIN workflow_steps step ON step.id=module.step_id
        SET task.responsibility_position_code='OPERATION_SUPERVISOR',
            task.instructions=CASE
              WHEN step.step_key='consignment_approval' THEN '操作主管核对委托资料与开单费用并明确通过或退回。'
              ELSE '操作主管根据已登记的境外运输资源确定整车或拼车配载；仓库只执行扫码装车、出库与交接。'
            END,
            task.updated_at=UTC_TIMESTAMP(3)
        WHERE (step.step_key='consignment_approval' AND module.module_code='consignment')
           OR (step.step_key='port_loading' AND module.module_code='loading')`);
      await connection.query(`UPDATE workflow_step_fields SET
        help_text='操作主管查看完整委托资料和开单费用后通过或退回。',updated_at=UTC_TIMESTAMP(3)
        WHERE field_key='approval_result' AND module_code='consignment'`);
      await connection.query(`UPDATE order_workflow_transitions SET
        target_step_name='操作主管审批',updated_at=UTC_TIMESTAMP(3)
        WHERE action_code='submit' AND from_status='draft'`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'order.module.costs.manage' FROM roles
        WHERE status='active' AND code IN ('pos_sales','pos_operation','pos_operation_supervisor')`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'order.module.consignment.manage' FROM roles
        WHERE status='active' AND code='pos_operation_supervisor'`);
      await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code)
        SELECT id,'order.module.loading.manage' FROM roles
        WHERE status='active' AND code='pos_operation_supervisor'`);
    },
  },
  {
    version: 167,
    name: "loading_integrity_and_sync",
    definition: "transport_batch_order_claims;loading_planning_submissions;order_settlement_sync_requests\n" + JSON.stringify(loadingIntegrityTriggers),
    up: applyLoadingIntegrityMigration,
  },
];

migrations.push({version:179,name:'configurable_meeting_flow_and_atomic_settlement',definition:applyMeetingFlowMigration.toString(),up:connection=>applyMeetingFlowMigration(connection,addColumnIfMissing)});
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
  ["operational_rule_configs", "rule_code"],
  ["transport_batch_order_claims", "batch_id"],
  ["loading_planning_submissions", "sync_status"],
  ["order_settlement_sync_requests", "revision"],
  ['business_process_policies','policy_key'], ['order_daily_tracking','request_id'], ['order_dispatch_requests','status'],
  ['order_payable_offline_approvals','evidence_reference'], ['order_commission_records','write_token'], ['hr_report_snapshots','payload_json'],
  ['settlement_commit_guards','valid'], ['settlement_cash_transactions','request_id'], ['settlement_reconciliations','payment_reserved_amount'], ['business_expenses','cash_reserved_amount'],
  ['transport_cost_allocations','creation_mode'],
  ['quotations','intake_payload_hash'],
  ['settlement_cash_allocation_requests','payload_hash'],
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
          AND (${requiredMysqlSchemaColumns.map(()=>'(table_name=? AND column_name=?)').join(' OR ')})`,
      requiredMysqlSchemaColumns.flat(),
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
