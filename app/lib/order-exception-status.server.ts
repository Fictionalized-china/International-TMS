import { env } from "cloudflare:workers";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";

export function orderExceptionStatusStatements(
  db:D1Database,
  organizationId:string,
  orderIds:string[],
  now=new Date().toISOString(),
) {
  const unique=[...new Set(orderIds.filter(Boolean))];
  const statements:D1PreparedStatement[]=[];
  for(const chunk of chunkD1Values(unique,2)){
    const placeholders=d1Placeholders(chunk.length);
    statements.push(db.prepare(
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
    ).bind(now,organizationId,...chunk));
  }
  return statements;
}

export async function synchronizeOrderExceptionStatuses(organizationId:string,orderIds:string[],now=new Date().toISOString()){
  const statements=orderExceptionStatusStatements(env.DB,organizationId,orderIds,now);
  if(!statements.length)return 0;
  const result=await env.DB.batch(statements);
  return result.reduce((sum,row)=>sum+Number(row.meta?.changes??0),0);
}
