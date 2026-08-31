import { env } from "cloudflare:workers";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";
import { synchronizeOrderExceptionStatuses } from "./order-exception-status.server";

export async function synchronizeBatchTransport(organizationId:string,batchId:string,now:string){
  const stats=await env.DB.prepare(`SELECT
      MAX(o.business_type) business_type,
      COUNT(DISTINCT v.id) vehicle_count,
      COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL AND NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) staffed_vehicle_count,
      MAX(CASE
        WHEN o.business_type='ftl'
          AND NULLIF(TRIM(b.overseas_carrier_name),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_vehicle_type),'') IS NOT NULL
          AND COALESCE(b.overseas_vehicle_count,0)>0
          AND NULLIF(TRIM(b.overseas_vehicle_plate),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_driver_name),'') IS NOT NULL
          AND NULLIF(TRIM(b.overseas_driver_phone),'') IS NOT NULL THEN 1
        WHEN COALESCE(o.business_type,'ltl')!='ftl'
          AND b.carrier_id IS NOT NULL
          AND b.warehouse_id IS NOT NULL
          AND b.border_port IS NOT NULL
          AND b.planned_departure_at IS NOT NULL THEN 1
        ELSE 0
      END) plan_complete,
      MAX(b.road_status) road_status
    FROM transport_batches b
    JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
    JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
    LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
    WHERE b.organization_id=? AND b.id=?`).bind(organizationId,batchId).first<{business_type:string|null;vehicle_count:number;staffed_vehicle_count:number;plan_complete:number;road_status:string|null}>();
  const orders=await env.DB.prepare(`SELECT bo.order_id
    FROM transport_batch_orders bo
    WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no`).bind(organizationId,batchId).all<{order_id:string}>();
  const isFtlBatch=stats?.business_type==="ftl";
  const batchBaseReady=Boolean(stats?.plan_complete&&stats.vehicle_count&&stats.staffed_vehicle_count===stats.vehicle_count);
  const batchReady=batchBaseReady&&orders.results.length>0;
  const batchOutboundCompleted=["loaded_waiting_exit","outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(stats?.road_status??"");
  const batchBlockers=[
    !stats?.plan_complete ? (isFtlBatch?"整车运输单车辆信息未完整":"配载运输单基础信息未完整") : null,
    !stats?.vehicle_count ? (isFtlBatch?"整车运输单尚未生成车辆":"配载运输单尚未添加车辆") : null,
    stats?.vehicle_count&&stats.staffed_vehicle_count!==stats.vehicle_count ? "车辆车牌/司机未完整" : null,
  ].filter(Boolean).join("；");
  const statements=[
    env.DB.prepare(`UPDATE transport_batches
      SET status=CASE
            WHEN road_status IN ('overseas_arrived','waiting_pickup','pickup_completed') THEN 'arrived'
            WHEN road_status='outbound_in_transit' THEN 'departed'
            ELSE ?
          END,
          road_status=CASE
            WHEN road_status IN ('loaded_waiting_exit','outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed') THEN road_status
            ELSE ?
          END,
          updated_at=?
      WHERE id=? AND organization_id=?`).bind(batchReady?"loading":"planning",batchReady?"preplanned":"waiting_loading",now,batchId,organizationId),
    ...orders.results.map((order)=>{
      const blockingReason=batchBlockers||null;
      const currentStepName=batchOutboundCompleted?"装车出库交接完成":batchBaseReady?(isFtlBatch?"整车运输单已安排，待装车出库":"配载运输单已安排，待仓库整批装车出库"):(isFtlBatch?"整车运输单待完善车辆信息":"配载成单，待完善整批车辆信息");
      const progress=batchOutboundCompleted?100:batchBaseReady?75:60;
      return env.DB.prepare(`UPDATE order_module_instances
         SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,
             started_at=COALESCE(started_at,?),
             completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,
             blocking_reason=?,updated_at=?
       WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id=?`).bind(
        batchOutboundCompleted?"completed":"in_progress",
        batchOutboundCompleted?"confirmed":"planned",
        currentStepName,
        progress,
        now,
        batchOutboundCompleted?"completed":"in_progress",
        now,
        batchOutboundCompleted?null:blockingReason,
        now,
        organizationId,
        order.order_id,
      );
    }),
  ];
  await env.DB.batch(statements);
  await Promise.all([
    ...orders.results.map((item)=>syncOrderWorkflowSnapshot(organizationId,item.order_id)),
    synchronizeOrderExceptionStatuses(organizationId,orders.results.map(item=>item.order_id),now),
  ]);
}
