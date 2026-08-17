import {
  completionStatusLabels,
  currencyFinance,
  orderCompletionStatus,
  type CurrencyFinance,
  type OrderCompletionStatus,
} from "./order-review";

export type ReviewTiming = {
  orderAt: string | null;
  pickupAt: string | null;
  inboundAt: string | null;
  loadingAt: string | null;
  outboundAt: string | null;
  overseasArrivalAt: string | null;
  pickupCompletedAt: string | null;
};

export type ReviewCargo = {
  plannedPieces: number;
  plannedWeightKg: number;
  plannedVolumeCbm: number;
  actualPieces: number;
  actualWeightKg: number;
  actualVolumeCbm: number;
  loadedPieces: number;
  loadedWeightKg: number;
  loadedVolumeCbm: number;
};

export type ReviewException = {
  cargoDifferenceCount: number;
  maxCargoDifferencePercent: number;
  openWarehouseExceptionCount: number;
  delayDays: number;
  costAdjustmentCount: number;
  customerDisputeSummary: string | null;
};

export type ReviewPeople = {
  salesperson: string | null;
  mainOperator: string | null;
  warehouseHandler: string | null;
  financeHandler: string | null;
};

export type ReviewBlocker = { code: string; message: string; href: string };

export type OrderReviewView = {
  snapshotId: string | null;
  revision: number;
  generatedAt: string | null;
  generatedBy: string | null;
  completionStatus: OrderCompletionStatus;
  completionLabel: string;
  timing: ReviewTiming;
  cargo: ReviewCargo;
  finance: CurrencyFinance[];
  exceptions: ReviewException;
  people: ReviewPeople;
  blockers: ReviewBlocker[];
  pickupComplete: boolean;
  customerDisputeSummary: string | null;
  reviewConclusion: string | null;
  improvementNotes: string | null;
};

type SnapshotRow = {
  id: string;
  revision: number;
  generated_at: string;
  generated_by: string | null;
  customer_dispute_summary: string | null;
  review_conclusion: string | null;
  improvement_notes: string | null;
};

export async function loadOrderReview(
  db: D1Database,
  organizationId: string,
  orderId: string,
): Promise<OrderReviewView> {
  const snapshot = await db.prepare(
    `SELECT r.id,r.revision,r.generated_at,u.display_name generated_by,
            r.customer_dispute_summary,r.review_conclusion,r.improvement_notes
       FROM order_review_snapshots r
       LEFT JOIN users u ON u.id=r.generated_by_user_id
      WHERE r.organization_id=? AND r.order_id=?`,
  ).bind(organizationId, orderId).first<SnapshotRow>();
  return buildOrderReview(db, organizationId, orderId, snapshot ?? null);
}

