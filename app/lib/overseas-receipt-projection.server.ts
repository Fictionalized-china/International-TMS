import {env} from "cloudflare:workers";
import {syncOrderWorkflowSnapshot} from "./order-modules.server";
import {prepareOrderIntakeAdvance,intakeGateCommitStatements} from "./order-intake-gate.server";
import {loadOverseasInboundCustomsGates} from "./overseas-inbound-policy.server";
import {automaticallyNotifyOverseasArrival,confirmOverseasBatchArrival} from "./overseas-warehouse.server";
import {syncTrackingModuleStatusForOrder} from "./batch-tracking.server";
export type OverseasReceivingResult={completed:boolean;batchNumber:string;remaining:number;warning?:string|null};
export async function finalizeOverseasReceiving(input: {
  organizationId: string;
  orderId: string;
  batchId?:string|null;
  actorUserId: string;
  actualArrivalAt: string;
  notes: string;
}): Promise<OverseasReceivingResult> {
  const batch = await env.DB.prepare(
    `SELECT b.id,b.batch_number,b.road_status,b.actual_arrival_at
     FROM transport_batch_orders bo
     JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.status!='cancelled'
       AND (? IS NULL OR b.id=?)
     ORDER BY b.updated_at DESC LIMIT 1`,
  ).bind(input.organizationId, input.orderId,input.batchId??null,input.batchId??null).first<{
    id: string;
    batch_number: string;
    road_status: string;
    actual_arrival_at: string | null;
  }>();
  if (!batch) {
    const standalone = await confirmOverseasBatchArrival({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actualArrivalAt: input.actualArrivalAt,
      actorUserId: input.actorUserId,
      notes: input.notes,
    });
    return {
      completed: true,
      batchNumber: standalone.batchNumber,
      remaining: 0,
      warning: standalone.warning,
    };
  }
  if (batch.road_status === "pickup_completed")
    return { completed: true, batchNumber: batch.batch_number, remaining: 0 };
  if (!["outbound_in_transit", "overseas_arrived", "waiting_pickup"].includes(batch.road_status))
    throw new Error("运输单尚未登记实际出境");
  const singleOrderWarning = await confirmSingleOrderOverseasArrival({
    ...input,
    batchId: batch.id,
  });
  if (["overseas_arrived", "waiting_pickup"].includes(batch.road_status)) {
    const retry = await confirmOverseasBatchArrival({
      organizationId: input.organizationId,
      batchId: batch.id,
      actualArrivalAt: batch.actual_arrival_at || input.actualArrivalAt,
      actorUserId: input.actorUserId,
      notes: input.notes,
    });
    return {
      completed: true,
      batchNumber: batch.batch_number,
      remaining: 0,
      warning: [singleOrderWarning, retry.warning].filter(Boolean).join("；") || null,
    };
  }
  const readiness = await env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN EXISTS(
              SELECT 1 FROM transport_batch_packages mapped_package
              WHERE mapped_package.organization_id=bo.organization_id
                AND mapped_package.batch_id=bo.batch_id AND mapped_package.order_id=bo.order_id
                AND mapped_package.status!='removed'
            ) AND NOT EXISTS(
              SELECT 1 FROM transport_batch_packages batch_package
              WHERE batch_package.organization_id=bo.organization_id
                AND batch_package.batch_id=bo.batch_id AND batch_package.order_id=bo.order_id
                AND batch_package.status NOT IN ('arrived','removed')
            ) THEN 1 ELSE 0 END) ready
     FROM transport_batch_orders bo
     JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'`,
  ).bind(input.organizationId, batch.id).first<{ total: number; ready: number | null }>();
  const total = readiness?.total ?? 0;
  const ready = readiness?.ready ?? 0;
  if (!total) throw new Error("运输单没有有效子订单");
  if (ready < total)
    return {
      completed: false,
      batchNumber: batch.batch_number,
      remaining: total - ready,
      warning: singleOrderWarning,
    };

  const arrival = await confirmOverseasBatchArrival({
    organizationId: input.organizationId,
    batchId: batch.id,
    actualArrivalAt: input.actualArrivalAt,
    actorUserId: input.actorUserId,
    notes: input.notes,
  });
  return {
    completed: true,
    batchNumber: batch.batch_number,
    remaining: 0,
    warning: [singleOrderWarning, arrival.warning].filter(Boolean).join("；") || null,
  };
}

