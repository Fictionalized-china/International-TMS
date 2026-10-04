CREATE TABLE settlement_cash_allocation_requests (
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  cash_transaction_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id,actor_user_id,request_id)
);
