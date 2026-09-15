PRAGMA foreign_keys = ON;

ALTER TABLE overseas_warehouse_operations ADD COLUMN appointment_period TEXT
  CHECK(appointment_period IS NULL OR appointment_period IN ('morning','afternoon','evening'));
