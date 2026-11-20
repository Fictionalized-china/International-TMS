PRAGMA foreign_keys = ON;

-- A project order may travel in several PZ batches.  The physical OUL is the
-- exclusive unit; an order row is only the commercial/workflow aggregate.
DROP TRIGGER IF EXISTS batch_order_claim_insert;
DROP TRIGGER IF EXISTS batch_order_claim_update;
DROP TRIGGER IF EXISTS batch_order_claim_delete;
DROP TRIGGER IF EXISTS batch_claim_cancel;
DROP TRIGGER IF EXISTS batch_claim_restore;
DROP TRIGGER IF EXISTS batch_claim_delete;
DROP TRIGGER IF EXISTS batch_cancel_after_physical_guard;
DROP TRIGGER IF EXISTS dispatch_cancel_after_handover_guard;
-- 0149 guarded a whole packing job with one legacy transport_batch_id.
-- Exact OUL ownership below replaces that aggregate pointer and is required
-- for one order / packing job to travel in several physical batches.
DROP TRIGGER IF EXISTS warehouse_pz_order_requires_packing_job_insert;

DROP TABLE transport_batch_order_claims;
CREATE TABLE transport_batch_order_claims (
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  PRIMARY KEY (organization_id,order_id,batch_id)
);
CREATE INDEX idx_batch_order_claims_batch
  ON transport_batch_order_claims(organization_id,batch_id);
CREATE INDEX idx_batch_order_claims_order
  ON transport_batch_order_claims(organization_id,order_id);

INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
SELECT bo.organization_id,bo.order_id,bo.batch_id
FROM transport_batch_orders bo
JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
WHERE bo.status!='removed' AND b.status!='cancelled';

CREATE TABLE transport_batch_packages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES transport_batches(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE RESTRICT,
  packing_job_id TEXT NOT NULL REFERENCES warehouse_packing_jobs(id) ON DELETE RESTRICT,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','loaded','departed','arrived','removed')),
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(batch_id,package_id)
);
CREATE INDEX idx_batch_packages_batch
  ON transport_batch_packages(organization_id,batch_id,status,sequence_no);
CREATE INDEX idx_batch_packages_order
  ON transport_batch_packages(organization_id,order_id,status,batch_id);
CREATE INDEX idx_batch_packages_package
  ON transport_batch_packages(organization_id,package_id,status);

CREATE TABLE transport_batch_package_claims (
  organization_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  PRIMARY KEY (organization_id,package_id)
);
CREATE INDEX idx_batch_package_claims_batch
  ON transport_batch_package_claims(organization_id,batch_id);
CREATE INDEX idx_batch_package_claims_order
  ON transport_batch_package_claims(organization_id,order_id);

-- A physical OUL can be held by one active dispatch only.  A separate claim
-- table preserves history while allowing cancelled work to release the OUL.
CREATE TABLE warehouse_dispatch_package_claims (
  organization_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  PRIMARY KEY (organization_id,package_id)
);
CREATE INDEX idx_dispatch_package_claims_dispatch
  ON warehouse_dispatch_package_claims(organization_id,dispatch_id);

INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
SELECT item.organization_id,item.package_id,item.dispatch_id
FROM warehouse_dispatch_items item
JOIN warehouse_dispatches dispatch
  ON dispatch.id=item.dispatch_id AND dispatch.organization_id=item.organization_id
WHERE dispatch.status!='cancelled';

CREATE TRIGGER dispatch_item_package_scope_insert_guard
BEFORE INSERT ON warehouse_dispatch_items
WHEN NOT EXISTS (
  SELECT 1
  FROM warehouse_dispatches dispatch
  JOIN warehouse_packages package_row
    ON package_row.id=NEW.package_id
   AND package_row.organization_id=NEW.organization_id
  WHERE dispatch.id=NEW.dispatch_id
    AND dispatch.organization_id=NEW.organization_id
    AND dispatch.status='loading'
    AND package_row.label_kind='oul'
    AND package_row.lifecycle_status='active'
    AND package_row.status IN ('in_stock','allocated')
)
BEGIN
  SELECT RAISE(ABORT,'dispatch_item_package_scope_invalid');
END;

CREATE TRIGGER dispatch_package_claim_insert
AFTER INSERT ON warehouse_dispatch_items
BEGIN
  INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
  SELECT NEW.organization_id,NEW.package_id,NEW.dispatch_id
  WHERE EXISTS(
    SELECT 1 FROM warehouse_dispatches dispatch
    WHERE dispatch.id=NEW.dispatch_id AND dispatch.organization_id=NEW.organization_id
      AND dispatch.status!='cancelled'
  );
END;

