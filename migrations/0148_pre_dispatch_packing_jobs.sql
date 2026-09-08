PRAGMA foreign_keys = ON;

-- 二次打包必须先于配载单和装车任务存在。该表保存订单级最终包装事实，
-- 使 OUL 的生成和贴标不再依赖 warehouse_dispatches。
CREATE TABLE warehouse_packing_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE RESTRICT,
  transport_batch_id TEXT REFERENCES transport_batches(id) ON DELETE RESTRICT,
  dispatch_id TEXT REFERENCES warehouse_dispatches(id) ON DELETE RESTRICT,
  packing_mode TEXT NOT NULL CHECK(packing_mode IN ('preserve','merge','split')),
  source_package_count INTEGER NOT NULL CHECK(source_package_count > 0),
  outbound_package_count INTEGER NOT NULL CHECK(outbound_package_count BETWEEN 1 AND 500),
  total_weight_kg REAL NOT NULL CHECK(total_weight_kg > 0),
  total_volume_cbm REAL NOT NULL CHECK(total_volume_cbm > 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK(status IN ('generated','labelled','allocated','loading','dispatched','cancelled')),
  labeling_confirmed_at TEXT,
  labeling_confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE warehouse_packing_job_sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  packing_job_id TEXT NOT NULL REFERENCES warehouse_packing_jobs(id) ON DELETE CASCADE,
  inbound_warehouse_package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(packing_job_id,inbound_warehouse_package_id)
);

ALTER TABLE warehouse_packages ADD COLUMN packing_job_id TEXT
  REFERENCES warehouse_packing_jobs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_warehouse_packing_jobs_active_order
  ON warehouse_packing_jobs(organization_id,warehouse_id,order_id)
  WHERE status!='cancelled';
CREATE INDEX idx_warehouse_packing_jobs_queue
  ON warehouse_packing_jobs(organization_id,warehouse_id,status,updated_at DESC);
CREATE INDEX idx_warehouse_packing_job_sources_package
  ON warehouse_packing_job_sources(organization_id,inbound_warehouse_package_id);
CREATE INDEX idx_warehouse_packages_packing_job
  ON warehouse_packages(organization_id,packing_job_id,lifecycle_status);

CREATE TRIGGER warehouse_packing_job_scope_insert_guard
BEFORE INSERT ON warehouse_packing_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM shipments shipment
  WHERE shipment.id=NEW.shipment_id
    AND shipment.organization_id=NEW.organization_id
    AND shipment.order_id=NEW.order_id
) OR NOT EXISTS (
  SELECT 1 FROM warehouse_receipts receipt
  WHERE receipt.organization_id=NEW.organization_id
    AND receipt.warehouse_id=NEW.warehouse_id
    AND receipt.shipment_id=NEW.shipment_id
    AND receipt.status='completed' AND receipt.cargo_complete=1
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_scope_invalid');
END;

CREATE TRIGGER warehouse_packing_job_source_insert_guard
BEFORE INSERT ON warehouse_packing_job_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_jobs job
  JOIN warehouse_packages package_row
    ON package_row.id=NEW.inbound_warehouse_package_id
   AND package_row.organization_id=NEW.organization_id
  JOIN shipments shipment
    ON shipment.id=package_row.shipment_id
   AND shipment.organization_id=package_row.organization_id
  WHERE job.id=NEW.packing_job_id
    AND job.organization_id=NEW.organization_id
    AND job.warehouse_id=package_row.warehouse_id
    AND job.order_id=shipment.order_id
    AND package_row.label_kind='inbound_mark'
    AND package_row.lifecycle_status='active'
    AND package_row.status='in_stock'
) OR EXISTS (
  SELECT 1
  FROM warehouse_packing_job_sources existing_source
  JOIN warehouse_packing_jobs existing_job ON existing_job.id=existing_source.packing_job_id
  WHERE existing_source.organization_id=NEW.organization_id
    AND existing_source.inbound_warehouse_package_id=NEW.inbound_warehouse_package_id
    AND existing_source.packing_job_id!=NEW.packing_job_id
    AND existing_job.status!='cancelled'
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_source_scope_invalid');
END;

CREATE TRIGGER warehouse_package_packing_job_insert_guard
BEFORE INSERT ON warehouse_packages
WHEN NEW.packing_job_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_jobs job
  WHERE job.id=NEW.packing_job_id
    AND job.organization_id=NEW.organization_id
    AND job.warehouse_id=NEW.warehouse_id
    AND job.shipment_id=NEW.shipment_id
    AND job.status!='cancelled'
    AND NEW.label_kind='oul'
    AND NEW.lifecycle_status='active'
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_oul_scope_invalid');
END;

CREATE TRIGGER warehouse_packing_job_status_transition_guard
BEFORE UPDATE OF status ON warehouse_packing_jobs
WHEN NEW.status!=OLD.status AND NOT (
  (OLD.status='generated' AND NEW.status IN ('labelled','cancelled')) OR
  (OLD.status='labelled' AND NEW.status IN ('allocated','cancelled')) OR
  (OLD.status='allocated' AND NEW.status IN ('loading','cancelled')) OR
  (OLD.status='loading' AND NEW.status='dispatched')
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_status_transition_invalid');
END;

CREATE TRIGGER warehouse_packing_job_ready_integrity_guard
BEFORE UPDATE OF status ON warehouse_packing_jobs
WHEN NEW.status IN ('labelled','allocated','loading','dispatched') AND (
  NEW.source_package_count != (
    SELECT COUNT(*) FROM warehouse_packing_job_sources source
    WHERE source.organization_id=NEW.organization_id AND source.packing_job_id=NEW.id
  ) OR NEW.outbound_package_count != (
    SELECT COUNT(*) FROM warehouse_packages package_row
    WHERE package_row.organization_id=NEW.organization_id
      AND package_row.packing_job_id=NEW.id
      AND package_row.label_kind='oul' AND package_row.lifecycle_status!='voided'
  ) OR EXISTS (
    SELECT 1 FROM warehouse_packages package_row
    WHERE package_row.organization_id=NEW.organization_id
      AND package_row.packing_job_id=NEW.id
      AND package_row.label_kind='oul' AND package_row.lifecycle_status!='voided'
      AND (COALESCE(package_row.weight_kg,0)<=0 OR COALESCE(package_row.length_cm,0)<=0
        OR COALESCE(package_row.width_cm,0)<=0 OR COALESCE(package_row.height_cm,0)<=0
        OR COALESCE(package_row.volume_cbm,0)<=0)
  )
)
BEGIN
  SELECT RAISE(ABORT,'packing_job_counts_or_measures_incomplete');
END;
