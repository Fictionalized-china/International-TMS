export async function applyCloudMutationIntegrityMigration(connection, addColumnIfMissing) {
  await connection.query(`CREATE TABLE IF NOT EXISTS mutation_commit_guards (
    id VARCHAR(128) PRIMARY KEY, valid TINYINT NOT NULL, created_at VARCHAR(40) NOT NULL,
    CONSTRAINT mutation_guard_valid CHECK(valid=1)
  ) ENGINE=InnoDB`);
  await addColumnIfMissing(connection, "warehouse_stocktakes", "mutation_version", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(connection, "settlement_invoice_records", "request_id", "VARCHAR(64) NULL");
  await addColumnIfMissing(connection, "settlement_invoice_records", "request_payload_hash", "VARCHAR(64) NULL");
  const [indexes] = await connection.query("SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='settlement_invoice_records' AND index_name='invoice_submission_once'");
  if (!indexes.length) await connection.query("CREATE UNIQUE INDEX invoice_submission_once ON settlement_invoice_records(organization_id,created_by_user_id,request_id)");
}