CREATE TRIGGER dispatch_package_claim_update
AFTER UPDATE OF organization_id,package_id,dispatch_id ON warehouse_dispatch_items
BEGIN
  DELETE FROM warehouse_dispatch_package_claims
  WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id
    AND dispatch_id=OLD.dispatch_id;
  INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
  SELECT NEW.organization_id,NEW.package_id,NEW.dispatch_id
  WHERE EXISTS(
    SELECT 1 FROM warehouse_dispatches dispatch
    WHERE dispatch.id=NEW.dispatch_id AND dispatch.organization_id=NEW.organization_id
      AND dispatch.status!='cancelled'
  );
END;

CREATE TRIGGER dispatch_package_claim_delete
AFTER DELETE ON warehouse_dispatch_items
BEGIN
  DELETE FROM warehouse_dispatch_package_claims
  WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id
    AND dispatch_id=OLD.dispatch_id;
END;

CREATE TRIGGER dispatch_package_claim_cancel
AFTER UPDATE OF status ON warehouse_dispatches
WHEN NEW.status='cancelled' AND OLD.status!='cancelled'
BEGIN
  DELETE FROM warehouse_dispatch_package_claims
  WHERE organization_id=NEW.organization_id AND dispatch_id=NEW.id;
END;

CREATE TRIGGER dispatch_package_claim_restore
AFTER UPDATE OF status ON warehouse_dispatches
WHEN OLD.status='cancelled' AND NEW.status!='cancelled'
BEGIN
  INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
  SELECT organization_id,package_id,dispatch_id
  FROM warehouse_dispatch_items
  WHERE organization_id=NEW.organization_id AND dispatch_id=NEW.id;
END;

CREATE TRIGGER dispatch_package_claim_dispatch_delete
AFTER DELETE ON warehouse_dispatches
BEGIN
  DELETE FROM warehouse_dispatch_package_claims
  WHERE organization_id=OLD.organization_id AND dispatch_id=OLD.id;
END;

-- A completed physical handover is immutable.  Corrections must be recorded
-- as a new operational event instead of cancelling history and releasing the
-- same OUL to another truck.
CREATE TRIGGER dispatch_cancel_after_handover_guard
BEFORE UPDATE OF status ON warehouse_dispatches
WHEN NEW.status='cancelled' AND OLD.status='dispatched'
BEGIN
  SELECT RAISE(ABORT,'dispatched_warehouse_handover_cannot_be_cancelled');
END;

-- Preserve every existing PZ allocation by assigning all of that packing
-- job's active OULs to its existing batch before the legacy job pointer is no
-- longer treated as the source of truth.
INSERT INTO transport_batch_packages(
  id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,
  status,added_by_user_id,created_at,updated_at
)
SELECT lower(hex(randomblob(16))),job.organization_id,job.transport_batch_id,
       job.order_id,job.id,p.id,
       ROW_NUMBER() OVER(PARTITION BY job.transport_batch_id ORDER BY p.package_number,p.id),
       CASE
         WHEN p.lifecycle_status IN ('overseas_received','signed') THEN 'arrived'
         WHEN p.lifecycle_status='in_transit' OR p.status='dispatched' THEN 'departed'
         ELSE 'planned'
       END,
       job.created_by_user_id,job.created_at,job.updated_at
FROM warehouse_packing_jobs job
JOIN transport_batches b
  ON b.id=job.transport_batch_id AND b.organization_id=job.organization_id
 AND b.status!='cancelled'
JOIN warehouse_packages p
  ON p.organization_id=job.organization_id AND p.packing_job_id=job.id
 AND p.label_kind='oul' AND p.lifecycle_status!='voided'
WHERE job.transport_batch_id IS NOT NULL AND job.status!='cancelled';

INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
SELECT bp.organization_id,bp.package_id,bp.order_id,bp.batch_id
FROM transport_batch_packages bp
JOIN transport_batches b ON b.id=bp.batch_id AND b.organization_id=bp.organization_id
WHERE bp.status!='removed' AND b.status!='cancelled';

CREATE TRIGGER batch_package_scope_insert_guard
BEFORE INSERT ON transport_batch_packages
WHEN NOT EXISTS (
  SELECT 1
  FROM warehouse_packages p
  JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
  JOIN warehouse_packing_jobs job
    ON job.id=p.packing_job_id AND job.organization_id=p.organization_id
  JOIN transport_batches batch
    ON batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id
  WHERE p.id=NEW.package_id AND p.organization_id=NEW.organization_id
    AND s.order_id=NEW.order_id AND job.id=NEW.packing_job_id
    AND job.order_id=NEW.order_id AND job.warehouse_id=batch.warehouse_id
    AND p.label_kind='oul' AND p.lifecycle_status='active'
    AND p.status='in_stock' AND batch.status!='cancelled'
)
BEGIN
  SELECT RAISE(ABORT,'transport_batch_package_scope_invalid');
END;

CREATE TRIGGER batch_order_claim_insert AFTER INSERT ON transport_batch_orders
BEGIN
  INSERT OR IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(
    SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled'
  );
