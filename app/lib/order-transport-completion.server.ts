export type OrderTransportCompletionState = {
  complete: boolean;
  totalPackageCount: number;
  waitingDispatchCount: number;
  waitingArrivalCount: number;
  untrackedDepartedCount: number;
  reason: string | null;
};

/**
 * Domestic warehouse handover has different immutable ownership facts:
 * LTL OULs must belong to an active PZ batch, while an FTL OUL is carried by
 * the order's own main assignment and therefore has no transport_batch_package
 * row. Both paths still require a real warehouse dispatch and every final OUL
 * to have left the domestic warehouse.
 */
export function hasCompletedDomesticWarehouseDispatch(input: {
  businessType: string | null;
  batchPackageCount: number;
  warehouseDispatched: boolean | number;
  transportState: Pick<OrderTransportCompletionState,
    "totalPackageCount"|"waitingDispatchCount"|"untrackedDepartedCount">;
}) {
  const {transportState}=input;
  if(!input.warehouseDispatched||transportState.totalPackageCount<1||transportState.waitingDispatchCount>0)return false;
  return input.businessType==="ftl"
    ? true
    : input.batchPackageCount>0&&transportState.untrackedDepartedCount===0;
}

/**
 * Physical transport is complete only after every non-void OUL has left the
 * domestic warehouse through a batch and every active batch package has
 * reached the overseas warehouse. Commercial settlement remains order-level.
 */
export async function loadOrderTransportCompletionState(
  db: D1Database,
  organizationId: string,
  orderId: string,
): Promise<OrderTransportCompletionState> {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*)
       FROM warehouse_packing_jobs job
       JOIN warehouse_packages package_row
         ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id
        AND package_row.label_kind='oul'
        AND package_row.lifecycle_status!='voided'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled') total_package_count,
    (SELECT COUNT(*)
       FROM warehouse_packing_jobs job
       JOIN warehouse_packages package_row
         ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id
        AND package_row.label_kind='oul'
        AND package_row.lifecycle_status='active'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled'
        AND package_row.status!='dispatched') waiting_dispatch_count,
    (SELECT COUNT(*)
       FROM transport_batch_packages batch_package
       JOIN transport_batches batch
         ON batch.id=batch_package.batch_id
        AND batch.organization_id=batch_package.organization_id
        AND batch.status!='cancelled'
      WHERE batch_package.organization_id=? AND batch_package.order_id=?
        AND batch_package.status NOT IN ('arrived','removed')) waiting_arrival_count,
    (SELECT COUNT(*)
       FROM warehouse_packing_jobs job
       JOIN warehouse_packages package_row
         ON package_row.packing_job_id=job.id
        AND package_row.organization_id=job.organization_id
        AND package_row.label_kind='oul'
        AND package_row.lifecycle_status IN ('loaded','in_transit')
        AND package_row.status='dispatched'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled'
        AND NOT EXISTS(
          SELECT 1
          FROM transport_batch_packages batch_package
          JOIN transport_batches batch
            ON batch.id=batch_package.batch_id
           AND batch.organization_id=batch_package.organization_id
           AND batch.status!='cancelled'
          WHERE batch_package.organization_id=package_row.organization_id
            AND batch_package.package_id=package_row.id
            AND batch_package.status!='removed'
        )) untracked_departed_count`)
    .bind(
      organizationId,
      orderId,
      organizationId,
      orderId,
      organizationId,
      orderId,
      organizationId,
      orderId,
    )
    .first<{
      total_package_count: number;
      waiting_dispatch_count: number;
      waiting_arrival_count: number;
      untracked_departed_count: number;
    }>();
  const totalPackageCount = Number(row?.total_package_count ?? 0);
  const waitingDispatchCount = Number(row?.waiting_dispatch_count ?? 0);
  const waitingArrivalCount = Number(row?.waiting_arrival_count ?? 0);
  const untrackedDepartedCount = Number(row?.untracked_departed_count ?? 0);
  const details = [
    !totalPackageCount ? "没有有效最终出仓包裹" : null,
    waitingDispatchCount ? `${waitingDispatchCount} 包待配载/装车` : null,
    waitingArrivalCount ? `${waitingArrivalCount} 包在途或待到仓` : null,
    untrackedDepartedCount ? `${untrackedDepartedCount} 包缺少有效运输批次` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    complete: details.length === 0,
    totalPackageCount,
    waitingDispatchCount,
    waitingArrivalCount,
    untrackedDepartedCount,
    reason: details.length ? `同一订单的运输尚未完成：${details.join("、")}。全部批次到仓后才能整票签收和归档` : null,
  };
}

/** Keep this predicate and bindings inside the final archive transaction. */
export function orderTransportCompletionPredicate() {
  return `
    EXISTS(
      SELECT 1
      FROM warehouse_packing_jobs job
      JOIN warehouse_packages package_row
        ON package_row.packing_job_id=job.id
       AND package_row.organization_id=job.organization_id
       AND package_row.label_kind='oul'
       AND package_row.lifecycle_status!='voided'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled'
    )
    AND NOT EXISTS(
      SELECT 1
      FROM warehouse_packing_jobs job
      JOIN warehouse_packages package_row
        ON package_row.packing_job_id=job.id
       AND package_row.organization_id=job.organization_id
       AND package_row.label_kind='oul'
       AND package_row.lifecycle_status='active'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled'
        AND package_row.status!='dispatched'
    )
    AND NOT EXISTS(
      SELECT 1
      FROM transport_batch_packages batch_package
      JOIN transport_batches batch
        ON batch.id=batch_package.batch_id
       AND batch.organization_id=batch_package.organization_id
       AND batch.status!='cancelled'
      WHERE batch_package.organization_id=? AND batch_package.order_id=?
        AND batch_package.status NOT IN ('arrived','removed')
    )
    AND NOT EXISTS(
      SELECT 1
      FROM warehouse_packing_jobs job
      JOIN warehouse_packages package_row
        ON package_row.packing_job_id=job.id
       AND package_row.organization_id=job.organization_id
       AND package_row.label_kind='oul'
       AND package_row.lifecycle_status IN ('loaded','in_transit')
       AND package_row.status='dispatched'
      WHERE job.organization_id=? AND job.order_id=? AND job.status!='cancelled'
        AND NOT EXISTS(
          SELECT 1
          FROM transport_batch_packages batch_package
          JOIN transport_batches batch
            ON batch.id=batch_package.batch_id
           AND batch.organization_id=batch_package.organization_id
           AND batch.status!='cancelled'
          WHERE batch_package.organization_id=package_row.organization_id
            AND batch_package.package_id=package_row.id
            AND batch_package.status!='removed'
        )
    )`;
}

export function orderTransportCompletionPredicateValues(
  organizationId: string,
  orderId: string,
) {
  return [
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
    organizationId,
    orderId,
  ];
}
