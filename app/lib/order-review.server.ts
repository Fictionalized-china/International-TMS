import {
  completionStatusLabels,
  configuredModuleRequiresCompletion,
  costsModuleReviewBlocker,
  currencyFinance,
  finalizedOrderReviewState,
  orderCompletionStatus,
  orderReviewFinalizationDecision,
  orderReviewPreparationModuleState,
  orderReviewSettlementBlockers,
  pendingOrderReviewCurrentStep,
  pendingOrderReviewCompletionStatus,
  pickupCompletionRequired,
  pickupCompletionReviewBlocker,
  refreshedArchivedOrderCompletionStatus,
  refreshedArchivedSettlementCompletedAt,
  type CurrencyFinance,
  type OrderCompletionStatus,
} from "./order-review";
import { syncOrderBusinessWorkflow } from "./business-workflow.server";
import { missingRequiredModuleFields } from "./workflow-fields.server";

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
  pickupRequired: boolean;
  customerDisputeSummary: string | null;
  reviewConclusion: string | null;
  improvementNotes: string | null;
};

export type OrderReviewFinalizationGate = {
  allowed: boolean;
  reason: string | null;
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
    pickupRequired: draft.pickupRequired,
    blockers: draft.blockers.map((item) => item.message),
    reviewGenerated: true,
    finance: draft.finance,
  });
  const reviewModuleState = orderReviewPreparationModuleState(
    completionStatus,
    draft.blockers.map((item) => item.message),
  );
  const readinessStatus = completionStatus === "in_progress" ? "blocked" : completionStatus;
  const persistedCompletionStatus = pendingOrderReviewCompletionStatus(completionStatus);
  const pendingStep = pendingOrderReviewCurrentStep(completionStatus);
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
      settlement_completed_at=NULL,
      current_step_code=CASE WHEN ?=1 THEN ? ELSE current_step_code END,
      current_step_name=CASE WHEN ?=1 THEN ? ELSE current_step_name END,
      workflow_updated_at=CASE WHEN ?!='in_progress' THEN ? ELSE workflow_updated_at END,
      updated_at=?
      WHERE id=? AND organization_id=? AND status!='completed'`)
      .bind(
        persistedCompletionStatus,
        pendingStep?1:0,
        pendingStep?.code??null,
        pendingStep?1:0,
        pendingStep?.name??null,
        completionStatus,
        input.now,
        input.now,
        input.orderId,
        input.organizationId,
      ),
  ];
  const module = await db.prepare(
    "SELECT id,current_step_code FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='review'",
  ).bind(input.organizationId,input.orderId).first<{id:string;current_step_code:string|null}>();
  if (module) {
    statements.push(
      db.prepare(`UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=?,
        started_at=COALESCE(started_at,?),completed_at=?,updated_at=? WHERE id=? AND organization_id=?`)
        .bind(
          reviewModuleState.status,
          reviewModuleState.stepCode,
          reviewModuleState.stepName,
          reviewModuleState.progressPercent,
          reviewModuleState.blockingReason,
          input.now,null,input.now,module.id,input.organizationId,
        ),
      db.prepare(`INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(),input.organizationId,input.orderId,module.id,"generate_review","生成订单复盘",module.current_step_code,
          reviewModuleState.stepCode,
          reviewModuleState.stepName,input.userId,
          completionStatusLabels[completionStatus],input.now),
    );
  }
  await db.batch(statements);
  await syncSettlementFollowUpTask(db,input.organizationId,input.orderId,input.userId,input.now,completionStatus);
  await syncOrderBusinessWorkflow({
    organizationId: input.organizationId,
    orderId: input.orderId,
    actorUserId: input.userId,
    source: "admin",
  });
  return { completionStatus, label: completionStatusLabels[completionStatus], blockers: draft.blockers };
}