END;

CREATE TRIGGER batch_order_claim_update AFTER UPDATE OF organization_id,order_id,batch_id,status ON transport_batch_orders
BEGIN
  DELETE FROM transport_batch_order_claims
  WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
  INSERT OR IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(
    SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled'
  );
END;

CREATE TRIGGER batch_order_claim_delete AFTER DELETE ON transport_batch_orders
BEGIN
  DELETE FROM transport_batch_order_claims
  WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
END;

CREATE TRIGGER batch_package_claim_insert AFTER INSERT ON transport_batch_packages
BEGIN
  INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.package_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(
    SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled'
  );
END;

CREATE TRIGGER batch_package_claim_update
AFTER UPDATE OF organization_id,package_id,order_id,batch_id,status ON transport_batch_packages
BEGIN
  DELETE FROM transport_batch_package_claims
  WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id AND batch_id=OLD.batch_id;
  INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.package_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(
    SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled'
  );
END;

CREATE TRIGGER batch_package_claim_delete AFTER DELETE ON transport_batch_packages
BEGIN
  DELETE FROM transport_batch_package_claims
  WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id AND batch_id=OLD.batch_id;
END;

-- Once any OUL in a PZ has physically left or arrived, cancelling the PZ
-- would release its exclusive claim and allow a second, contradictory trip.
CREATE TRIGGER batch_cancel_after_physical_guard
BEFORE UPDATE OF status ON transport_batches
WHEN NEW.status='cancelled' AND OLD.status!='cancelled' AND (
  EXISTS(
    SELECT 1 FROM transport_batch_packages batch_package
    WHERE batch_package.organization_id=OLD.organization_id
      AND batch_package.batch_id=OLD.id
      AND batch_package.status IN ('departed','arrived')
  ) OR EXISTS(
    SELECT 1 FROM warehouse_dispatches dispatch
    WHERE dispatch.organization_id=OLD.organization_id
      AND dispatch.transport_batch_id=OLD.id
      AND dispatch.status='dispatched'
  )
)
BEGIN
  SELECT RAISE(ABORT,'transport_batch_with_physical_handover_cannot_be_cancelled');
END;

CREATE TRIGGER batch_claim_cancel AFTER UPDATE OF status ON transport_batches
WHEN NEW.status='cancelled' AND OLD.status!='cancelled'
BEGIN
  DELETE FROM transport_batch_order_claims
  WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
  DELETE FROM transport_batch_package_claims
  WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
END;

CREATE TRIGGER batch_claim_restore AFTER UPDATE OF status ON transport_batches
WHEN OLD.status='cancelled' AND NEW.status!='cancelled'
BEGIN
  INSERT OR IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT organization_id,order_id,batch_id FROM transport_batch_orders
  WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
  INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
  SELECT organization_id,package_id,order_id,batch_id FROM transport_batch_packages
  WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
END;

CREATE TRIGGER batch_claim_delete AFTER DELETE ON transport_batches
BEGIN
  DELETE FROM transport_batch_order_claims
  WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;
  DELETE FROM transport_batch_package_claims
  WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;
END;

-- Batch-written milestones keep the batch identity.  Order pages still show
-- the aggregate stream, while batch workbenches can no longer mistake one
-- partial trip's event for another trip of the same order.
ALTER TABLE order_tracking_milestones ADD COLUMN transport_batch_id TEXT
  REFERENCES transport_batches(id) ON DELETE SET NULL;
CREATE INDEX idx_order_tracking_batch
  ON order_tracking_milestones(organization_id,transport_batch_id,order_id,event_at DESC);

-- Historical batch events predate the batch identity column.  Backfill only
-- when the order had exactly one effective batch, so ambiguous split-order
-- history is never guessed.
UPDATE order_tracking_milestones AS milestone
SET transport_batch_id=(
  SELECT MIN(bo.batch_id)
  FROM transport_batch_orders bo
  JOIN transport_batches batch
    ON batch.id=bo.batch_id AND batch.organization_id=bo.organization_id
  WHERE bo.organization_id=milestone.organization_id
    AND bo.order_id=milestone.order_id AND bo.status!='removed'
    AND batch.status!='cancelled'
)
WHERE milestone.transport_batch_id IS NULL
  AND milestone.milestone_code IN (
    'departed','border_arrived','exported','transloaded','transit_customs',
    'foreign_entered','customs_cleared','station_arrived'
  )
  AND 1=(
    SELECT COUNT(DISTINCT bo.batch_id)
    FROM transport_batch_orders bo
    JOIN transport_batches batch
      ON batch.id=bo.batch_id AND batch.organization_id=bo.organization_id
    WHERE bo.organization_id=milestone.organization_id
      AND bo.order_id=milestone.order_id AND bo.status!='removed'
      AND batch.status!='cancelled'
  );