async function confirmSingleOrderOverseasArrival(input: {
  organizationId: string;
  batchId: string;
  orderId: string;
  actorUserId: string;
  actualArrivalAt: string;
  notes: string;
}) {
  const order = await env.DB.prepare(
    `SELECT o.order_number,o.overseas_warehouse_id,o.customs_clearance_mode,
            COALESCE(w.name,'境外目的仓') warehouse_name,w.address warehouse_address
       FROM transport_batch_orders bo
       JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
       LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
      WHERE bo.organization_id=? AND bo.batch_id=? AND bo.order_id=? AND bo.status!='removed'`,
  ).bind(input.organizationId, input.batchId, input.orderId).first<{
    order_number: string;
    overseas_warehouse_id: string | null;
    customs_clearance_mode: string;
    warehouse_name: string;
    warehouse_address: string | null;
  }>();
  if (!order) throw new Error("当前订单不属于该运输批次");
  if (!order.overseas_warehouse_id) throw new Error("订单尚未指定境外目的仓");
  const [customsGate] = await loadOverseasInboundCustomsGates(
    input.organizationId,
    [{
      orderId: input.orderId,
      orderNumber: order.order_number,
      customsClearanceMode: order.customs_clearance_mode === "customer" ? "customer" : "company",
    }],
  );
  if (!customsGate || customsGate.blocked)
    throw new Error(customsGate?.message || "当前订单清关门禁解析失败");

  const now = new Date().toISOString();
  const location = [order.warehouse_name, order.warehouse_address].filter(Boolean).join(" · ");
  const intake=await prepareOrderIntakeAdvance(input.organizationId,input.orderId);
  await env.DB.batch([
    ...intakeGateCommitStatements(intake,now),
    env.DB.prepare(
      `UPDATE transport_batch_orders SET status='arrived',updated_at=?
        WHERE organization_id=? AND batch_id=? AND order_id=? AND status!='removed'`,
    ).bind(now, input.organizationId, input.batchId, input.orderId),
    env.DB.prepare(`UPDATE transport_batch_packages SET status='arrived',updated_at=?
      WHERE organization_id=? AND batch_id=? AND order_id=? AND status!='removed'`)
      .bind(now,input.organizationId,input.batchId,input.orderId),
    env.DB.prepare(
      `INSERT INTO overseas_warehouse_operations(
         id,organization_id,batch_id,order_id,warehouse_id,status,actual_arrival_at,
         notes,updated_by_user_id,created_at,updated_at
       ) VALUES(?,?,?,?,?,'arrived',?,?,?,?,?)
       ON CONFLICT(batch_id,order_id) DO UPDATE SET
         warehouse_id=COALESCE(overseas_warehouse_operations.warehouse_id,excluded.warehouse_id),
         status=CASE WHEN overseas_warehouse_operations.status='waiting_arrival' THEN 'arrived' ELSE overseas_warehouse_operations.status END,
         actual_arrival_at=COALESCE(overseas_warehouse_operations.actual_arrival_at,excluded.actual_arrival_at),
         notes=COALESCE(excluded.notes,overseas_warehouse_operations.notes),
         updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.batchId,
      input.orderId,
      order.overseas_warehouse_id,
      input.actualArrivalAt,
      input.notes || null,
      input.actorUserId,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE shipments SET status='in_transit',current_location=?,updated_at=?
        WHERE organization_id=? AND order_id=? AND status!='cancelled'`,
    ).bind(location || "境外目的仓", now, input.organizationId, input.orderId),
    env.DB.prepare(
      `INSERT INTO order_tracking_milestones(
         id,organization_id,order_id,milestone_code,milestone_name,event_at,location,notes,
         visible_to_customer,created_by_user_id,created_at,transport_batch_id
       ) SELECT ?,?,?,'station_arrived','到达境外目的仓',?,?,?,1,?,?,?
         WHERE NOT EXISTS(
           SELECT 1 FROM order_tracking_milestones
           WHERE organization_id=? AND order_id=? AND transport_batch_id=? AND milestone_code='station_arrived'
         )`,
    ).bind(
      crypto.randomUUID(),
      input.organizationId,
      input.orderId,
      input.actualArrivalAt,
      location || "境外目的仓",
      input.notes || null,
      input.actorUserId,
      now,
      input.batchId,
      input.organizationId,
      input.orderId,
      input.batchId,
    ),
    env.DB.prepare(
      `UPDATE order_module_instances
          SET status='in_progress',current_step_code='arrived',current_step_name='等待系统自动通知客户',
              progress_percent=MAX(progress_percent,25),started_at=COALESCE(started_at,?),
              blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='overseas_warehouse' AND enabled=1
          AND status!='completed'`,
    ).bind(now, now, input.organizationId, input.orderId),
  ]);

  await syncTrackingModuleStatusForOrder(input.organizationId,input.orderId,"station_arrived",input.actorUserId,now);

  try {
    await automaticallyNotifyOverseasArrival({
      organizationId: input.organizationId,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      occurredAt: input.actualArrivalAt,
    });
    await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
    return null;
  } catch (error) {
    await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
    const reason = error instanceof Error ? error.message : "客户通知暂未完成";
    return `本票已到仓并推进，客户通知待重试：${reason}`;
  }
}
