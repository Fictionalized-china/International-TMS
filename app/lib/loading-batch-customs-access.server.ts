import {
  resolveBatchOrderCustomsAccess,
  type BatchCustomsAccess,
  type BatchOrderCustomsAccess,
} from "./loading-batch-customs-access";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

type BatchOrderDispatchRow = {
  order_id: string;
  business_type: string | null;
  dispatched: number;
};

export async function loadBatchCustomsAccess(
  db: D1Database,
  organizationId: string,
  batchId: string,
): Promise<BatchCustomsAccess> {
  const rows = await db.prepare(
    `SELECT bo.order_id,o.business_type,
       CASE WHEN EXISTS(
         SELECT 1 FROM warehouse_dispatches d
         JOIN warehouse_dispatch_items di
           ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
         JOIN warehouse_packages p
           ON p.id=di.package_id AND p.organization_id=di.organization_id
         JOIN shipments s
           ON s.id=p.shipment_id AND s.organization_id=p.organization_id
         WHERE d.organization_id=bo.organization_id
           AND d.transport_batch_id=bo.batch_id
           AND s.order_id=bo.order_id
           AND d.status='dispatched'
       ) THEN 1 ELSE 0 END dispatched
     FROM transport_batch_orders bo
     JOIN transport_orders o
       ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
     ORDER BY bo.sequence_no,bo.order_id`,
  ).bind(batchId, organizationId).all<BatchOrderDispatchRow>();

  const dispatched = rows.results.filter((row) => row.dispatched === 1).length;
  const allDispatched = rows.results.length > 0 && dispatched === rows.results.length;
  const orders: BatchOrderCustomsAccess[] = [];
  for (const row of rows.results) {
    const workflow = await loadLockedWorkflowStageContext(
      db,
      organizationId,
      row.order_id,
      "customs",
    );
    orders.push(resolveBatchOrderCustomsAccess({
      orderId: row.order_id,
      businessType: row.business_type,
      dispatched: row.dispatched === 1,
      allDispatched,
      workflow,
    }));
  }
  return {
    total: rows.results.length,
    dispatched,
    allDispatched,
    orders,
  };
}
