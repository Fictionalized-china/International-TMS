CREATE TABLE mutation_commit_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1),
  created_at TEXT NOT NULL
);
ALTER TABLE warehouse_stocktakes ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_invoice_records ADD COLUMN request_id TEXT;
ALTER TABLE settlement_invoice_records ADD COLUMN request_payload_hash TEXT;
CREATE UNIQUE INDEX invoice_submission_once ON settlement_invoice_records(organization_id,created_by_user_id,request_id);
