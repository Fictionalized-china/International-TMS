PRAGMA foreign_keys = OFF;

CREATE TABLE order_customs_records_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  clearance_stage TEXT NOT NULL CHECK(clearance_stage IN ('origin','transit','destination')),
  declaration_number TEXT,
  declaration_type TEXT,
  declaration_mode TEXT,
  document_provider TEXT,
  broker_name TEXT,
  broker_contact TEXT,
  cutoff_at TEXT,
  declared_at TEXT,
  released_at TEXT,
  transit_customs INTEGER NOT NULL DEFAULT 0 CHECK(transit_customs IN (0,1)),
  inspection_required INTEGER NOT NULL DEFAULT 0 CHECK(inspection_required IN (0,1)),
  inspection_notes TEXT,
  quarantine_required INTEGER NOT NULL DEFAULT 0 CHECK(quarantine_required IN (0,1)),
  quarantine_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','documents_pending','declared','inspecting','released','cancelled')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO order_customs_records_v2 (
  id,organization_id,order_id,clearance_stage,declaration_number,declaration_type,
  declaration_mode,document_provider,broker_name,broker_contact,cutoff_at,
  declared_at,released_at,transit_customs,inspection_required,inspection_notes,
  quarantine_required,quarantine_notes,status,created_by_user_id,created_at,updated_at
)
SELECT
  id,organization_id,order_id,clearance_stage,declaration_number,declaration_type,
  declaration_mode,document_provider,broker_name,broker_contact,cutoff_at,
  declared_at,released_at,transit_customs,inspection_required,inspection_notes,
  quarantine_required,quarantine_notes,status,created_by_user_id,created_at,updated_at
FROM order_customs_records;

DROP TABLE order_customs_records;
ALTER TABLE order_customs_records_v2 RENAME TO order_customs_records;
CREATE INDEX idx_order_customs_records_order ON order_customs_records(order_id,clearance_stage,status);

CREATE TABLE transport_batch_orders_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL DEFAULT 1 CHECK(sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','assigned','departed','arrived','removed')),
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,order_id)
);

INSERT INTO transport_batch_orders_v2 (
  id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at
)
SELECT
  id,organization_id,batch_id,order_id,sequence_no,
  CASE status WHEN 'loaded' THEN 'assigned' ELSE status END,
  added_by_user_id,created_at,updated_at
FROM transport_batch_orders;

DROP TABLE transport_batch_orders;
ALTER TABLE transport_batch_orders_v2 RENAME TO transport_batch_orders;
CREATE INDEX idx_batch_orders_order ON transport_batch_orders(order_id,status,batch_id);
CREATE INDEX idx_batch_orders_batch ON transport_batch_orders(batch_id,status,sequence_no);

UPDATE order_module_instances
SET enabled=0,
    status='not_applicable',
    current_step_code=NULL,
    current_step_name='未启用（整车/直装）',
    progress_percent=0,
    blocking_reason=NULL,
    updated_at=datetime('now')
WHERE module_code='loading'
  AND order_id IN (
    SELECT id FROM transport_orders WHERE business_type!='ltl'
  );

PRAGMA foreign_keys = ON;
