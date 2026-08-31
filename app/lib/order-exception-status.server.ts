import { env } from "cloudflare:workers";

const CHUNK_SIZE=700;

export async function synchronizeOrderExceptionStatuses(
  organizationId:string,
  orderIds:string[],
  now=new Date().toISOString(),
) {
  const unique=[...new Set(orderIds.filter(Boolean))];
  let changed=0;
  for(let index=0;index<unique.length;index+=CHUNK_SIZE){
    const chunk=unique.slice(index,index+CHUNK_SIZE);
    const placeholders=chunk.map(()=>"?").join(",");
    const result=await env.DB.prepare(
      `UPDATE transport_orders AS target
       SET exception_status=CASE
         WHEN EXISTS(
           SELECT 1 FROM transport_batch_exceptions e
           WHERE e.organization_id=target.organization_id
             AND e.status IN ('open','processing')
             AND (e.scope='batch' AND EXISTS(
               SELECT 1 FROM transport_batch_orders bo
               WHERE bo.batch_id=e.batch_id AND bo.order_id=target.id AND bo.status!='removed'
             ) OR e.order_id=target.id)
             AND e.severity IN ('high','critical')
         ) OR EXISTS(
           SELECT 1 FROM warehouse_exceptions e
           JOIN shipments s ON s.id=e.shipment_id
           WHERE e.organization_id=target.organization_id AND s.order_id=target.id
             AND e.status IN ('open','processing') AND e.severity IN ('high','critical')
         ) THEN 'exception'
         WHEN EXISTS(
           SELECT 1 FROM transport_batch_exceptions e
           WHERE e.organization_id=target.organization_id
             AND e.status IN ('open','processing')
             AND (e.scope='batch' AND EXISTS(
               SELECT 1 FROM transport_batch_orders bo
               WHERE bo.batch_id=e.batch_id AND bo.order_id=target.id AND bo.status!='removed'
             ) OR e.order_id=target.id)
         ) OR EXISTS(
           SELECT 1 FROM warehouse_exceptions e
           JOIN shipments s ON s.id=e.shipment_id
           WHERE e.organization_id=target.organization_id AND s.order_id=target.id
             AND e.status IN ('open','processing')
         ) THEN 'warning'
         ELSE 'normal'
       END,
       updated_at=?
       WHERE target.organization_id=? AND target.id IN (${placeholders})`,
    ).bind(now,organizationId,...chunk).run();
    changed+=Number(result.meta?.changes||0);
  }
  return changed;
}
