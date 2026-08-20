ALTER TABLE quotations ADD COLUMN salesperson_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_quotations_salesperson
  ON quotations(organization_id, salesperson_user_id, status);

UPDATE quotations
SET salesperson_user_id = created_by_user_id
WHERE salesperson_user_id IS NULL
  AND created_by_user_id IS NOT NULL;

ALTER TABLE transport_orders ADD COLUMN salesperson_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_transport_orders_salesperson
  ON transport_orders(organization_id, salesperson_user_id, status);

UPDATE transport_orders
SET salesperson_user_id = (
  SELECT q.salesperson_user_id
  FROM quotations q
  WHERE q.id = transport_orders.quotation_id
)
WHERE quotation_id IS NOT NULL
  AND salesperson_user_id IS NULL;
