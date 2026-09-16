PRAGMA foreign_keys = ON;

ALTER TABLE quotations ADD COLUMN mark_contact_ids_json TEXT;
ALTER TABLE transport_orders ADD COLUMN mark_contacts_snapshot_json TEXT;

-- 新报价可由工作流决定唛头联系人必填、选填或隐藏；已有报价未填写该列时
-- 仍由订单生成逻辑使用旧联系电话兼容，不改变历史唛头。
INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,handler_position_codes,created_at,updated_at
)
SELECT wd.id || ':catalog:consignment:quotation_mark_contacts',wd.id,s.id,
       'quotation_mark_contacts','我方唛头联系人','multiselect',0,1,25,NULL,
       '按部门与岗位从组织账号中选择 0 至 3 名我方联系人；订单生成时冻结姓名、岗位和电话快照。',
       'consignment','SALES',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM workflow_definitions wd
  JOIN workflow_steps s ON s.workflow_id=wd.id AND s.step_key='quotation' AND s.is_active=1
 WHERE wd.road_load_type IN ('ftl','ltl');
