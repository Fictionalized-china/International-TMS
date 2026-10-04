-- A single active batch owns an order, regardless of which entry point creates it.
-- Existing duplicates deliberately fail migration; never choose a winner silently.
CREATE TABLE transport_batch_order_claims (
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  PRIMARY KEY (organization_id,order_id)
);
CREATE INDEX idx_batch_order_claims_batch ON transport_batch_order_claims(organization_id,batch_id);
INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
SELECT bo.organization_id,bo.order_id,bo.batch_id
FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
WHERE bo.status!='removed' AND b.status!='cancelled';

CREATE TRIGGER batch_order_claim_insert AFTER INSERT ON transport_batch_orders
BEGIN
  INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled');
END;
CREATE TRIGGER batch_order_claim_update AFTER UPDATE OF organization_id,order_id,batch_id,status ON transport_batch_orders
BEGIN
  DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
  INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
  WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches b
    WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled');
END;
CREATE TRIGGER batch_order_claim_delete AFTER DELETE ON transport_batch_orders
BEGIN
  DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
END;
CREATE TRIGGER batch_claim_cancel AFTER UPDATE OF status ON transport_batches
WHEN NEW.status='cancelled' AND OLD.status!='cancelled'
BEGIN
  DELETE FROM transport_batch_order_claims WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
END;
CREATE TRIGGER batch_claim_restore AFTER UPDATE OF status ON transport_batches
WHEN OLD.status='cancelled' AND NEW.status!='cancelled'
BEGIN
  INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
  SELECT organization_id,order_id,batch_id FROM transport_batch_orders
  WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
END;
CREATE TRIGGER batch_claim_delete AFTER DELETE ON transport_batches
BEGIN
  DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;
END;

CREATE TABLE loading_planning_submissions (
  organization_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','complete')),
  sync_token TEXT,
  sync_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,actor_user_id,request_id),
  UNIQUE(batch_id)
);
CREATE TABLE order_settlement_sync_requests (
  organization_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,order_id)
);
