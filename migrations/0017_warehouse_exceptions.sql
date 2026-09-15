PRAGMA foreign_keys = ON;

CREATE TABLE warehouse_exceptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  exception_number TEXT NOT NULL,
  package_id TEXT NOT NULL REFERENCES warehouse_packages(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  exception_type TEXT NOT NULL CHECK (exception_type IN ('damage','shortage','overage','wrong_label','wrong_location','other')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','resolved','cancelled')),
  previous_package_status TEXT NOT NULL,
  description TEXT NOT NULL,
  resolution TEXT,
  reported_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, exception_number)
);

CREATE TABLE warehouse_exception_attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  exception_id TEXT NOT NULL REFERENCES warehouse_exceptions(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  data_url TEXT NOT NULL,
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_warehouse_exceptions_org_status ON warehouse_exceptions(organization_id,status,updated_at DESC);
CREATE INDEX idx_exception_attachments_parent ON warehouse_exception_attachments(exception_id);
