ALTER TABLE customers ADD COLUMN identity_code TEXT;

UPDATE customers SET identity_code =
  substr('ABCDEFGHJKMNPQRSTUVWXYZ', (rowid % 23) + 1, 1) ||
  substr('23456789', ((CAST(rowid / 23 AS INTEGER)) % 8) + 1, 1) ||
  substr('ABCDEFGHJKMNPQRSTUVWXYZ', ((CAST(rowid / 184 AS INTEGER)) % 23) + 1, 1) ||
  substr('23456789', ((CAST(rowid / 4232 AS INTEGER)) % 8) + 1, 1) ||
  substr('ABCDEFGHJKMNPQRSTUVWXYZ', ((CAST(rowid / 33856 AS INTEGER)) % 23) + 1, 1)
WHERE identity_code IS NULL;

CREATE UNIQUE INDEX idx_customers_org_identity_code ON customers(organization_id, identity_code);

CREATE TRIGGER validate_customer_identity_code_insert
BEFORE INSERT ON customers
WHEN NEW.identity_code IS NULL
  OR length(NEW.identity_code) != 5
  OR NEW.identity_code GLOB '*[^A-Z2-9]*'
  OR NEW.identity_code GLOB '*[OL01]*'
  OR NEW.identity_code NOT GLOB '*[A-Z]*'
  OR NEW.identity_code NOT GLOB '*[2-9]*'
BEGIN
  SELECT RAISE(ABORT, 'invalid customer identity code');
END;

CREATE TRIGGER validate_customer_identity_code_update
BEFORE UPDATE OF identity_code ON customers
WHEN NEW.identity_code IS NULL
  OR length(NEW.identity_code) != 5
  OR NEW.identity_code GLOB '*[^A-Z2-9]*'
  OR NEW.identity_code GLOB '*[OL01]*'
  OR NEW.identity_code NOT GLOB '*[A-Z]*'
  OR NEW.identity_code NOT GLOB '*[2-9]*'
BEGIN
  SELECT RAISE(ABORT, 'invalid customer identity code');
END;
