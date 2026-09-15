PRAGMA foreign_keys = ON;

-- 最终包装批次是入仓唛头与出仓 OUL 之间的订单级追溯边界。
-- 一个 PZ 可以承载多张订单，但每个包装批次和每张 OUL 始终只属于一张订单。
CREATE TABLE warehouse_packing_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  transport_batch_id TEXT REFERENCES transport_batches(id) ON DELETE RESTRICT,
  dispatch_id TEXT NOT NULL REFERENCES warehouse_dispatches(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK(source_type IN ('ftl_order','pz_order')),
  packing_mode TEXT NOT NULL CHECK(packing_mode IN ('preserve','merge','split')),
  source_package_count INTEGER NOT NULL CHECK(source_package_count > 0),
  outbound_package_count INTEGER NOT NULL CHECK(outbound_package_count BETWEEN 1 AND 500),
  total_weight_kg REAL CHECK(total_weight_kg IS NULL OR total_weight_kg > 0),
  total_volume_cbm REAL CHECK(total_volume_cbm IS NULL OR total_volume_cbm > 0),
  notes TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK(status IN ('generated','printed','labelled','loading','dispatched','cancelled')),
  labels_printed_at TEXT,
  labels_printed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  labeling_confirmed_at TEXT,
  labeling_confirmed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,dispatch_id,order_id,revision),
  CHECK(
    (source_type='ftl_order' AND transport_batch_id IS NULL) OR
    (source_type='pz_order' AND transport_batch_id IS NOT NULL)
  )
);

CREATE TABLE warehouse_packing_batch_sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  packing_batch_id TEXT NOT NULL REFERENCES warehouse_packing_batches(id) ON DELETE CASCADE,
  inbound_warehouse_package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(packing_batch_id,inbound_warehouse_package_id)
);

ALTER TABLE warehouse_packages ADD COLUMN packing_batch_id TEXT
  REFERENCES warehouse_packing_batches(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_warehouse_packing_batches_active_order
  ON warehouse_packing_batches(organization_id,dispatch_id,order_id)
  WHERE status!='cancelled';
CREATE INDEX idx_warehouse_packing_batches_dispatch
  ON warehouse_packing_batches(organization_id,warehouse_id,dispatch_id,status);
CREATE INDEX idx_warehouse_packing_batch_sources_package
  ON warehouse_packing_batch_sources(organization_id,inbound_warehouse_package_id);
CREATE INDEX idx_warehouse_packages_packing_batch
  ON warehouse_packages(organization_id,packing_batch_id,lifecycle_status);

CREATE TRIGGER warehouse_packing_batch_scope_insert_guard
BEFORE INSERT ON warehouse_packing_batches
WHEN NOT (
  (
    NEW.source_type='ftl_order'
    AND NEW.transport_batch_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM warehouse_dispatches dispatch
      JOIN shipments shipment
        ON shipment.id=dispatch.shipment_id
       AND shipment.organization_id=dispatch.organization_id
      WHERE dispatch.id=NEW.dispatch_id
        AND dispatch.organization_id=NEW.organization_id
        AND dispatch.transport_batch_id IS NULL
        AND shipment.order_id=NEW.order_id
    )
  )
  OR
  (
    NEW.source_type='pz_order'
    AND NEW.transport_batch_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM warehouse_dispatches dispatch
      JOIN transport_batches batch
        ON batch.id=NEW.transport_batch_id
       AND batch.organization_id=NEW.organization_id
      JOIN transport_batch_orders batch_order
        ON batch_order.batch_id=batch.id
       AND batch_order.organization_id=batch.organization_id
       AND batch_order.order_id=NEW.order_id
       AND batch_order.status!='removed'
      WHERE dispatch.id=NEW.dispatch_id
        AND dispatch.organization_id=NEW.organization_id
        AND dispatch.transport_batch_id=NEW.transport_batch_id
        AND batch.warehouse_id=NEW.warehouse_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT,'packing_batch_scope_invalid');
END;

CREATE TRIGGER warehouse_packing_batch_scope_update_guard
BEFORE UPDATE OF organization_id,warehouse_id,order_id,transport_batch_id,dispatch_id,source_type
ON warehouse_packing_batches
WHEN (
  NEW.organization_id IS NOT OLD.organization_id OR
  NEW.warehouse_id IS NOT OLD.warehouse_id OR
  NEW.order_id IS NOT OLD.order_id OR
  NEW.transport_batch_id IS NOT OLD.transport_batch_id OR
  NEW.dispatch_id IS NOT OLD.dispatch_id OR
  NEW.source_type IS NOT OLD.source_type
) AND (
  EXISTS(SELECT 1 FROM warehouse_packing_batch_sources source WHERE source.packing_batch_id=OLD.id)
  OR EXISTS(SELECT 1 FROM warehouse_packages package_row WHERE package_row.packing_batch_id=OLD.id)
)
BEGIN
  SELECT RAISE(ABORT,'packing_batch_identity_locked');
END;

CREATE TRIGGER warehouse_packing_source_insert_guard
BEFORE INSERT ON warehouse_packing_batch_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_batches batch
  JOIN warehouse_packages package_row
    ON package_row.id=NEW.inbound_warehouse_package_id
   AND package_row.organization_id=NEW.organization_id
  JOIN shipments shipment
    ON shipment.id=package_row.shipment_id
   AND shipment.organization_id=package_row.organization_id
  WHERE batch.id=NEW.packing_batch_id
    AND batch.organization_id=NEW.organization_id
    AND batch.warehouse_id=package_row.warehouse_id
    AND batch.order_id=shipment.order_id
    AND package_row.label_kind='inbound_mark'
    AND package_row.lifecycle_status!='voided'
) OR EXISTS (
  SELECT 1
  FROM warehouse_packing_batch_sources existing_source
  JOIN warehouse_packing_batches existing_batch
    ON existing_batch.id=existing_source.packing_batch_id
   AND existing_batch.organization_id=existing_source.organization_id
  WHERE existing_source.organization_id=NEW.organization_id
    AND existing_source.inbound_warehouse_package_id=NEW.inbound_warehouse_package_id
    AND existing_source.packing_batch_id!=NEW.packing_batch_id
    AND existing_batch.status!='cancelled'
)
BEGIN
  SELECT RAISE(ABORT,'packing_source_scope_invalid');