export async function loadOrderReviewFinalizationGate(
  db: D1Database,
  organizationId: string,
  orderId: string,
  review?: OrderReviewView,
): Promise<OrderReviewFinalizationGate> {
  const currentReview = review ?? await loadOrderReview(db,organizationId,orderId);
  const missingFields = await missingRequiredModuleFields(
    organizationId,
    orderId,
    "review",
  );
  if (missingFields.length) {
    return {
      allowed: false,
      reason: `请先补齐当前模板要求的字段：${missingFields.map((field) => field.label).join("、")}`,
    };
  }
  const pendingRequiredModules = await db.prepare(
    `WITH instance_modules AS (
       SELECT ms.module_code,ms.display_name,ms.is_required,ms.status
       FROM workflow_instances wi
       JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id
       JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       WHERE wi.organization_id=? AND wi.order_id=?
     ), pending AS (
       SELECT module_code,MIN(display_name) module_name
       FROM instance_modules
       WHERE is_required=1 AND module_code!='review' AND status!='completed'
       GROUP BY module_code
       UNION ALL
       SELECT m.module_code,m.module_name
       FROM order_module_instances m
       WHERE m.organization_id=? AND m.order_id=?
         AND m.enabled=1 AND m.is_required=1 AND m.module_code!='review'
         AND m.status NOT IN ('completed','not_applicable')
         AND NOT EXISTS(SELECT 1 FROM instance_modules)
     )
     SELECT module_code,module_name FROM pending ORDER BY module_code`,
  ).bind(organizationId,orderId,organizationId,orderId).all<{
    module_code: string;
    module_name: string;
  }>();
  if (pendingRequiredModules.results.length) {
    return {
      allowed: false,
      reason: `当前工作流仍有必办模块未完成：${pendingRequiredModules.results.map((item) => item.module_name).join("、")}`,
    };
  }
  return orderReviewFinalizationDecision({
    confirmed: true,
    snapshotId: currentReview.snapshotId,
    completionStatus: currentReview.completionStatus,
    blockers: currentReview.blockers.map((blocker) => blocker.message),
  });
}

