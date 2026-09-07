PRAGMA foreign_keys = ON;

-- 商品申报数量与物理包装数量必须分开保存。旧列 pieces 继续作为申报商品数量，
-- 新字段只负责入仓包装、唛头和最终出库包装的业务事实。
ALTER TABLE quotations ADD COLUMN declared_quantity_unit TEXT NOT NULL DEFAULT '件';
ALTER TABLE quotations ADD COLUMN planned_package_count INTEGER NOT NULL DEFAULT 1 CHECK(planned_package_count > 0);
ALTER TABLE quotations ADD COLUMN planned_package_type TEXT NOT NULL DEFAULT 'other';

ALTER TABLE transport_orders ADD COLUMN declared_quantity_unit TEXT NOT NULL DEFAULT '件';
ALTER TABLE transport_orders ADD COLUMN planned_inbound_package_count INTEGER NOT NULL DEFAULT 1 CHECK(planned_inbound_package_count > 0);
ALTER TABLE transport_orders ADD COLUMN planned_inbound_package_type TEXT NOT NULL DEFAULT 'other';
ALTER TABLE transport_orders ADD COLUMN inbound_mark_revision INTEGER NOT NULL DEFAULT 1 CHECK(inbound_mark_revision > 0);
ALTER TABLE transport_orders ADD COLUMN inbound_package_locked_at TEXT;

ALTER TABLE order_cargo_items ADD COLUMN declared_quantity REAL NOT NULL DEFAULT 1 CHECK(declared_quantity > 0);
ALTER TABLE order_cargo_items ADD COLUMN declared_unit TEXT NOT NULL DEFAULT '件';

-- order_cargo_packages 是入仓唛头身份，不再代表最终出境包装。
ALTER TABLE order_cargo_packages ADD COLUMN label_revision INTEGER NOT NULL DEFAULT 1 CHECK(label_revision > 0);
ALTER TABLE order_cargo_packages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1));
ALTER TABLE order_cargo_packages ADD COLUMN is_supplemental INTEGER NOT NULL DEFAULT 0 CHECK(is_supplemental IN (0,1));
ALTER TABLE order_cargo_packages ADD COLUMN received_at TEXT;
ALTER TABLE order_cargo_packages ADD COLUMN received_warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE order_cargo_packages ADD COLUMN received_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL;
ALTER TABLE order_cargo_packages ADD COLUMN received_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- warehouse_packages 保存最终出库包装（OUL）；legacy/inbound_mark 仅用于平滑承接旧表结构。
ALTER TABLE warehouse_packages ADD COLUMN label_kind TEXT NOT NULL DEFAULT 'legacy'
  CHECK(label_kind IN ('legacy','inbound_mark','oul'));
ALTER TABLE warehouse_packages ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_status IN ('active','voided','loaded','in_transit','overseas_received','signed'));
ALTER TABLE warehouse_packages ADD COLUMN source_order_package_id TEXT REFERENCES order_cargo_packages(id) ON DELETE SET NULL;
ALTER TABLE warehouse_packages ADD COLUMN packing_revision INTEGER NOT NULL DEFAULT 1 CHECK(packing_revision > 0);
ALTER TABLE warehouse_packages ADD COLUMN voided_at TEXT;
ALTER TABLE warehouse_packages ADD COLUMN voided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE warehouse_packages ADD COLUMN void_reason TEXT;
ALTER TABLE warehouse_packages ADD COLUMN signed_at TEXT;

-- 一个 OUL 可由同一订单的多个入仓包装合并而来；一个入仓包装也可拆分到多个 OUL。
CREATE TABLE warehouse_package_relations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  inbound_package_id TEXT NOT NULL REFERENCES order_cargo_packages(id) ON DELETE RESTRICT,
  outbound_package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'packed' CHECK(relation_type IN ('kept','merged','split','packed')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(inbound_package_id,outbound_package_id)
);

CREATE INDEX idx_order_cargo_packages_active_mark
  ON order_cargo_packages(organization_id,order_id,is_active,status,package_sequence);
CREATE INDEX idx_warehouse_packages_oul
  ON warehouse_packages(organization_id,label_kind,lifecycle_status,shipment_id);
