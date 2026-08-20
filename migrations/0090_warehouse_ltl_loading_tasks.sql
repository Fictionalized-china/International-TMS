PRAGMA foreign_keys = ON;

ALTER TABLE warehouse_dispatches ADD COLUMN transport_batch_id TEXT
  REFERENCES transport_batches(id) ON DELETE SET NULL;
ALTER TABLE warehouse_dispatches ADD COLUMN planned_loading_at TEXT;

CREATE INDEX idx_warehouse_dispatches_transport_batch
  ON warehouse_dispatches(organization_id,transport_batch_id,status,updated_at DESC);
