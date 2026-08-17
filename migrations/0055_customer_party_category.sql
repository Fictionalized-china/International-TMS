ALTER TABLE customers ADD COLUMN party_category TEXT NOT NULL DEFAULT 'customer'
  CHECK (party_category IN ('customer', 'supplier', 'both'));