export async function finalizeOrderReview(
  db: D1Database,
  input: {
    organizationId: string;
    orderId: string;
    userId: string;
    now: string;
    confirmed: boolean;
  },
) {
  const order = await db.prepare(
    "SELECT status FROM transport_orders WHERE organization_id=? AND id=?",
  ).bind(input.organizationId,input.orderId).first<{ status: string }>();
  if (!order) return { completed: false as const, reason: "订单不存在" };
  if (order.status !== "in_execution") {
    return {
      completed: false as const,
      reason: order.status === "completed" ? "订单已经完成归档" : "当前订单状态不能最终确认归档",
    };
  }
  const module = await db.prepare(
    `SELECT m.id,m.current_step_code
     FROM order_module_instances m
     JOIN transport_orders o ON o.organization_id=m.organization_id AND o.id=m.order_id
     WHERE m.organization_id=? AND m.order_id=? AND m.module_code='review'
       AND (
         (o.workflow_instance_id IS NULL AND m.enabled=1)
         OR EXISTS(
           SELECT 1
           FROM workflow_instance_step_states ss
           JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
           WHERE ss.instance_id=o.workflow_instance_id AND ms.module_code='review'
         )
       )`,
  ).bind(input.organizationId,input.orderId).first<{
    id: string;
    current_step_code: string | null;
  }>();
  if (!module) return { completed: false as const, reason: "当前工作流未启用订单复盘" };
  const review = await loadOrderReview(db,input.organizationId,input.orderId);
  if (!input.confirmed)
    return { completed: false as const, reason: "请明确确认最终归档" };
  const decision = await loadOrderReviewFinalizationGate(
    db,
    input.organizationId,
    input.orderId,
    review,
  );
  if (!decision.allowed)
    return { completed: false as const, reason: decision.reason };
  if (review.completionStatus === "in_progress")
    return { completed: false as const, reason: "当前仍有必办门禁未完成" };
  const finalState = finalizedOrderReviewState(review.completionStatus);
  await db.batch([
    db.prepare(`UPDATE transport_orders SET
      completion_status=?,status='completed',
      business_completed_at=COALESCE(business_completed_at,?),
      settlement_completed_at=CASE WHEN ?=1 THEN COALESCE(settlement_completed_at,?) ELSE NULL END,
      current_step_code='completed',current_step_name=?,
      current_assignee_user_id=NULL,workflow_updated_at=?,updated_at=?
      WHERE id=? AND organization_id=? AND status='in_execution'`)
      .bind(
        finalState.completionStatus,
        input.now,
        finalState.settlementCompleted ? 1 : 0,
        input.now,
        finalState.currentStepName,
        input.now,
        input.now,
        input.orderId,
        input.organizationId,
      ),
    db.prepare(`UPDATE order_module_instances SET
      status='completed',current_step_code='confirmed',current_step_name='复盘确认',
      progress_percent=100,blocking_reason=NULL,started_at=COALESCE(started_at,?),
      completed_at=COALESCE(completed_at,?),updated_at=?
      WHERE id=? AND organization_id=? AND status!='completed'`)
      .bind(input.now,input.now,input.now,module.id,input.organizationId),
    db.prepare(`INSERT INTO order_module_history(
      id,organization_id,order_id,module_instance_id,action_code,action_name,
      from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        crypto.randomUUID(),input.organizationId,input.orderId,module.id,
        "finalize_review","最终确认并归档",module.current_step_code,
        "confirmed","复盘确认",input.userId,"全部当前工作流门禁已通过",input.now,
      ),
  ]);
  await syncSettlementFollowUpTask(
    db,input.organizationId,input.orderId,input.userId,input.now,finalState.completionStatus,
  );
  await syncOrderBusinessWorkflow({
    organizationId: input.organizationId,
    orderId: input.orderId,
    actorUserId: input.userId,
    source: "admin",
  });
  return {
    completed: true as const,
    reason: null,
    completionStatus: finalState.completionStatus,
  };
}

export async function refreshOrderCompletionStatus(
  db:D1Database,
  organizationId:string,
  orderIds:string[],
  now:string,
) {
  for (const orderId of [...new Set(orderIds)]) {
    const order = await db.prepare(
      `SELECT status,completion_status,settlement_completed_at,
        EXISTS(SELECT 1 FROM order_review_snapshots r WHERE r.organization_id=o.organization_id AND r.order_id=o.id) has_snapshot
       FROM transport_orders o WHERE organization_id=? AND id=?`,
    ).bind(organizationId,orderId).first<{
      status: string;
      completion_status: OrderCompletionStatus;
      settlement_completed_at: string | null;
      has_snapshot: number;
    }>();
    if (!order?.has_snapshot) continue;
    const draft = await buildOrderReview(db,organizationId,orderId,null);
    const status = orderCompletionStatus({pickupComplete:draft.pickupComplete,pickupRequired:draft.pickupRequired,blockers:draft.blockers.map(x=>x.message),reviewGenerated:true,finance:draft.finance});
    const reviewModuleState = orderReviewPreparationModuleState(status,draft.blockers.map(x=>x.message));
    const archived = order.status === "completed";
    const persistedCompletionStatus = archived
      ? refreshedArchivedOrderCompletionStatus(order.completion_status,status)
      : pendingOrderReviewCompletionStatus(status);
    const pendingStep = pendingOrderReviewCurrentStep(status);
    const settlementCompletedAt = refreshedArchivedSettlementCompletedAt({
      archived,
      previousStatus: order.completion_status,
      latestStatus: persistedCompletionStatus,
      previousCompletedAt: order.settlement_completed_at,
      now,
    });
    await db.batch([
      db.prepare(`UPDATE transport_orders SET completion_status=?,
        settlement_completed_at=?,
        current_step_code=CASE WHEN status!='completed' AND ?=1 THEN ? ELSE current_step_code END,
        current_step_name=CASE WHEN status!='completed' AND ?=1 THEN ? ELSE current_step_name END,
        workflow_updated_at=CASE WHEN status!='completed' AND ?!='in_progress' THEN ? ELSE workflow_updated_at END,
        updated_at=?
        WHERE id=? AND organization_id=?`)
        .bind(
          persistedCompletionStatus,
          settlementCompletedAt,
          pendingStep?1:0,
          pendingStep?.code??null,
          pendingStep?1:0,
          pendingStep?.name??null,
          status,
          now,
          now,
          orderId,
          organizationId,
        ),
      db.prepare(`UPDATE order_review_snapshots SET readiness_status=?,finance_json=?,blocker_json=?,updated_at=? WHERE organization_id=? AND order_id=?`)
        .bind(status==="in_progress"?"blocked":status,JSON.stringify(draft.finance),JSON.stringify(draft.blockers),now,organizationId,orderId),
      db.prepare(`UPDATE order_module_instances SET status=?,current_step_code=?,current_step_name=?,progress_percent=?,blocking_reason=?,
        started_at=COALESCE(started_at,?),completed_at=NULL,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='review' AND status!='completed'`)
        .bind(reviewModuleState.status,reviewModuleState.stepCode,reviewModuleState.stepName,reviewModuleState.progressPercent,
          reviewModuleState.blockingReason,now,now,organizationId,orderId),
    ]);
    await syncSettlementFollowUpTask(db,organizationId,orderId,null,now,status);
    await syncOrderBusinessWorkflow({ organizationId, orderId, source: "system" });
  }
}

type ConfiguredReviewModuleState = {
  enabled: number;
  is_required: number;
  status: string;
  blocking_reason: string | null;
};

export async function loadConfiguredReviewModuleState(
  db: D1Database,
  organizationId: string,
  orderId: string,
  moduleCode: string,
): Promise<ConfiguredReviewModuleState | null> {
  const row = await db.prepare(
    `SELECT o.workflow_instance_id,m.enabled stored_enabled,m.is_required stored_required,
      m.status,m.blocking_reason,
      (SELECT COUNT(*)
       FROM workflow_instance_step_states ss
       JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       WHERE ss.instance_id=o.workflow_instance_id AND ms.module_code=?) configured_count,
      (SELECT COALESCE(MAX(ms.is_required),0)
       FROM workflow_instance_step_states ss
       JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id
       WHERE ss.instance_id=o.workflow_instance_id AND ms.module_code=?) configured_required
     FROM transport_orders o
     LEFT JOIN order_module_instances m
       ON m.organization_id=o.organization_id AND m.order_id=o.id AND m.module_code=?
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(moduleCode,moduleCode,moduleCode,organizationId,orderId).first<{
    workflow_instance_id: string | null;
    stored_enabled: number | null;
    stored_required: number | null;
    status: string | null;
    blocking_reason: string | null;
    configured_count: number;
    configured_required: number;
  }>();
  if (!row) return null;
  const frozen = Boolean(row.workflow_instance_id);
  return {
    enabled: frozen ? Number(row.configured_count > 0) : row.stored_enabled ?? 0,
    is_required: frozen ? Number(row.configured_required > 0) : row.stored_required ?? 0,
    status: row.status ?? "not_started",
    blocking_reason: row.blocking_reason,
  };
}

async function buildOrderReview(
  db:D1Database,
  organizationId:string,
  orderId:string,
  snapshot:SnapshotRow|null,
  manual?:{customerDisputeSummary:string|null;reviewConclusion:string|null;improvementNotes:string|null},
):Promise<OrderReviewView> {
  const [order,cargo,actual,loaded] = await Promise.all([
    db.prepare(`SELECT o.order_date,o.created_at,o.requested_delivery_date,o.completion_status,COALESCE(o.salesperson_user_id,c.sales_owner_user_id) sales_owner_user_id,
      sales.display_name salesperson,creator.display_name creator
      FROM transport_orders o JOIN customers c ON c.id=o.customer_id
      LEFT JOIN users sales ON sales.id=COALESCE(o.salesperson_user_id,c.sales_owner_user_id) LEFT JOIN users creator ON creator.id=o.created_by_user_id
      WHERE o.organization_id=? AND o.id=?`).bind(organizationId,orderId)
      .first<{order_date:string|null;created_at:string;requested_delivery_date:string|null;completion_status:OrderCompletionStatus;salesperson:string|null;creator:string|null}>(),
    db.prepare(`SELECT COALESCE(SUM(package_count*pieces_per_package),0) pieces,
      COALESCE(SUM(package_count*gross_weight_per_package_kg),0) weight,
      COALESCE(SUM(package_count*volume_per_package_cbm),0) volume
      FROM order_cargo_items WHERE organization_id=? AND order_id=?`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number}>(),
    db.prepare(`SELECT COALESCE(SUM(r.total_pieces),0) pieces,COALESCE(SUM(r.total_weight_kg),0) weight,COALESCE(SUM(r.total_volume_cbm),0) volume,
      MAX(r.received_at) inbound_at,MAX(u.display_name) warehouse_handler
      FROM warehouse_receipts r
      JOIN shipments s ON s.id=r.shipment_id
      JOIN warehouses w ON w.id=r.warehouse_id AND w.organization_id=r.organization_id AND w.warehouse_role IN ('domestic_collection','port')
      LEFT JOIN users u ON u.id=r.received_by_user_id
      WHERE r.organization_id=? AND s.order_id=? AND r.status='completed'`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number;inbound_at:string|null;warehouse_handler:string|null}>(),
    db.prepare(`SELECT COALESCE(SUM(p.pieces),0) pieces,COALESCE(SUM(p.weight_kg),0) weight,COALESCE(SUM(p.volume_cbm),0) volume,
      MAX(di.loaded_at) loading_at
      FROM warehouse_dispatch_items di
      JOIN warehouse_dispatches d ON d.id=di.dispatch_id
      JOIN warehouse_packages p ON p.id=di.package_id
      JOIN shipments package_shipment ON package_shipment.id=p.shipment_id
      WHERE di.organization_id=? AND package_shipment.order_id=? AND di.status='loaded'`).bind(organizationId,orderId)
      .first<{pieces:number;weight:number;volume:number;loading_at:string|null}>(),
  ]);
  const [
    timing,
    financeRows,
    controls,
    exceptionRow,
    settlementWorkflowFields,
    pickupWorkflowFields,
    costsModule,
    pickupModule,
    warehouseModule,
    exceptionsModule,
  ] = await Promise.all([
    db.prepare(`SELECT
      (SELECT MIN(s.actual_pickup_at) FROM shipments s WHERE s.organization_id=? AND s.order_id=?) pickup_at,
      COALESCE(
        (SELECT MAX(x.actual_exit_at) FROM transport_exit_confirmations x JOIN transport_batch_orders bo ON bo.batch_id=x.batch_id WHERE x.organization_id=? AND bo.order_id=? AND bo.status!='removed'),
        (SELECT MAX(m.event_at) FROM order_tracking_milestones m WHERE m.organization_id=? AND m.order_id=? AND m.milestone_code='exported')
      ) outbound_at,
      (SELECT MAX(op.actual_arrival_at) FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status!='cancelled') overseas_arrival_at,
      (SELECT MAX(op.pickup_at) FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status='picked_up') pickup_completed_at,
      CASE WHEN EXISTS(SELECT 1 FROM overseas_warehouse_operations op WHERE op.organization_id=? AND op.order_id=? AND op.status='picked_up')
        OR EXISTS(SELECT 1 FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed' AND b.road_status='pickup_completed')
        OR EXISTS(SELECT 1 FROM shipments s WHERE s.organization_id=? AND s.order_id=? AND s.status='delivered') THEN 1 ELSE 0 END pickup_complete`)
      .bind(organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId)
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
      ((SELECT COUNT(*) FROM warehouse_exceptions x JOIN shipments s ON s.id=x.shipment_id
        WHERE x.organization_id=? AND s.order_id=? AND x.status IN ('open','processing'))
       +
       (SELECT COUNT(*) FROM transport_batch_exceptions x
        WHERE x.organization_id=? AND x.status IN ('open','processing') AND x.blocks_progress=1 AND (
          x.order_id=? OR (x.scope='batch' AND EXISTS(
            SELECT 1 FROM transport_batch_orders bo
            WHERE bo.organization_id=x.organization_id AND bo.batch_id=x.batch_id
              AND bo.order_id=? AND bo.status!='removed'
          ))
        ))) open_exception_count`)
      .bind(organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,organizationId,orderId,orderId)
      .first<{cargo_difference_count:number;max_difference:number;pending_difference_count:number;open_exception_count:number}>(),
    db.prepare(`SELECT f.field_key,f.label,f.is_active,f.is_required
      FROM transport_orders o
      JOIN workflow_instance_fields f ON f.instance_id=o.workflow_instance_id
      WHERE o.organization_id=? AND o.id=?
        AND f.module_code='costs'
      ORDER BY f.sort_order,f.field_key`)
      .bind(organizationId,orderId)
      .all<{field_key:string;label:string;is_active:number;is_required:number}>(),
    db.prepare(`SELECT f.field_key,f.label,f.is_active,f.is_required
      FROM transport_orders o
      JOIN workflow_instance_fields f ON f.instance_id=o.workflow_instance_id
      WHERE o.organization_id=? AND o.id=?
        AND f.module_code='overseas_warehouse'
      ORDER BY f.sort_order,f.field_key`)
      .bind(organizationId,orderId)
      .all<{field_key:string;label:string;is_active:number;is_required:number}>(),
    loadConfiguredReviewModuleState(db,organizationId,orderId,"costs"),
    loadConfiguredReviewModuleState(db,organizationId,orderId,"overseas_warehouse"),
    loadConfiguredReviewModuleState(db,organizationId,orderId,"warehouse"),
    loadConfiguredReviewModuleState(db,organizationId,orderId,"exceptions"),
  ]);
  const [people] = await Promise.all([
    db.prepare(`SELECT
      (SELECT u.display_name FROM order_module_instances m JOIN users u ON u.id=m.assignee_user_id WHERE m.organization_id=? AND m.order_id=? AND m.module_code='transport') main_operator,
      (SELECT u.display_name FROM settlement_cash_allocations a JOIN business_expenses e ON e.id=a.expense_id JOIN settlement_cash_transactions t ON t.id=a.cash_transaction_id LEFT JOIN users u ON u.id=t.handled_by_user_id WHERE e.organization_id=? AND e.order_id=? AND t.status!='void' ORDER BY a.created_at DESC LIMIT 1) finance_handler`)
      .bind(organizationId,orderId,organizationId,orderId).first<{main_operator:string|null;finance_handler:string|null}>(),
  ]);
  if (!order) throw new Error("订单不存在");
  const finance=financeRows.results.map(row=>currencyFinance(row));
  const hasReceivable=financeRows.results.some(row=>row.receivable_count>0);
  const hasPayable=financeRows.results.some(row=>row.payable_count>0);
  const blockers:ReviewBlocker[]=[];
  const pickupComplete = Boolean(timing?.pickup_complete);
  const pickupFields = pickupWorkflowFields.results.map((field) => ({
    fieldKey: field.field_key,
    label: field.label,
    isActive: field.is_active === 1,
    isRequired: field.is_required === 1,
  }));
  const pickupReviewState = {
    module: pickupModule ? {
      enabled: pickupModule.enabled === 1,
      isRequired: pickupModule.is_required === 1,
    } : null,
    fields: pickupFields,
    pickupComplete,
  };
  const pickupRequired = pickupCompletionRequired(pickupReviewState);
  const pickupBlocker = pickupCompletionReviewBlocker(pickupReviewState);
  if (pickupBlocker) blockers.push({
    code: pickupBlocker.code,
    message: pickupBlocker.message,
    href: `/admin/orders/${orderId}/modules/overseas_warehouse#module-business-data`,
  });
  const settlementBlockers = orderReviewSettlementBlockers({
      fields: settlementWorkflowFields.results.map((field) => ({
        fieldKey: field.field_key,
        label: field.label,
        isActive: field.is_active === 1,
        isRequired: field.is_required === 1,
      })),
      hasReceivable,
      hasPayable,
      controls: controls.results
        .filter((row) => ["receivable", "payable"].includes(row.direction))
        .map((row) => ({
          direction: row.direction as "receivable" | "payable",
          confirmed: row.confirmed === 1,
          businessReviewed: row.business_reviewed === 1,
          financeReviewed: row.finance_reviewed === 1,
        })),
      finance,
    });
  const configuredCostsBlocker = costsModuleReviewBlocker(costsModule ? {
    enabled: costsModule.enabled === 1,
    isRequired: costsModule.is_required === 1,
    status: costsModule.status,
    blockingReason: costsModule.blocking_reason,
  } : null);
  if (configuredCostsBlocker) {
    blockers.push({
      code: configuredCostsBlocker.code,
      message: configuredCostsBlocker.message,
      href: `/admin/orders/${orderId}/modules/costs#module-business-data`,
    });
  }
  const applicableSettlementBlockers = costsModule
    ? costsModule.enabled === 1 && costsModule.is_required === 1
      ? settlementBlockers.filter((blocker) => blocker.area === "billing")
      : []
    : settlementBlockers;
  blockers.push(
    ...applicableSettlementBlockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      href: blocker.area === "billing"
        ? "/admin/billing"
        : `/admin/orders/${orderId}/modules/costs#module-business-data`,
    })),
  );
  if (
    (exceptionRow?.pending_difference_count ?? 0) > 0 &&
    configuredModuleRequiresCompletion(warehouseModule ? {
      enabled: warehouseModule.enabled === 1,
      isRequired: warehouseModule.is_required === 1,
    } : null)
  ) blockers.push({code:"cargo_difference",message:"仓库实收差异或费用影响尚未确认",href:`/admin/orders/${orderId}/modules/warehouse#module-business-data`});
  if (
    (exceptionRow?.open_exception_count ?? 0) > 0 &&
    configuredModuleRequiresCompletion(exceptionsModule ? {
      enabled: exceptionsModule.enabled === 1,
      isRequired: exceptionsModule.is_required === 1,
    } : null)
  ) blockers.push({code:"open_exception",message:"仍有未关闭的仓库异常",href:`/admin/orders/${orderId}/modules/exceptions#module-business-data`});
  const dispute=manual?.customerDisputeSummary ?? snapshot?.customer_dispute_summary ?? null;
  const pickupCompletedAt=timing?.pickup_completed_at??null;
  const delayDays=order.requested_delivery_date&&pickupCompletedAt
    ? Math.max(0,Math.ceil((new Date(pickupCompletedAt).getTime()-new Date(order.requested_delivery_date).getTime())/86400000)) : 0;
  const completionStatus=orderCompletionStatus({pickupComplete,pickupRequired,blockers:blockers.map(x=>x.message),reviewGenerated:Boolean(snapshot),finance});
  return {
    snapshotId:snapshot?.id??null,revision:snapshot?.revision??0,generatedAt:snapshot?.generated_at??null,generatedBy:snapshot?.generated_by??null,
    completionStatus,completionLabel:completionStatusLabels[completionStatus],
    timing:{orderAt:order.order_date||order.created_at,pickupAt:timing?.pickup_at??null,inboundAt:actual?.inbound_at??null,loadingAt:loaded?.loading_at??null,outboundAt:timing?.outbound_at??null,overseasArrivalAt:timing?.overseas_arrival_at??null,pickupCompletedAt},
    cargo:{plannedPieces:cargo?.pieces??0,plannedWeightKg:cargo?.weight??0,plannedVolumeCbm:cargo?.volume??0,actualPieces:actual?.pieces??0,actualWeightKg:actual?.weight??0,actualVolumeCbm:actual?.volume??0,loadedPieces:loaded?.pieces??0,loadedWeightKg:loaded?.weight??0,loadedVolumeCbm:loaded?.volume??0},
    finance,
    exceptions:{cargoDifferenceCount:exceptionRow?.cargo_difference_count??0,maxCargoDifferencePercent:exceptionRow?.max_difference??0,openWarehouseExceptionCount:exceptionRow?.open_exception_count??0,delayDays,costAdjustmentCount:financeRows.results.reduce((s,r)=>s+r.adjustment_count,0),customerDisputeSummary:dispute},
    people:{salesperson:order.salesperson||order.creator,mainOperator:people?.main_operator??null,warehouseHandler:actual?.warehouse_handler??null,financeHandler:people?.finance_handler??null},
    blockers,pickupComplete,pickupRequired,customerDisputeSummary:dispute,
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
