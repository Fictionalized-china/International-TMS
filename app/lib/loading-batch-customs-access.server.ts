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
         SELECT 1 FROM transport_batch_packages mapped
         WHERE mapped.organization_id=bo.organization_id
           AND mapped.batch_id=bo.batch_id AND mapped.order_id=bo.order_id
           AND mapped.status!='removed'
       ) AND NOT EXISTS(
         SELECT 1 FROM transport_batch_packages mapped
         WHERE mapped.organization_id=bo.organization_id
           AND mapped.batch_id=bo.batch_id AND mapped.order_id=bo.order_id
           AND mapped.status!='removed'
           AND NOT EXISTS(
             SELECT 1 FROM warehouse_dispatches dispatch
             JOIN warehouse_dispatch_items item
               ON item.dispatch_id=dispatch.id AND item.organization_id=dispatch.organization_id
             WHERE dispatch.organization_id=mapped.organization_id
               AND dispatch.transport_batch_id=mapped.batch_id
               AND item.package_id=mapped.package_id
               AND dispatch.status='dispatched'
           )
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