export async function generateOrderReview(
  db: D1Database,
  input: {
    organizationId: string;
    orderId: string;
    userId: string;
    now: string;
    customerDisputeSummary?: string;
    reviewConclusion?: string;
    improvementNotes?: string;
  },
) {
  const previous = await db.prepare(
    "SELECT id,revision FROM order_review_snapshots WHERE organization_id=? AND order_id=?",
  ).bind(input.organizationId, input.orderId).first<{ id: string; revision: number }>();
  const draft = await buildOrderReview(db, input.organizationId, input.orderId, null, {
    customerDisputeSummary: input.customerDisputeSummary || null,
    reviewConclusion: input.reviewConclusion || null,
    improvementNotes: input.improvementNotes || null,
  });
  const completionStatus = orderCompletionStatus({
    pickupComplete: draft.pickupComplete,
    blockers: draft.blockers.map((item) => item.message),
    reviewGenerated: true,
    finance: draft.finance,
  });
  const readinessStatus = completionStatus === "in_progress" ? "blocked" : completionStatus;
  const id = previous?.id ?? crypto.randomUUID();
  const revision = (previous?.revision ?? 0) + 1;
  const statements = [
    db.prepare(`INSERT INTO order_review_snapshots(
      id,organization_id,order_id,revision,readiness_status,timing_json,
      planned_pieces,planned_weight_kg,planned_volume_cbm,actual_pieces,actual_weight_kg,actual_volume_cbm,
      loaded_pieces,loaded_weight_kg,loaded_volume_cbm,finance_json,exception_json,people_json,blocker_json,
      customer_dispute_summary,review_conclusion,improvement_notes,generated_by_user_id,generated_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(organization_id,order_id) DO UPDATE SET
      revision=excluded.revision,readiness_status=excluded.readiness_status,timing_json=excluded.timing_json,
      planned_pieces=excluded.planned_pieces,planned_weight_kg=excluded.planned_weight_kg,planned_volume_cbm=excluded.planned_volume_cbm,
      actual_pieces=excluded.actual_pieces,actual_weight_kg=excluded.actual_weight_kg,actual_volume_cbm=excluded.actual_volume_cbm,
      loaded_pieces=excluded.loaded_pieces,loaded_weight_kg=excluded.loaded_weight_kg,loaded_volume_cbm=excluded.loaded_volume_cbm,
      finance_json=excluded.finance_json,exception_json=excluded.exception_json,people_json=excluded.people_json,
      blocker_json=excluded.blocker_json,customer_dispute_summary=excluded.customer_dispute_summary,
      review_conclusion=excluded.review_conclusion,improvement_notes=excluded.improvement_notes,
      generated_by_user_id=excluded.generated_by_user_id,generated_at=excluded.generated_at,updated_at=excluded.updated_at`)
      .bind(
        id,input.organizationId,input.orderId,revision,readinessStatus,JSON.stringify(draft.timing),
        draft.cargo.plannedPieces,draft.cargo.plannedWeightKg,draft.cargo.plannedVolumeCbm,
        draft.cargo.actualPieces,draft.cargo.actualWeightKg,draft.cargo.actualVolumeCbm,
        draft.cargo.loadedPieces,draft.cargo.loadedWeightKg,draft.cargo.loadedVolumeCbm,
        JSON.stringify(draft.finance),JSON.stringify(draft.exceptions),JSON.stringify(draft.people),JSON.stringify(draft.blockers),
        input.customerDisputeSummary||null,input.reviewConclusion||null,input.improvementNotes||null,input.userId,input.now,input.now,
      ),
    db.prepare(`UPDATE transport_orders SET
      completion_status=?,
      business_completed_at=CASE WHEN ?!='in_progress' THEN COALESCE(business_completed_at,?) ELSE business_completed_at END,
      settlement_completed_at=CASE WHEN ?='completed_settled' THEN COALESCE(settlement_completed_at,?) ELSE NULL END,
      status=CASE WHEN ?='completed_settled' THEN 'completed' ELSE status END,
      current_step_code=CASE WHEN ?='completed_settled' THEN 'completed' ELSE current_step_code END,
      current_step_name=CASE WHEN ?='completed_settled' THEN '订单完成 · 已完成并结清' WHEN ?!='in_progress' THEN '订单完成 · 待结算跟进' ELSE current_step_name END,
      workflow_updated_at=CASE WHEN ?!='in_progress' THEN ? ELSE workflow_updated_at END,
      updated_at=?
      WHERE id=? AND organization_id=?`)
      .bind(completionStatus,completionStatus,input.now,completionStatus,input.now,completionStatus,completionStatus,completionStatus,completionStatus,completionStatus,input.now,input.now,input.orderId,input.organizationId),
  ];
  const module = await db.prepare(
    "SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='review'",
  ).bind(input.organizationId,input.orderId).first<{id:string;current_step_code:string|null}>();
  if (module) {
    statements.push(
      db.prepare(`UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=?,
        started_at=COALESCE(started_at,?),completed_at=?,updated_at=? WHERE id=? AND organization_id=?`)
        .bind(
          completionStatus === "in_progress" ? "blocked" : "completed",
          completionStatus === "in_progress" ? "reviewing" : "confirmed",
          completionStatus === "in_progress" ? "复盘中" : "复盘确认",
          completionStatus === "in_progress" ? 67 : 100,
          draft.blockers.map((item)=>item.message).join("；") || null,
          input.now,completionStatus === "in_progress" ? null : input.now,input.now,module.id,input.organizationId,
        ),
      db.prepare(`INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(),input.organizationId,input.orderId,module.id,"generate_review","生成订单复盘",module.current_step_code,
          completionStatus === "in_progress" ? "reviewing" : "confirmed",
          completionStatus === "in_progress" ? "复盘中" : "复盘确认",input.userId,
          completionStatusLabels[completionStatus],input.now),
    );
  }
  await db.batch(statements);
  await syncSettlementFollowUpTask(db,input.organizationId,input.orderId,input.userId,input.now,completionStatus);
  return { completionStatus, label: completionStatusLabels[completionStatus], blockers: draft.blockers };
}

export async function refreshOrderCompletionStatus(
  db:D1Database,
  organizationId:string,
  orderIds:string[],
  now:string,
) {
  for (const orderId of [...new Set(orderIds)]) {
    const snapshot = await db.prepare("SELECT 1 FROM order_review_snapshots WHERE organization_id=? AND order_id=?")
      .bind(organizationId,orderId).first();
    if (!snapshot) continue;
    const draft = await buildOrderReview(db,organizationId,orderId,null);
    const status = orderCompletionStatus({pickupComplete:draft.pickupComplete,blockers:draft.blockers.map(x=>x.message),reviewGenerated:true,finance:draft.finance});
    await db.batch([
      db.prepare(`UPDATE transport_orders SET completion_status=?,status=CASE WHEN ?='completed_settled' THEN 'completed' WHEN status='completed' THEN 'in_execution' ELSE status END,
        settlement_completed_at=CASE WHEN ?='completed_settled' THEN COALESCE(settlement_completed_at,?) ELSE NULL END,
        current_step_code=CASE WHEN ?='completed_settled' THEN 'completed' ELSE current_step_code END,
        current_step_name=CASE WHEN ?='completed_settled' THEN '订单完成 · 已完成并结清' WHEN ?!='in_progress' THEN '订单完成 · 待结算跟进' ELSE current_step_name END,
        workflow_updated_at=CASE WHEN ?!='in_progress' THEN ? ELSE workflow_updated_at END,
        updated_at=?
        WHERE id=? AND organization_id=?`)
        .bind(status,status,status,now,status,status,status,status,now,now,orderId,organizationId),
      db.prepare(`UPDATE order_review_snapshots SET readiness_status=?,finance_json=?,blocker_json=?,updated_at=? WHERE organization_id=? AND order_id=?`)
        .bind(status==="in_progress"?"blocked":status,JSON.stringify(draft.finance),JSON.stringify(draft.blockers),now,organizationId,orderId),
      db.prepare(`UPDATE order_module_instances SET status='completed',current_step_code='settled',current_step_name='结算完成',progress_percent=100,
        blocking_reason=NULL,completed_at=COALESCE(completed_at,?),updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='costs' AND ?='completed_settled'`)
        .bind(now,now,organizationId,orderId,status),
    ]);
    await syncSettlementFollowUpTask(db,organizationId,orderId,null,now,status);
  }
}

async function buildOrderReview(
  db:D1Database,
  organizationId:string,
  orderId:string,
  snapshot:SnapshotRow|null,
  manual?:{customerDisputeSummary:string|null;reviewConclusion:string|null;improvementNotes:string|null},
):Promise<OrderReviewView> {
  const [order,cargo,actual,loaded,timing,financeRows,controls,exceptionRow,people] = await Promise.all([
    db.prepare(`SELECT o.order_date,o.created_at,o.requested_delivery_date,o.completion_status,c.sales_owner_user_id,
      sales.display_name salesperson,creator.display_name creator
      FROM transport_orders o JOIN customers c ON c.id=o.customer_id
      LEFT JOIN users sales ON sales.id=c.sales_owner_user_id LEFT JOIN users creator ON creator.id=o.created_by_user_id
      WHERE o.organization_id=? AND o.id=?`).bind(organizationId,orderId)
      .first<{order_date:string|null;created_at:string;requested_delivery_date:string|null;completion_status:OrderCompletionStatus;salesperson:string|null;creator:string|null}>(),
    db.prepare(`SELECT COALESCE(SUM(package_count*pieces_per_package),0) pieces,
      COALESCE(SUM(package_count*gross_weight_per_package_kg),0) weight,
      COALESCE(SUM(package_count*volume_per_package_cbm),0) volume
      FROM order_cargo_items WHERE organization_id=? AND order_id=?`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number}>(),
    db.prepare(`SELECT COALESCE(SUM(r.total_pieces),0) pieces,COALESCE(SUM(r.total_weight_kg),0) weight,COALESCE(SUM(r.total_volume_cbm),0) volume,
      MAX(r.received_at) inbound_at,MAX(u.display_name) warehouse_handler
      FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id LEFT JOIN users u ON u.id=r.received_by_user_id
      WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number;inbound_at:string|null;warehouse_handler:string|null}>(),
    db.prepare(`SELECT COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight,COALESCE(SUM(p.volume_cbm),0) volume,
      MAX(di.loaded_at) loading_at
      FROM warehouse_dispatch_items di JOIN warehouse_dispatches d ON d.id=di.dispatch_id
      JOIN shipments s ON s.id=d.shipment_id JOIN warehouse_packages p ON p.id=di.package_id
      WHERE di.organization_id=? AND s.order_id=? AND di.status='loaded'`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number;loading_at:string|null}>(),
    db.prepare(`SELECT
      (SELECT MIN(s.actual_pickup_at) FROM shipments s WHERE s.organization_id=? AND s.order_id=?) pickup_at,
      (SELECT MAX(x.actual_exit_at) FROM transport_exit_confirmations x JOIN transport_batch_orders bo ON bo.batch_id=x.batch_id WHERE x.organization_id=? AND bo.order_id=? AND bo.status!='removed') outbound_at,
      (SELECT MAX(op.actual_arrival_at) FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled') overseas_arrival_at,
      (SELECT MAX(op.pickup_at) FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status='picked_up') pickup_completed_at,
      CASE WHEN EXISTS(SELECT 1 FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status='picked_up')
        OR EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.road_status='pickup_completed')
        OR EXISTS(SELECT 1 FROM shipments s WHERE s.organization_id=? AND s.order_id=? AND s.status='delivered') THEN 1 ELSE 0 END pickup_complete`)
      .bind(organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId)
      .first<{pickup_at:string|null;outbound_at:string|null;overseas_arrival_at:string|null;pickup_completed_at:string|null;pickup_complete:number}>(),
    db.prepare(`SELECT e.currency,
      SUM(CASE WHEN e.direction='receivable' THEN e.amount ELSE 0 END) receivable,
      SUM(CASE WHEN e.direction='payable' THEN e.amount ELSE 0 END) payable,
      COALESCE(SUM(CASE WHEN e.direction='receivable' THEN (SELECT COALESCE(SUM(a.amount),0) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.status!='void' WHERE a.expense_id=e.id) ELSE 0 END),0) received,
      COALESCE(SUM(CASE WHEN e.direction='payable' THEN (SELECT COALESCE(SUM(a.amount),0) FROM settlement_cash_allocations a JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id AND t.status!='void' WHERE a.expense_id=e.id) ELSE 0 END),0) paid,
      SUM(CASE WHEN e.direction='receivable' THEN 1 ELSE 0 END) receivable_count,
      SUM(CASE WHEN e.direction='payable' THEN 1 ELSE 0 END) payable_count,
      SUM(CASE WHEN e.charge_code LIKE '%ADJ%' OR COALESCE(e.notes,'') LIKE '%调整%' THEN 1 ELSE 0 END) adjustment_count
      FROM business_expenses e WHERE e.organization_id=? AND e.order_id=? AND e.stage!='cancelled' GROUP BY e.currency ORDER BY e.currency`)
      .bind(organizationId,orderId).all<{currency:string;receivable:number;payable:number;received:number;paid:number;receivable_count:number;payable_count:number;adjustment_count:number}>(),
    db.prepare(`SELECT direction,confirmed,business_reviewed,finance_reviewed,business_locked,finance_locked FROM order_expense_direction_controls WHERE organization_id=? AND order_id=?`)
      .bind(organizationId,orderId).all<{direction:string;confirmed:number;business_reviewed:number;finance_reviewed:number;business_locked:number;finance_locked:number}>(),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM warehouse_receipt_differences d WHERE d.organization_id=? AND d.order_id=? AND d.status!='cancelled' AND d.max_difference_percent>0) cargo_difference_count,
      COALESCE((SELECT MAX(d.max_difference_percent) FROM warehouse_receipt_differences d WHERE d.organization_id=? AND d.order_id=? AND d.status!='cancelled'),0) max_difference,
      (SELECT COUNT(*) FROM warehouse_receipt_differences d WHERE d.organization_id=? AND d.order_id=? AND (d.status='pending' OR d.fee_impact_confirmed=0)) pending_difference_count,
      (SELECT COUNT(*) FROM warehouse_exceptions x JOIN shipments s ON s.id=x.shipment_id WHERE x.organization_id=? AND s.order_id=? AND x.status IN ('open','processing')) open_exception_count`)
      .bind(organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId)
      .first<{cargo_difference_count:number;max_difference:number;pending_difference_count:number;open_exception_count:number}>(),
    db.prepare(`SELECT
      (SELECT u.display_name FROM order_module_instances m JOIN users u ON u.id=m.assignee_user_id WHERE m.organization_id=? AND m.order_id=? AND m.module_code='transport') main_operator,
      (SELECT u.display_name FROM settlement_cash_allocations a JOIN business_expenses e ON e.id=a.expense_id JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id LEFT JOIN users u ON u.id=t.handled_by_user_id WHERE e.organization_id=? AND e.order_id=? AND t.status!='void' ORDER BY a.created_at DESC LIMIT 1) finance_handler`)
      .bind(organizationId,orderId,organizationId,orderId).first<{main_operator:string|null;finance_handler:string|null}>(),
  ]);
  if (!order) throw new Error("订单不存在");
  const finance=financeRows.results.map(row=>currencyFinance(row));
  const hasReceivable=financeRows.results.some(row=>row.receivable_count>0);
  const hasPayable=financeRows.results.some(row=>row.payable_count>0);
  const control=(direction:string)=>controls.results.find(row=>row.direction===direction);
  const blockers:ReviewBlocker[]=[];
  if (!timing?.pickup_complete) blockers.push({code:"pickup",message:"客户自提/签收尚未完成",href:`/admin/orders/${orderId}/modules/overseas_warehouse#module-business-data`});
  if (!hasReceivable) blockers.push({code:"receivable_missing",message:"尚未录入应收费用",href:`/admin/orders/${orderId}/modules/costs#module-business-data`});
  if (!hasPayable) blockers.push({code:"payable_missing",message:"尚未录入应付费用",href:`/admin/orders/${orderId}/modules/costs#module-business-data`});
  for (const direction of ["receivable","payable"] as const) {
    if ((direction==="receivable"?hasReceivable:hasPayable) && !control(direction)?.finance_locked)
      blockers.push({code:`${direction}_unlocked`,message:`${direction==="receivable"?"应收":"应付"}费用尚未完成财务锁定`,href:`/admin/orders/${orderId}/modules/costs#module-business-data`});
  }
  if ((exceptionRow?.pending_difference_count??0)>0) blockers.push({code:"cargo_difference",message:"仓库实收差异或费用影响尚未确认",href:`/admin/orders/${orderId}/modules/warehouse#module-business-data`});
  if ((exceptionRow?.open_exception_count??0)>0) blockers.push({code:"open_exception",message:"仍有未关闭的仓库异常",href:`/admin/orders/${orderId}/modules/exceptions#module-business-data`});
  const dispute=manual?.customerDisputeSummary ?? snapshot?.customer_dispute_summary ?? null;
  const pickupCompletedAt=timing?.pickup_completed_at??null;
  const delayDays=order.requested_delivery_date&&pickupCompletedAt
    ? Math.max(0,Math.ceil((new Date(pickupCompletedAt).getTime()-new Date(order.requested_delivery_date).getTime())/86400000)) : 0;
  const completionStatus=orderCompletionStatus({pickupComplete:Boolean(timing?.pickup_complete),blockers:blockers.map(x=>x.message),reviewGenerated:Boolean(snapshot),finance});
  return {
    snapshotId:snapshot?.id??null,revision:snapshot?.revision??0,generatedAt:snapshot?.generated_at??null,generatedBy:snapshot?.generated_by??null,
    completionStatus,completionLabel:completionStatusLabels[completionStatus],
    timing:{orderAt:order.order_date||order.created_at,pickupAt:timing?.pickup_at??null,inboundAt:actual?.inbound_at??null,loadingAt:loaded?.loading_at??null,outboundAt:timing?.outbound_at??null,overseasArrivalAt:timing?.overseas_arrival_at??null,pickupCompletedAt},
    cargo:{plannedPieces:cargo?.pieces??0,plannedWeightKg:cargo?.weight??0,plannedVolumeCbm:cargo?.volume??0,actualPieces:actual?.pieces??0,actualWeightKg:actual?.weight??0,actualVolumeCbm:actual?.volume??0,loadedPieces:loaded?.pieces??0,loadedWeightKg:loaded?.weight??0,loadedVolumeCbm:loaded?.volume??0},
    finance,
    exceptions:{cargoDifferenceCount:exceptionRow?.cargo_difference_count??0,maxCargoDifferencePercent:exceptionRow?.max_difference??0,openWarehouseExceptionCount:exceptionRow?.open_exception_count??0,delayDays,costAdjustmentCount:financeRows.results.reduce((s,r)=>s+r.adjustment_count,0),customerDisputeSummary:dispute},
    people:{salesperson:order.salesperson||order.creator,mainOperator:people?.main_operator??null,warehouseHandler:actual?.warehouse_handler??null,financeHandler:people?.finance_handler??null},
    blockers,pickupComplete:Boolean(timing?.pickup_complete),customerDisputeSummary:dispute,
    reviewConclusion:manual?.reviewConclusion??snapshot?.review_conclusion??null,
    improvementNotes:manual?.improvementNotes??snapshot?.improvement_notes??null,
  };
}

async function syncSettlementFollowUpTask(db:D1Database,organizationId:string,orderId:string,userId:string|null,now:string,status:OrderCompletionStatus){
  const existing=await db.prepare("SELECT id FROM order_tasks WHERE organization_id=? AND order_id=? AND task_type='settlement_follow_up' AND status IN ('pending','in_progress') LIMIT 1")
    .bind(organizationId,orderId).first<{id:string}>();
  if(status==="business_complete_unsettled"&&!existing){
    await db.prepare(`INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,priority,status,assigned_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,'业务已完成：继续收付款与核销','high','pending',?,?,?)`)
      .bind(crypto.randomUUID(),organizationId,orderId,"costs","settlement_follow_up",userId,now,now).run();
  }
  if(status==="completed_settled"&&existing){
    await db.prepare("UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE id=? AND organization_id=?")
      .bind(now,now,existing.id,organizationId).run();
  }
}
