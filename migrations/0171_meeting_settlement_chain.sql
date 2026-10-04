CREATE TABLE order_payable_offline_approvals(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,order_id TEXT NOT NULL,approver_name TEXT NOT NULL,approved_at TEXT NOT NULL,evidence_reference TEXT NOT NULL,recorded_by_user_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(organization_id,order_id));
INSERT OR IGNORE INTO permissions(code,module,name,description) VALUES
('settlement.signature.manage','billing','办理订单费用签核','按业务流程策略与本单责任人办理应收应付签核'),
('settlement.offline_approval.record','billing','记录线下付款审批','财务登记总经理线下审批人、时间与凭证');
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'settlement.signature.manage' FROM roles WHERE code IN ('owner','boss','developer','pos_sales','pos_customer_service','pos_operation','pos_operation_supervisor','pos_business_route','pos_finance') AND status='active';
INSERT OR IGNORE INTO role_permissions(role_id,permission_code)
SELECT id,'settlement.offline_approval.record' FROM roles WHERE code IN ('owner','boss','developer','pos_finance') AND status='active';
-- Meeting default is sequential and all three enabled signatures are mandatory.
-- Hidden fields remain hidden; completed instance steps are never rewritten.
UPDATE workflow_step_fields SET is_required=1,updated_at=datetime('now') WHERE module_code='costs' AND is_active=1 AND field_key IN ('customer_service_confirmation','business_review','finance_review');
UPDATE workflow_instance_fields SET is_required=1 WHERE module_code='costs' AND is_active=1 AND field_key IN ('customer_service_confirmation','business_review','finance_review')
AND EXISTS(SELECT 1 FROM workflow_instance_step_states s WHERE s.instance_id=workflow_instance_fields.instance_id AND s.step_key=workflow_instance_fields.step_key AND s.status!='completed');
