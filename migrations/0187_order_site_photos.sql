-- Originals remain in the shared attachment store; this is an association,
-- not another document, shipment, or inventory ledger.
CREATE TABLE order_site_photo_submissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,actor_user_id,request_key)
);
CREATE TABLE order_site_photos (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES transport_orders(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES order_attachments(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES order_site_photo_submissions(id),
  stage_code TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT REFERENCES shipment_events(id) ON DELETE SET NULL,
  warehouse_id TEXT REFERENCES warehouses(id) ON DELETE SET NULL,
  package_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  thumbnail_data_url TEXT NOT NULL,
  thumbnail_content_type TEXT NOT NULL,
  description TEXT,
  occurred_at TEXT NOT NULL,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,order_id,source_type,source_id,content_hash)
);
CREATE INDEX idx_order_site_photos_order ON order_site_photos(organization_id,order_id,occurred_at,id);
CREATE INDEX idx_order_site_photos_event ON order_site_photos(organization_id,event_id);