END;

CREATE TRIGGER warehouse_packing_source_update_guard
BEFORE UPDATE OF organization_id,packing_batch_id,inbound_warehouse_package_id
ON warehouse_packing_batch_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_batches batch
  JOIN warehouse_packages package_row
    ON package_row.id=NEW.inbound_warehouse_package_id
   AND package_row.organization_id=NEW.organization_id
  JOIN shipments shipment
    ON shipment.id=package_row.shipment_id
   AND shipment.organization_id=package_row.organization_id
  WHERE batch.id=NEW.packing_batch_id
    AND batch.organization_id=NEW.organization_id
    AND batch.warehouse_id=package_row.warehouse_id
    AND batch.order_id=shipment.order_id
    AND package_row.label_kind='inbound_mark'
    AND package_row.lifecycle_status!='voided'
)
OR EXISTS (
  SELECT 1
  FROM warehouse_packing_batch_sources existing_source
  JOIN warehouse_packing_batches existing_batch
    ON existing_batch.id=existing_source.packing_batch_id
   AND existing_batch.organization_id=existing_source.organization_id
  WHERE existing_source.organization_id=NEW.organization_id
    AND existing_source.inbound_warehouse_package_id=NEW.inbound_warehouse_package_id
    AND existing_source.id!=OLD.id
    AND existing_source.packing_batch_id!=NEW.packing_batch_id
    AND existing_batch.status!='cancelled'
)
BEGIN
  SELECT RAISE(ABORT,'packing_source_scope_invalid');
END;

-- 已关联为包装批次来源的入仓唛头，不能再改到其他订单、组织或仓库。
CREATE TRIGGER warehouse_packing_source_package_identity_guard
BEFORE UPDATE OF organization_id,shipment_id,warehouse_id,label_kind,lifecycle_status
ON warehouse_packages
WHEN EXISTS (
  SELECT 1
  FROM warehouse_packing_batch_sources source
  JOIN warehouse_packing_batches batch
    ON batch.id=source.packing_batch_id
   AND batch.organization_id=source.organization_id
  JOIN shipments shipment
    ON shipment.id=NEW.shipment_id
   AND shipment.organization_id=NEW.organization_id
  WHERE source.inbound_warehouse_package_id=OLD.id
    AND (
      source.organization_id!=NEW.organization_id OR
      batch.warehouse_id!=NEW.warehouse_id OR
      batch.order_id!=shipment.order_id OR
      NEW.label_kind!='inbound_mark' OR
      NEW.lifecycle_status='voided'
    )
)
BEGIN
  SELECT RAISE(ABORT,'packing_source_identity_locked');
