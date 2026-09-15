PRAGMA foreign_keys = ON;

-- 报价页面已有费用备注输入，但旧表没有对应列，界面内容会静默丢失。
ALTER TABLE quotation_charges ADD COLUMN notes TEXT;

-- 询价报价的标准输入曾只存在于页面代码，导致工作流第一节点显示 0 个字段。
-- 这里为所有整车/拼车版本补齐同一组原生字段。INSERT OR IGNORE 保留老板
-- 已经配置过的必填、选填、隐藏状态，不覆盖任何既有版本选择。
WITH quotation_fields(
  field_key,label,field_type,module_code,is_required,is_active,sort_order,options_text,help_text
) AS (VALUES
  ('quotation_customer_contact_name','客户联系人','text','consignment',1,1,10,NULL,'本次报价的客户联系人；默认带出客户档案的主联系人。'),
  ('quotation_customer_contact_phone','联系电话','text','consignment',1,1,20,NULL,'本次报价联系人电话。'),
  ('quotation_salesperson_user_id','业务员','select','consignment',1,1,30,NULL,'负责本次询价与报价的业务员；未显示时默认当前操作人。'),
  ('quotation_customs_clearance_mode','清关办理方式','select','consignment',1,1,40,'company|公司代办清关
customer|客户自理清关','选择公司代办清关或客户自理清关。'),
  ('quotation_origin_region','起运地区','select','consignment',1,1,50,NULL,'按国家或地区、省或州、城市三级选择起运地区。'),
  ('quotation_pickup_address','提货地址','textarea','consignment',1,1,60,NULL,'本次报价使用的详细提货地址，可不写入客户常用地址。'),
  ('quotation_destination_region','目的地区','select','consignment',1,1,70,NULL,'按国家或地区、省或州、城市三级选择目的地区。'),
  ('quotation_destination_warehouse_id','目的仓库','warehouse','consignment',1,1,80,NULL,'本次报价的境外目的仓。'),
  ('quotation_destination_warehouse_note','目的地备注','textarea','consignment',0,1,90,NULL,'门牌、联系人、提货窗口等本票补充说明。'),
  ('quotation_cargo_description','货物描述','textarea','cargo',1,1,100,NULL,'货物名称、品类、材质、用途等报价说明。'),
  ('quotation_notes','报价备注','textarea','cargo',0,1,110,NULL,'报价范围、特殊约定或其他说明。'),
  ('quotation_pieces','预计件数','number','cargo',1,1,120,NULL,'本次报价预计货物件数。'),
  ('quotation_gross_weight_kg','预计重量 KG','number','cargo',1,1,130,NULL,'本次报价预计毛重。'),
  ('quotation_length_cm','预计长度 CM','number','cargo',1,1,140,NULL,'单件或统一包装预计长度。'),
  ('quotation_width_cm','预计宽度 CM','number','cargo',1,1,150,NULL,'单件或统一包装预计宽度。'),
  ('quotation_height_cm','预计高度 CM','number','cargo',1,1,160,NULL,'单件或统一包装预计高度。'),
  ('quotation_volume_cbm','预计体积 CBM','number','cargo',1,1,170,NULL,'根据件数和长宽高自动计算；也参与报价接受前门禁。'),
  ('quotation_charge_items','客户应收费用','amount','costs',1,1,180,NULL,'至少一条数量和单价均有效的客户应收费用。'),
  ('quotation_valid_until','报价有效期','date','costs',0,1,190,NULL,'客户接受报价的有效截止日期。')
)
INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT wd.id || ':catalog:' || qf.module_code || ':' || qf.field_key,
       wd.id,s.id,qf.field_key,qf.label,qf.field_type,qf.is_required,qf.is_active,
       qf.sort_order,qf.options_text,qf.help_text,qf.module_code,
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
FROM workflow_definitions wd
JOIN workflow_steps s
  ON s.workflow_id=wd.id AND s.step_key='quotation' AND s.is_active=1
CROSS JOIN quotation_fields qf
WHERE wd.road_load_type IN ('ftl','ltl');

-- 修复旧订单/旧报价实例可能没有字段快照的情况。只补当前及未来节点；
-- 已越过节点不灌入今天的规则，继续保持历史快照与门禁冻结。
INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT lower(hex(randomblob(16))),wi.id,f.workflow_id,s.step_key,
       COALESCE(f.module_code,'consignment'),f.field_key,f.label,f.field_type,
       f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,CURRENT_TIMESTAMP
FROM workflow_instances wi
JOIN workflow_step_fields f ON f.workflow_id=wi.workflow_id
JOIN workflow_steps s
  ON s.id=f.step_id AND s.workflow_id=f.workflow_id
JOIN workflow_steps current_step
  ON current_step.workflow_id=wi.workflow_id
 AND current_step.step_key=wi.current_step_key
WHERE current_step.sort_order<=s.sort_order;
