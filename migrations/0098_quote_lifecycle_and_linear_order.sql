PRAGMA foreign_keys = ON;

-- The legacy status column remains for compatibility with older reports. New
-- business decisions use lifecycle_status so the UI has one unambiguous state.
ALTER TABLE quotations ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'pending'
  CHECK(lifecycle_status IN ('pending','accepted','withdrawn','void'));
ALTER TABLE quotations ADD COLUMN withdrawn_at TEXT;
ALTER TABLE quotations ADD COLUMN withdrawn_by_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotations ADD COLUMN acceptance_source TEXT
  CHECK(acceptance_source IS NULL OR acceptance_source IN ('admin','portal'));

ALTER TABLE transport_orders ADD COLUMN quote_withdrawn INTEGER NOT NULL DEFAULT 0
  CHECK(quote_withdrawn IN (0,1));

UPDATE quotations
SET lifecycle_status = CASE status
  WHEN 'accepted' THEN 'accepted'
  WHEN 'expired' THEN 'withdrawn'
  WHEN 'cancelled' THEN 'void'
  ELSE 'pending'
END;

-- A retained order is proof that the source quote was accepted. This repairs
-- historical rows whose legacy status was later changed independently.
UPDATE quotations
SET lifecycle_status='accepted',
    status='accepted',
    accepted_at=COALESCE(accepted_at,updated_at),
    acceptance_source=COALESCE(acceptance_source,'admin')
WHERE EXISTS(
  SELECT 1 FROM transport_orders o WHERE o.quotation_id=quotations.id
);

CREATE INDEX idx_quotations_lifecycle
  ON quotations(organization_id,lifecycle_status,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_orders_unique_quotation
  ON transport_orders(quotation_id)
  WHERE quotation_id IS NOT NULL;