END;

CREATE TRIGGER warehouse_package_packing_batch_insert_guard
BEFORE INSERT ON warehouse_packages
WHEN NEW.packing_batch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_batches batch
  JOIN shipments shipment
    ON shipment.id=NEW.shipment_id
   AND shipment.organization_id=NEW.organization_id
  WHERE batch.id=NEW.packing_batch_id
    AND batch.organization_id=NEW.organization_id
    AND batch.warehouse_id=NEW.warehouse_id
    AND batch.order_id=shipment.order_id
    AND batch.status!='cancelled'
    AND NEW.label_kind='oul'
    AND NEW.lifecycle_status!='voided'
)
BEGIN
  SELECT RAISE(ABORT,'packing_oul_scope_invalid');
END;

CREATE TRIGGER warehouse_package_packing_batch_update_guard
BEFORE UPDATE OF packing_batch_id,organization_id,shipment_id,warehouse_id,label_kind,lifecycle_status
ON warehouse_packages
WHEN NEW.packing_batch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM warehouse_packing_batches batch
  JOIN shipments shipment
    ON shipment.id=NEW.shipment_id
   AND shipment.organization_id=NEW.organization_id
  WHERE batch.id=NEW.packing_batch_id
    AND batch.organization_id=NEW.organization_id
    AND batch.warehouse_id=NEW.warehouse_id
    AND batch.order_id=shipment.order_id
    AND (
      batch.status!='cancelled' OR
      NEW.packing_batch_id=OLD.packing_batch_id
    )
    AND NEW.label_kind='oul'
)
BEGIN
  SELECT RAISE(ABORT,'packing_oul_scope_invalid');
END;

CREATE TRIGGER warehouse_package_packing_batch_reassignment_guard
BEFORE UPDATE OF packing_batch_id ON warehouse_packages
WHEN OLD.packing_batch_id IS NOT NULL
  AND NEW.packing_batch_id IS NOT OLD.packing_batch_id
BEGIN
  SELECT RAISE(ABORT,'packing_oul_identity_locked');
END;

CREATE TRIGGER warehouse_packing_batch_status_transition_guard
BEFORE UPDATE OF status ON warehouse_packing_batches
WHEN NEW.status!=OLD.status AND NOT (
  (OLD.status='generated' AND NEW.status IN ('printed','cancelled')) OR
  (OLD.status='printed' AND NEW.status IN ('labelled','cancelled')) OR
  (OLD.status='labelled' AND NEW.status IN ('loading','cancelled')) OR
  (OLD.status='loading' AND NEW.status='dispatched')
)
BEGIN
  SELECT RAISE(ABORT,'packing_batch_status_transition_invalid');
END;

CREATE TRIGGER warehouse_packing_batch_ready_integrity_guard
BEFORE UPDATE OF status ON warehouse_packing_batches
WHEN NEW.status IN ('printed','labelled','loading','dispatched') AND (
  NEW.source_package_count != (
    SELECT COUNT(*)
    FROM warehouse_packing_batch_sources source
    WHERE source.organization_id=NEW.organization_id
      AND source.packing_batch_id=NEW.id
  )
  OR NEW.outbound_package_count != (
    SELECT COUNT(*)
    FROM warehouse_packages package_row
    WHERE package_row.organization_id=NEW.organization_id
      AND package_row.packing_batch_id=NEW.id
      AND package_row.label_kind='oul'
      AND package_row.lifecycle_status!='voided'
  )
  OR EXISTS (
    SELECT 1
    FROM warehouse_packages package_row
    WHERE package_row.organization_id=NEW.organization_id
      AND package_row.packing_batch_id=NEW.id
      AND package_row.label_kind='oul'
      AND package_row.lifecycle_status!='voided'
      AND NOT EXISTS (
        SELECT 1
        FROM warehouse_dispatch_items item
        WHERE item.organization_id=NEW.organization_id
          AND item.dispatch_id=NEW.dispatch_id
          AND item.package_id=package_row.id
      )
  )
)
BEGIN
  SELECT RAISE(ABORT,'packing_batch_counts_incomplete');
END;
