async function hasIndex(connection, table, index) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function replaceTrigger(connection, name, event, table, timing, body) {
  await connection.query(`DROP TRIGGER IF EXISTS \`trg_${name}\``);
  await connection.query(
    `CREATE TRIGGER \`trg_${name}\` ${timing} ${event} ON \`${table}\`
     FOR EACH ROW BEGIN ${body} END`,
  );
}

export async function applyPartialOrderTransportMigration(connection, addColumnIfMissing) {
  for (const name of [
    "batch_order_claim_insert",
    "batch_order_claim_update",
    "batch_order_claim_delete",
    "batch_claim_cancel",
    "batch_claim_restore",
    "batch_claim_delete",
    "batch_cancel_after_physical_guard",
    "batch_package_scope_insert_guard",
    "batch_package_claim_insert",
    "batch_package_claim_update",
    "batch_package_claim_delete",
    "dispatch_item_package_scope_insert_guard",
    "dispatch_package_claim_insert",
    "dispatch_package_claim_update",
    "dispatch_package_claim_delete",
    "dispatch_package_claim_cancel",
    "dispatch_package_claim_restore",
    "dispatch_package_claim_dispatch_delete",
    "dispatch_cancel_after_handover_guard",
    "warehouse_pz_order_requires_packing_job_insert",
  ]) await connection.query(`DROP TRIGGER IF EXISTS \`trg_${name}\``);

  const [primaryRows] = await connection.query(
    `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) columns_list
     FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name='transport_batch_order_claims'
       AND index_name='PRIMARY'`,
  );
  if (primaryRows[0]?.columns_list !== "organization_id,order_id,batch_id") {
    await connection.query(`ALTER TABLE transport_batch_order_claims
      DROP PRIMARY KEY,ADD PRIMARY KEY(organization_id,order_id,batch_id)`);
  }
  if (!(await hasIndex(connection, "transport_batch_order_claims", "idx_batch_order_claims_order"))) {
    await connection.query(
      "CREATE INDEX idx_batch_order_claims_order ON transport_batch_order_claims(organization_id,order_id)",
    );
  }

  await connection.query(`CREATE TABLE IF NOT EXISTS transport_batch_packages (
    id VARCHAR(160) NOT NULL PRIMARY KEY,
    organization_id VARCHAR(160) NOT NULL,
    batch_id VARCHAR(160) NOT NULL,
    order_id VARCHAR(160) NOT NULL,
    packing_job_id VARCHAR(160) NOT NULL,
    package_id VARCHAR(160) NOT NULL,
    sequence_no INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'planned',
    added_by_user_id VARCHAR(160) NULL,
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL,
    UNIQUE KEY uq_transport_batch_package(batch_id,package_id),
    KEY idx_batch_packages_batch(organization_id,batch_id,status,sequence_no),
    KEY idx_batch_packages_order(organization_id,order_id,status,batch_id),
    KEY idx_batch_packages_package(organization_id,package_id,status),
    CHECK(sequence_no>0),
    CHECK(status IN ('planned','loaded','departed','arrived','removed'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await connection.query(`CREATE TABLE IF NOT EXISTS transport_batch_package_claims (
    organization_id VARCHAR(160) NOT NULL,
    package_id VARCHAR(160) NOT NULL,
    order_id VARCHAR(160) NOT NULL,
    batch_id VARCHAR(160) NOT NULL,
    PRIMARY KEY(organization_id,package_id),
    KEY idx_batch_package_claims_batch(organization_id,batch_id),
    KEY idx_batch_package_claims_order(organization_id,order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await connection.query(`CREATE TABLE IF NOT EXISTS warehouse_dispatch_package_claims (
    organization_id VARCHAR(160) NOT NULL,
    package_id VARCHAR(160) NOT NULL,
    dispatch_id VARCHAR(160) NOT NULL,
    PRIMARY KEY(organization_id,package_id),
    KEY idx_dispatch_package_claims_dispatch(organization_id,dispatch_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await addColumnIfMissing(
    connection,
    "order_tracking_milestones",
    "transport_batch_id",
    "VARCHAR(160) NULL",
  );
  if (!(await hasIndex(connection, "order_tracking_milestones", "idx_order_tracking_batch"))) {
    await connection.query(
      "CREATE INDEX idx_order_tracking_batch ON order_tracking_milestones(organization_id,transport_batch_id,order_id,event_at)",
    );
  }
  await connection.query(`UPDATE order_tracking_milestones milestone
    JOIN (
      SELECT bo.organization_id,bo.order_id,MIN(bo.batch_id) batch_id
      FROM transport_batch_orders bo
      JOIN transport_batches batch ON batch.id=bo.batch_id
        AND batch.organization_id=bo.organization_id
      WHERE bo.status!='removed' AND batch.status!='cancelled'
      GROUP BY bo.organization_id,bo.order_id
      HAVING COUNT(DISTINCT bo.batch_id)=1
    ) unique_batch ON unique_batch.organization_id=milestone.organization_id
      AND unique_batch.order_id=milestone.order_id
    SET milestone.transport_batch_id=unique_batch.batch_id
    WHERE milestone.transport_batch_id IS NULL
      AND milestone.milestone_code IN (
        'departed','border_arrived','exported','transloaded','transit_customs',
        'foreign_entered','customs_cleared','station_arrived'
      )`);

  const [duplicateDispatches] = await connection.query(`SELECT item.organization_id,item.package_id,COUNT(*) total
    FROM warehouse_dispatch_items item
    JOIN warehouse_dispatches dispatch ON dispatch.id=item.dispatch_id
      AND dispatch.organization_id=item.organization_id AND dispatch.status!='cancelled'
    GROUP BY item.organization_id,item.package_id HAVING COUNT(*)>1 LIMIT 1`);
  if (duplicateDispatches.length) {
    throw new Error("存在同一 OUL 被多个活动装车任务占用的历史数据，请先核实；迁移未放宽该冲突");
  }
  if (await hasIndex(connection, "warehouse_dispatch_items", "idx_dispatch_items_package_single")) {
    await connection.query("DROP INDEX idx_dispatch_items_package_single ON warehouse_dispatch_items");
  }
  await connection.query(`INSERT INTO warehouse_dispatch_package_claims(
      organization_id,package_id,dispatch_id
    )
    SELECT item.organization_id,item.package_id,item.dispatch_id
    FROM warehouse_dispatch_items item
    JOIN warehouse_dispatches dispatch ON dispatch.id=item.dispatch_id
      AND dispatch.organization_id=item.organization_id
    WHERE dispatch.status!='cancelled'
    ON DUPLICATE KEY UPDATE dispatch_id=VALUES(dispatch_id)`);

  await connection.query(`INSERT IGNORE INTO transport_batch_packages(
      id,organization_id,batch_id,order_id,packing_job_id,package_id,sequence_no,
      status,added_by_user_id,created_at,updated_at
    )
    SELECT UUID(),job.organization_id,job.transport_batch_id,job.order_id,job.id,package_row.id,
      ROW_NUMBER() OVER(PARTITION BY job.transport_batch_id ORDER BY package_row.package_number,package_row.id),
      CASE
        WHEN package_row.lifecycle_status IN ('overseas_received','signed') THEN 'arrived'
        WHEN package_row.lifecycle_status='in_transit' OR package_row.status='dispatched' THEN 'departed'
        ELSE 'planned'
      END,
      job.created_by_user_id,job.created_at,job.updated_at
    FROM warehouse_packing_jobs job
    JOIN transport_batches batch ON batch.id=job.transport_batch_id
      AND batch.organization_id=job.organization_id AND batch.status!='cancelled'
    JOIN warehouse_packages package_row ON package_row.organization_id=job.organization_id
      AND package_row.packing_job_id=job.id AND package_row.label_kind='oul'
      AND package_row.lifecycle_status!='voided'
    WHERE job.transport_batch_id IS NOT NULL AND job.status!='cancelled'`);
  const [duplicatePackageClaims] = await connection.query(`SELECT batch_package.organization_id,
      batch_package.package_id,COUNT(DISTINCT batch_package.batch_id) total
    FROM transport_batch_packages batch_package
    JOIN transport_batches batch ON batch.id=batch_package.batch_id
      AND batch.organization_id=batch_package.organization_id
    WHERE batch_package.status!='removed' AND batch.status!='cancelled'
    GROUP BY batch_package.organization_id,batch_package.package_id
    HAVING COUNT(DISTINCT batch_package.batch_id)>1 LIMIT 1`);
  if (duplicatePackageClaims.length) {
    throw new Error("存在同一 OUL 被多个有效配载单占用的历史数据，请先核实；迁移未覆盖冲突归属");
  }
  await connection.query(`INSERT INTO transport_batch_package_claims(
      organization_id,package_id,order_id,batch_id
    )
    SELECT batch_package.organization_id,batch_package.package_id,
      batch_package.order_id,batch_package.batch_id
    FROM transport_batch_packages batch_package
    JOIN transport_batches batch ON batch.id=batch_package.batch_id
      AND batch.organization_id=batch_package.organization_id
    WHERE batch_package.status!='removed' AND batch.status!='cancelled'
    ON DUPLICATE KEY UPDATE
      order_id=VALUES(order_id),batch_id=VALUES(batch_id)`);

  await replaceTrigger(connection, "batch_order_claim_insert", "INSERT", "transport_batch_orders", "AFTER", `
    INSERT IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
    SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
    WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches batch
      WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id AND batch.status!='cancelled');`);
  await replaceTrigger(connection, "batch_order_claim_update", "UPDATE", "transport_batch_orders", "AFTER", `
    IF NOT(NEW.organization_id <=> OLD.organization_id) OR NOT(NEW.order_id <=> OLD.order_id)
      OR NOT(NEW.batch_id <=> OLD.batch_id) OR NOT(NEW.status <=> OLD.status) THEN
      DELETE FROM transport_batch_order_claims
      WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;
      INSERT IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
      SELECT NEW.organization_id,NEW.order_id,NEW.batch_id
      WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches batch
        WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id AND batch.status!='cancelled');
    END IF;`);
  await replaceTrigger(connection, "batch_order_claim_delete", "DELETE", "transport_batch_orders", "AFTER", `
    DELETE FROM transport_batch_order_claims
    WHERE organization_id=OLD.organization_id AND order_id=OLD.order_id AND batch_id=OLD.batch_id;`);

  await replaceTrigger(connection, "batch_package_scope_insert_guard", "INSERT", "transport_batch_packages", "BEFORE", `
    IF NOT EXISTS(
      SELECT 1 FROM warehouse_packages package_row
      JOIN shipments shipment ON shipment.id=package_row.shipment_id
        AND shipment.organization_id=package_row.organization_id
      JOIN warehouse_packing_jobs job ON job.id=package_row.packing_job_id
        AND job.organization_id=package_row.organization_id
      JOIN transport_batches batch ON batch.id=NEW.batch_id
        AND batch.organization_id=NEW.organization_id
      WHERE package_row.id=NEW.package_id AND package_row.organization_id=NEW.organization_id
        AND shipment.order_id=NEW.order_id AND job.id=NEW.packing_job_id
        AND job.order_id=NEW.order_id AND job.warehouse_id=batch.warehouse_id
        AND package_row.label_kind='oul' AND package_row.lifecycle_status='active'
        AND package_row.status='in_stock' AND batch.status!='cancelled'
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='transport_batch_package_scope_invalid'; END IF;`);
  await replaceTrigger(connection, "batch_package_claim_insert", "INSERT", "transport_batch_packages", "AFTER", `
    INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
    SELECT NEW.organization_id,NEW.package_id,NEW.order_id,NEW.batch_id
    WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches batch
      WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id AND batch.status!='cancelled');`);
  await replaceTrigger(connection, "batch_package_claim_update", "UPDATE", "transport_batch_packages", "AFTER", `
    IF NOT(NEW.organization_id <=> OLD.organization_id) OR NOT(NEW.package_id <=> OLD.package_id)
      OR NOT(NEW.order_id <=> OLD.order_id) OR NOT(NEW.batch_id <=> OLD.batch_id)
      OR NOT(NEW.status <=> OLD.status) THEN
      DELETE FROM transport_batch_package_claims
      WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id AND batch_id=OLD.batch_id;
      INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
      SELECT NEW.organization_id,NEW.package_id,NEW.order_id,NEW.batch_id
      WHERE NEW.status!='removed' AND EXISTS(SELECT 1 FROM transport_batches batch
        WHERE batch.id=NEW.batch_id AND batch.organization_id=NEW.organization_id AND batch.status!='cancelled');
    END IF;`);
  await replaceTrigger(connection, "batch_package_claim_delete", "DELETE", "transport_batch_packages", "AFTER", `
    DELETE FROM transport_batch_package_claims
    WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id AND batch_id=OLD.batch_id;`);

  await replaceTrigger(connection, "batch_cancel_after_physical_guard", "UPDATE", "transport_batches", "BEFORE", `
    IF NEW.status='cancelled' AND OLD.status!='cancelled' AND (
      EXISTS(SELECT 1 FROM transport_batch_packages batch_package
        WHERE batch_package.organization_id=OLD.organization_id
          AND batch_package.batch_id=OLD.id
          AND batch_package.status IN ('departed','arrived'))
      OR EXISTS(SELECT 1 FROM warehouse_dispatches dispatch
        WHERE dispatch.organization_id=OLD.organization_id
          AND dispatch.transport_batch_id=OLD.id AND dispatch.status='dispatched')
    ) THEN SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT='transport_batch_with_physical_handover_cannot_be_cancelled'; END IF;`);

  await replaceTrigger(connection, "batch_claim_cancel", "UPDATE", "transport_batches", "AFTER", `
    IF NEW.status='cancelled' AND OLD.status!='cancelled' THEN
      DELETE FROM transport_batch_order_claims WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
      DELETE FROM transport_batch_package_claims WHERE organization_id=NEW.organization_id AND batch_id=NEW.id;
    END IF;`);
  await replaceTrigger(connection, "batch_claim_restore", "UPDATE", "transport_batches", "AFTER", `
    IF OLD.status='cancelled' AND NEW.status!='cancelled' THEN
      INSERT IGNORE INTO transport_batch_order_claims(organization_id,order_id,batch_id)
      SELECT organization_id,order_id,batch_id FROM transport_batch_orders
      WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
      INSERT INTO transport_batch_package_claims(organization_id,package_id,order_id,batch_id)
      SELECT organization_id,package_id,order_id,batch_id FROM transport_batch_packages
      WHERE organization_id=NEW.organization_id AND batch_id=NEW.id AND status!='removed';
    END IF;`);
  await replaceTrigger(connection, "batch_claim_delete", "DELETE", "transport_batches", "AFTER", `
    DELETE FROM transport_batch_order_claims WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;
    DELETE FROM transport_batch_package_claims WHERE organization_id=OLD.organization_id AND batch_id=OLD.id;`);

  await replaceTrigger(connection, "dispatch_item_package_scope_insert_guard", "INSERT", "warehouse_dispatch_items", "BEFORE", `
    IF NOT EXISTS(
      SELECT 1 FROM warehouse_dispatches dispatch
      JOIN warehouse_packages package_row ON package_row.id=NEW.package_id
        AND package_row.organization_id=NEW.organization_id
      WHERE dispatch.id=NEW.dispatch_id AND dispatch.organization_id=NEW.organization_id
        AND dispatch.status='loading' AND package_row.label_kind='oul'
        AND package_row.lifecycle_status='active'
        AND package_row.status IN ('in_stock','allocated')
    ) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='dispatch_item_package_scope_invalid'; END IF;`);
  await replaceTrigger(connection, "dispatch_package_claim_insert", "INSERT", "warehouse_dispatch_items", "AFTER", `
    INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
    SELECT NEW.organization_id,NEW.package_id,NEW.dispatch_id
    WHERE EXISTS(SELECT 1 FROM warehouse_dispatches dispatch
      WHERE dispatch.id=NEW.dispatch_id AND dispatch.organization_id=NEW.organization_id
        AND dispatch.status!='cancelled');`);
  await replaceTrigger(connection, "dispatch_package_claim_update", "UPDATE", "warehouse_dispatch_items", "AFTER", `
    IF NOT(NEW.organization_id <=> OLD.organization_id) OR NOT(NEW.package_id <=> OLD.package_id)
      OR NOT(NEW.dispatch_id <=> OLD.dispatch_id) THEN
      DELETE FROM warehouse_dispatch_package_claims
      WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id
        AND dispatch_id=OLD.dispatch_id;
      INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
      SELECT NEW.organization_id,NEW.package_id,NEW.dispatch_id
      WHERE EXISTS(SELECT 1 FROM warehouse_dispatches dispatch
        WHERE dispatch.id=NEW.dispatch_id AND dispatch.organization_id=NEW.organization_id
          AND dispatch.status!='cancelled');
    END IF;`);
  await replaceTrigger(connection, "dispatch_package_claim_delete", "DELETE", "warehouse_dispatch_items", "AFTER", `
    DELETE FROM warehouse_dispatch_package_claims
    WHERE organization_id=OLD.organization_id AND package_id=OLD.package_id
      AND dispatch_id=OLD.dispatch_id;`);
  await replaceTrigger(connection, "dispatch_package_claim_cancel", "UPDATE", "warehouse_dispatches", "AFTER", `
    IF NEW.status='cancelled' AND OLD.status!='cancelled' THEN
      DELETE FROM warehouse_dispatch_package_claims
      WHERE organization_id=NEW.organization_id AND dispatch_id=NEW.id;
    END IF;`);
  await replaceTrigger(connection, "dispatch_package_claim_restore", "UPDATE", "warehouse_dispatches", "AFTER", `
    IF OLD.status='cancelled' AND NEW.status!='cancelled' THEN
      INSERT INTO warehouse_dispatch_package_claims(organization_id,package_id,dispatch_id)
      SELECT organization_id,package_id,dispatch_id FROM warehouse_dispatch_items
      WHERE organization_id=NEW.organization_id AND dispatch_id=NEW.id;
    END IF;`);
  await replaceTrigger(connection, "dispatch_package_claim_dispatch_delete", "DELETE", "warehouse_dispatches", "AFTER", `
    DELETE FROM warehouse_dispatch_package_claims
    WHERE organization_id=OLD.organization_id AND dispatch_id=OLD.id;`);
  await replaceTrigger(connection, "dispatch_cancel_after_handover_guard", "UPDATE", "warehouse_dispatches", "BEFORE", `
    IF NEW.status='cancelled' AND OLD.status='dispatched' THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT='dispatched_warehouse_handover_cannot_be_cancelled'; END IF;`);
}
