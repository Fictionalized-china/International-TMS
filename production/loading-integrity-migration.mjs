export const loadingIntegrityTriggers = [
  ["batch_order_claim_insert", "INSERT", "transport_batch_orders", `
    INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
    SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
    WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches b
      WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled');`],
  ["batch_order_claim_update", "UPDATE", "transport_batch_orders", `
    IF NOT(NEW.organization_id <=> OLD.organization_id) OR NOT(NEW.order_id <=> OLD.order_id)
      OR NOT(NEW.batch_id <=> OLD.batch_id) OR NOT(NEW.status <=> OLD.status) THEN
      DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
      INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
      SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
      WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches b
        WHERE b.id=NEW.batch_id AND b.organization_id=NEW.organization_id AND b.status!='cancelled');
    END IF;`],
  ["batch_order_claim_delete", "DELETE", "transport_batch_orders", `
    DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;`],
  ["batch_claim_cancel", "UPDATE", "transport_batches", `
    IF NEW.status='cancelled' AND OLD.status!='cancelled' THEN
      DELETE FROM transport_batch_order_claims WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
    END IF;`],
  ["batch_claim_restore", "UPDATE", "transport_batches", `
    IF OLD.status='cancelled' AND NEW.status!='cancelled' THEN
      INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
      SELECT organization_id,order_id,batch_id FROM transport_batch_orders
      WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
    END IF;`],
  ["batch_claim_delete", "DELETE", "transport_batches", `
    DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;`],
];

export async function applyLoadingIntegrityMigration(connection) {
  const [duplicates] = await connection.query(`SELECT bo.organization_id,bo.order_id,COUNT(*) total
    FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    WHERE bo.status!='removed' AND b.status!='cancelled'
    GROUP BY bo.organization_id,bo.order_id HAVING COUNT(*)>1 LIMIT 1`);
  if (duplicates.length) throw new Error("存在重复有效配载占用，请先核实历史数据；迁移未修改订单");
  await connection.query(`CREATE TABLE IF NOT EXISTS transport_batch_order_claims (
    organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,batch_id VARCHAR(128) NOT NULL,
    PRIMARY KEY(organization_id,order_id),KEY idx_batch_order_claims_batch(organization_id,batch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await connection.query(`INSERT INTO transport_batch_order_claims(organization_id,order_id,batch_id)
    SELECT bo.organization_id,bo.order_id,bo.batch_id FROM transport_batch_orders bo
    JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    WHERE bo.status!='removed' AND b.status!='cancelled'
    ON DUPLICATE KEY UPDATE batch_id=VALUES(batch_id)`);
  await connection.query(`CREATE TABLE IF NOT EXISTS loading_planning_submissions (
    organization_id VARCHAR(128) NOT NULL,actor_user_id VARCHAR(128) NOT NULL,request_id VARCHAR(128) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,batch_id VARCHAR(128) NOT NULL,result_json JSON NOT NULL,
    sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',sync_token VARCHAR(128) NULL,sync_started_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY(organization_id,actor_user_id,request_id),UNIQUE KEY uq_loading_submission_batch(batch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await connection.query(`CREATE TABLE IF NOT EXISTS order_settlement_sync_requests (
    organization_id VARCHAR(128) NOT NULL,order_id VARCHAR(128) NOT NULL,revision VARCHAR(128) NOT NULL,
    updated_at DATETIME(3) NOT NULL,PRIMARY KEY(organization_id,order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  for (const [name,event,table,body] of loadingIntegrityTriggers) {
    await connection.query(`DROP TRIGGER IF EXISTS trg_${name}`);
    await connection.query(`CREATE TRIGGER trg_${name} AFTER ${event} ON ${table} FOR EACH ROW BEGIN ${body} END`);
  }
}
