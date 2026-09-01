PRAGMA foreign_keys = ON;

CREATE TABLE portal_registration_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  customer_identity_code TEXT,
  contact_name TEXT NOT NULL,
  contact_phone TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  review_notes TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id,user_id)
);

CREATE INDEX idx_portal_registration_review
  ON portal_registration_requests(organization_id,status,created_at DESC);

CREATE INDEX idx_portal_registration_customer
  ON portal_registration_requests(organization_id,customer_id,status);
