PRAGMA foreign_keys = ON;

ALTER TABLE warehouse_packages ADD COLUMN length_cm REAL NOT NULL DEFAULT 0
  CHECK(length_cm >= 0);
ALTER TABLE warehouse_packages ADD COLUMN width_cm REAL NOT NULL DEFAULT 0
  CHECK(width_cm >= 0);
ALTER TABLE warehouse_packages ADD COLUMN height_cm REAL NOT NULL DEFAULT 0
  CHECK(height_cm >= 0);
