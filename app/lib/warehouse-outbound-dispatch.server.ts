export type CompleteWarehouseDispatchTransactionInput = {
  db: D1Database;
  organizationId: string;
  warehouseId: string;
  dispatchId: string;
  actorUserId: string;
  occurredAt: string;
  description: string;
  transportBatchId?: string | null;
  /** Server-authored checks committed before any physical handover writes. */
  commitGuards?:readonly D1PreparedStatement[];
};

/**
 * Commits the physical outbound handover exactly once.
 *
 * D1 executes `batch` atomically. Every side effect reads through the same
 * organization/warehouse-scoped dispatch while it is still `loading`, and the
 * final statement is the status compare-and-swap. A concurrent retry that runs
 * after the winner therefore writes zero rows everywhere and receives
 * `transitioned: false`; post-commit workflow/audit work must only run for the
 * winning caller.
 */
export async function completeWarehouseDispatchTransaction(
  input: CompleteWarehouseDispatchTransactionInput,
) {
  const {
    db,
    organizationId,
    warehouseId,
    dispatchId,
    actorUserId,
    occurredAt,
    description,
    transportBatchId,
  } = input;
  const statements: D1PreparedStatement[] = [
    ...(input.commitGuards??[]),
    db.prepare(
      `UPDATE warehouse_packing_batches
       SET status='dispatched',updated_at=?
       WHERE organization_id=? AND warehouse_id=? AND dispatch_id=? AND status='loading'
         AND NOT EXISTS(
           SELECT 1 FROM warehouse_dispatch_items item
           WHERE item.organization_id=warehouse_packing_batches.organization_id
             AND item.dispatch_id=warehouse_packing_batches.dispatch_id
             AND item.status!='loaded'
         )`,
    ).bind(occurredAt, organizationId, warehouseId, dispatchId),
    db.prepare(
      `UPDATE warehouse_packages
       SET status='dispatched',lifecycle_status=CASE WHEN label_kind='oul' THEN 'in_transit' ELSE lifecycle_status END,updated_at=?
       WHERE organization_id=? AND warehouse_id=?
         AND label_kind='oul' AND lifecycle_status='active'
         AND id IN (
           SELECT di.package_id
           FROM warehouse_dispatch_items di
           JOIN warehouse_dispatches d
             ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
           WHERE d.id=? AND d.organization_id=? AND d.status='loading'
         )`,
    ).bind(occurredAt, organizationId, warehouseId, dispatchId, organizationId),
    db.prepare(
      `UPDATE transport_batch_packages
       SET status='departed',updated_at=?
       WHERE organization_id=? AND batch_id=? AND status IN ('planned','loaded')
         AND package_id IN (
           SELECT item.package_id FROM warehouse_dispatch_items item
           JOIN warehouse_dispatches dispatch
             ON dispatch.id=item.dispatch_id AND dispatch.organization_id=item.organization_id
           WHERE dispatch.id=? AND dispatch.organization_id=? AND dispatch.status='loading'
         )`,
    ).bind(occurredAt, organizationId, transportBatchId??"", dispatchId, organizationId),
    db.prepare(
      `UPDATE warehouse_packages
       SET status='dispatched',
           notes=TRIM(COALESCE(notes||'；','')||'关联的最终 OUL 已全部完成装车出库，入仓唛头结束流转'),
           updated_at=?
       WHERE organization_id=? AND warehouse_id=?
         AND label_kind='inbound_mark' AND lifecycle_status='active' AND status='allocated'
         AND source_order_package_id IN (
           SELECT DISTINCT relation.inbound_package_id
           FROM warehouse_package_relations relation
           JOIN warehouse_dispatch_items item
             ON item.package_id=relation.outbound_package_id
            AND item.organization_id=relation.organization_id
           JOIN warehouse_dispatches dispatch
             ON dispatch.id=item.dispatch_id AND dispatch.organization_id=item.organization_id
           WHERE relation.organization_id=? AND dispatch.id=? AND dispatch.status='loading'
             AND NOT EXISTS (
               SELECT 1
               FROM warehouse_package_relations pending_relation
               JOIN transport_batch_packages pending_batch_package
                 ON pending_batch_package.package_id=pending_relation.outbound_package_id
                AND pending_batch_package.organization_id=pending_relation.organization_id
                AND pending_batch_package.status!='removed'
               WHERE pending_relation.organization_id=relation.organization_id
                 AND pending_relation.inbound_package_id=relation.inbound_package_id
                 AND pending_batch_package.status NOT IN ('departed','arrived')
             )
         )`,
    ).bind(occurredAt, organizationId, warehouseId, organizationId, dispatchId),
    db.prepare(
      `UPDATE warehouse_packing_jobs
       SET status='loading',updated_at=?
       WHERE organization_id=? AND warehouse_id=? AND status='allocated'
         AND id IN (
           SELECT DISTINCT package_row.packing_job_id
           FROM warehouse_dispatch_items item
           JOIN warehouse_packages package_row
             ON package_row.id=item.package_id AND package_row.organization_id=item.organization_id
           WHERE item.dispatch_id=? AND item.organization_id=?
         )
         AND NOT EXISTS (
           SELECT 1 FROM warehouse_packages remaining
           WHERE remaining.organization_id=warehouse_packing_jobs.organization_id
             AND remaining.packing_job_id=warehouse_packing_jobs.id
             AND remaining.label_kind='oul' AND remaining.lifecycle_status='active'
             AND remaining.status='in_stock'
         )`,
    ).bind(occurredAt, organizationId, warehouseId, dispatchId, organizationId),
    db.prepare(
      `UPDATE warehouse_packing_jobs
       SET status='dispatched',updated_at=?
       WHERE organization_id=? AND warehouse_id=? AND status='loading'
         AND id IN (
           SELECT DISTINCT package_row.packing_job_id
           FROM warehouse_dispatch_items item
           JOIN warehouse_packages package_row
             ON package_row.id=item.package_id AND package_row.organization_id=item.organization_id
           WHERE item.dispatch_id=? AND item.organization_id=?
         )
         AND NOT EXISTS (
           SELECT 1 FROM warehouse_packages remaining
           WHERE remaining.organization_id=warehouse_packing_jobs.organization_id
             AND remaining.packing_job_id=warehouse_packing_jobs.id
             AND remaining.label_kind='oul' AND remaining.lifecycle_status='active'
             AND remaining.status!='dispatched'
         )`,
    ).bind(occurredAt, organizationId, warehouseId, dispatchId, organizationId),
    db.prepare(
      `INSERT INTO warehouse_package_movements(
         id,organization_id,package_id,operation_type,from_location_id,to_location_id,
         batch_id,operator_user_id,notes,occurred_at,created_at
       )
       SELECT lower(hex(randomblob(16))),di.organization_id,di.package_id,'dispatch',
              p.location_id,NULL,d.sorting_batch_id,?,?,?,?
       FROM warehouse_dispatch_items di
       JOIN warehouse_packages p
         ON p.id=di.package_id AND p.organization_id=di.organization_id
       JOIN warehouse_dispatches d
         ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
       WHERE d.id=? AND d.organization_id=? AND d.status='loading'
         AND p.warehouse_id=? AND p.label_kind='oul'`,
    ).bind(actorUserId, description, occurredAt, occurredAt, dispatchId, organizationId, warehouseId),
    db.prepare(
      `INSERT INTO warehouse_operations(
         id,organization_id,shipment_id,operation_type,location,notes,
         operator_user_id,occurred_at,created_at
       )
       SELECT lower(hex(randomblob(16))),scope.organization_id,scope.shipment_id,
              'dispatch',scope.current_location,?,?,?,?
       FROM (
         SELECT DISTINCT di.organization_id,s.id shipment_id,s.current_location
         FROM warehouse_dispatch_items di
         JOIN warehouse_packages p
           ON p.id=di.package_id AND p.organization_id=di.organization_id
         JOIN shipments s
           ON s.id=p.shipment_id AND s.organization_id=p.organization_id
         JOIN warehouse_dispatches d
           ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
         WHERE d.id=? AND d.organization_id=? AND d.status='loading'
           AND p.warehouse_id=? AND p.label_kind='oul'
       ) scope`,
    ).bind(description, actorUserId, occurredAt, occurredAt, dispatchId, organizationId, warehouseId),
    db.prepare(
      `INSERT INTO shipment_events(
         id,shipment_id,status,location,description,event_at,
         visible_to_customer,created_by_user_id,created_at
       )
       SELECT lower(hex(randomblob(16))),scope.shipment_id,'picked_up',
              scope.current_location,?,?,1,?,?
       FROM (
         SELECT DISTINCT s.id shipment_id,s.current_location
         FROM warehouse_dispatch_items di
         JOIN warehouse_packages p
           ON p.id=di.package_id AND p.organization_id=di.organization_id
         JOIN shipments s
           ON s.id=p.shipment_id AND s.organization_id=p.organization_id
         JOIN warehouse_dispatches d
           ON d.id=di.dispatch_id AND d.organization_id=di.organization_id
         WHERE d.id=? AND d.organization_id=? AND d.status='loading'
           AND p.warehouse_id=? AND p.label_kind='oul'
       ) scope`,
    ).bind(description, occurredAt, actorUserId, occurredAt, dispatchId, organizationId, warehouseId),
    db.prepare(
      `UPDATE order_cargo_packages
       SET status='loaded'
       WHERE organization_id=? AND status NOT IN ('cancelled','in_transit','delivered')
         AND id IN (
           SELECT DISTINCT relation.inbound_package_id
           FROM warehouse_package_relations relation
           JOIN warehouse_dispatch_items item
             ON item.package_id=relation.outbound_package_id
            AND item.organization_id=relation.organization_id
           JOIN warehouse_dispatches dispatch
             ON dispatch.id=item.dispatch_id AND dispatch.organization_id=item.organization_id
           WHERE relation.organization_id=? AND dispatch.id=? AND dispatch.status='loading'
             AND NOT EXISTS (
               SELECT 1
               FROM warehouse_package_relations pending_relation
               JOIN warehouse_packages pending_oul
                 ON pending_oul.id=pending_relation.outbound_package_id
                AND pending_oul.organization_id=pending_relation.organization_id
               WHERE pending_relation.organization_id=relation.organization_id
                 AND pending_relation.inbound_package_id=relation.inbound_package_id
                 AND pending_oul.label_kind='oul' AND pending_oul.lifecycle_status='active'
                 AND pending_oul.status!='dispatched'
             )
         )`,
    ).bind(organizationId, organizationId, dispatchId),
  ];

  if (transportBatchId) {
    statements.push(
      db.prepare(
        `UPDATE transport_vehicle_loads
         SET loaded_at=COALESCE(loaded_at,?)
         WHERE batch_id=? AND organization_id=?
           AND EXISTS(
             SELECT 1
             FROM warehouse_dispatches d
             JOIN warehouse_dispatch_items di
               ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
             JOIN warehouse_packages p
               ON p.id=di.package_id AND p.organization_id=di.organization_id
             WHERE d.id=? AND d.organization_id=? AND d.status='loading'
               AND d.transport_batch_id=? AND p.warehouse_id=? AND p.label_kind='oul'
           )`,
      ).bind(
        occurredAt,
        transportBatchId,
        organizationId,
        dispatchId,
        organizationId,
        transportBatchId,
        warehouseId,
      ),
      db.prepare(
        `UPDATE transport_batches
         SET road_status='loaded_waiting_exit',updated_at=?
         WHERE id=? AND organization_id=? AND warehouse_id=?
           AND EXISTS(
             SELECT 1
             FROM warehouse_dispatches d
             JOIN warehouse_dispatch_items di
               ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
             JOIN warehouse_packages p
               ON p.id=di.package_id AND p.organization_id=di.organization_id
             WHERE d.id=? AND d.organization_id=? AND d.status='loading'
               AND d.transport_batch_id=? AND p.warehouse_id=? AND p.label_kind='oul'
           )`,
      ).bind(
        occurredAt,
        transportBatchId,
        organizationId,
        warehouseId,
        dispatchId,
        organizationId,
        transportBatchId,
        warehouseId,
      ),
    );
  }

  // The compare-and-swap is intentionally last. D1 batches are serialized and
  // atomic, so every preceding statement observes `loading` only for the one
  // transaction that can win this status transition.
  statements.push(
    db.prepare(
      `UPDATE warehouse_dispatches
       SET status='dispatched',dispatched_by_user_id=?,dispatched_at=?,updated_at=?
       WHERE id=? AND organization_id=? AND status='loading'
         AND EXISTS(
           SELECT 1
           FROM warehouse_dispatch_items di
           JOIN warehouse_packages p
             ON p.id=di.package_id AND p.organization_id=di.organization_id
           WHERE di.dispatch_id=warehouse_dispatches.id
             AND di.organization_id=warehouse_dispatches.organization_id
             AND p.warehouse_id=? AND p.label_kind='oul'
         )`,
    ).bind(actorUserId, occurredAt, occurredAt, dispatchId, organizationId, warehouseId),
  );

  const results = await db.batch(statements);
  const compareAndSwap = results[results.length - 1];
  return { transitioned: Number(compareAndSwap?.meta.changes ?? 0) === 1 };
}