CREATE INDEX idx_warehouse_package_relations_outbound
  ON warehouse_package_relations(outbound_package_id,inbound_package_id);

-- PZ 编号使用稳定的两位仓库编号。先按组织内创建顺序为现有仓库分配，之后不可随意改动。
ALTER TABLE warehouses ADD COLUMN serial_code TEXT;
WITH ranked AS (
  SELECT id,organization_id,
         printf('%02d',ROW_NUMBER() OVER(PARTITION BY organization_id ORDER BY created_at,id)) serial_code
  FROM warehouses
)
UPDATE warehouses
   SET serial_code=(SELECT ranked.serial_code FROM ranked WHERE ranked.id=warehouses.id)
 WHERE serial_code IS NULL;
CREATE UNIQUE INDEX idx_warehouses_org_serial_code
  ON warehouses(organization_id,serial_code);

-- 新字段进入所有现有整车/拼车报价工作流；老板仍可在具体版本改成选填或隐藏。
WITH quotation_fields(
  field_key,label,field_type,module_code,is_required,is_active,sort_order,options_text,help_text
) AS (VALUES
  ('quotation_declared_quantity_unit','商品数量单位','text','cargo',1,1,121,NULL,'报关与商业单据使用的商品数量单位，例如件、套、台。'),
  ('quotation_planned_package_count','预计入仓包装数','number','cargo',1,1,122,NULL,'按物理外包装数量生成入仓唛头；不等于包装内商品数量。'),
  ('quotation_planned_package_type','预计包装类型','select','cargo',1,1,123,'carton|纸箱
pallet|托盘
wooden_case|木箱
bag|袋装
other|其他','本次预计入仓的物理外包装类型。')
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
JOIN workflow_steps s ON s.workflow_id=wd.id AND s.step_key='quotation' AND s.is_active=1
CROSS JOIN quotation_fields qf
WHERE wd.road_load_type IN ('ftl','ltl');

INSERT OR IGNORE INTO workflow_instance_fields(
  id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,
  is_required,is_active,sort_order,options_text,help_text,created_at
)
SELECT lower(hex(randomblob(16))),wi.id,f.workflow_id,s.step_key,
       COALESCE(f.module_code,'cargo'),f.field_key,f.label,f.field_type,
       f.is_required,f.is_active,f.sort_order,f.options_text,f.help_text,CURRENT_TIMESTAMP
FROM workflow_instances wi
JOIN workflow_step_fields f ON f.workflow_id=wi.workflow_id
JOIN workflow_steps s ON s.id=f.step_id AND s.workflow_id=f.workflow_id
JOIN workflow_steps current_step ON current_step.workflow_id=wi.workflow_id AND current_step.step_key=wi.current_step_key
WHERE current_step.sort_order<=s.sort_order
  AND f.field_key IN ('quotation_declared_quantity_unit','quotation_planned_package_count','quotation_planned_package_type');

-- 国内仓收货改为扫码驱动；旧的包装数、商品件数输入从新订单工作流中退出。
UPDATE workflow_step_fields
   SET is_required=0,is_active=0,updated_at=CURRENT_TIMESTAMP
 WHERE field_key IN ('actual_package_count','actual_pieces')
   AND step_id IN (SELECT id FROM workflow_steps WHERE step_key='warehouse_receiving');

INSERT OR IGNORE INTO workflow_step_fields(
  id,workflow_id,step_id,field_key,label,field_type,is_required,is_active,
  sort_order,options_text,help_text,module_code,created_at,updated_at
)
SELECT wd.id || ':catalog:warehouse:inbound_mark_scan',wd.id,s.id,
       'inbound_mark_scan','入仓唛头扫码','text',1,1,1190,NULL,
       '逐一扫描每个外包装上的入仓唛头；包装数由扫码结果自动汇总。','warehouse',
       CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
  FROM workflow_definitions wd
  JOIN workflow_steps s ON s.workflow_id=wd.id AND s.step_key='warehouse_receiving' AND s.is_active=1
 WHERE wd.road_load_type IN ('ftl','ltl');
