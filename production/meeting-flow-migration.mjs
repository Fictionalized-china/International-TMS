// MySQL counterpart of local 0168-0179. Never run automatically at application startup.
export async function applyMeetingFlowMigration(connection,addColumn) {
  const tables={
    business_process_policies:"organization_id VARCHAR(128) NOT NULL,policy_key VARCHAR(128) NOT NULL,policy_value TEXT NOT NULL,updated_by_user_id VARCHAR(128),updated_at VARCHAR(40) NOT NULL,PRIMARY KEY(organization_id,policy_key)",
    business_process_policy_history:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,policy_key VARCHAR(128) NOT NULL,old_value TEXT,new_value TEXT NOT NULL,actor_user_id VARCHAR(128) NOT NULL,created_at VARCHAR(40) NOT NULL,KEY policy_history_org(organization_id,created_at)",
    order_daily_tracking:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,shipment_id VARCHAR(128) NOT NULL,request_id VARCHAR(160) NOT NULL,payload_hash VARCHAR(64) NOT NULL,event_kind VARCHAR(32) NOT NULL,event_at VARCHAR(40) NOT NULL,location VARCHAR(200) NOT NULL,vehicle_reference VARCHAR(100),notes TEXT NOT NULL,visible_to_customer INT NOT NULL DEFAULT 1,actor_user_id VARCHAR(128) NOT NULL,created_at VARCHAR(40) NOT NULL,UNIQUE KEY daily_submission_once(organization_id,actor_user_id,request_id),KEY daily_tracking_order(organization_id,order_id,event_at)",
    order_dispatch_requests:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,task_id VARCHAR(128) NOT NULL,status VARCHAR(32) NOT NULL DEFAULT 'pending',planned_port_arrival_at VARCHAR(40) NOT NULL,requested_by_user_id VARCHAR(128),carrier_id VARCHAR(128),vehicle_id VARCHAR(128),driver_id VARCHAR(128),freight_amount DECIMAL(18,4),freight_currency VARCHAR(8),exchange_rate DECIMAL(18,8),resource_notes TEXT,fulfilled_by_user_id VARCHAR(128),fulfilled_at VARCHAR(40),created_at VARCHAR(40) NOT NULL,updated_at VARCHAR(40) NOT NULL,UNIQUE KEY dispatch_order_once(organization_id,order_id)",
    order_payable_offline_approvals:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,approver_name VARCHAR(200) NOT NULL,approved_at VARCHAR(40) NOT NULL,evidence_reference TEXT NOT NULL,recorded_by_user_id VARCHAR(128) NOT NULL,created_at VARCHAR(40) NOT NULL,UNIQUE KEY offline_order_once(organization_id,order_id)",
    order_commission_records:"organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,amount DECIMAL(18,4) NOT NULL DEFAULT 0,status VARCHAR(32) NOT NULL DEFAULT 'pending',paid_on VARCHAR(10),notes TEXT,revision INT NOT NULL DEFAULT 1,updated_by_user_id VARCHAR(128) NOT NULL,updated_at VARCHAR(40) NOT NULL,write_token VARCHAR(128),PRIMARY KEY(organization_id,order_id)",
    order_commission_history:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,amount DECIMAL(18,4) NOT NULL,status VARCHAR(32) NOT NULL,paid_on VARCHAR(10),notes TEXT,revision INT NOT NULL,actor_user_id VARCHAR(128) NOT NULL,created_at VARCHAR(40) NOT NULL,UNIQUE KEY commission_history_revision(organization_id,order_id,revision)",
    hr_report_snapshots:"id VARCHAR(128) PRIMARY KEY,organization_id VARCHAR(128) NOT NULL,period_kind VARCHAR(16) NOT NULL,date_from VARCHAR(10) NOT NULL,date_to VARCHAR(10) NOT NULL,payload_json LONGTEXT NOT NULL,created_at VARCHAR(40) NOT NULL,UNIQUE KEY hr_report_period(organization_id,period_kind,date_from,date_to)",
    settlement_commit_guards:"id VARCHAR(128) PRIMARY KEY,valid INT NOT NULL,created_at VARCHAR(40) NOT NULL",
    settlement_cash_allocation_requests:"organization_id VARCHAR(128) NOT NULL,actor_user_id VARCHAR(128) NOT NULL,request_id VARCHAR(160) NOT NULL,payload_hash VARCHAR(64) NOT NULL,cash_transaction_id VARCHAR(128) NOT NULL,reconciliation_id VARCHAR(128) NOT NULL,created_at VARCHAR(40) NOT NULL,PRIMARY KEY(organization_id,actor_user_id,request_id)",
  };
  for(const [name,columns] of Object.entries(tables))await connection.query(`CREATE TABLE IF NOT EXISTS ${name} (${columns}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  for(const [table,column,type] of [
    ['customers','cs_order_entry_enabled','INT NOT NULL DEFAULT 0'],['transport_orders','planned_port_arrival_at','VARCHAR(40) NULL'],
    ['settlement_cash_transactions','payment_reconciliation_id','VARCHAR(128) NULL'],['settlement_cash_transactions','request_id','VARCHAR(160) NULL'],['settlement_cash_transactions','payload_hash','VARCHAR(64) NULL'],
    ['settlement_cash_transactions','allocation_reserved_amount','DECIMAL(18,4) NOT NULL DEFAULT 0'],['settlement_cash_transactions','allocation_write_token','VARCHAR(128) NULL'],
    ['settlement_reconciliations','payment_reserved_amount','DECIMAL(18,4) NOT NULL DEFAULT 0'],['settlement_reconciliations','payment_write_token','VARCHAR(128) NULL'],
    ['business_expenses','cash_reserved_amount','DECIMAL(18,4) NOT NULL DEFAULT 0'],['business_expenses','cash_write_token','VARCHAR(128) NULL'],
    ['transport_cost_allocations','creation_mode',"VARCHAR(32) NOT NULL DEFAULT 'post_dispatch'"],
    ['quotations','intake_payload_hash','VARCHAR(64) NULL'],['quotations','intake_payables_json','LONGTEXT NULL'],
  ])await addColumn(connection,table,column,type);
  await connection.query(`
CREATE OR REPLACE VIEW eligible_planned_cost_orders AS
SELECT a.id allocation_id,a.organization_id,bo.order_id
FROM transport_cost_allocations a
JOIN transport_batches b ON b.id=a.batch_id AND b.organization_id=a.organization_id
JOIN loading_planning_submissions submission ON submission.batch_id=b.id AND submission.organization_id=b.organization_id
JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
JOIN order_module_instances costs ON costs.organization_id=o.organization_id AND costs.order_id=o.id AND costs.module_code='costs'
WHERE a.creation_mode='planning' AND a.status='draft'
  AND b.approval_status='draft' AND b.status='planning' AND b.actual_departure_at IS NULL
  AND submission.sync_status='pending' AND submission.actor_user_id=a.created_by_user_id
  AND b.approved_by_user_id=submission.actor_user_id
  AND o.status='in_execution' AND o.business_type='ltl'
  AND costs.enabled=1 AND costs.status NOT IN ('completed','not_applicable','blocked')
  AND (o.workflow_instance_id IS NULL OR EXISTS (
    SELECT 1 FROM workflow_instances wi
    JOIN workflow_instance_step_states step ON step.instance_id=wi.id AND step.step_key=wi.current_step_key AND step.status='active'
    JOIN workflow_instance_module_states module ON module.instance_step_state_id=step.id AND module.module_code='loading' AND module.status NOT IN ('completed','not_applicable','blocked')
    WHERE wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id AND wi.order_id=o.id AND wi.status='active'
  ))
  AND EXISTS (SELECT 1 FROM warehouse_packing_jobs job
    WHERE job.organization_id=o.organization_id AND job.order_id=o.id AND job.transport_batch_id=b.id AND job.status='allocated')
  AND NOT EXISTS (SELECT 1 FROM order_expense_direction_controls control
    WHERE control.organization_id=o.organization_id AND control.order_id=o.id AND control.direction='payable'
      AND (control.confirmed=1 OR control.business_reviewed=1 OR control.finance_reviewed=1 OR control.business_locked=1 OR control.finance_locked=1))
  AND NOT EXISTS (SELECT 1 FROM order_tracking_milestones milestone
    WHERE milestone.organization_id=o.organization_id AND milestone.order_id=o.id AND milestone.milestone_code IN ('exported','actual_exit','exit'));
  `);
  const [indexes]=await connection.query("SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='settlement_cash_transactions' AND index_name='cash_submission_once'");
  if(!indexes.length)await connection.query('CREATE UNIQUE INDEX cash_submission_once ON settlement_cash_transactions(organization_id,created_by_user_id,request_id)');
  await connection.query(`UPDATE settlement_reconciliations r LEFT JOIN (SELECT organization_id,payment_reconciliation_id,SUM(amount) amount FROM settlement_cash_transactions WHERE status!='void' GROUP BY organization_id,payment_reconciliation_id) t ON t.organization_id=r.organization_id AND t.payment_reconciliation_id=r.id SET r.payment_reserved_amount=COALESCE(t.amount,0)`);
  await connection.query(`UPDATE settlement_cash_transactions t LEFT JOIN (SELECT organization_id,cash_transaction_id,SUM(amount) amount FROM settlement_cash_allocations GROUP BY organization_id,cash_transaction_id) a ON a.organization_id=t.organization_id AND a.cash_transaction_id=t.id SET t.allocation_reserved_amount=COALESCE(a.amount,0)`);
  await connection.query(`UPDATE business_expenses e LEFT JOIN (SELECT a.organization_id,a.expense_id,SUM(a.amount) amount FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.organization_id=a.organization_id AND t.status!='void' GROUP BY a.organization_id,a.expense_id) a ON a.organization_id=e.organization_id AND a.expense_id=e.id SET e.cash_reserved_amount=COALESCE(a.amount,0)`);
  const grants={
    'order.intake.manage':['pos_sales','pos_customer_service','pos_hr_admin'],
    'customer.view':['pos_hr_admin'],'customer.scope.all':['pos_hr_admin'],
    'workflow.process_policy.manage':[], 'workflow.view':[],
    'tracking.daily.manage':['pos_tracking'], 'dispatch.request':['pos_tracking','pos_operation','pos_operation_supervisor'],
    'dispatch.manage':['pos_business_route'], 'dispatch.cost.view':['pos_business_route','pos_operation_supervisor'],
    'settlement.signature.manage':['pos_sales','pos_customer_service','pos_operation','pos_operation_supervisor','pos_business_route','pos_finance'],
    'settlement.offline_approval.record':['pos_finance'], 'hr.report.view':['pos_hr_admin'], 'hr.report.amount.view':['pos_hr_admin'], 'hr.commission.manage':['pos_hr_admin'],
    'menu.admin.hr_reports.view':['pos_hr_admin'], 'menu.admin.settlement_approvals.view':['pos_sales','pos_customer_service','pos_operation','pos_operation_supervisor','pos_business_route','pos_finance'],
    'order.view':['pos_business_route','pos_hr_admin'], 'shipment.view':['pos_business_route','pos_hr_admin'], 'order.scope.all':['pos_hr_admin'], 'data.export':['pos_hr_admin'],
    'menu.admin.tracking_center.view':['pos_business_route','pos_hr_admin'], 'menu.admin.orders.view':['pos_business_route'],
  };
  for(const [permission,roles] of Object.entries(grants)){
    await connection.query('INSERT IGNORE INTO permissions(code,module,name,description) VALUES(?,?,?,?)',[permission,permission.split('.')[0],permission,'会议流程独立权限；岗位名称及敏感金额另行配置']);
    const roleCodes=['owner','boss','developer',...roles];
    await connection.query(`INSERT IGNORE INTO role_permissions(role_id,permission_code) SELECT id,? FROM roles WHERE status='active' AND code IN (${roleCodes.map(()=>'?').join(',')})`,[permission,...roleCodes]);
  }
  await connection.query("UPDATE position_portal_settings s JOIN positions p ON p.id=s.position_id SET s.business_data_scope='company' WHERE p.code IN ('TRACKING','BUSINESS_ROUTE','HR_ADMIN') AND s.business_data_scope='self'");
  await connection.query("UPDATE workflow_step_fields SET is_required=1,updated_at=UTC_TIMESTAMP(3) WHERE module_code='costs' AND is_active=1 AND field_key IN ('customer_service_confirmation','business_review','finance_review')");
  await connection.query("UPDATE workflow_instance_fields f JOIN workflow_instance_step_states s ON s.instance_id=f.instance_id AND s.step_key=f.step_key SET f.is_required=1 WHERE f.module_code='costs' AND f.is_active=1 AND f.field_key IN ('customer_service_confirmation','business_review','finance_review') AND s.status!='completed'");
}
