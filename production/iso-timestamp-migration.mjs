/** Match D1 and the legacy MySQL schema's ISO-8601 text timestamp contract.
 * Only feature-owned timestamp columns are converted, never order/cargo data.
 * MySQL strict DATETIME rejects the trailing Z used by every domain writer.
 */
export async function applyIsoTimestampMigration(connection) {
  const tables = [
    'analytics_metric_configs', 'analytics_manual_metric_values', 'analytics_report_snapshots', 'analytics_port_settings',
    'operational_rule_configs', 'loading_planning_submissions', 'order_settlement_sync_requests',
    'business_process_policies', 'business_process_policy_history', 'order_daily_tracking', 'order_dispatch_requests',
    'order_payable_offline_approvals', 'order_commission_records', 'order_commission_history', 'hr_report_snapshots',
    'settlement_commit_guards', 'settlement_cash_allocation_requests',
  ];
  const timestampColumns = ['created_at','updated_at','generated_at','sync_started_at','event_at','planned_port_arrival_at','fulfilled_at','approved_at'];
  const [columns] = await connection.query(`SELECT table_name AS table_name,column_name AS column_name,data_type AS data_type,is_nullable AS is_nullable,column_default AS column_default,extra AS extra
    FROM information_schema.columns WHERE table_schema=DATABASE()
      AND table_name IN (${tables.map(() => '?').join(',')}) AND column_name IN (${timestampColumns.map(() => '?').join(',')})`, [...tables,...timestampColumns]);
  for (const column of columns) {
    if (!tables.includes(column.table_name) || !timestampColumns.includes(column.column_name)) throw new Error('Unexpected timestamp migration target');
    const target = `\`${column.table_name}\``;
    const field = `\`${column.column_name}\``;
    if (['datetime','timestamp'].includes(column.data_type)) {
      if (column.column_default != null || column.extra) throw new Error(`Timestamp column has an unexpected default: ${column.table_name}.${column.column_name}`);
      await connection.query(`ALTER TABLE ${target} MODIFY COLUMN ${field} VARCHAR(32) ${column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    } else if (column.data_type !== 'varchar') {
      throw new Error(`Unexpected timestamp type: ${column.table_name}.${column.column_name}`);
    }
    // Safe on retry after a partial DDL migration. Keep nulls and existing ISO
    // values intact, and retain each historical UTC instant to the millisecond.
    await connection.query(`UPDATE ${target} SET ${field}=CONCAT(DATE_FORMAT(CAST(${field} AS DATETIME(3)),'%Y-%m-%dT%H:%i:%s.'),LEFT(DATE_FORMAT(CAST(${field} AS DATETIME(3)),'%f'),3),'Z') WHERE ${field} LIKE '____-__-__ __:__:__%'`);
  }
}
