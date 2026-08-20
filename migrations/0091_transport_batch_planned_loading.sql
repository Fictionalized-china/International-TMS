PRAGMA foreign_keys = ON;

ALTER TABLE transport_batches ADD COLUMN planned_loading_at TEXT;
