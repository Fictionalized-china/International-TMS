import { env } from "cloudflare:workers";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/admin.loading-detail";
import { OrderNumberLink } from "../components/EntityNumberLink";
import { OrganizationAssigneePicker } from "../components/OrganizationAssigneePicker";
import type { OrganizationAssigneeMember } from "../lib/organization-assignee";
import { isActiveOrganizationAssigneeForPositions } from "../lib/organization-assignee.server";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { synchronizeOrderDocumentsModuleStatus } from "../lib/documents-module-status.server";
import { valueOf } from "../lib/validation";
import { checkOrderDeparture, checkOrderPreDepartureDocuments } from "../lib/order-readiness.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import { roadStatusLabels } from "../lib/warehouse-actual";
import { allocationMethodLabel, type AllocationMethod } from "../lib/cost-allocation";
import { confirmCostAllocation, createCostAllocation, loadCostAllocations, updateCostAllocation, type AssertCostAllocationCanMutate } from "../lib/cost-allocation.server";
import { canAccessSettlementWorkbench } from "../lib/billing-access";
import { loadBatchCostAllocationActionPolicy } from "../lib/batch-cost-allocation-action-policy.server";
import type { BatchCostAllocationActionPolicy } from "../lib/batch-cost-allocation-action-policy";
import { canManageOrderModule } from "../lib/position-portal";
import { maxInlineOrderDocumentBytes, orderDocumentTypeCodes, orderDocumentTypeLabel } from "../lib/order-documents";
import { loadOrderDocumentWorkflowMutationAccess } from "../lib/order-document-access.server";
import { batchCostsManageScopeSql, batchVisibilitySql, canAccessBatchWorkspace } from "../lib/order-access.server";
import {
  loadingOrderDocumentDefinitions,
  summarizeLoadingDocumentRequirements,
  type LoadingOrderDocumentCode,
  type OrderLoadingDocumentRequirements,
} from "../lib/loading-document-requirements";
import { loadOrderLoadingDocumentRequirements } from "../lib/loading-document-requirements.server";
import {
  batchOrderCustomsReleaseActionAvailable,
  type BatchOrderCustomsAccess,
} from "../lib/loading-batch-customs-access";
import { loadBatchCustomsAccess } from "../lib/loading-batch-customs-access.server";
import { syncCustomsModuleFromRecords } from "../lib/customs-status.server";
import {
  BATCH_TRACKING_MILESTONES,
  BATCH_TRACKING_OPTIONAL_CODES,
  BATCH_TRACKING_REQUIRED_PREVIOUS,
  missingBatchTrackingPrerequisites,
} from "../lib/batch-tracking.shared";
import {
  getBatchOrderIds,
  getBatchMainVehiclePlate,
  validateBatchTrackingRequiredPrevious,
  syncTrackingModuleStatusForOrder,
  syncBatchRoadStatusFromTracking,
} from "../lib/batch-tracking.server";
import type { BatchTrackingActionPolicy } from "../lib/batch-tracking-action-policy";
import { loadBatchTrackingActionPolicy } from "../lib/batch-tracking-action-policy.server";
import { Modal, useModalScrollLock } from "../components/Modal";
import { QueryPagination } from "../components/QueryPagination";
import { paginateList, readListPage } from "../lib/list-pagination";
import {
  buildBatchOverseasInboundHref,
  resolveBatchOverseasInboundHandoff,
} from "../lib/batch-overseas-inbound-navigation";
import {
  createBatchException,
  listBatchExceptionPackages,
  listBatchExceptions,
  listBlockingBatchExceptions,
  progressBatchException,
  resolveBatchException,
  type BatchException,
  type BatchExceptionPackage,
} from "../lib/batch-exceptions.server";
import {
  assignedBatchNotificationStatement,
  broadcastInternalNotification,
  warehouseBatchReadyNotificationStatement,
} from "../lib/internal-notifications.server";
import { isActiveExceptionStatus } from "../lib/batch-exception-policy";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";
import {
  BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS,
  BATCH_RESPONSIBILITY_POSITION_CODES,
  batchInitialResponsibilityDisabledReasons,
  batchResponsibilityPermissionDisabledReasons,
  batchRequiresSupervisorApproval,
  batchSharedResponsibilityIsActive,
  buildConfiguredBatchResponsibilityTargets,
  canOrdinaryReassignBatchResponsibility,
  buildBatchInitialResponsibilityRestrictions,
  findBatchInitialResponsibilityConflict,
  type BatchResponsibilityTransferTarget,
} from "../lib/batch-responsibility";
import {
  batchInitialResponsibilityAssignmentGuard,
  loadBatchInitialResponsibilityRestrictions,
} from "../lib/batch-responsibility.server";
import {
  loadOrderAssignmentManifest,
} from "../lib/order-assignment-manifest.server";
import {
  batchWorkflowFieldPolicy,
  batchWorkflowModulePolicy,
  orderBatchWorkflowPolicy,
  orderWorkflowFieldBlocksBatch,
  validateBatchWorkflowFormSubmission,
  type BatchOrderWorkflowPolicy,
  type BatchWorkflowFormBinding,
  type BatchWorkflowModuleCode,
} from "../lib/batch-workflow-policy";
import { workflowFieldCatalog, workflowFieldModeFlags } from "../lib/workflow-field-catalog";
import { runtimeWorkflowFieldPolicy } from "../lib/workflow-field-runtime";
import {
  resolveCustomsDeclarationWorkflowInput,
} from "../lib/customs-declaration-workflow";
import { loadExistingCustomsDeclarationForMutation } from "../lib/customs-declaration-store.server";

const WAREHOUSE_OWNED_BATCH_INTENTS = new Set([
  "arrangement",
  "vehicle",
  "generate_manifest",
  "batch_document_upload",
  "batch_document_review",
  "overseas_arrival",
]);

let orderModulesImportPromise:
  | Promise<typeof import("../lib/order-modules.server")>
  | null = null;

async function ensureOrderModulesModule() {
  if (!orderModulesImportPromise) {
    orderModulesImportPromise = import("../lib/order-modules.server");
  }
  return orderModulesImportPromise;
}

async function syncOrderWorkflowSnapshotSafe(organizationId: string, orderId: string) {
  const modules = await ensureOrderModulesModule();
  await modules.syncOrderWorkflowSnapshot(organizationId, orderId);
}

async function syncCostModuleStatusSafe(organizationId: string, orderId: string, now: string) {
  const modules = await ensureOrderModulesModule();
  await modules.syncCostsModuleStatus(organizationId, orderId, now);
}

async function loadBatchResponsibilityTransferTargets(input: {
  organizationId: string;
  orderIds: readonly string[];
  operationAssigneeUserId: string;
  documentAssigneeUserId: string;
}) {
  const targets: BatchResponsibilityTransferTarget[] = [];
  // D1 queries are kept sequential. A PZ can mount many orders, and issuing
  // every snapshot read concurrently can exhaust a production Worker's D1
  // connection budget.
  for (const orderId of input.orderIds) {
    const manifest = await loadOrderAssignmentManifest(input.organizationId, orderId);
    targets.push(...buildConfiguredBatchResponsibilityTargets({
      orderId,
      manifest,
      operationAssigneeUserId: input.operationAssigneeUserId,
      documentAssigneeUserId: input.documentAssigneeUserId,
    }));
  }
  for (const [kind, positionCode] of Object.entries(BATCH_RESPONSIBILITY_POSITION_CODES)) {
    if (!targets.some((target) => target.positionCode === positionCode)) {
      throw new Error(
        `挂载订单冻结工作流中没有未完成的${kind === "operation" ? "操作" : "单证"}职责（${positionCode}）`,
      );
    }
  }
  return targets;
}

function responsibilityRevisionGuard() {
  return `EXISTS(
    SELECT 1 FROM transport_batches responsibility_guard
    WHERE responsibility_guard.id=? AND responsibility_guard.organization_id=?
      AND responsibility_guard.responsibility_revision=?
      AND responsibility_guard.operation_assignee_user_id=?
      AND responsibility_guard.document_assignee_user_id=?
  )`;
}

function uniqueTargetModuleCodes(targets: readonly BatchResponsibilityTransferTarget[]) {
  return [...new Set(targets.flatMap((target) => target.moduleCodes))];
}

async function assignBatchResponsibilities(input:{
  organizationId:string;
  batchId:string;
  batchNumber:string;
  operationAssigneeUserId:string;
  documentAssigneeUserId:string;
  actorUserId:string;
  now:string;
  mode:"approve"|"reassign";
  previousOperationAssigneeUserId?:string|null;
  previousDocumentAssigneeUserId?:string|null;
  allowAfterDeparture?:boolean;
  targets:readonly BatchResponsibilityTransferTarget[];
}) {
  const revision=crypto.randomUUID();
  const initialResponsibilityGuard=input.mode==="approve"
    ? batchInitialResponsibilityAssignmentGuard({
        operationAssigneeUserId:input.operationAssigneeUserId,
        documentAssigneeUserId:input.documentAssigneeUserId,
      })
    : null;
  const assignmentUpdate=input.mode==="approve"
    ? env.DB.prepare(`UPDATE transport_batches
        SET approval_status='approved',operation_assignee_user_id=?,document_assignee_user_id=?,
            approved_by_user_id=?,approved_at=?,approval_notes=NULL,responsibility_revision=?,updated_at=?
        WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND approval_status='submitted'
          AND ${initialResponsibilityGuard!.sql}`)
      .bind(input.operationAssigneeUserId,input.documentAssigneeUserId,input.actorUserId,input.now,revision,input.now,input.batchId,input.organizationId,...initialResponsibilityGuard!.values)
    : env.DB.prepare(`UPDATE transport_batches
        SET operation_assignee_user_id=?,document_assignee_user_id=?,responsibility_revision=?,updated_at=?
        WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND approval_status='approved'
          AND operation_assignee_user_id IS ? AND document_assignee_user_id IS ?
          AND (?=1 OR (
            actual_departure_at IS NULL
            AND road_status NOT IN ('outbound_in_transit','overseas_arrived','waiting_pickup','pickup_completed')
          ))`)
      .bind(input.operationAssigneeUserId,input.documentAssigneeUserId,revision,input.now,input.batchId,input.organizationId,input.previousOperationAssigneeUserId??null,input.previousDocumentAssigneeUserId??null,input.allowAfterDeparture?1:0);
  const guard=responsibilityRevisionGuard();
  const guardValues=[input.batchId,input.organizationId,revision,input.operationAssigneeUserId,input.documentAssigneeUserId];
  const taskStateStatements:D1PreparedStatement[]=[];
  const moduleOwnerStatements:D1PreparedStatement[]=[];
  const cancelStatements:D1PreparedStatement[]=[];
  const historyStatements:D1PreparedStatement[]=[];
  const insertStatements:D1PreparedStatement[]=[];
  const orderIds=[...new Set(input.targets.map(target=>target.orderId))];
  for(const orderId of orderIds){
    const orderTargets=input.targets.filter(target=>target.orderId===orderId);
    for(const target of orderTargets){
      for(const taskStateIds of chunkD1Values(target.taskStateIds,10)){
        taskStateStatements.push(env.DB.prepare(`UPDATE workflow_instance_task_states
          SET assignee_user_id=?,updated_at=?
          WHERE id IN (${d1Placeholders(taskStateIds.length)})
            AND status NOT IN ('completed','not_applicable')
            AND instance_module_state_id IN(
              SELECT ms.id FROM workflow_instance_module_states ms
              JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
              JOIN workflow_instances wi ON wi.id=ss.instance_id
              WHERE wi.id=? AND wi.organization_id=? AND wi.order_id=?
            ) AND ${guard}`)
          .bind(target.assigneeUserId,input.now,...taskStateIds,target.workflowInstanceId,input.organizationId,orderId,...guardValues));
      }
      for(const moduleCodes of chunkD1Values(target.primaryModuleCodes,12)){
        moduleOwnerStatements.push(env.DB.prepare(`UPDATE order_module_instances
          SET assignee_user_id=?,blocking_reason=NULL,updated_at=?
          WHERE organization_id=? AND order_id=?
            AND module_code IN (${d1Placeholders(moduleCodes.length)})
            AND status NOT IN ('completed','not_applicable')
            AND EXISTS(
              SELECT 1 FROM workflow_instance_module_states ms
              JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
              JOIN workflow_instances wi ON wi.id=ss.instance_id
              WHERE wi.id=? AND wi.organization_id=? AND wi.order_id=?
                AND ms.module_code=order_module_instances.module_code
                AND ms.status NOT IN ('completed','not_applicable')
            ) AND ${guard}`)
          .bind(target.assigneeUserId,input.now,input.organizationId,orderId,...moduleCodes,target.workflowInstanceId,input.organizationId,orderId,...guardValues));
      }
      for(const moduleCodes of chunkD1Values(target.moduleCodes,12)){
        insertStatements.push(env.DB.prepare(`INSERT INTO order_tasks(
            id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,
            assigned_by_user_id,due_at,created_at,updated_at
          )
          SELECT lower(hex(randomblob(16))),m.organization_id,m.order_id,m.module_code,'module_owner',
            m.module_name||?,'pending',?,?,NULL,?,?
          FROM order_module_instances m
          WHERE m.organization_id=? AND m.order_id=?
            AND m.module_code IN (${d1Placeholders(moduleCodes.length)})
            AND m.status NOT IN ('completed','not_applicable')
            AND ${guard}`)
          .bind(`处理任务（${target.positionCode}）`,target.assigneeUserId,input.actorUserId,input.now,input.now,input.organizationId,orderId,...moduleCodes,...guardValues));
      }
    }
    const moduleCodes=uniqueTargetModuleCodes(orderTargets);
    for(const moduleCodeChunk of chunkD1Values(moduleCodes,8)){
      cancelStatements.push(env.DB.prepare(`UPDATE order_tasks SET status='cancelled',updated_at=?
        WHERE organization_id=? AND order_id=? AND task_type='module_owner'
          AND status IN ('pending','in_progress')
          AND module_code IN (${d1Placeholders(moduleCodeChunk.length)})
          AND ${guard}`)
        .bind(input.now,input.organizationId,orderId,...moduleCodeChunk,...guardValues));
      historyStatements.push(env.DB.prepare(`INSERT INTO order_module_history(
          id,organization_id,order_id,module_instance_id,action_code,action_name,
          from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at
        )
        SELECT lower(hex(randomblob(16))),m.organization_id,m.order_id,m.id,'assign',
          ?,m.current_step_code,m.current_step_code,m.current_step_name,?,?,?
        FROM order_module_instances m
        WHERE m.organization_id=? AND m.order_id=?
          AND m.module_code IN (${d1Placeholders(moduleCodeChunk.length)})
          AND m.status NOT IN ('completed','not_applicable')
          AND ${guard}`)
        .bind(input.mode==="approve"?"配载单统一分配":"配载单负责人变更",input.actorUserId,`${input.batchNumber}：操作与单证职责按冻结工作流配置统一交接`,input.now,input.organizationId,orderId,...moduleCodeChunk,...guardValues));
    }
  }
  const results=await env.DB.batch([
    assignmentUpdate,
    ...taskStateStatements,
    ...moduleOwnerStatements,
    ...cancelStatements,
    ...historyStatements,
    ...insertStatements,
  ]);
  return Number(results[0]?.meta?.changes||0)>0;
}

type Batch={id:string;batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;actual_departure_at:string|null;status:string;road_status:string;carrier_id:string|null;warehouse_id:string|null;carrier_name:string|null;warehouse_name:string|null;border_port:string|null;customs_location:string|null;transit_location:string|null;route_notes:string|null;notes:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null;approval_status:string;operation_supervisor_user_id:string|null;operation_assignee_user_id:string|null;document_assignee_user_id:string|null;responsibility_revision:string|null;submitted_at:string|null;approved_at:string|null;operation_supervisor_name:string|null;operation_assignee_name:string|null;document_assignee_name:string|null};

type BatchWorkflowPolicyRow={
  order_id:string;
  business_type:string;
  bound_workflow_instance_id:string|null;
  matched_workflow_instance_id:string|null;
  module_code:BatchWorkflowModuleCode;
  enabled:number;
  module_required:number;
  field_key:string|null;
  label:string|null;
  is_active:number|null;
  field_required:number|null;
};

const ftlBatchHiddenLoadingFields=new Set([
  "business_type","loading_batch","consolidation_warehouse","cost_allocation",
  "vehicle_capacity_weight","vehicle_capacity_volume",
]);

async function loadBatchOrderWorkflowPolicies(
  organizationId:string,
  batchId:string,
):Promise<BatchOrderWorkflowPolicy[]> {
  const rows=await env.DB.prepare(`WITH batch_orders AS (
      SELECT bo.order_id,o.business_type,
        o.workflow_instance_id bound_workflow_instance_id,
        wi.id matched_workflow_instance_id,wi.workflow_id
      FROM transport_batch_orders bo
      JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      LEFT JOIN workflow_instances wi ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id AND wi.order_id=o.id
      WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
    ), module_codes(module_code) AS (
      VALUES ('loading'),('tracking'),('customs')
    ), modules AS (
      SELECT bo.order_id,bo.business_type,bo.bound_workflow_instance_id,
        bo.matched_workflow_instance_id,bo.workflow_id,c.module_code,
        COALESCE(mi.enabled,0) enabled,COALESCE(mi.is_required,0) module_required
      FROM batch_orders bo CROSS JOIN module_codes c
      LEFT JOIN order_module_instances mi
        ON mi.organization_id=? AND mi.order_id=bo.order_id AND mi.module_code=c.module_code
    ), snapshot_fields AS (
      SELECT m.order_id,m.business_type,m.bound_workflow_instance_id,
        m.matched_workflow_instance_id,m.module_code,m.enabled,m.module_required,
        f.field_key,f.label,f.is_active,f.is_required field_required
      FROM modules m
      LEFT JOIN workflow_instance_fields f
        ON f.instance_id=m.matched_workflow_instance_id AND f.module_code=m.module_code
    ), live_fields AS (
      SELECT m.order_id,m.business_type,m.bound_workflow_instance_id,
        m.matched_workflow_instance_id,m.module_code,m.enabled,m.module_required,
        f.field_key,f.label,f.is_active,f.is_required field_required
      FROM modules m
      JOIN workflow_step_fields f
        ON f.workflow_id=m.workflow_id AND COALESCE(f.module_code,'consignment')=m.module_code
      WHERE m.bound_workflow_instance_id IS NULL
        AND NOT EXISTS(
        SELECT 1 FROM workflow_instance_fields snapshot
        WHERE snapshot.instance_id=m.matched_workflow_instance_id AND snapshot.module_code=m.module_code
      )
    )
    SELECT * FROM snapshot_fields
    UNION ALL
    SELECT * FROM live_fields
    ORDER BY order_id,module_code,field_key`).bind(
      organizationId,batchId,organizationId,
    ).all<BatchWorkflowPolicyRow>();
  const invalidBinding=rows.results.find(row=>
    row.bound_workflow_instance_id!==null&&row.matched_workflow_instance_id===null);
  if(invalidBinding){
    throw new Error(`订单 ${invalidBinding.order_id} 的工作流实例绑定异常，不能办理配载单`);
  }
  const policies=new Map<string,BatchOrderWorkflowPolicy>();
  const configuredPolicies=new Set<string>();
  for(const row of rows.results){
    const identity=`${row.order_id}:${row.module_code}`;
    const current=policies.get(identity)??{
      orderId:row.order_id,businessType:row.business_type,moduleCode:row.module_code,
      enabled:row.enabled===1,required:row.enabled===1&&row.module_required===1,fields:[],
    };
    if(row.bound_workflow_instance_id!==null||row.field_key){
      configuredPolicies.add(identity);
    }
    if(row.field_key&&!(row.business_type==="ftl"&&row.module_code==="loading"&&ftlBatchHiddenLoadingFields.has(row.field_key))){
      current.fields.push({
        fieldKey:row.field_key,label:row.label??undefined,
        isActive:row.is_active===1,isRequired:row.is_active===1&&row.field_required===1,
      });
    }
    policies.set(identity,current);
  }
  for(const policy of policies.values()){
    // A populated instance/template field set is authoritative. Missing keys
    // stay hidden; catalog defaults are only a legacy fallback for old orders
    // that have no field configuration at all.
    if(configuredPolicies.has(`${policy.orderId}:${policy.moduleCode}`))continue;
    const existing=new Set(policy.fields.map(field=>field.fieldKey));
    for(const item of workflowFieldCatalog){
      if(item.moduleCode!==policy.moduleCode||existing.has(item.fieldKey))continue;
      if(policy.businessType==="ftl"&&policy.moduleCode==="loading"&&ftlBatchHiddenLoadingFields.has(item.fieldKey))continue;
      const flags=workflowFieldModeFlags(item.defaultMode);
      policy.fields.push({
        fieldKey:item.fieldKey,label:item.label,
        isActive:Boolean(flags.isActive),isRequired:Boolean(flags.isActive&&flags.isRequired),
      });
    }
  }
  return [...policies.values()];
}

type BatchTrackingPolicyOrder = { order_id: string; order_number: string };

function batchTrackingPolicyOrders(orders: readonly BatchTrackingPolicyOrder[]) {
  return orders.map((order) => ({
    orderId: order.order_id,
    orderNumber: order.order_number,
  }));
}

async function loadFreshBatchTrackingAction(
  organizationId: string,
  batchId: string,
  fieldKey: "tracking_milestone" | "actual_exit_at",
): Promise<BatchTrackingActionPolicy> {
  const orders = await env.DB.prepare(
    `SELECT bo.order_id,o.order_number
     FROM transport_batch_orders bo
     JOIN transport_orders o
       ON o.id=bo.order_id AND o.organization_id=bo.organization_id
     WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
     ORDER BY bo.sequence_no,bo.order_id`,
  ).bind(organizationId, batchId).all<BatchTrackingPolicyOrder>();
  const loaded = await loadBatchTrackingActionPolicy({
    db: env.DB,
    organizationId,
    orders: batchTrackingPolicyOrders(orders.results),
    fieldKey,
  });
  return loaded.batch;
}
type BatchOrder={order_id:string;order_number:string;business_type:string|null;work_number:string;customer_name:string;cargo_description:string|null;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number;declared_weight_kg:number;declared_volume_cbm:number;inbound_at:string|null;dispatched_packages:number;in_stock_packages:number;overseas_warehouse_id:string|null;overseas_warehouse_name:string|null;overseas_status:string|null;overseas_arrival_at:string|null;document_assignee_user_id:string|null;customs_assignee_user_id:string|null};
type BatchCargoItem={id:string;order_id:string;line_no:number;cargo_name_cn:string;cargo_name_en:string|null;hs_code:string|null;overseas_hs_code:string|null;package_type:string;package_count:number;pieces_per_package:number;gross_weight_per_package_kg:number;length_cm:number;width_cm:number;height_cm:number;volume_per_package_cbm:number;declared_value:number;currency:string;brand_model:string|null;marks:string|null;special_attributes:string|null};
type BatchOrderPagination={page:number;pageCount:number;pageSize:number;total:number};
type Vehicle={id:string;vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number;capacity_volume_cbm:number;used_weight:number;used_volume:number;loaded_orders:number;status:string};
type Option={id:string;name:string};
type ReferenceOption={code:string;name:string};
type BatchDocument={id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;description:string|null;review_status:string;created_at:string};
type OrderDocument={id:string;order_id:string;document_category:string;file_name:string;content_type:string;size_bytes:number;description:string|null;review_status:string;created_at:string};
type CustomsSummary={order_id:string;total:number;released:number};
type BatchCustomsDeclaration={id:string;order_id:string;customs_record_id:string;clearance_stage:string;declaration_number:string;declaration_type:string;declaration_title:string;declaring_company:string;declared_at:string;declared_amount:number;currency:string;gross_weight_kg:number;released_at:string|null;status:string;is_deleted:number;is_redeclared:number;is_amended:number;is_inspected:number;change_reason:string|null;updated_at:string};
type BatchOutboundStatus={order_id:string;dispatched:number};
type DepartureGateStatus={order_id:string;ready:boolean;reasons:string[]};
type BatchTrackingMilestone={id:string;order_id:string;milestone_code:string;milestone_name:string;event_at:string;location:string|null;vehicle_reference:string|null;notes:string|null;visible_to_customer:number;created_at:string};
type BatchTrackingFlag={order_id:string;requires_transloading:number;requires_transit_customs:number};
type CarrierVehicleOption={id:string;carrier_id:string;plate_number:string;vehicle_type:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null;carrier_name:string};
type CarrierDriverOption={id:string;carrier_id:string;name:string;phone:string|null;carrier_name:string};
type ManifestOrderRow={order_id:string;order_number:string;work_number:string;customer_name:string;cargo_names:string|null;pieces:number;gross_weight_kg:number;volume_cbm:number};
type ManifestVehicleRow={vehicle_no:string;vehicle_type:string|null;plate_number:string|null;driver_name:string|null;driver_phone:string|null;capacity_weight_kg:number|null;capacity_volume_cbm:number|null};
type ManifestBatchRow={batch_number:string;batch_name:string;origin_location:string;destination_location:string;planned_departure_at:string|null;planned_arrival_at:string|null;border_port:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null;carrier_name:string|null};

const trackingFormBindings:BatchWorkflowFormBinding[]=[
  {moduleCode:"tracking",fieldKey:"tracking_milestone",formNames:["milestoneCode"],label:"运输节点",fallbackRequired:true},
  {moduleCode:"tracking",fieldKey:"tracking_event_at",formNames:["eventAt"],label:"节点发生时间",fallbackRequired:true},
  {moduleCode:"tracking",fieldKey:"tracking_location",formNames:["location"],label:"运踪地点",fallbackRequired:true},
  {moduleCode:"tracking",fieldKey:"tracking_vehicle",formNames:["vehicleReference"],label:"当前车辆/车牌"},
  {moduleCode:"tracking",fieldKey:"tracking_notes",formNames:["notes"],label:"运踪说明"},
  {moduleCode:"tracking",fieldKey:"visible_to_customer",formNames:["visibleToCustomer"],label:"客户可见",fallbackRequired:true},
];

const exitFormBindings:BatchWorkflowFormBinding[]=[
  {moduleCode:"tracking",fieldKey:"actual_exit_at",formNames:["actualExitAt"],label:"实际出境时间",fallbackRequired:true},
  {moduleCode:"loading",fieldKey:"exit_port",formNames:["exitPort"],label:"实际出境口岸",fallbackRequired:true},
  {moduleCode:"loading",fieldKey:"main_plate_number",formNames:["exitVehiclePlate"],label:"实际出境车辆车牌",fallbackRequired:true},
  {moduleCode:"tracking",fieldKey:"tracking_notes",formNames:["exitNotes","proofReference"],label:"出境备注"},
];

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);
}

function buildLoadingManifestHtml(batch: ManifestBatchRow, orders: ManifestOrderRow[], vehicles: ManifestVehicleRow[], generatedAt: string) {
  const totalPieces = orders.reduce((sum, item) => sum + item.pieces, 0);
  const totalWeight = orders.reduce((sum, item) => sum + item.gross_weight_kg, 0);
  const totalVolume = orders.reduce((sum, item) => sum + item.volume_cbm, 0);
  const rows = orders.map((item) => `<tr><td>${escapeHtml(item.order_number)}</td><td>${escapeHtml(item.work_number)}</td><td>${escapeHtml(item.customer_name)}</td><td>${escapeHtml(item.cargo_names || "未填写")}</td><td class="num">${item.pieces}</td><td class="num">${item.gross_weight_kg.toFixed(2)}</td><td class="num">${item.volume_cbm.toFixed(3)}</td><td>${escapeHtml(batch.overseas_vehicle_plate || "待安排")}</td></tr>`).join("");
  const vehicleRows = vehicles.map((item) => `<tr><td>${escapeHtml(item.vehicle_no)}</td><td>${escapeHtml(item.vehicle_type || "—")}</td><td>${escapeHtml(item.plate_number || "—")}</td><td>${escapeHtml(item.driver_name || "—")}</td><td>${escapeHtml(item.driver_phone || "—")}</td><td class="num">${item.capacity_weight_kg ? `${item.capacity_weight_kg} KG` : "不限"}</td><td class="num">${item.capacity_volume_cbm ? `${item.capacity_volume_cbm} CBM` : "不限"}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>配载单 ${escapeHtml(batch.batch_number)}</title><style>
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;color:#111;margin:24px;font-size:12px}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px}
  .meta{display:flex;flex-wrap:wrap;gap:4px 24px;margin:8px 0;color:#333}
  .meta b{margin-right:4px;color:#555}
  table{width:100%;border-collapse:collapse;margin:6px 0}
  th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
  th{background:#eee}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:bold;background:#f7f7f7}
  .footer{margin-top:18px;display:flex;justify-content:space-between;color:#555}
  .sign{margin-top:26px;display:flex;gap:48px}.sign div{flex:1;border-top:1px solid #333;padding-top:6px}
  @media print{body{margin:8mm}}
</style></head><body>
<h1>配载单 ${escapeHtml(batch.batch_number)}</h1>
<div class="meta"><span>${escapeHtml(batch.batch_name)}</span></div>
<div class="meta"><span><b>线路</b>${escapeHtml(batch.origin_location)} → ${escapeHtml(batch.destination_location)}</span><span><b>承运商</b>${escapeHtml(batch.carrier_name || "待定")}</span><span><b>出境口岸</b>${escapeHtml(batch.border_port || "待定")}</span><span><b>计划发车</b>${escapeHtml(batch.planned_departure_at?.slice(0, 16).replace("T", " ") || "待定")}</span><span><b>计划到达</b>${escapeHtml(batch.planned_arrival_at?.slice(0, 16).replace("T", " ") || "待定")}</span></div>
<h2>境外运输资源</h2>
<div class="meta"><span><b>境外承运方</b>${escapeHtml(batch.overseas_carrier_name || "待定")}</span><span><b>车型/数量</b>${escapeHtml(batch.overseas_vehicle_type || "待定")} × ${batch.overseas_vehicle_count || 1}</span><span><b>车牌</b>${escapeHtml(batch.overseas_vehicle_plate || "待定")}</span><span><b>司机</b>${escapeHtml(batch.overseas_driver_name || "待定")} ${escapeHtml(batch.overseas_driver_phone || "")}</span></div>
<h2>装载车辆（${vehicles.length} 车）</h2>
<table><thead><tr><th>序号</th><th>车型</th><th>车牌号</th><th>司机</th><th>电话</th><th>载重上限</th><th>体积上限</th></tr></thead><tbody>${vehicleRows}</tbody></table>
<h2>挂载订单（${orders.length} 票）</h2>
<table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>货物名称</th><th>件数</th><th>实收重量 KG</th><th>实收体积 CBM</th><th>装载车辆</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">合计</td><td class="num">${totalPieces}</td><td class="num">${totalWeight.toFixed(2)}</td><td class="num">${totalVolume.toFixed(3)}</td><td>—</td></tr></tfoot></table>
<div class="footer"><span>系统生成时间：${escapeHtml(generatedAt.slice(0, 19).replace("T", " "))}</span><span>生成来源：配载工作台（自动审核通过）</span></div>
<div class="sign"><div>仓库装车签字 / 日期</div><div>司机签字 / 日期</div><div>理货签字 / 日期</div></div>
</body></html>`;
}

const BATCH_DOCUMENT_TYPES=[
  {code:"loading_manifest",name:"配载单",hint:"仓库生成 PZ 配载单时自动形成，只读留档，不参与审核或出境门禁",required:false},
  {code:"vehicle_manifest",name:"装车清单",hint:"仓库按 PZ 配载订单、车辆和司机自动生成并同步",required:false},
  {code:"batch_waybill",name:"批次运单",hint:"仓库按 PZ 配载单运输资源自动生成并同步",required:false},
  {code:"border_handover",name:"口岸交接文件",hint:"口岸换装、过境或交接凭证",required:false},
  {code:"transshipment_order",name:"换装单",hint:"发生换装时上传的批次共用凭证",required:false},
] as const;
const ORDER_BATCH_DOCUMENT_CODES=loadingOrderDocumentDefinitions.map((item)=>item.code);
const BATCH_WORKSPACE_TAB_CODES=["batch","outbound","documents","tracking","overseas","exceptions"] as const;
type BatchWorkspaceTab=(typeof BATCH_WORKSPACE_TAB_CODES)[number];

function isBatchWorkspaceTab(value:string|null):value is BatchWorkspaceTab{
  return BATCH_WORKSPACE_TAB_CODES.includes(value as BatchWorkspaceTab);
}

const VEHICLE_TYPE_OPTIONS=[
  "卡车",
  "尖程拼车",
  "13米平板",
  "13.5米高栏",
  "13.7米平板",
  "17.5米平板",
  "17.5米厢式车",
  "13米高栏",
  "16米厢式车",
  "13米厢式车",
  "冷藏车",
];

async function hasFrozenBatchCostsManageScope(
  current: Parameters<typeof batchCostsManageScopeSql>[0],
  batchId: string,
) {
  const scope = batchCostsManageScopeSql(current, "cost_scope_batch");
  if(scope.sql==="0=1")return false;
  return Boolean(await env.DB.prepare(`SELECT 1 allowed
    FROM transport_batches cost_scope_batch
    WHERE cost_scope_batch.id=? AND cost_scope_batch.organization_id=?
      AND ${scope.sql}`).bind(batchId,current.organizationId,...scope.values).first<{allowed:number}>());
}

function sameOrderSet(left:readonly string[],right:readonly string[]){
  const a=new Set(left),b=new Set(right);
  return a.size===b.size&&[...a].every(orderId=>b.has(orderId));
}

function hasBatchCostWritePermissions(permissions:readonly string[]){
  return canAccessSettlementWorkbench(permissions)&&
    permissions.includes("billing.manage")&&
    permissions.includes("order.module.costs.manage");
}

function costAllocationBlockedReason(input:{
  canWritePermissions:boolean;
  hasWholeBatchOwnership:boolean;
  policy:BatchCostAllocationActionPolicy;
}){
  if(!input.policy.visible)return null;
  if(!input.canWritePermissions)return "当前账号缺少费用管理或成本模块办理权限，本区只读。";
  if(!input.hasWholeBatchOwnership)return "当前账号不是全部挂载订单共同的冻结费用负责人，本区只读。";
  return input.policy.reason;
}

async function assertFreshBatchCostMutation(input:{
  request:Request;
  organizationId:string;
  userId:string;
  batchId:string;
  allocationId:string|null;
  orderIds:readonly string[];
}){
  const fresh=await requireSessionUser(input.request,"order.view");
  if(fresh.organizationId!==input.organizationId||fresh.userId!==input.userId)
    throw new Error("当前登录账号或组织已变化，请刷新页面后重试");
  if(!canAccessBatchWorkspace(fresh)||!hasBatchCostWritePermissions(fresh.permissions))
    throw new Error("当前账号已不具备费用分摊办理权限");
  if(!(await hasFrozenBatchCostsManageScope(fresh,input.batchId)))
    throw new Error("当前账号已不再是全部挂载订单共同的冻结费用负责人");
  const snapshot=await loadBatchCostAllocationActionPolicy({
    db:env.DB,organizationId:fresh.organizationId,batchId:input.batchId,
  });
  if(!snapshot.policy.editable)throw new Error(snapshot.policy.reason??"当前冻结工作流不允许办理费用分摊");
  if(!sameOrderSet(snapshot.rows.map(row=>row.order_id),input.orderIds))
    throw new Error("配载单挂载订单已变化，请刷新后重新生成或核对分摊草稿");
  if(input.allocationId){
    const allocation=await env.DB.prepare(`SELECT 1 present FROM transport_cost_allocations
      WHERE id=? AND organization_id=? AND batch_id=? AND status='draft'`)
      .bind(input.allocationId,fresh.organizationId,input.batchId).first<{present:number}>();
    if(!allocation)throw new Error("费用分摊草稿状态已变化，请刷新页面后重试");
  }
}

export async function loader({request,params}:Route.LoaderArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId;
  if(!canAccessBatchWorkspace(current))throw new Response("当前岗位没有配载单工作台访问权限",{status:403});
  const batchVisibility=batchVisibilitySql(current,"b");
  const fromOrderId = new URL(request.url).searchParams.get("fromOrderId");
  const batch=await env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.actual_departure_at,b.status,b.road_status,b.carrier_id,b.warehouse_id,b.border_port,b.customs_location,b.transit_location,b.route_notes,b.notes,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,b.approval_status,b.operation_supervisor_user_id,b.operation_assignee_user_id,b.document_assignee_user_id,b.responsibility_revision,b.submitted_at,b.approved_at,c.name carrier_name,w.name warehouse_name,supervisor.display_name operation_supervisor_name,operator.display_name operation_assignee_name,document_owner.display_name document_assignee_name FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id LEFT JOIN warehouses w ON w.id=b.warehouse_id LEFT JOIN users supervisor ON supervisor.id=b.operation_supervisor_user_id LEFT JOIN users operator ON operator.id=b.operation_assignee_user_id LEFT JOIN users document_owner ON document_owner.id=b.document_assignee_user_id WHERE b.id=? AND b.organization_id=? AND ${batchVisibility.sql}`).bind(batchId,current.organizationId,...batchVisibility.values).first<Batch>();
  if(!batch)throw new Response("配载批次不存在",{status:404});
  const canViewBatchCosts=canAccessSettlementWorkbench(current.permissions);
  const canWriteBatchCosts=hasBatchCostWritePermissions(current.permissions);
  // D1 allows only a small number of simultaneous connections per Worker
  // invocation. Load the workspace in groups of four instead of opening every
  // independent query at once.
  const [orders,vehicles,carriers,warehouses]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id,o.order_number,o.business_type,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,o.cargo_description,
        COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
        COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
        COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
        COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm,
        o.gross_weight_kg declared_weight_kg,o.volume_cbm declared_volume_cbm,
        (SELECT MIN(r.received_at) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed') inbound_at,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status='dispatched') dispatched_packages,
        (SELECT COUNT(*) FROM warehouse_packages wp JOIN shipments s2 ON s2.id=wp.shipment_id WHERE s2.order_id=o.id AND wp.status IN ('in_stock','allocated')) in_stock_packages,
        o.overseas_warehouse_id,ow.name overseas_warehouse_name,
        CASE WHEN EXISTS(
          SELECT 1 FROM warehouse_receipts owr
          JOIN shipments os ON os.id=owr.shipment_id AND os.organization_id=owr.organization_id
          WHERE owr.organization_id=o.organization_id AND os.order_id=o.id
            AND owr.warehouse_id=o.overseas_warehouse_id AND owr.status='completed' AND owr.cargo_complete=1
        ) THEN 'received' ELSE op.status END overseas_status,
        COALESCE(op.actual_arrival_at,(
          SELECT MAX(owr.received_at) FROM warehouse_receipts owr
          JOIN shipments os ON os.id=owr.shipment_id AND os.organization_id=owr.organization_id
          WHERE owr.organization_id=o.organization_id AND os.order_id=o.id
            AND owr.warehouse_id=o.overseas_warehouse_id AND owr.status='completed' AND owr.cargo_complete=1
        )) overseas_arrival_at,
        (SELECT omi.assignee_user_id FROM order_module_instances omi WHERE omi.organization_id=o.organization_id AND omi.order_id=o.id AND omi.module_code='documents' AND omi.enabled=1 LIMIT 1) document_assignee_user_id,
        (SELECT omi.assignee_user_id FROM order_module_instances omi WHERE omi.organization_id=o.organization_id AND omi.order_id=o.id AND omi.module_code='customs' AND omi.enabled=1 LIMIT 1) customs_assignee_user_id
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id LEFT JOIN overseas_warehouse_operations op ON op.batch_id=bo.batch_id AND op.order_id=bo.order_id AND op.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' GROUP BY bo.order_id ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchOrder>(),
    env.DB.prepare(`WITH vehicle_order_actual AS (
        SELECT l.vehicle_id,p.order_id,
          COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.gross_weight_per_package_kg)) weight,
          COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=p.order_id AND r.status='completed'),SUM(i.volume_per_package_cbm)) volume
        FROM transport_vehicle_loads l JOIN order_cargo_packages p ON p.id=l.package_id JOIN order_cargo_items i ON i.id=p.cargo_item_id
        GROUP BY l.vehicle_id,p.order_id
      ) SELECT v.id,v.vehicle_no,v.vehicle_type,v.plate_number,v.driver_name,v.driver_phone,v.capacity_weight_kg,v.capacity_volume_cbm,v.status,COALESCE(SUM(a.weight),0) used_weight,COALESCE(SUM(a.volume),0) used_volume,COUNT(DISTINCT a.order_id) loaded_orders
      FROM transport_batch_vehicles v LEFT JOIN vehicle_order_actual a ON a.vehicle_id=v.id
      WHERE v.batch_id=? AND v.organization_id=? GROUP BY v.id ORDER BY v.created_at`).bind(batchId,current.organizationId).all<Vehicle>(),
    env.DB.prepare("SELECT id,name FROM carriers WHERE organization_id=? AND status='active' AND carrier_scope='overseas' ORDER BY name").bind(current.organizationId).all<Option>(),
    env.DB.prepare("SELECT id,name FROM warehouses WHERE organization_id=? AND status='active' AND warehouse_role IN ('domestic_collection','port') ORDER BY CASE warehouse_role WHEN 'domestic_collection' THEN 10 ELSE 20 END,code,name").bind(current.organizationId).all<Option>(),
  ]);
  const [borderPorts,costAllocations,batchDocuments,orderDocuments,orderDocumentArchive]=await Promise.all([
    env.DB.prepare("SELECT code,name FROM reference_data WHERE organization_id=? AND category='border_port' AND status='active' ORDER BY sort_order,code").bind(current.organizationId).all<ReferenceOption>(),
    canViewBatchCosts?loadCostAllocations(env.DB,current.organizationId,batchId):Promise.resolve(null),
    env.DB.prepare(`WITH ranked AS (
      SELECT id,document_category,file_name,content_type,size_bytes,description,review_status,created_at,
        ROW_NUMBER() OVER(PARTITION BY document_category ORDER BY created_at DESC,id DESC) row_no
      FROM transport_batch_documents WHERE organization_id=? AND batch_id=?
    ) SELECT id,document_category,file_name,content_type,size_bytes,description,review_status,created_at
      FROM ranked WHERE row_no=1 ORDER BY created_at DESC`).bind(current.organizationId,batchId).all<BatchDocument>(),
    env.DB.prepare(`WITH ranked AS (
      SELECT a.id,a.order_id,m.document_category,a.file_name,a.content_type,a.size_bytes,m.description,m.review_status,a.created_at,
        ROW_NUMBER() OVER(PARTITION BY a.order_id,m.document_category ORDER BY a.created_at DESC,a.id DESC) row_no
      FROM transport_batch_orders bo JOIN order_attachments a ON a.order_id=bo.order_id AND a.organization_id=bo.organization_id
      JOIN order_document_metadata m ON m.attachment_id=a.id AND m.order_id=bo.order_id AND m.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
    ) SELECT id,order_id,document_category,file_name,content_type,size_bytes,description,review_status,created_at
      FROM ranked WHERE row_no=1 ORDER BY created_at DESC`).bind(batchId,current.organizationId).all<OrderDocument>(),
    env.DB.prepare(`SELECT a.id,a.order_id,m.document_category,a.file_name,a.content_type,a.size_bytes,
        m.description,m.review_status,a.created_at
      FROM transport_batch_orders bo
      JOIN order_attachments a ON a.order_id=bo.order_id AND a.organization_id=bo.organization_id
      JOIN order_document_metadata m ON m.attachment_id=a.id AND m.order_id=bo.order_id AND m.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
      ORDER BY bo.sequence_no,m.document_category,a.created_at DESC,a.id DESC`).bind(batchId,current.organizationId).all<OrderDocument>(),
  ]);
  const [customsSummaries,customsDeclarations,batchExceptions,exceptionPackages]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id,COUNT(d.id) total,COALESCE(SUM(CASE WHEN d.status='released' THEN 1 ELSE 0 END),0) released
      FROM transport_batch_orders bo
      LEFT JOIN order_customs_records r ON r.order_id=bo.order_id AND r.organization_id=bo.organization_id AND r.clearance_stage='origin'
      LEFT JOIN order_customs_declarations d ON d.customs_record_id=r.id AND d.order_id=bo.order_id AND d.organization_id=bo.organization_id AND d.is_deleted=0 AND d.status!='cancelled'
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' GROUP BY bo.order_id`).bind(batchId,current.organizationId).all<CustomsSummary>(),
    env.DB.prepare(`SELECT d.id,d.order_id,d.customs_record_id,r.clearance_stage,d.declaration_number,d.declaration_type,d.declaration_title,d.declaring_company,d.declared_at,d.declared_amount,d.currency,d.gross_weight_kg,d.released_at,d.status,d.is_deleted,d.is_redeclared,d.is_amended,d.is_inspected,d.change_reason,d.updated_at
      FROM transport_batch_orders bo
      JOIN order_customs_declarations d ON d.order_id=bo.order_id AND d.organization_id=bo.organization_id
      JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
      ORDER BY bo.sequence_no,r.clearance_stage,d.created_at DESC`).bind(batchId,current.organizationId).all<BatchCustomsDeclaration>(),
    listBatchExceptions(current.organizationId,batchId),
    listBatchExceptionPackages(current.organizationId,batchId),
  ]);
  const returnOrderId =
    fromOrderId && orders.results.some((item) => item.order_id === fromOrderId)
      ? fromOrderId
      : (orders.results[0]?.order_id ?? null);
  const batchCustomsAccess=await loadBatchCustomsAccess(env.DB,current.organizationId,batchId);
  const outboundStatuses={results:batchCustomsAccess.orders.map((order):BatchOutboundStatus=>({
    order_id:order.orderId,
    dispatched:order.dispatched?1:0,
  }))};
  const departureGateStatuses:DepartureGateStatus[]=[];
  for(const item of orders.results){
    departureGateStatuses.push({
      order_id:item.order_id,
      ...await checkOrderDeparture(current.organizationId,item.order_id,undefined,{warehouseDispatchConfirmed:true}),
    });
  }
  const batchOrderIds=orders.results.map((item)=>item.order_id);
  const batchWorkflowPolicies=await loadBatchOrderWorkflowPolicies(current.organizationId,batchId);
  const costAllocationAction=canViewBatchCosts
    ? (await loadBatchCostAllocationActionPolicy({db:env.DB,organizationId:current.organizationId,batchId})).policy
    : null;
  const hasWholeBatchCostOwnership=canWriteBatchCosts
    ? await hasFrozenBatchCostsManageScope(current,batchId)
    : false;
  const canManageBatchCosts=Boolean(
    canViewBatchCosts&&canWriteBatchCosts&&hasWholeBatchCostOwnership&&costAllocationAction?.editable,
  );
  const showBatchCosts=Boolean(
    canViewBatchCosts&&(costAllocationAction?.visible||costAllocations?.length),
  );
  const batchCostBlockedReason=costAllocationAction?costAllocationBlockedReason({
    canWritePermissions:canWriteBatchCosts,
    hasWholeBatchOwnership:hasWholeBatchCostOwnership,
    policy:costAllocationAction,
  }):null;
  // Resolve both write surfaces from the same frozen order contracts that the
  // POST handlers will reload. Resolve sequentially to keep D1 connections
  // bounded for large PZ batches.
  const trackingMilestoneAction=(await loadBatchTrackingActionPolicy({
    db:env.DB,
    organizationId:current.organizationId,
    orders:batchTrackingPolicyOrders(orders.results),
    fieldKey:"tracking_milestone",
  })).batch;
  const actualExitAction=(await loadBatchTrackingActionPolicy({
    db:env.DB,
    organizationId:current.organizationId,
    orders:batchTrackingPolicyOrders(orders.results),
    fieldKey:"actual_exit_at",
  })).batch;
  const batchCargoItems=(await env.DB.prepare(`SELECT i.id,i.order_id,i.line_no,i.cargo_name_cn,i.cargo_name_en,i.hs_code,i.overseas_hs_code,
      i.package_type,i.package_count,i.pieces_per_package,i.gross_weight_per_package_kg,
      i.length_cm,i.width_cm,i.height_cm,i.volume_per_package_cbm,i.declared_value,i.currency,
      i.brand_model,i.marks,i.special_attributes
    FROM transport_batch_orders bo
    JOIN order_cargo_items i ON i.order_id=bo.order_id AND i.organization_id=bo.organization_id
    WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'
    ORDER BY bo.sequence_no,i.line_no,i.id`).bind(batchId,current.organizationId).all<BatchCargoItem>()).results;
  const orderDocumentRequirements=await loadOrderLoadingDocumentRequirements(current.organizationId,batchOrderIds);
  const trackingMilestones: BatchTrackingMilestone[] = [];
  if(batchOrderIds.length){
    for (const chunk of chunkD1Values(batchOrderIds, 1)) {
      const trackingPlaceholders = d1Placeholders(chunk.length);
      const rows = await env.DB.prepare(`SELECT id,order_id,milestone_code,milestone_name,event_at,location,vehicle_reference,notes,visible_to_customer,created_at
        FROM order_tracking_milestones
        WHERE organization_id=? AND order_id IN (${trackingPlaceholders})
        ORDER BY event_at DESC, created_at DESC`).bind(current.organizationId,...chunk).all<BatchTrackingMilestone>();
      trackingMilestones.push(...rows.results);
    }
  }
  const [trackingFlags,batchVehiclePlate,carrierVehicles,carrierDrivers,responsibilityMembers]=await Promise.all([
    env.DB.prepare(`SELECT bo.order_id, COALESCE(o.requires_transloading,0) requires_transloading, COALESCE(o.requires_transit_customs,0) requires_transit_customs
      FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
      WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<BatchTrackingFlag>(),
    getBatchMainVehiclePlate(current.organizationId,batchId),
    env.DB.prepare(`SELECT v.id,v.carrier_id,v.plate_number,v.vehicle_type,v.capacity_weight_kg,v.capacity_volume_cbm,c.name carrier_name
      FROM carrier_vehicles v JOIN carriers c ON c.id=v.carrier_id
      WHERE v.organization_id=? AND v.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,v.plate_number`).bind(current.organizationId).all<CarrierVehicleOption>(),
    env.DB.prepare(`SELECT d.id,d.carrier_id,d.name,d.phone,c.name carrier_name
      FROM carrier_drivers d JOIN carriers c ON c.id=d.carrier_id
      WHERE d.organization_id=? AND d.status='active' AND c.status='active' AND c.carrier_scope='overseas'
      ORDER BY c.name,d.name`).bind(current.organizationId).all<CarrierDriverOption>(),
    env.DB.prepare(`SELECT u.id,u.display_name,
        d.id department_id,d.code department_code,d.name department_name,
        p.id position_id,p.code position_code,p.name position_name,
        (SELECT GROUP_CONCAT(DISTINCT effective_permission.code)
           FROM (
             SELECT rp.permission_code code
               FROM membership_roles effective_mr
               JOIN roles effective_role
                 ON effective_role.id=effective_mr.role_id AND effective_role.status='active'
               JOIN role_permissions rp ON rp.role_id=effective_role.id
              WHERE effective_mr.membership_id=m.id
                AND NOT EXISTS (
                  SELECT 1 FROM membership_permission_overrides denied
                   WHERE denied.membership_id=m.id
                     AND denied.permission_code=rp.permission_code
                     AND denied.effect='deny'
                )
             UNION
             SELECT allowed.permission_code
               FROM membership_permission_overrides allowed
              WHERE allowed.membership_id=m.id AND allowed.effect='allow'
             UNION
             SELECT '*'
               FROM membership_roles protected_mr
               JOIN roles protected_role
                 ON protected_role.id=protected_mr.role_id AND protected_role.status='active'
              WHERE protected_mr.membership_id=m.id
                AND protected_role.code IN ('owner','boss')
           ) effective_permission) permission_codes
      FROM memberships m
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
      JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
        AND p.department_code=d.code
      WHERE m.organization_id=? AND m.status='active' AND p.code IN ('OPERATION','DOC')
      ORDER BY d.sort_order,p.sort_order,u.display_name`).bind(current.organizationId).all<OrganizationAssigneeMember>(),
  ]);
  responsibilityMembers.results=responsibilityMembers.results.filter((member)=>{
    const kind=member.position_code==="OPERATION"
      ? "operation"
      : member.position_code==="DOC"
        ? "document"
        : null;
    return kind!==null&&!batchResponsibilityPermissionDisabledReasons([member],kind)[member.id];
  });
  const initialResponsibilityRestrictions=batch.approval_status==="submitted"
    ? await loadBatchInitialResponsibilityRestrictions(env.DB,current.organizationId,batchId)
    : buildBatchInitialResponsibilityRestrictions([]);
  return{current,batch,canViewBatchCosts,showBatchCosts,canManageBatchCosts,batchCostBlockedReason,orders:orders.results,batchWorkflowPolicies,trackingMilestoneAction,actualExitAction,batchCargoItems,vehicles:vehicles.results,carriers:carriers.results,warehouses:warehouses.results,borderPorts:borderPorts.results,costAllocations,batchDocuments:batchDocuments.results,orderDocuments:orderDocuments.results,orderDocumentArchive:orderDocumentArchive.results,orderDocumentRequirements,customsSummaries:customsSummaries.results,customsDeclarations:customsDeclarations.results,batchExceptions,exceptionPackages,outboundStatuses:outboundStatuses.results,batchCustomsAccess,departureGateStatuses,returnOrderId,trackingMilestones,trackingFlags:trackingFlags.results,batchVehiclePlate,carrierVehicles:carrierVehicles.results,carrierDrivers:carrierDrivers.results,operationMembers:responsibilityMembers.results.filter(member=>member.position_code==="OPERATION"),documentMembers:responsibilityMembers.results.filter(member=>member.position_code==="DOC"),initialResponsibilityRestrictions};
}

export async function action({request,params}:Route.ActionArgs){
  const current=await requireSessionUser(request,"order.view"),batchId=params.batchId,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(!canAccessBatchWorkspace(current))throw new Response("当前岗位没有配载单工作台访问权限",{status:403});
  const batchVisibility=batchVisibilitySql(current,"b");
  const privileged=["BOSS","DEVELOPER"].includes(current.positionCode??"")||current.roleCodes.some(code=>["owner","boss","developer"].includes(code));
  const responsibilityIntent=["batch_approve","batch_reassign","batch_reject"].includes(intent);
  const customsIntent=intent==="batch_order_customs_declaration_save";
  const documentIntent=["batch_order_document_upload","batch_order_document_review"].includes(intent);
  const exceptionIntent=["batch_exception_create","batch_exception_progress","batch_exception_resolve"].includes(intent);
  const trackingIntent=["exit_confirm","batch_tracking_option_toggle","batch_tracking_add"].includes(intent);
  const costIntent=["create_cost_allocation","update_cost_allocation","confirm_cost_allocation"].includes(intent);
  const allowed=responsibilityIntent
    ? privileged||current.permissions.includes("transport.batch.approve")
    : costIntent
      ? hasBatchCostWritePermissions(current.permissions)
      : documentIntent
        ? canManageOrderModule(current,"documents")
      : customsIntent
        ? canManageOrderModule(current,"customs")
        : exceptionIntent
          ? canManageOrderModule(current,"exceptions")
          : trackingIntent
            ? canManageOrderModule(current,"tracking")
            : canManageOrderModule(current,"loading");
  if(!allowed)throw new Response(costIntent?"无权查看或办理敏感费用分摊":customsIntent?"无权办理报关作业":documentIntent?"无权办理逐票文件":exceptionIntent?"无权办理配载异常":"无权办理拼车配载",{status:403});
  const batch=await env.DB.prepare(`SELECT b.id,b.batch_number,b.status,b.road_status,b.border_port,b.customs_location,b.route_notes,b.warehouse_id,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone FROM transport_batches b WHERE b.id=? AND b.organization_id=? AND b.status!='cancelled' AND ${batchVisibility.sql}`).bind(batchId,current.organizationId,...batchVisibility.values).first<{id:string;batch_number:string;status:string;road_status:string;border_port:string|null;customs_location:string|null;route_notes:string|null;warehouse_id:string|null;overseas_carrier_name:string|null;overseas_vehicle_type:string|null;overseas_vehicle_count:number;overseas_vehicle_plate:string|null;overseas_driver_name:string|null;overseas_driver_phone:string|null}>();
  if(!batch)return{formError:"配载批次无效"};
  const batchApproval=await env.DB.prepare("SELECT batch_number,approval_status,operation_supervisor_user_id,operation_assignee_user_id,document_assignee_user_id,responsibility_revision,actual_departure_at,road_status FROM transport_batches WHERE id=? AND organization_id=?").bind(batchId,current.organizationId).first<{batch_number:string;approval_status:string;operation_supervisor_user_id:string|null;operation_assignee_user_id:string|null;document_assignee_user_id:string|null;responsibility_revision:string|null;actual_departure_at:string|null;road_status:string}>();
  if(!batchApproval)return{formError:"配载单审核状态无效"};
  if(responsibilityIntent){
    if(!batchRequiresSupervisorApproval(batchApproval.batch_number))return{formError:"整车批次不进入拼车配载审核与统一分配"};
    if(!privileged&&batchApproval.operation_supervisor_user_id!==current.userId)return{formError:"该配载单已指派给其他操作主管审核"};
    if(intent==="batch_reject"){
      if(batchApproval.approval_status!=="submitted")return{formError:"仅待审核的配载单可以退回"};
      const rejectionNotes=valueOf(form,"rejectionNotes").trim();
      if(!rejectionNotes)return{formError:"请填写退回原因，仓库据此调整后重新提交"};
      const rejected=await env.DB.prepare(`UPDATE transport_batches
        SET approval_status='rejected',approval_notes=?,operation_assignee_user_id=NULL,
            document_assignee_user_id=NULL,responsibility_revision=NULL,updated_at=?
        WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND approval_status='submitted'`)
        .bind(rejectionNotes,now,batchId,current.organizationId).run();
      if(!Number(rejected.meta?.changes||0))return{formError:"配载单状态已被其他人更新，请刷新后重试"};
      await writeAudit({request,action:"transport.batch.reject",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchNumber:batch.batch_number,rejectionNotes}});
      return{success:`${batch.batch_number} 已退回仓库调整`};
    }
    const reassigning=intent==="batch_reassign";
    if(!reassigning&&batchApproval.approval_status!=="submitted")return{formError:"仅待审核的配载单可以审核通过"};
    if(reassigning&&batchApproval.approval_status!=="approved")return{formError:"仅已审核配载单可以变更负责人"};
    const operationAssigneeUserId=valueOf(form,"operationAssigneeUserId");
    const documentAssigneeUserId=valueOf(form,"documentAssigneeUserId");
    if(!(await isActiveOrganizationAssigneeForPositions(
      current.organizationId,
      operationAssigneeUserId,
      ["OPERATION"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.operation,
    )))return{formError:"\u8bf7\u9009\u62e9\u540c\u65f6\u5177\u5907\u914d\u8f7d\u67e5\u770b\u3001\u8fd0\u8e2a\u548c\u5f02\u5e38\u5904\u7406\u6743\u9650\u7684\u6709\u6548\u64cd\u4f5c\u5c97\u4e2a\u4eba\u8d26\u6237"};
    if(!(await isActiveOrganizationAssigneeForPositions(
      current.organizationId,
      documentAssigneeUserId,
      ["DOC"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.document,
    )))return{formError:"\u8bf7\u9009\u62e9\u540c\u65f6\u5177\u5907\u914d\u8f7d\u67e5\u770b\u3001\u6587\u4ef6\u548c\u62a5\u5173\u6743\u9650\u7684\u6709\u6548\u5355\u8bc1\u5c97\u4e2a\u4eba\u8d26\u6237"};
    if(!(await isActiveOrganizationAssigneeForPositions(current.organizationId,operationAssigneeUserId,["OPERATION"])))return{formError:"请选择操作岗下的有效个人账户"};
    if(!(await isActiveOrganizationAssigneeForPositions(current.organizationId,documentAssigneeUserId,["DOC"])))return{formError:"请选择单证岗下的有效个人账户"};
    const ordinaryReassignmentAllowed=canOrdinaryReassignBatchResponsibility({
      batchNumber:batchApproval.batch_number,
      approvalStatus:batchApproval.approval_status,
      roadStatus:batchApproval.road_status,
      actualDepartureAt:batchApproval.actual_departure_at,
    });
    const reassignReason=valueOf(form,"reassignReason").trim();
    if(reassigning&&!ordinaryReassignmentAllowed&&!privileged)return{formError:"配载单实际出境后禁止普通改派；仅老板或开发者可走异常改派"};
    if(reassigning&&!ordinaryReassignmentAllowed&&privileged&&!reassignReason)return{formError:"实际出境后的异常改派必须填写原因"};
    if(reassigning&&batchApproval.operation_assignee_user_id===operationAssigneeUserId&&batchApproval.document_assignee_user_id===documentAssigneeUserId)return{formError:"操作与单证负责人均未变化，无需重复提交"};
    const orderIds=await getBatchOrderIds(current.organizationId,batchId);
    if(!orderIds.length)return{formError:"配载单没有可指派的挂载订单"};
    try{
      const modules=await ensureOrderModulesModule();
      for(const orderId of orderIds)await modules.ensureOrderModules(current.organizationId,orderId);
      if(!reassigning){
        const restrictions=await loadBatchInitialResponsibilityRestrictions(env.DB,current.organizationId,batchId);
        if(restrictions.configurationErrors.length)return{formError:`工作流配置阻断：${restrictions.configurationErrors.join("；")}`};
        const conflict=findBatchInitialResponsibilityConflict(restrictions,{operationAssigneeUserId,documentAssigneeUserId});
        if(conflict)return{formError:conflict.reason};
      }
      const targets=await loadBatchResponsibilityTransferTargets({
        organizationId:current.organizationId,
        orderIds,
        operationAssigneeUserId,
        documentAssigneeUserId,
      });
      const changed=await assignBatchResponsibilities({
        organizationId:current.organizationId,batchId,batchNumber:batch.batch_number,
        operationAssigneeUserId,documentAssigneeUserId,actorUserId:current.userId,now,
        mode:reassigning?"reassign":"approve",
        previousOperationAssigneeUserId:batchApproval.operation_assignee_user_id,
        previousDocumentAssigneeUserId:batchApproval.document_assignee_user_id,
        allowAfterDeparture:reassigning&&!ordinaryReassignmentAllowed&&privileged,
        targets,
      });
      if(!changed){
        if(!reassigning){
          const latestRestrictions=await loadBatchInitialResponsibilityRestrictions(env.DB,current.organizationId,batchId);
          const latestConflict=findBatchInitialResponsibilityConflict(latestRestrictions,{operationAssigneeUserId,documentAssigneeUserId});
          if(latestConflict)return{formError:latestConflict.reason};
        }
        return{formError:"配载单状态或负责人已被其他人更新，请刷新后重试"};
      }
      for(const orderId of orderIds)await syncOrderWorkflowSnapshotSafe(current.organizationId,orderId);
      const notificationStatements=[
        assignedBatchNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:batch.batch_number,assigneeUserId:operationAssigneeUserId,actorUserId:current.userId,responsibilityLabel:"操作职责",targetTab:"tracking" as const,now}),
        assignedBatchNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:batch.batch_number,assigneeUserId:documentAssigneeUserId,actorUserId:current.userId,responsibilityLabel:"单证与报关职责",targetTab:"documents" as const,now}),
      ];
      if(!reassigning&&batch.warehouse_id)notificationStatements.push(
        warehouseBatchReadyNotificationStatement(env.DB,{organizationId:current.organizationId,batchId,batchNumber:batch.batch_number,warehouseId:batch.warehouse_id,actorUserId:current.userId,now}),
      );
      await env.DB.batch(notificationStatements);
      await writeAudit({request,action:reassigning?"transport.batch.reassign":"transport.batch.approve",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchNumber:batch.batch_number,operationAssigneeUserId,documentAssigneeUserId,previousOperationAssigneeUserId:batchApproval.operation_assignee_user_id,previousDocumentAssigneeUserId:batchApproval.document_assignee_user_id,orderCount:orderIds.length,reassignReason:reassignReason||null,exceptionReassignment:reassigning&&!ordinaryReassignmentAllowed}});
      return{success:reassigning?`${batch.batch_number} 已完成整批改派，旧负责人保留历史只读记录`:`${batch.batch_number} 已审核通过，${orderIds.length} 票订单的操作与单证职责已统一交接`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(costIntent){
    if(batchRequiresSupervisorApproval(batchApproval.batch_number)&&batchApproval.approval_status!=="approved"){
      return{formError:"配载单尚未审核通过，费用分摊暂不可办理"};
    }
    if(!(await hasFrozenBatchCostsManageScope(current,batchId))){
      return{formError:"整批费用分摊仅允许由全部挂载订单共同的冻结费用负责人办理；当前账号的负责范围不完整"};
    }
    const costAction=await loadBatchCostAllocationActionPolicy({
      db:env.DB,organizationId:current.organizationId,batchId,
    });
    if(!costAction.policy.editable)return{formError:costAction.policy.reason??"当前冻结工作流不允许办理费用分摊"};
    if(intent!=="create_cost_allocation"){
      const allocationId=valueOf(form,"allocationId");
      const allocation=allocationId?await env.DB.prepare(`SELECT id FROM transport_cost_allocations
        WHERE id=? AND organization_id=? AND batch_id=? AND status!='cancelled'`)
        .bind(allocationId,current.organizationId,batchId).first<{id:string}>():null;
      if(!allocation)return{formError:"费用分摊记录不存在或不属于当前配载单"};
    }
  }
  const assertCostCanMutate:AssertCostAllocationCanMutate=async(context)=>{
    if(context.organizationId!==current.organizationId||context.batchId!==batchId)
      throw new Error("费用分摊办理范围已变化，请刷新页面后重试");
    await assertFreshBatchCostMutation({
      request,organizationId:current.organizationId,userId:current.userId,batchId,
      allocationId:context.allocationId,orderIds:context.orderIds,
    });
  };
  if(batchRequiresSupervisorApproval(batchApproval.batch_number)&&batchApproval.approval_status!=="approved"&&!costIntent)return{formError:"配载单须由操作主管审核并同时指定整单操作与单证负责人后才能继续办理"};
  if(batchRequiresSupervisorApproval(batchApproval.batch_number)&&!batchSharedResponsibilityIsActive(batchApproval.road_status)&&!privileged&&(trackingIntent||exceptionIntent||customsIntent||documentIntent))return{formError:"配载单已到达境外仓，整批操作与单证负责人现为只读；后续由各订单客服和财务继续办理"};
  if((trackingIntent||exceptionIntent)&&!privileged&&batchApproval.operation_assignee_user_id!==current.userId)return{formError:"本配载单的运踪与异常只允许已指派的整单操作负责人办理"};
  // Resolve the exact frozen field after ownership is checked. This prevents
  // a previous PZ owner from probing the replacement owner's workflow and
  // ensures client-supplied order ids never determine mutation targets.
  const trackingActionPolicy=trackingIntent
    ? await loadFreshBatchTrackingAction(
        current.organizationId,
        batchId,
        intent==="exit_confirm"?"actual_exit_at":"tracking_milestone",
      )
    : null;
  if(trackingActionPolicy&&!trackingActionPolicy.editable)return{formError:trackingActionPolicy.reason??"当前冻结工作流不允许办理该运踪动作"};
  if((customsIntent||documentIntent)&&!privileged){
    if(batchRequiresSupervisorApproval(batchApproval.batch_number)&&batchApproval.document_assignee_user_id!==current.userId)return{formError:"本配载单的逐票文件与报关仅允许已指派的整单单证负责人办理"};
    if(!batchRequiresSupervisorApproval(batchApproval.batch_number)){
      const orderId=valueOf(form,"orderId");
      const moduleCode=customsIntent?"customs":"documents";
      const assignment=await env.DB.prepare(`SELECT 1 FROM order_module_instances omi
        WHERE omi.organization_id=? AND omi.order_id=? AND omi.module_code=? AND omi.enabled=1 AND omi.assignee_user_id=?
          AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=omi.organization_id AND bo.order_id=omi.order_id AND bo.batch_id=? AND bo.status!='removed')`)
        .bind(current.organizationId,orderId,moduleCode,current.userId,batchId).first();
      if(!assignment)return{formError:customsIntent?"本票报关仅允许订单已指派的单证负责人办理":"本票文件仅允许订单已指派的单证负责人办理"};
    }
  }
  if(intent==="batch_exception_create"){
    try{
      const created=await createBatchException({
        organizationId:current.organizationId,
        batchId,
        scope:valueOf(form,"exceptionScope"),
        orderId:valueOf(form,"orderId")||null,
        packageId:valueOf(form,"packageId")||null,
        exceptionType:valueOf(form,"exceptionType"),
        severity:valueOf(form,"severity"),
        blocksProgress:form.get("blocksProgress")==="on",
        description:valueOf(form,"description"),
        actorUserId:current.userId,
        now,
      });
      await writeAudit({request,action:"transport.batch.exception.create",resourceType:"transport_batch_exception",resourceId:created.id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,exceptionNumber:created.exceptionNumber,scope:created.scope,orderId:created.orderId,packageId:created.packageId,severity:created.severity,blocksProgress:created.blocksProgress,affectedOrders:created.affectedOrderIds.length}});
      await broadcastInternalNotification({
        organizationId:current.organizationId,
        actorUserId:current.userId,
        category:"transport_batch_exception_created",
        severity:created.severity==="critical"||created.severity==="high"?"critical":"warning",
        title:`配载单异常：${created.exceptionNumber}`,
        message:`${batch.batch_number} 新增${batchExceptionScopeLabel(created.scope)}异常：${created.description}${created.blocksProgress?"；异常关闭前阻断整批推进":"；仅提醒，不阻断推进"}。`,
        link:`/admin/loading/${encodeURIComponent(batchId)}?tab=exceptions`,
        requiresLeadershipAck:created.blocksProgress,
      });
      return{success:`异常 ${created.exceptionNumber} 已登记并同步 ${created.affectedOrderIds.length} 票订单${created.blocksProgress?"；当前会阻断整批推进":""}`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="batch_exception_progress"){
    try{
      await progressBatchException({organizationId:current.organizationId,batchId,exceptionId:valueOf(form,"exceptionId"),actorUserId:current.userId,now});
      await writeAudit({request,action:"transport.batch.exception.progress",resourceType:"transport_batch_exception",resourceId:valueOf(form,"exceptionId"),organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId}});
      return{success:"异常已进入处理中"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="batch_exception_resolve"){
    const exceptionId=valueOf(form,"exceptionId");
    const target=await env.DB.prepare("SELECT exception_number FROM transport_batch_exceptions WHERE id=? AND organization_id=? AND batch_id=?").bind(exceptionId,current.organizationId,batchId).first<{exception_number:string}>();
    try{
      const resolved=await resolveBatchException({organizationId:current.organizationId,batchId,exceptionId,actorUserId:current.userId,resolution:valueOf(form,"resolution"),now});
      await writeAudit({request,action:"transport.batch.exception.resolve",resourceType:"transport_batch_exception",resourceId:exceptionId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,exceptionNumber:target?.exception_number,resolution:resolved.resolution,affectedOrders:resolved.affectedOrderIds.length}});
      await broadcastInternalNotification({organizationId:current.organizationId,actorUserId:current.userId,category:"transport_batch_exception_resolved",severity:"info",title:`配载异常已关闭：${target?.exception_number||"异常"}`,message:`${batch.batch_number} 的异常已处理：${resolved.resolution}。相关订单异常状态已重新计算，历史流程不回退。`,link:`/admin/loading/${encodeURIComponent(batchId)}?tab=exceptions`});
      return{success:`${target?.exception_number||"异常"} 已结案；${resolved.affectedOrderIds.length} 票订单状态已重新计算`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(WAREHOUSE_OWNED_BATCH_INTENTS.has(intent))return{formError:"该数据由仓库端配载单维护，管理后台仅同步查看"};
  if(["batch_tracking_option_toggle","batch_tracking_add"].includes(intent)){
    const dispatchGate=await env.DB.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN EXISTS(
        SELECT 1 FROM warehouse_dispatches d
        JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
        JOIN warehouse_packages p ON p.id=di.package_id
        JOIN shipments s ON s.id=p.shipment_id
        WHERE d.organization_id=bo.organization_id AND s.order_id=bo.order_id AND d.status='dispatched'
      ) THEN 1 ELSE 0 END),0) dispatched
      FROM transport_batch_orders bo WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed'`).bind(batchId,current.organizationId).first<{total:number;dispatched:number}>();
    if(!dispatchGate?.total||dispatchGate.dispatched!==dispatchGate.total)return{formError:"仓库端尚未完成整批装车出库，运输执行与跟踪暂不可登记"};
  }
  if(intent==="batch_document_upload"){
    const documentCategory=valueOf(form,"documentCategory"),file=form.get("attachment");
    if(!BATCH_DOCUMENT_TYPES.some(item=>item.code===documentCategory))return{formError:"请选择有效的批次文件类型"};
    if(!(file instanceof File)||file.size<=0)return{formError:"请选择要上传的批次文件"};
    const fileError=validateDocumentFile(file);if(fileError)return{formError:fileError};
    const id=crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO transport_batch_documents(id,organization_id,batch_id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,uploaded_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).bind(id,current.organizationId,batchId,documentCategory,file.name,file.type,file.size,await toDataUrl(file),valueOf(form,"documentDescription")||null,current.userId,now,now).run();
    await writeAudit({request,action:"transport.batch.document.upload",resourceType:"transport_batch_document",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,documentCategory}});
    return{success:`${batchDocumentTypeLabel(documentCategory)}已上传，等待审核`};
  }
  if(intent==="batch_document_review"){
    const attachmentId=valueOf(form,"attachmentId"),reviewStatus=valueOf(form,"reviewStatus");
    if(!["approved","rejected"].includes(reviewStatus))return{formError:"请选择有效的审核结果"};
    const result=await env.DB.prepare("UPDATE transport_batch_documents SET review_status=?,reviewed_by_user_id=?,reviewed_at=?,review_notes=?,updated_at=? WHERE id=? AND batch_id=? AND organization_id=?").bind(reviewStatus,current.userId,now,valueOf(form,"reviewNotes")||null,now,attachmentId,batchId,current.organizationId).run();
    if(!result.meta.changes)return{formError:"批次文件不存在或已失效"};
    await writeAudit({request,action:"transport.batch.document.review",resourceType:"transport_batch_document",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,reviewStatus}});
    return{success:reviewStatus==="approved"?"批次文件已审核通过":"批次文件已退回"};
  }
  if(intent==="batch_order_document_upload"){
    const orderId=valueOf(form,"orderId"),documentCategory=valueOf(form,"documentCategory"),file=form.get("attachment");
    const approveImmediately=valueOf(form,"approveImmediately")==="1";
    if(!ORDER_BATCH_DOCUMENT_CODES.includes(documentCategory as LoadingOrderDocumentCode)||!orderDocumentTypeCodes.has(documentCategory))return{formError:"请选择有效的订单文件类型"};
    if(!(file instanceof File)||file.size<=0)return{formError:"请选择要上传的订单文件"};
    const fileError=validateDocumentFile(file);if(fileError)return{formError:fileError};
    const order=await env.DB.prepare(`SELECT o.customer_id FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id WHERE bo.batch_id=? AND bo.order_id=? AND bo.organization_id=? AND bo.status!='removed'`).bind(batchId,orderId,current.organizationId).first<{customer_id:string}>();
    if(!order)return{formError:"该订单不属于当前配载单"};
    const workflowAccess=await loadOrderDocumentWorkflowMutationAccess(
      env.DB,current.organizationId,orderId,documentCategory,
    );
    if(!workflowAccess.allowed){
      return{
        formError:workflowAccess.reason||"当前订单冻结工作流不允许上传该文件",
      };
    }
    const attachmentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)").bind(attachmentId,current.organizationId,orderId,order.customer_id,file.name,file.type,file.size,await toDataUrl(file),current.userId,now),
      env.DB.prepare("INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,reviewed_by_user_id,reviewed_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?)").bind(attachmentId,current.organizationId,orderId,documentCategory,valueOf(form,"documentDescription")||orderDocumentTypeLabel(documentCategory),approveImmediately?"approved":"pending",approveImmediately?current.userId:null,approveImmediately?now:null,now),
    ]);
    await synchronizeOrderDocumentsModuleStatus({organizationId:current.organizationId,orderId,actorUserId:current.userId,now,source:"admin_upload"});
    await writeAudit({request,action:"transport.batch.order_document.upload",resourceType:"order_attachment",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orderId,documentCategory,approveImmediately}});
    return{success:approveImmediately?`${orderDocumentTypeLabel(documentCategory)}已上传并通过`:`${orderDocumentTypeLabel(documentCategory)}已上传到对应订单，等待审核`};
  }
  if(intent==="generate_manifest"){
    // 配载单由工作台自动生成：仓库按生成的配载单装车出库，不再要求人工上传。
    const [ordersList,vehiclesList]=await Promise.all([
      env.DB.prepare(`SELECT bo.order_id,o.order_number,COALESCE((SELECT s.shipment_number FROM shipments s WHERE s.order_id=o.id ORDER BY s.created_at DESC LIMIT 1),o.order_number) work_number,c.name customer_name,
          COALESCE((SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.order_id=o.id AND i.organization_id=o.organization_id),o.cargo_description) cargo_names,
          COALESCE((SELECT SUM(r.total_pieces) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.pieces) pieces,
          COALESCE((SELECT SUM(r.total_weight_kg) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.gross_weight_kg) gross_weight_kg,
          COALESCE((SELECT SUM(r.total_volume_cbm) FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE s.order_id=o.id AND r.status='completed'),o.volume_cbm) volume_cbm
        FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id
        WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<ManifestOrderRow>(),
      env.DB.prepare("SELECT vehicle_no,vehicle_type,plate_number,driver_name,driver_phone,capacity_weight_kg,capacity_volume_cbm FROM transport_batch_vehicles WHERE batch_id=? AND organization_id=? AND status!='cancelled' ORDER BY vehicle_no").bind(batchId,current.organizationId).all<ManifestVehicleRow>(),
    ]);
    if(!vehiclesList.results.length)return{formError:"配载单还没有车辆；请先在配载单信息中添加车辆，再生成配载单"};
    const batchDetail=await env.DB.prepare("SELECT b.batch_number,b.batch_name,b.origin_location,b.destination_location,b.planned_departure_at,b.planned_arrival_at,b.border_port,b.overseas_carrier_name,b.overseas_vehicle_type,b.overseas_vehicle_count,b.overseas_vehicle_plate,b.overseas_driver_name,b.overseas_driver_phone,c.name carrier_name FROM transport_batches b LEFT JOIN carriers c ON c.id=b.carrier_id WHERE b.id=? AND b.organization_id=?").bind(batchId,current.organizationId).first<ManifestBatchRow>();
    if(!batchDetail)return{formError:"配载批次无效"};
    const html=buildLoadingManifestHtml(batchDetail,ordersList.results,vehiclesList.results,now);
    const documentId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("UPDATE transport_batch_documents SET review_status='archived',updated_at=? WHERE batch_id=? AND organization_id=? AND document_category='loading_manifest'").bind(now,batchId,current.organizationId),
      env.DB.prepare(`INSERT INTO transport_batch_documents(id,organization_id,batch_id,document_category,file_name,content_type,size_bytes,data_url,description,review_status,uploaded_by_user_id,reviewed_by_user_id,reviewed_at,review_notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'系统自动生成；仓库按此配载单装车出库','approved',?,?,?,?,?,?)`).bind(documentId,current.organizationId,batchId,"loading_manifest",`配载单-${batchDetail.batch_number}.html`,"text/html",new TextEncoder().encode(html).length,`data:text/html;charset=utf-8,${encodeURIComponent(html)}`,current.userId,current.userId,now,"配载工作台自动生成",now,now),
    ]);
    await writeAudit({request,action:"transport.batch.manifest.generate",resourceType:"transport_batch_document",resourceId:documentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orders:ordersList.results.length,vehicles:vehiclesList.results.length}});
    return{success:`配载单已生成并自动审核通过（${ordersList.results.length} 票 · ${vehiclesList.results.length} 车）；仓库可按此配载单装车出库`};
  }
  if(intent==="batch_order_document_review"){
    const orderId=valueOf(form,"orderId"),attachmentId=valueOf(form,"attachmentId"),reviewStatus=valueOf(form,"reviewStatus");
    if(!["approved","rejected"].includes(reviewStatus))return{formError:"请选择有效的审核结果"};
    const target=await env.DB.prepare(`SELECT m.document_category
      FROM order_document_metadata m
      WHERE m.attachment_id=? AND m.order_id=? AND m.organization_id=?
        AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=? AND bo.order_id=m.order_id AND bo.organization_id=m.organization_id AND bo.status!='removed')`)
      .bind(attachmentId,orderId,current.organizationId,batchId).first<{document_category:string}>();
    if(!target)return{formError:"订单文件不存在或不属于当前配载单"};
    const workflowAccess=await loadOrderDocumentWorkflowMutationAccess(
      env.DB,current.organizationId,orderId,target.document_category,
    );
    if(!workflowAccess.allowed){
      return{formError:workflowAccess.reason||"当前订单冻结工作流不允许审核该文件"};
    }
    const result=await env.DB.prepare(`UPDATE order_document_metadata SET review_status=?,reviewed_by_user_id=?,reviewed_at=?,updated_at=? WHERE attachment_id=? AND order_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.batch_id=? AND bo.order_id=? AND bo.organization_id=? AND bo.status!='removed')`).bind(reviewStatus,current.userId,now,now,attachmentId,orderId,current.organizationId,batchId,orderId,current.organizationId).run();
    if(!result.meta.changes)return{formError:"订单文件不存在或不属于当前配载单"};
    await synchronizeOrderDocumentsModuleStatus({organizationId:current.organizationId,orderId,actorUserId:current.userId,now,source:"admin_review"});
    await writeAudit({request,action:"transport.batch.order_document.review",resourceType:"order_attachment",resourceId:attachmentId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,orderId,reviewStatus}});
    return{success:reviewStatus==="approved"?"订单文件已审核通过":"订单文件已退回"};
  }
  if(intent==="batch_order_customs_declaration_save"){
    const orderId=valueOf(form,"orderId"),declarationId=valueOf(form,"declarationId")||null;
    const releaseRequested=valueOf(form,"releaseDeclaration")==="1";
    const customsAccess=await loadBatchCustomsAccess(env.DB,current.organizationId,batchId);
    const orderCustomsAccess=customsAccess.orders.find(item=>item.orderId===orderId);
    if(!orderCustomsAccess)return{formError:"该订单不属于当前配载单"};
    if(releaseRequested&&!declarationId){
      return{formError:"确认放行必须选择当前订单已有的有效报关单"};
    }
    if(releaseRequested?!orderCustomsAccess.canRelease:!orderCustomsAccess.canManageDeclarations){
      const access=releaseRequested?orderCustomsAccess.releaseAccess:orderCustomsAccess.declarationAccess;
      return{formError:access.reason||`当前冻结工作流节点不允许${releaseRequested?"确认海关放行":"办理报关申报"}`};
    }
    const workflowPolicies=await loadBatchOrderWorkflowPolicies(current.organizationId,batchId);
    const customsPolicy=orderBatchWorkflowPolicy(workflowPolicies,orderId,"customs");
    if(!customsPolicy.enabled)return{formError:"当前订单工作流未启用报关模块"};
    const existingDeclaration=declarationId?await loadExistingCustomsDeclarationForMutation(env.DB,{
      declarationId,organizationId:current.organizationId,orderId,
    }):null;
    if(declarationId&&!existingDeclaration)return{formError:"要更新的申报单不存在"};
    if(releaseRequested&&(existingDeclaration?.is_deleted===1||existingDeclaration?.status==="cancelled")){
      return{formError:"已删单或已取消的报关记录不能确认放行，请先新增有效报关单"};
    }
    const resolved=resolveCustomsDeclarationWorkflowInput({
      form,fields:customsPolicy.fields,existing:existingDeclaration,now,
      autoDeclarationNumber:`AUTO-CUS-${orderId.slice(0,8)}-${Date.now().toString(36).toUpperCase()}`,
    });
    if(resolved.error||!resolved.value)return{formError:resolved.error||"报关单数据无效"};
    const {clearanceStage,declarationNumber,declarationType,declarationTitle,declaringCompany,
      declaredAt,currency,declaredAmount,grossWeightKg,isDeleted,changeReason,declarationStatus,
      releasedAt,isRedeclared,isAmended,isInspected}=resolved.value;
    if(declarationStatus==="released"&&!orderCustomsAccess.canRelease){
      return{formError:orderCustomsAccess.releaseAccess.reason||"当前冻结工作流节点不允许确认海关放行"};
    }
    if(declarationStatus==="released"){
      const documentGate=await checkOrderPreDepartureDocuments(current.organizationId,orderId);
      if(!documentGate.ready)return{formError:`确认放行前请先处理文件：${documentGate.reasons.join("；")}`};
    }
    let customsRecordId=valueOf(form,"customsRecordId")||existingDeclaration?.customs_record_id||null;
    if(customsRecordId){
      const record=await env.DB.prepare("SELECT id FROM order_customs_records WHERE id=? AND organization_id=? AND order_id=? AND clearance_stage=?").bind(customsRecordId,current.organizationId,orderId,clearanceStage).first();
      if(!record)return{formError:"所选报关任务不存在或阶段不一致"};
    }else{
      const record=await env.DB.prepare("SELECT id FROM order_customs_records WHERE organization_id=? AND order_id=? AND clearance_stage=? AND status!='cancelled' ORDER BY created_at LIMIT 1").bind(current.organizationId,orderId,clearanceStage).first<{id:string}>();
      customsRecordId=record?.id??crypto.randomUUID();
      if(!record)await env.DB.prepare("INSERT INTO order_customs_records(id,organization_id,order_id,clearance_stage,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,'draft',?,?,?)").bind(customsRecordId,current.organizationId,orderId,clearanceStage,current.userId,now,now).run();
    }
    try{
      if(declarationId){
        await env.DB.prepare(`UPDATE order_customs_declarations SET customs_record_id=?,declaration_number=?,declaration_type=?,declaration_title=?,declaring_company=?,declared_at=?,declared_amount=?,currency=?,gross_weight_kg=?,released_at=?,status=?,is_deleted=?,is_redeclared=?,is_amended=?,is_inspected=?,change_reason=?,updated_at=? WHERE id=? AND organization_id=? AND order_id=?`).bind(customsRecordId,declarationNumber,declarationType,declarationTitle,declaringCompany,declaredAt,declaredAmount,currency,grossWeightKg,declarationStatus==="released"?releasedAt:null,declarationStatus,isDeleted?1:0,isRedeclared?1:0,isAmended?1:0,isInspected?1:0,changeReason||null,now,declarationId,current.organizationId,orderId).run();
      }else{
        const id=crypto.randomUUID();
        await env.DB.prepare(`INSERT INTO order_customs_declarations(id,organization_id,order_id,customs_record_id,declaration_number,declaration_type,declaration_title,declaring_company,declared_at,declared_amount,currency,gross_weight_kg,released_at,status,is_deleted,is_redeclared,is_amended,is_inspected,change_reason,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,current.organizationId,orderId,customsRecordId,declarationNumber,declarationType,declarationTitle,declaringCompany,declaredAt,declaredAmount,currency,grossWeightKg,declarationStatus==="released"?releasedAt:null,declarationStatus,isDeleted?1:0,isRedeclared?1:0,isAmended?1:0,isInspected?1:0,changeReason||null,current.userId,now,now).run();
      }
    }catch(error){if(String(error).includes("UNIQUE"))return{formError:"同一订单的报关单号不能重复"};throw error}
    await syncCustomsModuleFromRecords(current.organizationId,orderId,current.userId);
    await writeAudit({request,action:declarationId?"transport.batch.order_customs_declaration.update":"transport.batch.order_customs_declaration.create",resourceType:"transport_order",resourceId:orderId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,declarationId,declarationNumber,clearanceStage,declarationStatus}});
    return{success:isDeleted?"本票报关单已标记删单，门禁与订单工作流已同步":"本票报关单已保存，门禁与订单工作流已同步"};
  }
  if(intent==="create_cost_allocation"){
    const chargeCode=valueOf(form,"chargeCode"),charge=COST_CHARGES.find(item=>item.code===chargeCode),method=valueOf(form,"method");
    if(!charge)return{formError:"请选择有效的分摊费用项目"};
    if(!["auto","weight","volume","equal"].includes(method))return{formError:"请选择有效的分摊方式"};
    try{
      const allocationId=await createCostAllocation(env.DB,{organizationId:current.organizationId,batchId,chargeCode:charge.code,chargeName:charge.name,counterpartyName:valueOf(form,"counterpartyName"),currency:valueOf(form,"currency")||"CNY",exchangeRate:positiveNumberOf(form,"exchangeRate",1),totalAmount:positiveNumberOf(form,"totalAmount"),method:method as "auto"|AllocationMethod,notes:valueOf(form,"allocationNotes"),userId:current.userId,now,assertCanMutate:assertCostCanMutate});
      await writeAudit({request,action:"transport.batch.cost_allocation.create",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,chargeCode}});
      return{success:"分摊草稿已生成；请逐票检查后再确认入账"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="update_cost_allocation"){
    const allocationId=valueOf(form,"allocationId"),method=valueOf(form,"method");
    if(!["weight","volume","equal"].includes(method))return{formError:"分摊方式无效"};
    const lineIds=form.getAll("lineId").map(String),amounts=form.getAll("lineAmount").map(value=>Number(value)),reasons=form.getAll("lineReason").map(String);
    try{
      await updateCostAllocation(env.DB,{organizationId:current.organizationId,allocationId,method:method as AllocationMethod,adjustments:lineIds.map((lineId,index)=>({lineId,amount:amounts[index],reason:reasons[index]||""})),now,assertCanMutate:assertCostCanMutate});
      await writeAudit({request,action:"transport.batch.cost_allocation.update",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId,method}});
      return{success:"分摊草稿已保存，尚未生成正式费用"};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="confirm_cost_allocation"){
    const allocationId=valueOf(form,"allocationId");
    try{
      await confirmCostAllocation(env.DB,{organizationId:current.organizationId,allocationId,userId:current.userId,now,assertCanMutate:assertCostCanMutate});
      const affectedOrders=await env.DB.prepare("SELECT DISTINCT order_id FROM transport_cost_allocation_lines WHERE organization_id=? AND allocation_id=?").bind(current.organizationId,allocationId).all<{order_id:string}>();
      const synchronizationFailures=(await mapWithConcurrency(affectedOrders.results,2,async(item)=>{
        try{
          await syncCostModuleStatusSafe(current.organizationId,item.order_id,now);
          await syncOrderWorkflowSnapshotSafe(current.organizationId,item.order_id);
          return null;
        }catch{return item.order_id;}
      })).filter((orderId):orderId is string=>orderId!==null);
      let auditFailed=false;
      try{await writeAudit({request,action:"transport.batch.cost_allocation.confirm",resourceType:"transport_cost_allocation",resourceId:allocationId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{batchId}})}catch{auditFailed=true}
      const warning=[
        synchronizationFailures.length?`${synchronizationFailures.length} 票订单的工作流快照待重试`:null,
        auditFailed?"审计记录暂未写入":null,
      ].filter(Boolean).join("；");
      return{success:`成本分摊已人工确认，并为各订单生成正式应付费用；该结果只影响内部应付和毛利，不会改客户应收。下一步请到订单费用模块确认、审核并锁定应付${warning?`；注意：${warning}`:""}`};
    }catch(error){return{formError:errorMessage(error)}}
  }
  if(intent==="exit_confirm"){
    if(!trackingActionPolicy)return{formError:"当前冻结工作流无法核验实际出境动作"};
    const participatingOrderIds=new Set(trackingActionPolicy.participatingOrderIds);
    const workflowPolicies=(await loadBatchOrderWorkflowPolicies(current.organizationId,batchId)).filter(policy=>participatingOrderIds.has(policy.orderId));
    const trackingModule=batchWorkflowModulePolicy(workflowPolicies,"tracking");
    const actualExitField=batchWorkflowFieldPolicy(workflowPolicies,"tracking","actual_exit_at",true);
    if(!trackingModule.enabled||!actualExitField.visible||!trackingActionPolicy.participatingOrderIds.length)return{formError:"当前配载单工作流未开放实际出境登记"};
    const submissionError=validateBatchWorkflowFormSubmission(workflowPolicies,form,exitFormBindings);
    if(submissionError)return{formError:submissionError};
    const mainVehiclePlate=await getBatchMainVehiclePlate(current.organizationId,batchId);
    const actualExitAt=valueOf(form,"actualExitAt")||now;
    const exitPort=valueOf(form,"exitPort")||batch.border_port||"未配置";
    const exitVehiclePlate=(valueOf(form,"exitVehiclePlate")||mainVehiclePlate||batch.overseas_vehicle_plate||"未配置").trim().toUpperCase();
    const overseasVehiclePlate=(batch.overseas_vehicle_plate||"").trim().toUpperCase(),overseasCarrierName=batch.overseas_carrier_name||"",overseasVehicleType=batch.overseas_vehicle_type||"",overseasDriverName=batch.overseas_driver_name||"",overseasDriverPhone=batch.overseas_driver_phone||"";
    const resourceValues:Record<string,string|number>={overseas_carrier_name:overseasCarrierName,overseas_vehicle_type:overseasVehicleType,overseas_vehicle_count:batch.overseas_vehicle_count,overseas_vehicle_plate:overseasVehiclePlate,overseas_driver_name:overseasDriverName,overseas_driver_phone:overseasDriverPhone};
    const missingResources=Object.entries(resourceValues).flatMap(([fieldKey,value])=>workflowPolicies.some(policy=>orderWorkflowFieldBlocksBatch(workflowPolicies,policy.orderId,"loading",fieldKey,true))&&!String(value||"").trim()?[batchWorkflowFieldPolicy(workflowPolicies,"loading",fieldKey,true).label||fieldKey]:[]);
    if(missingResources.length)return{formError:`当前工作流要求先补齐运输资源：${Array.from(new Set(missingResources)).join("、")}`};
    if(["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(batch.road_status))return{formError:"该批次已经完成出境确认，请勿重复操作"};
    const blockingExceptions=await listBlockingBatchExceptions(current.organizationId,batchId);
    if(blockingExceptions.length)return{formError:`暂不能确认出境：仍有 ${blockingExceptions.length} 个阻断异常（${blockingExceptions.slice(0,3).map(item=>item.exception_number).join("、")}）`};
    const orders=await env.DB.prepare(`SELECT bo.order_id,o.order_number,s.id shipment_id,s.customer_id,s.current_location FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id LEFT JOIN shipments s ON s.id=(SELECT id FROM shipments WHERE order_id=bo.order_id ORDER BY created_at DESC LIMIT 1) WHERE bo.batch_id=? AND bo.organization_id=? AND bo.status!='removed' ORDER BY bo.sequence_no`).bind(batchId,current.organizationId).all<{order_id:string;order_number:string;shipment_id:string|null;customer_id:string|null;current_location:string|null}>();
    const participatingOrders=orders.results.filter(order=>participatingOrderIds.has(order.order_id));
    if(participatingOrders.length!==trackingActionPolicy.participatingOrderIds.length)return{formError:"配载单挂载订单已变化，请刷新页面后重新办理实际出境"};
    const exitTrackingOrderIds=trackingActionPolicy.participatingOrderIds;
    const sequenceOrderIds=workflowPolicies.filter(policy=>policy.moduleCode==="tracking"&&policy.enabled&&runtimeWorkflowFieldPolicy(policy.fields,"actual_exit_at",true).visible&&orderWorkflowFieldBlocksBatch(workflowPolicies,policy.orderId,"tracking","tracking_milestone",true)).map(policy=>policy.orderId);
    const exitSequenceMissing=sequenceOrderIds.length?await validateBatchTrackingRequiredPrevious(current.organizationId,sequenceOrderIds,"exported",actualExitAt):null;
    if(exitSequenceMissing)return{formError:`暂不能确认出境：运输事件顺序要求已开放运踪节点的订单先登记不晚于实际出境时间的“口岸到达”；仍有 ${exitSequenceMissing.missingOrders} 票未满足${exitSequenceMissing.sampleOrderNumber?`（示例：${exitSequenceMissing.sampleOrderNumber}）` : ""}`};
    const blockers:string[]=[];
    for(const item of participatingOrders){
      const dispatched=await env.DB.prepare(`SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE d.organization_id=? AND d.transport_batch_id=? AND s.order_id=? AND d.status='dispatched' LIMIT 1`).bind(current.organizationId,batchId,item.order_id).first();
      if(!dispatched){blockers.push("存在尚未完成仓库装车出库交接的订单");continue;}
      const readiness=await checkOrderDeparture(current.organizationId,item.order_id,undefined,{warehouseDispatchConfirmed:true});
      if(!readiness.ready)blockers.push(...readiness.reasons);
    }
    if(blockers.length)return{formError:`暂不能确认出境：${[...new Set(blockers)].join("；")}`};
    const exitNotes=valueOf(form,"exitNotes")||null;
    const description=`批次 ${batch.batch_number} 已从 ${exitPort} 出境，车辆 ${exitVehiclePlate}${overseasVehiclePlate?`，境外车辆 ${overseasVehiclePlate}`:""}`;
    const exitMilestoneGroups=new Map<string,{orderIds:string[];notes:string|null}>();
    for(const orderId of exitTrackingOrderIds){
      const fields=orderBatchWorkflowPolicy(workflowPolicies,orderId,"tracking").fields;
      const notes=runtimeWorkflowFieldPolicy(fields,"tracking_notes").visible?exitNotes:null;
      const key=notes??"__hidden__";
      const group=exitMilestoneGroups.get(key)??{orderIds:[],notes};
      group.orderIds.push(orderId);
      exitMilestoneGroups.set(key,group);
    }
    // Keep the physical batch transition atomic, but constrain every order
    // mutation to the ids re-authorised by the frozen actual_exit_at policy.
    const exitOrderChunks=chunkD1Values(exitTrackingOrderIds,8);
    const statements:D1PreparedStatement[]=[
      env.DB.prepare("INSERT INTO transport_exit_confirmations(id,organization_id,batch_id,actual_exit_at,exit_port,exit_vehicle_plate,overseas_vehicle_plate,overseas_carrier_name,overseas_vehicle_type,overseas_driver_name,overseas_driver_phone,proof_reference,notes,confirmed_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),current.organizationId,batchId,actualExitAt,exitPort,exitVehiclePlate,overseasVehiclePlate||null,overseasCarrierName||null,overseasVehicleType||null,overseasDriverName||null,overseasDriverPhone||null,valueOf(form,"proofReference")||null,valueOf(form,"exitNotes")||null,current.userId,now),
      env.DB.prepare("UPDATE transport_batches SET status='departed',road_status='outbound_in_transit',actual_departure_at=?,border_port=?,updated_at=? WHERE id=? AND organization_id=?").bind(actualExitAt,exitPort,now,batchId,current.organizationId),
      env.DB.prepare("UPDATE transport_batch_vehicles SET status='departed',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='cancelled'").bind(now,batchId,current.organizationId),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`UPDATE transport_batch_orders
        SET status='departed',updated_at=?
        WHERE batch_id=? AND organization_id=? AND status!='removed'
          AND order_id IN (${d1Placeholders(chunk.length)})`).bind(now,batchId,current.organizationId,...chunk)),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`UPDATE order_module_instances
        SET status='in_progress',current_step_code='transit',current_step_name='出境运输中',progress_percent=50,
            started_at=COALESCE(started_at,?),blocking_reason=NULL,updated_at=?
        WHERE organization_id=? AND module_code='tracking' AND enabled=1
          AND order_id IN (${d1Placeholders(chunk.length)})
          AND EXISTS(SELECT 1 FROM transport_batch_orders bo
            WHERE bo.organization_id=order_module_instances.organization_id
              AND bo.order_id=order_module_instances.order_id
              AND bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed')`).bind(now,now,current.organizationId,...chunk,current.organizationId,batchId)),
      ...Array.from(exitMilestoneGroups.values()).flatMap(group=>chunkD1Values(group.orderIds,12).map(chunk=>env.DB.prepare(`INSERT INTO order_tracking_milestones(
          id,organization_id,order_id,milestone_code,milestone_name,event_at,
          location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at
        )
        SELECT lower(hex(randomblob(16))),bo.organization_id,bo.order_id,'exported','出境',?,?,?,?,1,?,?
        FROM transport_batch_orders bo
        WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
          AND bo.order_id IN (${d1Placeholders(chunk.length)})
          AND NOT EXISTS(
            SELECT 1 FROM order_tracking_milestones existing
            WHERE existing.organization_id=bo.organization_id AND existing.order_id=bo.order_id
              AND existing.milestone_code='exported' AND existing.event_at=?
          )`).bind(actualExitAt,exitPort,exitVehiclePlate,group.notes,current.userId,now,current.organizationId,batchId,...chunk,actualExitAt))),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`UPDATE order_cargo_packages
        SET status='in_transit'
        WHERE organization_id=? AND status NOT IN ('cancelled','delivered')
          AND order_id IN (${d1Placeholders(chunk.length)})
          AND EXISTS(SELECT 1 FROM transport_batch_orders bo
            WHERE bo.organization_id=order_cargo_packages.organization_id
              AND bo.order_id=order_cargo_packages.order_id
              AND bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed')`).bind(current.organizationId,...chunk,current.organizationId,batchId)),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`INSERT INTO order_tasks(
          id,organization_id,order_id,module_code,task_type,title,priority,status,
          assignee_user_id,assigned_by_user_id,created_at,updated_at
        )
        SELECT lower(hex(randomblob(16))),bo.organization_id,bo.order_id,'costs','start_receivable_reconciliation',
          '发起客户应收对账','normal','pending',NULL,?,?,?
        FROM transport_batch_orders bo
        WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
          AND bo.order_id IN (${d1Placeholders(chunk.length)})
          AND NOT EXISTS(
            SELECT 1 FROM order_tasks existing
            WHERE existing.organization_id=bo.organization_id AND existing.order_id=bo.order_id
              AND existing.task_type='start_receivable_reconciliation'
              AND existing.status IN ('pending','in_progress')
          )`).bind(current.userId,now,now,current.organizationId,batchId,...chunk)),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`UPDATE shipments
        SET status='in_transit',current_location=?,updated_at=?
        WHERE organization_id=? AND id IN (
          SELECT (
            SELECT latest.id FROM shipments latest
            WHERE latest.organization_id=bo.organization_id AND latest.order_id=bo.order_id
            ORDER BY latest.created_at DESC LIMIT 1
          )
          FROM transport_batch_orders bo
          WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
            AND bo.order_id IN (${d1Placeholders(chunk.length)})
        )`).bind(exitPort,now,current.organizationId,current.organizationId,batchId,...chunk)),
      ...exitOrderChunks.map(chunk=>env.DB.prepare(`INSERT INTO shipment_events(
          id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at
        )
        SELECT lower(hex(randomblob(16))),latest.id,'in_transit',?,?,?,1,?,?
        FROM transport_batch_orders bo
        JOIN shipments latest ON latest.id=(
          SELECT candidate.id FROM shipments candidate
          WHERE candidate.organization_id=bo.organization_id AND candidate.order_id=bo.order_id
          ORDER BY candidate.created_at DESC LIMIT 1
        )
        WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed'
          AND bo.order_id IN (${d1Placeholders(chunk.length)})`).bind(exitPort,description,actualExitAt,current.userId,now,current.organizationId,batchId,...chunk)),
    ];
    await env.DB.batch(statements);
    const postCommitWarnings:string[]=[];
    try{await writeAudit({request,action:"transport.batch.exit.confirm",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{actualExitAt,exitPort,exitVehiclePlate,orders:participatingOrders.length}})}catch{postCommitWarnings.push("审计记录暂未写入")}
    const workflowEventFailures=(await mapWithConcurrency(participatingOrders,2,async item=>{
      if(!item.shipment_id||!item.customer_id)return null;
      try{
        await recordWorkflowEvent({organizationId:current.organizationId,event:"shipment.in_transit",customerId:item.customer_id,orderId:item.order_id,shipmentId:item.shipment_id,actorUserId:current.userId,source:"admin",metadata:{batchId,batchNumber:batch.batch_number,exitPort,exitVehiclePlate,overseasVehiclePlate:overseasVehiclePlate||null,overseasCarrierName:overseasCarrierName||null,overseasDriverName:overseasDriverName||null}});
        return null;
      }catch{return item.order_number;}
    })).filter((orderNumber):orderNumber is string=>orderNumber!==null);
    if(workflowEventFailures.length)postCommitWarnings.push(`${workflowEventFailures.length} 票旧版工作流事件待重试`);
    return{success:`出境确认完成；批次内运单已统一进入出境运输中，轨迹已同步${postCommitWarnings.length?`；注意：${postCommitWarnings.join("；")}`:""}`};
  }
  if(intent==="overseas_arrival"){
    return{formError:"到达境外目的仓不能在配载单中手工确认，请由各订单指定的境外目的仓扫码入库并完成清点"};
  }
  if(intent==="batch_tracking_option_toggle"){
    if(!trackingActionPolicy)return{formError:"当前冻结工作流无法核验运踪节点设置"};
    const participatingOrderIds=new Set(trackingActionPolicy.participatingOrderIds);
    const workflowPolicies=(await loadBatchOrderWorkflowPolicies(current.organizationId,batchId)).filter(policy=>participatingOrderIds.has(policy.orderId));
    const trackingModule=batchWorkflowModulePolicy(workflowPolicies,"tracking");
    const milestoneField=batchWorkflowFieldPolicy(workflowPolicies,"tracking","tracking_milestone",true);
    if(!trackingModule.enabled||!milestoneField.visible)return{formError:"当前配载单工作流未开放运输节点设置"};
    const optionCode=valueOf(form,"optionCode");
    if(!BATCH_TRACKING_OPTIONAL_CODES.includes(optionCode))return{formError:"可选节点类型无效"};
    const enable=form.get("enable")==="on";
    const column=optionCode==="transloaded"?"requires_transloading":"requires_transit_customs";
    const orderIds=trackingActionPolicy.participatingOrderIds;
    if(!orderIds.length)return{formError:"当前批次没有可操作的订单"};
    for(const chunk of chunkD1Values(orderIds,3)){
      await env.DB.prepare(`UPDATE transport_orders SET ${column}=?,updated_at=?
        WHERE organization_id=? AND id IN (${d1Placeholders(chunk.length)})
          AND EXISTS(SELECT 1 FROM transport_batch_orders bo
            WHERE bo.organization_id=transport_orders.organization_id
              AND bo.order_id=transport_orders.id
              AND bo.batch_id=? AND bo.status!='removed')`)
        .bind(enable?1:0,now,current.organizationId,...chunk,batchId).run();
    }
    await writeAudit({request,action:"transport.batch.tracking_option.toggle",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{optionCode,enable,orders:orderIds.length}});
    return{success:enable?`已为 ${orderIds.length} 票订单开启"${optionCode==="transloaded"?"可换装":"可转运"}"`:`已为 ${orderIds.length} 票订单关闭"${optionCode==="transloaded"?"可换装":"可转运"}"`};
  }
  if(intent==="batch_tracking_add"){
    if(!trackingActionPolicy)return{formError:"当前冻结工作流无法核验运踪节点登记"};
    const participatingOrderIds=new Set(trackingActionPolicy.participatingOrderIds);
    const workflowPolicies=(await loadBatchOrderWorkflowPolicies(current.organizationId,batchId)).filter(policy=>participatingOrderIds.has(policy.orderId));
    const trackingModule=batchWorkflowModulePolicy(workflowPolicies,"tracking");
    if(!trackingModule.enabled)return{formError:"当前配载单工作流未启用运踪模块"};
    const submissionError=validateBatchWorkflowFormSubmission(workflowPolicies,form,trackingFormBindings);
    if(submissionError)return{formError:submissionError};
    const milestoneCode=valueOf(form,"milestoneCode");
    const milestoneDef=BATCH_TRACKING_MILESTONES.find(item=>item.code===milestoneCode);
    if(!milestoneDef)return{formError:"请选择有效的运输节点"};
    const blockingExceptions=await listBlockingBatchExceptions(current.organizationId,batchId);
    if(blockingExceptions.length){
      const sample=blockingExceptions.slice(0,3).map(item=>item.exception_number).join("、");
      return{formError:`存在 ${blockingExceptions.length} 项阻断推进的配载异常（${sample}），请先在“异常处理”中结案`};
    }
    if(milestoneCode==="exported")return{formError:"请切换到“装车出库与出境确认”，填写实际出境时间并确认；系统会自动登记出境节点"};
    if(milestoneCode==="station_arrived")return{formError:"到达境外目的仓不能手工登记，请由各订单指定的境外目的仓扫码入库并完成清点"};
    const eventAt=valueOf(form,"eventAt")||now;
    const orderIds=trackingActionPolicy.participatingOrderIds;
    if(!orderIds.length)return{formError:"当前批次没有可操作的订单"};
    // Structural integrity gate: configured fields decide whether the action
    // exists; once it exists, event chronology must remain coherent.
    const previousMissing=await validateBatchTrackingRequiredPrevious(current.organizationId,orderIds,milestoneCode,eventAt);
    if(previousMissing){
      return{formError:`节点"${milestoneDef.name}"要求每个订单已登记${BATCH_TRACKING_REQUIRED_PREVIOUS[milestoneCode]?.join("、")||"前置节点"}；${previousMissing.missingOrders} 票订单未满足${previousMissing.sampleOrderNumber?`（示例：${previousMissing.sampleOrderNumber}）`:""}`};
    }
    const locationValue=valueOf(form,"location")||null;
    const notesValue=valueOf(form,"notes")||null;
    const vehicleReference=valueOf(form,"vehicleReference")||null;
    const visibilityField=batchWorkflowFieldPolicy(workflowPolicies,"tracking","visible_to_customer",true);
    const visibleToCustomer=visibilityField.visible?form.get("visibleToCustomer")!=="off":true;
    const groupedTargets=new Map<string,{orderIds:string[];location:string|null;vehicle:string|null;notes:string|null;visible:boolean}>();
    for(const orderId of orderIds){
      const fields=orderBatchWorkflowPolicy(workflowPolicies,orderId,"tracking").fields;
      const target={
        location:runtimeWorkflowFieldPolicy(fields,"tracking_location",true).visible?locationValue:null,
        vehicle:runtimeWorkflowFieldPolicy(fields,"tracking_vehicle").visible?vehicleReference:null,
        notes:runtimeWorkflowFieldPolicy(fields,"tracking_notes").visible?notesValue:null,
        visible:runtimeWorkflowFieldPolicy(fields,"visible_to_customer",true).visible?visibleToCustomer:true,
      };
      const key=JSON.stringify(target);
      const group=groupedTargets.get(key)??{orderIds:[],...target};
      group.orderIds.push(orderId);
      groupedTargets.set(key,group);
    }
    const trackingInsertStatements:D1PreparedStatement[]=[];
    for(const group of groupedTargets.values())for(const chunk of chunkD1Values(group.orderIds,16)){
      trackingInsertStatements.push(env.DB.prepare(`INSERT INTO order_tracking_milestones(
        id,organization_id,order_id,milestone_code,milestone_name,event_at,
        location,vehicle_reference,notes,visible_to_customer,created_by_user_id,created_at
      )
      SELECT lower(hex(randomblob(16))),?,target.id,?,?,?,?,?,?,?,?,?
      FROM transport_orders target
      WHERE target.organization_id=? AND target.id IN (${d1Placeholders(chunk.length)})
        AND EXISTS(SELECT 1 FROM transport_batch_orders bo WHERE bo.organization_id=? AND bo.batch_id=? AND bo.order_id=target.id AND bo.status!='removed')
        AND NOT EXISTS(
          SELECT 1 FROM order_tracking_milestones existing
          WHERE existing.organization_id=? AND existing.order_id=target.id
            AND existing.milestone_code=? AND existing.event_at=?
        )`).bind(current.organizationId,milestoneCode,milestoneDef.name,eventAt,group.location,group.vehicle,group.notes,group.visible?1:0,current.userId,now,current.organizationId,...chunk,current.organizationId,batchId,current.organizationId,milestoneCode,eventAt));
    }
    await env.DB.batch(trackingInsertStatements);
    const postCommitWarnings:string[]=[];
    try{await writeAudit({request,action:"transport.batch.tracking.add",resourceType:"transport_batch",resourceId:batchId,organizationId:current.organizationId,actorUserId:current.userId,metadata:{milestoneCode,eventAt,orders:orderIds.length,location:locationValue,vehicleReference}})}catch{postCommitWarnings.push("审计记录暂未写入")}
    const moduleSyncFailures=(await mapWithConcurrency(orderIds,2,async(orderId)=>{
      try{await syncTrackingModuleStatusForOrder(current.organizationId,orderId,milestoneCode,current.userId,now);return null}catch{return orderId}
    })).filter((orderId):orderId is string=>orderId!==null);
    if(moduleSyncFailures.length)postCommitWarnings.push(`${moduleSyncFailures.length} 票轨迹模块状态待重试`);
    try{await syncBatchRoadStatusFromTracking(current.organizationId,batchId,orderIds,now)}catch{postCommitWarnings.push("批次道路状态待重试")}
    const milestoneStatusMap:Record<string,string>={border_arrived:"customs",exported:"in_transit",transloaded:"in_transit",transit_customs:"in_transit",foreign_entered:"in_transit",customs_cleared:"in_transit",station_arrived:"in_transit"};
    const shipmentStatus=milestoneStatusMap[milestoneCode]||"in_transit";
    try{
      await env.DB.batch(Array.from(groupedTargets.values()).flatMap(group=>{
        const shipmentDescription=`批次 ${batch.batch_number} 登记「${milestoneDef.name}」${group.location?`，地点 ${group.location}`:""}${group.vehicle?`，车辆 ${group.vehicle}`:""}`;
        return chunkD1Values(group.orderIds,8).flatMap(chunk=>[
        env.DB.prepare(`UPDATE shipments SET status=?,current_location=?,updated_at=?
          WHERE organization_id=? AND id IN (
            SELECT (SELECT latest.id FROM shipments latest
              WHERE latest.organization_id=bo.organization_id AND latest.order_id=bo.order_id
              ORDER BY COALESCE(latest.updated_at,latest.created_at) DESC,latest.created_at DESC LIMIT 1)
            FROM transport_batch_orders bo
            WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' AND bo.order_id IN (${d1Placeholders(chunk.length)})
          )`).bind(shipmentStatus,group.location,now,current.organizationId,current.organizationId,batchId,...chunk),
        env.DB.prepare(`INSERT INTO shipment_events(id,shipment_id,status,location,description,event_at,visible_to_customer,created_by_user_id,created_at)
          SELECT lower(hex(randomblob(16))),latest.id,?,?,?,?,?,?,?
          FROM transport_batch_orders bo
          JOIN shipments latest ON latest.id=(
            SELECT candidate.id FROM shipments candidate
            WHERE candidate.organization_id=bo.organization_id AND candidate.order_id=bo.order_id
            ORDER BY COALESCE(candidate.updated_at,candidate.created_at) DESC,candidate.created_at DESC LIMIT 1
          )
          WHERE bo.organization_id=? AND bo.batch_id=? AND bo.status!='removed' AND bo.order_id IN (${d1Placeholders(chunk.length)})`).bind(shipmentStatus,group.location,shipmentDescription,eventAt,group.visible?1:0,current.userId,now,current.organizationId,batchId,...chunk),
        ]);
      }));
    }catch{postCommitWarnings.push("运单轨迹事件待重试")}
    return{success:`已为 ${orderIds.length} 票订单登记「${milestoneDef.name}」（${eventAt}）${postCommitWarnings.length?`；节点已保存，注意：${postCommitWarnings.join("；")}`:"；模块进度与批次状态已同步"}`};
  }
  return{formError:"操作无效"};
}

export default function LoadingDetail({loaderData,actionData}:Route.ComponentProps){
  const [searchParams]=useSearchParams();
  const [detailDrawerOpen,setDetailDrawerOpen]=useState(false);
  const [detailDrawerOrderId,setDetailDrawerOrderId]=useState<string|null>(null);
  const detailDrawerTriggerRef=useRef<HTMLButtonElement>(null);
  useModalScrollLock(detailDrawerOpen);
  const busy=useNavigation().state!=="idle";
  const privileged=["BOSS","DEVELOPER"].includes(loaderData.current.positionCode??"")||loaderData.current.roleCodes.some(code=>["owner","boss","developer"].includes(code));
  const requiresSupervisorApproval=batchRequiresSupervisorApproval(loaderData.batch.batch_number);
  const batchApproved=!requiresSupervisorApproval||loaderData.batch.approval_status==="approved";
  const sharedResponsibilityActive=batchSharedResponsibilityIsActive(loaderData.batch.road_status);
  const currentIsBatchOperator=privileged||loaderData.batch.operation_assignee_user_id===loaderData.current.userId;
  const currentIsBatchDocumentOwner=privileged||loaderData.batch.document_assignee_user_id===loaderData.current.userId;
  const canManageBatchResponsibility=requiresSupervisorApproval&&(privileged||(loaderData.current.permissions.includes("transport.batch.approve")&&loaderData.batch.operation_supervisor_user_id===loaderData.current.userId));
  const canReviewBatch=loaderData.batch.approval_status==="submitted"&&canManageBatchResponsibility;
  const operationPermissionDisabledReasons=batchResponsibilityPermissionDisabledReasons(loaderData.operationMembers,"operation");
  const documentPermissionDisabledReasons=batchResponsibilityPermissionDisabledReasons(loaderData.documentMembers,"document");
  const initialOperationDisabledReasons={...operationPermissionDisabledReasons,...batchInitialResponsibilityDisabledReasons(loaderData.initialResponsibilityRestrictions,"operation")};
  const initialDocumentDisabledReasons={...documentPermissionDisabledReasons,...batchInitialResponsibilityDisabledReasons(loaderData.initialResponsibilityRestrictions,"document")};
  const hasFreshOperationCandidate=loaderData.operationMembers.some(member=>!initialOperationDisabledReasons[member.id]);
  const hasFreshDocumentCandidate=loaderData.documentMembers.some(member=>!initialDocumentDisabledReasons[member.id]);
  const hasQualifiedOperationCandidate=loaderData.operationMembers.some(member=>!operationPermissionDisabledReasons[member.id]);
  const hasQualifiedDocumentCandidate=loaderData.documentMembers.some(member=>!documentPermissionDisabledReasons[member.id]);
  const initialResponsibilityConfigurationReady=loaderData.initialResponsibilityRestrictions.configurationErrors.length===0;
  const freshInitialAssigneesAvailable=hasFreshOperationCandidate&&hasFreshDocumentCandidate&&initialResponsibilityConfigurationReady;
  const ordinaryReassignmentAllowed=canOrdinaryReassignBatchResponsibility({batchNumber:loaderData.batch.batch_number,approvalStatus:loaderData.batch.approval_status,roadStatus:loaderData.batch.road_status,actualDepartureAt:loaderData.batch.actual_departure_at});
  const canReassignBatch=loaderData.batch.approval_status==="approved"&&canManageBatchResponsibility&&(ordinaryReassignmentAllowed||privileged);
  const manage=batchApproved&&currentIsBatchOperator&&canManageOrderModule(loaderData.current,"loading");
  const manageTracking=batchApproved&&(sharedResponsibilityActive||privileged)&&currentIsBatchOperator&&canManageOrderModule(loaderData.current,"tracking");
  const manageDocuments=batchApproved&&(sharedResponsibilityActive||privileged)&&currentIsBatchDocumentOwner&&canManageOrderModule(loaderData.current,"documents");
  const manageCustoms=batchApproved&&(sharedResponsibilityActive||privileged)&&currentIsBatchDocumentOwner&&canManageOrderModule(loaderData.current,"customs");
  const manageExceptions=batchApproved&&(sharedResponsibilityActive||privileged)&&currentIsBatchOperator&&canManageOrderModule(loaderData.current,"exceptions");
  const manageCosts=loaderData.canManageBatchCosts;
  const totals=summarizeBatch(loaderData.orders,loaderData.vehicles);
  const orderPagination=paginateList(loaderData.orders,readListPage(searchParams,"orderPage"));
  const visibleOrders=orderPagination.items;
  const loadingPlanValues:Record<string,string|null>={main_carrier_id:loaderData.batch.carrier_id,exit_port:loaderData.batch.border_port,planned_exit_at:loaderData.batch.planned_departure_at,customs_location:loaderData.batch.customs_location};
  const planReady=Object.entries(loadingPlanValues).every(([fieldKey,value])=>!loaderData.batchWorkflowPolicies.some(policy=>orderWorkflowFieldBlocksBatch(loaderData.batchWorkflowPolicies,policy.orderId,"loading",fieldKey,true))||Boolean(String(value||"").trim()));
  const loadPlanReady=planReady&&loaderData.vehicles.length>0;
  const flagsByOrder=new Map(loaderData.trackingFlags.map(item=>[item.order_id,item]));
  const requiresTransloading=loaderData.orders.some(o=>flagsByOrder.get(o.order_id)?.requires_transloading===1);
  const dispatchedCount=loaderData.batchCustomsAccess.dispatched;
  const allDispatched=loaderData.batchCustomsAccess.allDispatched;
  const pendingDispatchOrders=loaderData.orders.filter(order=>!loaderData.outboundStatuses.find(item=>item.order_id===order.order_id)?.dispatched);
  const customsPolicyFor=(orderId:string)=>orderBatchWorkflowPolicy(loaderData.batchWorkflowPolicies,orderId,"customs");
  // Only a required customs module may block batch progress. Visible optional
  // customs work remains actionable and is presented as optional in the UI.
  const customsReadyForOrder=(orderId:string)=>{
    const requirementGroup=loaderData.orderDocumentRequirements.find(group=>group.orderId===orderId);
    const modulePolicy=customsPolicyFor(orderId);
    if(!modulePolicy.enabled||!modulePolicy.required)return true;
    const customs=loaderData.customsSummaries.find(item=>item.order_id===orderId);
    const declarationsRequired=runtimeWorkflowFieldPolicy(modulePolicy.fields,"customs_declarations",true).required;
    const releaseRequired=runtimeWorkflowFieldPolicy(modulePolicy.fields,"customs_release",true).required;
    const customsDeclReady=(!declarationsRequired||Boolean(customs&&customs.total>0))&&(!releaseRequired||Boolean(customs&&customs.total>0&&customs.released===customs.total));
    const files=loaderData.orderDocuments.filter(item=>item.order_id===orderId);
    const requiredCustomsDocuments=(requirementGroup?.documents??[]).filter(document=>document.moduleCode==="customs"&&document.isActive&&document.isRequired);
    const customsFilesApproved=requiredCustomsDocuments.every(document=>files.some(item=>item.document_category===document.code&&["approved","archived"].includes(item.review_status)));
    return customsDeclReady&&customsFilesApproved;
  };
  const customsReadyCount=loaderData.orders.filter(order=>customsReadyForOrder(order.order_id)).length;
  const allCustomsReady=loaderData.orders.length>0&&customsReadyCount===loaderData.orders.length;
  const allRequiredDocumentsReady=loaderData.orders.length>0&&loaderData.orders.every(order=>{
    const requirements=loaderData.orderDocumentRequirements.find(group=>group.orderId===order.order_id)?.documents??[];
    const files=loaderData.orderDocuments.filter(item=>item.order_id===order.order_id);
    const customsModule=customsPolicyFor(order.order_id);
    const blockingRequirements=requirements.filter(requirement=>requirement.moduleCode!=="customs"||(customsModule.enabled&&customsModule.required));
    return summarizeLoadingDocumentRequirements(blockingRequirements,files).complete;
  });
  const allDocumentGateReady=allCustomsReady&&allRequiredDocumentsReady;
  const activeExceptions=loaderData.batchExceptions.filter(item=>isActiveExceptionStatus(item.status));
  const blockingExceptions=activeExceptions.filter(item=>item.blocks_progress===1);
  const exited=["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status);
  const arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status);
  const defaultActiveTab:BatchWorkspaceTab=activeExceptions.length?"exceptions":arrived?"overseas":exited?"tracking":!allDispatched?"batch":!allDocumentGateReady?"documents":"tracking";
  const requestedTab=searchParams.get("tab");
  const activeTab:BatchWorkspaceTab=isBatchWorkspaceTab(requestedTab)?requestedTab:defaultActiveTab;
  const tabHref=(tab:BatchWorkspaceTab)=>{const next=new URLSearchParams(searchParams);next.set("tab",tab);next.delete("orderPage");next.delete("documentView");return `?${next.toString()}`};
  const orderDepartureReady=loaderData.departureGateStatuses.every(item=>item.ready);
  const transportResourceValues:Record<string,string|number|null>={overseas_carrier_name:loaderData.batch.overseas_carrier_name,overseas_vehicle_type:loaderData.batch.overseas_vehicle_type,overseas_vehicle_count:loaderData.batch.overseas_vehicle_count,overseas_vehicle_plate:loaderData.batch.overseas_vehicle_plate,overseas_driver_name:loaderData.batch.overseas_driver_name,overseas_driver_phone:loaderData.batch.overseas_driver_phone};
  const hasRequiredTransportResources=Object.keys(transportResourceValues).some(fieldKey=>loaderData.batchWorkflowPolicies.some(policy=>orderWorkflowFieldBlocksBatch(loaderData.batchWorkflowPolicies,policy.orderId,"loading",fieldKey,true)));
  const missingRequiredTransportResources=Object.entries(transportResourceValues).flatMap(([fieldKey,value])=>loaderData.batchWorkflowPolicies.some(policy=>orderWorkflowFieldBlocksBatch(loaderData.batchWorkflowPolicies,policy.orderId,"loading",fieldKey,true))&&!String(value||"").trim()?[batchWorkflowFieldPolicy(loaderData.batchWorkflowPolicies,"loading",fieldKey,true).label||fieldKey]:[]);
  const transportResourceReady=missingRequiredTransportResources.length===0;
  const actualExitField=batchWorkflowFieldPolicy(loaderData.batchWorkflowPolicies,"tracking","actual_exit_at",true);
  const trackingModule=batchWorkflowModulePolicy(loaderData.batchWorkflowPolicies,"tracking");
  const actualExitAvailable=trackingModule.enabled&&actualExitField.visible;
  const sequenceOrders=loaderData.orders.filter(order=>{const policy=orderBatchWorkflowPolicy(loaderData.batchWorkflowPolicies,order.order_id,"tracking");return policy.enabled&&runtimeWorkflowFieldPolicy(policy.fields,"actual_exit_at",true).visible&&orderWorkflowFieldBlocksBatch(loaderData.batchWorkflowPolicies,order.order_id,"tracking","tracking_milestone",true);});
  const borderArrivalReady=sequenceOrders.length===0||sequenceOrders.every(order=>missingBatchTrackingPrerequisites(loaderData.trackingMilestones.filter(item=>item.order_id===order.order_id).map(item=>item.milestone_code),"exported").length===0);
  const canConfirmExit=actualExitAvailable&&allDispatched&&orderDepartureReady&&transportResourceReady&&borderArrivalReady&&!blockingExceptions.length;
  const exitBlockers=[
    ...pendingDispatchOrders.map(order=>`${order.order_number}：[结构性交接] 仓库装车出库尚未完成`),
    ...missingRequiredTransportResources.map(label=>`[工作流必填] 运输资源“${label}”尚未补齐`),
    ...(!borderArrivalReady?["[结构性顺序] 已要求运踪节点的订单仍未登记口岸到达"]:[]),
    ...blockingExceptions.map(item=>`${item.exception_number}：[阻断异常] ${item.description}`),
    ...loaderData.departureGateStatuses.flatMap(item=>item.reasons.map(reason=>`${loaderData.orders.find(order=>order.order_id===item.order_id)?.order_number||"订单"}：[工作流门禁] ${reason}`)),
  ];
  const currentWork=getBatchCurrentWork({status:loaderData.batch.road_status,documentGateReady:allDocumentGateReady,loadPlanReady,warehouseReady:allDispatched,borderArrivalReady,exceptionCount:activeExceptions.length});
  const closeDetailDrawer=()=>{
    setDetailDrawerOpen(false);
    setDetailDrawerOrderId(null);
    window.requestAnimationFrame(()=>detailDrawerTriggerRef.current?.focus());
  };
  const openDetailDrawer=(orderId?:string)=>{
    setDetailDrawerOrderId(orderId||null);
    setDetailDrawerOpen(true);
  };
  const overseasInboundHandoff=resolveBatchOverseasInboundHandoff(loaderData.orders);
  return <><header className="page-header batch-tracking-page-header"><div><p className="eyebrow">PZ LOAD · TRANSPORT TRACKING</p><h1>{loaderData.batch.batch_number}</h1><p>{loaderData.batch.batch_name} · {loaderData.batch.origin_location} → {loaderData.batch.destination_location}</p></div><div className="page-actions">{loaderData.returnOrderId&&<Link className="secondary" to={`/admin/orders/${loaderData.returnOrderId}`}>返回订单详情</Link>}<Link className="secondary" to="/admin/loading">返回配载单跟踪</Link><span className="status-pill">{allDispatched?"后台运输跟踪":"等待仓库出库"}</span><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div></header><ActionToast signal={actionData} message={actionData?.formError??actionData?.success} tone={actionData?.formError?"error":"success"}/>
  <div className="batch-detail-layout"><main className="batch-detail-main">
  {requiresSupervisorApproval&&loaderData.batch.approval_status==="submitted"&&<section className="panel batch-command-panel">
    <div className="panel-header"><div><h2>配载单待操作主管审核与统一分配</h2><p>一次选择整批操作负责人和整批单证负责人；提交成功后，两人分别接管本 PZ 下全部订单的后续共同业务。</p></div><span className="status-pill warning">待审核</span></div>
    {canReviewBatch?<><div className="alert info"><strong>首次交接必须换人：</strong>系统按每票订单锁定的工作流快照识别未完成操作/单证职责；原负责人在候选项中禁用并显示关联订单。新负责人接管整张 PZ，旧负责人仅保留历史订单只读权限。</div>{loaderData.initialResponsibilityRestrictions.configurationErrors.length>0?<div className="alert error" role="alert"><strong>工作流配置阻断：</strong>{loaderData.initialResponsibilityRestrictions.configurationErrors.join("；")}</div>:!freshInitialAssigneesAvailable&&<div className="alert warning" role="alert">当前组织没有同时可用的新操作负责人和新单证负责人；请先在组织架构中新增或启用其他人员。</div>}<Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="batch_approve"/><OrganizationAssigneePicker members={loaderData.operationMembers} name="operationAssigneeUserId" idPrefix="batch-operation-owner" personLabel="整批操作负责人" disabledUserReasons={initialOperationDisabledReasons} required/><OrganizationAssigneePicker members={loaderData.documentMembers} name="documentAssigneeUserId" idPrefix="batch-document-owner" personLabel="整批单证负责人" disabledUserReasons={initialDocumentDisabledReasons} required/><button className="primary span-2" disabled={busy||!freshInitialAssigneesAvailable}>审核通过并统一交接全部订单</button></Form><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="batch_reject"/><label className="field span-2"><span>退回原因</span><input name="rejectionNotes" placeholder="如需退回，请说明仓库应调整的内容"/></label><button className="secondary span-2" disabled={busy}>退回仓库调整</button></Form></>:<div className="alert warning">本配载单已提交给 {loaderData.batch.operation_supervisor_name||"指定操作主管"}；当前账号仅可查看，等待主管审核。</div>}
  </section>}
  {requiresSupervisorApproval&&loaderData.batch.approval_status==="approved"&&<section className="panel batch-command-panel batch-responsibility-panel"><div className="alert success batch-responsibility-status">已审核 · 操作：<strong>{loaderData.batch.operation_assignee_name||"待补充分配"}</strong> · 单证：<strong>{loaderData.batch.document_assignee_name||"待补充分配"}</strong><span>境外仓入库后转为只读</span></div>{canReassignBatch&&<details><summary>{loaderData.batch.operation_assignee_user_id&&loaderData.batch.document_assignee_user_id?"变更整批负责人":"补全整批负责人"}</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="batch_reassign"/><OrganizationAssigneePicker members={loaderData.operationMembers} name="operationAssigneeUserId" idPrefix="batch-reassign-operation" personLabel="整批操作负责人" required/><OrganizationAssigneePicker members={loaderData.documentMembers} name="documentAssigneeUserId" idPrefix="batch-reassign-document" personLabel="整批单证负责人" required/><label className="field span-2"><span>{ordinaryReassignmentAllowed?"变更说明（可选）":"异常改派原因（必填）"}</span><input name="reassignReason" required={!ordinaryReassignmentAllowed} placeholder="系统将通知新负责人并保留旧负责人历史只读记录"/></label><button className="primary span-2" disabled={busy}>确认统一改派</button></Form></details>}</section>}
  {requiresSupervisorApproval&&loaderData.batch.approval_status==="rejected"&&<div className="alert warning">配载单已退回仓库调整，重新提交审核前管理端保持只读。</div>}
  <section className="panel batch-command-panel batch-execution-overview">
    <div className="panel-header"><div><h2>配载单执行</h2></div><span className="status-pill">{roadStatusLabels[loaderData.batch.road_status]||loaderData.batch.road_status}</span></div>
    <BatchWorkspaceTabs status={loaderData.batch.road_status} documentGateReady={allDocumentGateReady} loadPlanReady={loadPlanReady} warehouseReady={allDispatched} borderArrivalReady={borderArrivalReady} exceptionCount={activeExceptions.length} activeTab={activeTab} tabHref={tabHref}/>
  </section>
  {activeTab==="tracking"&&<BatchTrackingWorkbench batchId={loaderData.batch.id} batchNumber={loaderData.batch.batch_number} orders={loaderData.orders} visibleOrders={visibleOrders} orderPagination={orderPagination} trackingMilestones={loaderData.trackingMilestones} trackingFlags={loaderData.trackingFlags} workflowPolicies={loaderData.batchWorkflowPolicies} milestoneAction={loaderData.trackingMilestoneAction} actualExitAction={loaderData.actualExitAction} batchVehiclePlate={loaderData.batchVehiclePlate} overseasVehiclePlate={loaderData.batch.overseas_vehicle_plate||null} borderPort={loaderData.batch.border_port||null} customsLocation={loaderData.batch.customs_location||null} busy={busy} manage={manageTracking&&allDispatched} warehouseReady={allDispatched} documentGateReady={allDocumentGateReady} exitConfirmed={exited} canConfirmExit={canConfirmExit} exitBlockers={Array.from(new Set(exitBlockers))} borderPorts={loaderData.borderPorts} documentsHref={tabHref("documents")} actionCloseSignal={actionData?.success?actionData:undefined}/>} 
  {activeTab==="documents"&&<BatchDocumentWorkbench batchId={loaderData.batch.id} orders={loaderData.orders} visibleOrders={visibleOrders} orderPagination={orderPagination} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} orderDocumentRequirements={loaderData.orderDocumentRequirements} customsSummaries={loaderData.customsSummaries} customsDeclarations={loaderData.customsDeclarations} workflowPolicies={loaderData.batchWorkflowPolicies} customsAccesses={loaderData.batchCustomsAccess.orders} busy={busy} manageDocuments={manageDocuments} manageCustoms={manageCustoms} currentUserId={loaderData.current.userId} documentOwnerUserId={loaderData.batch.document_assignee_user_id} documentOwnerName={loaderData.batch.document_assignee_name} privileged={privileged} requiresTransloading={requiresTransloading} ready={allDocumentGateReady} customsCloseSignal={actionData?.success?actionData:undefined} onOpenOrderDossier={orderId=>openDetailDrawer(orderId)}/>} 
  {activeTab==="exceptions"&&<BatchExceptionWorkbench batch={loaderData.batch} orders={loaderData.orders} packages={loaderData.exceptionPackages} exceptions={loaderData.batchExceptions} busy={busy} manage={manageExceptions} closeSignal={actionData?.success?actionData:undefined}/>}
  {activeTab==="batch"&&<><section className="panel loading-sheet batch-tab-panel" id="batch-arrangement">
    <div className="batch-detail-summary"><div><h2>仓库配载结果</h2><p>由仓库端自动同步，管理后台只读查看。</p></div><div className="loading-sheet-state batch-detail-summary-status"><span>{loaderData.orders.length} 票</span><span>{loaderData.vehicles.length} 车</span><b>{allDispatched?"仓库已出库":loadPlanReady&&allDocumentGateReady?"待仓库装车":"待仓库补齐"}</b></div></div>
    <div className="batch-detail-disclosure-body">
    <div className="loading-summary-strip">
      <span>起运地<strong>{loaderData.batch.origin_location}</strong></span>
      <span>目的地<strong>{loaderData.batch.destination_location}</strong></span>
      <span>承运商<strong>{loaderData.batch.carrier_name||"待选择"}</strong></span>
      <span>计划发车<strong>{formatShortDateTime(loaderData.batch.planned_departure_at)}</strong></span>
      <span>报关门禁<strong className={allCustomsReady?"":"danger-text"}>{allCustomsReady?"全部通过":"待处理"}</strong></span>
    </div>
    <div className="loading-sheet-layout">
      <div className="loading-preparation-summary loading-sheet-readonly">
        <span><b>生成仓库</b>{loaderData.batch.warehouse_name||"未记录"}</span>
        <span><b>运输线路</b>{loaderData.batch.route_notes||"未填写"}</span>
        <span><b>出境口岸</b>{loaderData.batch.border_port||"待仓库补齐"}</span>
        <span><b>清关地</b>{loaderData.batch.customs_location||"待仓库补齐"}</span>
        <span><b>计划发车</b>{formatShortDateTime(loaderData.batch.planned_departure_at)}</span>
        <span><b>计划到达</b>{formatShortDateTime(loaderData.batch.planned_arrival_at)}</span>
        <span><b>境外承运商</b>{loaderData.batch.overseas_carrier_name||loaderData.batch.carrier_name||"待仓库补齐"}</span>
        <span><b>车辆 / 司机</b>{loaderData.batch.overseas_vehicle_plate||"待仓库补齐"} · {loaderData.batch.overseas_driver_name||"待仓库补齐"} · {loaderData.batch.overseas_driver_phone||"电话待补齐"}</span>
      </div>
      <aside className="loading-sheet-tools">
        <section className="loading-tool-table"><div className="table-wrap"><table><thead><tr><th>数据来源</th><th>同步方式</th></tr></thead><tbody><tr><td><strong>仓库端货物配载</strong><small>配载单、挂载订单、车辆司机、文件和出库状态均以仓库端数据为准。</small></td><td><span className="status-pill success">自动同步</span></td></tr></tbody></table></div></section>
      </aside>
    </div>
    <LoadingTotals totals={totals}/>
    <div className="loading-sheet-columns">
      <section className="loading-sheet-section"><header><h3>挂载订单</h3><span>货物名称按每票货物明细完整汇总；这些完整订单跟随本配载单统一推进</span></header><div className="table-wrap loading-sheet-table"><table><thead><tr><th>订单号</th><th>工作号</th><th>委托人</th><th>起运地</th><th>目的地</th><th>货物名称</th><th>件数</th><th>报关重量</th><th>报关体积</th><th>进仓重量</th><th>进仓体积</th><th>入库时间</th><th>货物状态</th><th>配载车辆</th><th>境外仓</th><th>查看</th></tr></thead><tbody>{visibleOrders.map(item=><tr key={item.order_id}><td><strong><OrderNumberLink id={item.order_id} number={item.order_number}/></strong></td><td>{item.work_number}</td><td>{item.customer_name}</td><td>{loaderData.batch.origin_location}</td><td>{loaderData.batch.destination_location}</td><td><strong className="loading-cargo-names">{item.cargo_names||item.cargo_description||"未填写"}</strong></td><td>{item.pieces}</td><td>{item.declared_weight_kg.toFixed(2)}</td><td>{item.declared_volume_cbm.toFixed(3)}</td><td>{item.gross_weight_kg.toFixed(2)}</td><td>{item.volume_cbm.toFixed(3)}</td><td>{item.inbound_at?formatShortDateTime(item.inbound_at):<span className="off">未入库</span>}</td><td>{item.dispatched_packages>0?<span className="status-pill success">已出库 {item.dispatched_packages}</span>:item.inbound_at?(item.in_stock_packages>0?<span className="status-pill">在库 {item.in_stock_packages}</span>:<span className="status-pill off">无在库包装</span>):<span className="status-pill off">未入库</span>}</td><td>{loaderData.vehicles.map(vehicle=>vehicle.plate_number||vehicle.vehicle_no).join("、")||"待仓库补齐"}</td><td>{item.overseas_status==="arrived"||item.overseas_status==="notified"||item.overseas_status==="appointment"||item.overseas_status==="picked_up"?<span className="status-pill success">{item.overseas_arrival_at?`已到仓 ${formatShortDateTime(item.overseas_arrival_at)}`:"已到仓"}</span>:<span className="status-pill off">未到仓</span>}</td><td><div className="loading-row-actions"><Link className="text-button" to={`/admin/orders/${item.order_id}`}>订单详情</Link><Link className="text-button" to={tabHref("documents")}>报关状态</Link></div></td></tr>)}</tbody></table></div><QueryPagination {...orderPagination} pageParam="orderPage" unit="票订单"/></section>
      <section className="loading-sheet-section"><header><h3>运输车辆</h3><span>重量和体积仅供人工判断，系统不校验是否超载</span></header><div className="table-wrap loading-vehicle-table"><table><thead><tr><th>车辆编号</th><th>车牌</th><th>车型</th><th>司机</th><th>电话</th><th>整批实收重量</th><th>整批实收体积</th><th>挂载订单</th></tr></thead><tbody>{loaderData.vehicles.map(vehicle=><tr key={vehicle.id}><td><strong>{vehicle.vehicle_no}</strong></td><td>{vehicle.plate_number||"车牌待录"}</td><td>{vehicle.vehicle_type||"车型待录"}</td><td>{vehicle.driver_name||"司机待定"}</td><td>{vehicle.driver_phone||"电话待录"}</td><td>{totals.actualWeight.toFixed(2)} KG</td><td>{totals.actualVolume.toFixed(3)} CBM</td><td>{loaderData.orders.length} 票完整订单</td></tr>)}{!loaderData.vehicles.length&&<tr><td colSpan={8} className="empty-state">当前配载单还没有运输车辆。</td></tr>}</tbody></table></div></section>
    </div>
    </div>
  </section>
  {loaderData.showBatchCosts&&loaderData.costAllocations&&<CostAllocationSection allocations={loaderData.costAllocations} busy={busy} manage={manageCosts} blockedReason={loaderData.batchCostBlockedReason}/>}</>}
  {activeTab==="outbound"&&<section className="panel batch-tab-panel" id="batch-exit-gate"><div className="panel-header"><div><h2>装车出库</h2><p>本页只核对仓库装车和出库交接结果；后续报关、口岸到达与实际出境按页签顺序办理。</p></div><span className={`status-pill ${allDispatched?"success":""}`}>{allDispatched?"已完成":"待仓库办理"}</span></div>
    <div className="table-wrap batch-exit-gate-table"><table><thead><tr><th>装车项目</th><th>当前状态</th><th>核对结果</th></tr></thead><tbody>
      <tr className="completed-row"><td><strong>配载单同步</strong></td><td><span className="status-pill success">已通过</span></td><td>{loaderData.batch.batch_number} 已由仓库生成</td></tr>
      <tr className={hasRequiredTransportResources?(transportResourceReady?"completed-row":"blocked-row"):"readonly-row"}><td><strong>运输车辆与司机</strong></td><td><span className={`status-pill ${hasRequiredTransportResources?(transportResourceReady?"success":"danger"):"off"}`}>{hasRequiredTransportResources?(transportResourceReady?"必填项已齐":"必填项待补齐"):"当前工作流选填"}</span></td><td>{loaderData.batch.overseas_carrier_name||loaderData.batch.overseas_vehicle_plate?`${loaderData.batch.overseas_carrier_name||"承运方未填"} · ${loaderData.batch.overseas_vehicle_plate||"车牌未填"}`:hasRequiredTransportResources?"承运方、车辆或司机必填资料未齐":"未填写也不阻断当前流程"}</td></tr>
      <tr className={allDispatched?"completed-row":"blocked-row"}><td><strong>仓库装车出库</strong></td><td><span className={`status-pill ${allDispatched?"success":"danger"}`}>{allDispatched?"已完成":"待办理"}</span></td><td>{allDispatched?"全部订单已完成装车和出库交接":`${dispatchedCount}/${loaderData.orders.length} 票已完成；待处理：${pendingDispatchOrders.map(order=>order.order_number).join("、")}`}</td></tr>
    </tbody></table></div>
    {allDispatched?<div className="batch-outbound-next"><div><strong>装车出库已完成</strong><span>{allDocumentGateReady?"下一步登记口岸到达并确认实际出境。":"下一步由单证负责人完成逐票报关与放行。"}</span></div><Link className="primary" to={tabHref(allDocumentGateReady?"tracking":"documents")}>{allDocumentGateReady?"进入口岸到达与出境":"进入报关与文件"}</Link></div>:<div className="batch-gate-blocker"><div><strong>等待仓库完成装车出库</strong><p>仓库交接完成后，本配载单会自动进入下一环节。</p></div><div className="batch-gate-actions"><Link className="secondary" to={tabHref("batch")}>查看仓库配载结果</Link></div></div>}
  </section>}
  {activeTab==="overseas"&&<section className="panel batch-tab-panel" id="overseas-warehouse-receiving"><div className="panel-header"><div><h2>境外目的仓收货清点</h2><p>整张 PZ 一次交接到指定目的仓；仓库仍须逐票扫描原 OUL 货物码并分别留痕。</p></div><span className="status-pill">{loaderData.orders.filter(item=>item.overseas_status&&item.overseas_status!=="waiting_arrival").length}/{loaderData.orders.length} 票到仓</span></div>{loaderData.batch.road_status==="outbound_in_transit"&&manage?<>{overseasInboundHandoff.available?<WarehouseOverseasInboundAction batchId={loaderData.batch.id} batchNumber={loaderData.batch.batch_number} warehouseId={overseasInboundHandoff.warehouseId} orderIds={overseasInboundHandoff.orderIds}/>:<div className="alert error">{overseasInboundHandoff.reason}</div>}<div className="table-wrap overseas-receiving-table"><table><thead><tr><th>订单</th><th>客户</th><th>境外目的仓</th><th>当前状态</th></tr></thead><tbody>{visibleOrders.map(item=><tr key={item.order_id}><td><strong><OrderNumberLink id={item.order_id} number={item.order_number}/></strong></td><td>{item.customer_name}</td><td>{item.overseas_warehouse_name||"未指定"}</td><td><span className={`status-pill ${item.overseas_status&&item.overseas_status!=="waiting_arrival"?"success":""}`}>{item.overseas_status&&item.overseas_status!=="waiting_arrival"?"已清点到仓":"待仓库收货"}</span></td></tr>)}</tbody></table></div><QueryPagination {...orderPagination} pageParam="orderPage" unit="票订单"/></>:["overseas_arrived","waiting_pickup","pickup_completed"].includes(loaderData.batch.road_status)?<div className="alert success">本配载单全部订单已经境外仓扫码入库并清点，客户通知已由系统自动发送。</div>:<div className="alert warning">当前步骤尚未开放：请先完成装车出库与出境确认。</div>}</section>}
  </main><BatchDetailSideRail batch={loaderData.batch} totals={totals} vehicles={loaderData.vehicles} packageLabelCount={loaderData.exceptionPackages.length} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} customsReadyCount={customsReadyCount} trackingCount={loaderData.trackingMilestones.length} activeExceptionCount={activeExceptions.length} blockingExceptionCount={blockingExceptions.length} currentWork={currentWork} tabHref={tabHref} onOpen={()=>openDetailDrawer()} open={detailDrawerOpen} triggerRef={detailDrawerTriggerRef}/></div>
  {detailDrawerOpen&&<BatchDetailDrawer batch={loaderData.batch} orders={loaderData.orders} cargoItems={loaderData.batchCargoItems} packageLabels={loaderData.exceptionPackages} totals={totals} vehicles={loaderData.vehicles} batchDocuments={loaderData.batchDocuments} orderDocuments={loaderData.orderDocuments} orderDocumentArchive={loaderData.orderDocumentArchive} customsReadyCount={customsReadyCount} trackingCount={loaderData.trackingMilestones.length} activeExceptionCount={activeExceptions.length} blockingExceptionCount={blockingExceptions.length} currentWork={currentWork} selectedOrderId={detailDrawerOrderId} onClose={closeDetailDrawer}/>} 
  </>}

function BatchDetailSideRail({batch,totals,vehicles,packageLabelCount,batchDocuments,orderDocuments,customsReadyCount,trackingCount,activeExceptionCount,blockingExceptionCount,currentWork,tabHref,onOpen,open,triggerRef}:{batch:Batch;totals:ReturnType<typeof summarizeBatch>;vehicles:Vehicle[];packageLabelCount:number;batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];customsReadyCount:number;trackingCount:number;activeExceptionCount:number;blockingExceptionCount:number;currentWork:{title:string;hint:string};tabHref:(tab:BatchWorkspaceTab)=>string;onOpen:()=>void;open:boolean;triggerRef:RefObject<HTMLButtonElement|null>}){
  const vehicleNames=vehicles.map(vehicle=>vehicle.plate_number||vehicle.vehicle_no).filter(Boolean);
  const vehicleSummary=vehicleNames.length?vehicleNames.join("、"):batch.overseas_vehicle_plate||"待仓库补齐";
  const fileCount=batchDocuments.length+orderDocuments.length;
  const routeSummary=`${batch.origin_location} → ${batch.destination_location}`;
  const receiptSummary=`${totals.pieces} 件 · ${totals.actualWeight.toFixed(2)} KG · ${totals.actualVolume.toFixed(3)} CBM`;
  return <aside className="linear-order-side batch-detail-side" aria-label="配载单关键资料与快捷查看">
    <section className="linear-side-panel">
      <header><b>配载单关键资料</b><button ref={triggerRef} type="button" onClick={onOpen} aria-haspopup="dialog" aria-expanded={open}>展开 →</button></header>
      <dl className="linear-side-facts">
        <div><dt>配载单</dt><dd className="order-number-only" title={batch.batch_number}>{batch.batch_number}</dd></div>
        <div><dt>线路</dt><dd title={routeSummary}>{routeSummary}</dd></div>
        <div><dt>当前节点</dt><dd title={currentWork.title}>{currentWork.title}</dd></div>
        <div><dt>操作</dt><dd title={batch.operation_assignee_name||""}>{batch.operation_assignee_name||"待分配"}</dd></div>
        <div><dt>单证</dt><dd title={batch.document_assignee_name||""}>{batch.document_assignee_name||"待分配"}</dd></div>
        <div><dt>挂载货物</dt><dd>{totals.orderCount} 票 · {totals.pieces} 件</dd></div>
        <div><dt>货物标签</dt><dd>{packageLabelCount} 张</dd></div>
        <div><dt>实收</dt><dd title={receiptSummary}>{receiptSummary}</dd></div>
        <div><dt>车辆</dt><dd title={vehicleSummary}>{vehicleSummary}</dd></div>
      </dl>
    </section>
    <section className="linear-side-panel">
      <header><b>就地查看</b></header>
      <nav className="linear-side-links" aria-label="配载单工作区快捷入口">
        <Link to={tabHref("batch")}><span>挂载订单</span><small>{totals.orderCount} 票</small><i>→</i></Link>
        <Link to={tabHref("batch")}><span>配载与车辆</span><small>{vehicles.length} 车</small><i>→</i></Link>
        <Link to={tabHref("documents")}><span>文件汇总</span><small>{fileCount} 份</small><i>→</i></Link>
        <Link to={tabHref("documents")}><span>报关放行</span><small>{customsReadyCount}/{totals.orderCount} 票</small><i>→</i></Link>
        <Link to={tabHref("tracking")}><span>运踪节点</span><small>{trackingCount} 条</small><i>→</i></Link>
        <Link to={tabHref("exceptions")}><span>异常处理</span><small>{activeExceptionCount} 项待办</small><i>→</i></Link>
      </nav>
    </section>
    <section className={`linear-side-panel linear-side-tip${blockingExceptionCount?" blocked":""}`}>
      <header><b>当前提示</b></header>
      <p>{currentWork.hint}</p>
    </section>
  </aside>;
}

function BatchDetailDrawer({batch,orders,cargoItems,packageLabels,totals,vehicles,batchDocuments,orderDocuments,orderDocumentArchive,customsReadyCount,trackingCount,activeExceptionCount,blockingExceptionCount,currentWork,selectedOrderId,onClose}:{batch:Batch;orders:BatchOrder[];cargoItems:BatchCargoItem[];packageLabels:BatchExceptionPackage[];totals:ReturnType<typeof summarizeBatch>;vehicles:Vehicle[];batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];orderDocumentArchive:OrderDocument[];customsReadyCount:number;trackingCount:number;activeExceptionCount:number;blockingExceptionCount:number;currentWork:{title:string;hint:string};selectedOrderId:string|null;onClose:()=>void}){
  const closeButtonRef=useRef<HTMLButtonElement>(null);
  const drawerBodyRef=useRef<HTMLDivElement>(null);
  const selectedOrderIndex=selectedOrderId?orders.findIndex(order=>order.order_id===selectedOrderId):-1;
  const [orderPage,setOrderPage]=useState(selectedOrderIndex>=0?Math.floor(selectedOrderIndex/10)+1:1);
  useEffect(()=>{
    closeButtonRef.current?.focus();
    const handleKeyDown=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};
    window.addEventListener("keydown",handleKeyDown);
    return()=>window.removeEventListener("keydown",handleKeyDown);
  },[onClose]);
  useEffect(()=>{
    if(!selectedOrderId)return;
    const frame=window.requestAnimationFrame(()=>{
      const target=Array.from(drawerBodyRef.current?.querySelectorAll<HTMLElement>("[data-order-archive]")??[])
        .find(element=>element.dataset.orderArchive===selectedOrderId);
      target?.scrollIntoView({block:"start"});
    });
    return()=>window.cancelAnimationFrame(frame);
  },[selectedOrderId]);
  const approvalStatus=({draft:"待提交审核",submitted:"待主管审核",approved:"已审核",rejected:"已退回"} as Record<string,string>)[batch.approval_status]||batch.approval_status;
  const vehicleSummary=vehicles.map(vehicle=>[vehicle.plate_number||vehicle.vehicle_no,vehicle.driver_name].filter(Boolean).join(" · ")).filter(Boolean).join("、")||batch.overseas_vehicle_plate||"待仓库补齐";
  const fileCount=batchDocuments.length+orderDocuments.length;
  const orderPageCount=Math.max(1,Math.ceil(orders.length/10));
  const visibleDrawerOrders=orders.slice((orderPage-1)*10,orderPage*10);
  return <div className="linear-drawer-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <aside className="linear-order-drawer batch-detail-drawer" role="dialog" aria-modal="true" aria-label={`配载单资料 · ${batch.batch_number}`}>
      <header className="linear-drawer-head">
        <div><span>PZ LOAD · BATCH DOSSIER</span><h2>{batch.batch_number}</h2></div>
        <button ref={closeButtonRef} type="button" aria-label="关闭配载单资料" title="关闭" onClick={onClose}>×</button>
      </header>
      <div ref={drawerBodyRef} className="linear-drawer-body is-dossier">
        <section className={`linear-drawer-section batch-drawer-current${blockingExceptionCount?" blocked":""}`}>
          <h3>当前业务节点 <span>{currentWork.title}</span></h3>
          <p>{currentWork.hint}</p>
        </section>
        <BatchDrawerSection title="配载单概况" meta={approvalStatus}>
          <BatchDrawerFact label="配载单号" value={batch.batch_number}/>
          <BatchDrawerFact label="配载名称" value={batch.batch_name}/>
          <BatchDrawerFact label="道路状态" value={roadStatusLabels[batch.road_status]||batch.road_status}/>
          <BatchDrawerFact label="起运地" value={batch.origin_location}/>
          <BatchDrawerFact label="目的地" value={batch.destination_location}/>
          <BatchDrawerFact label="生成仓库" value={batch.warehouse_name||"待记录"}/>
        </BatchDrawerSection>
        <BatchDrawerSection title="线路与时效" meta="仓库与运踪数据自动同步">
          <BatchDrawerFact label="计划发车" value={formatShortDateTime(batch.planned_departure_at)}/>
          <BatchDrawerFact label="计划到达" value={formatShortDateTime(batch.planned_arrival_at)}/>
          <BatchDrawerFact label="实际出境" value={formatShortDateTime(batch.actual_departure_at)}/>
          <BatchDrawerFact label="出境口岸" value={batch.border_port||"待补齐"}/>
          <BatchDrawerFact label="清关地" value={batch.customs_location||"待补齐"}/>
          <BatchDrawerFact label="境外承运商" value={batch.overseas_carrier_name||batch.carrier_name||"待补齐"}/>
          <BatchDrawerFact label="运输线路" value={batch.route_notes||`${batch.origin_location} → ${batch.destination_location}`} wide/>
          <BatchDrawerFact label="车辆 / 司机" value={vehicleSummary} wide/>
        </BatchDrawerSection>
        <BatchDrawerSection title="整批负责人" meta="共同业务按整张配载单统一负责">
          <BatchDrawerFact label="操作主管" value={batch.operation_supervisor_name||"待分配"}/>
          <BatchDrawerFact label="整批操作负责人" value={batch.operation_assignee_name||"待分配"}/>
          <BatchDrawerFact label="整批单证负责人" value={batch.document_assignee_name||"待分配"}/>
        </BatchDrawerSection>
        <BatchDrawerSection title="货物与车辆汇总" meta={`${totals.orderCount} 票 · ${vehicles.length} 车`}>
          <BatchDrawerFact label="挂载订单" value={`${totals.orderCount} 票`}/>
          <BatchDrawerFact label="实收件数" value={`${totals.pieces} 件`}/>
          <BatchDrawerFact label="货物标签" value={`${packageLabels.length} 张`}/>
          <BatchDrawerFact label="申报重量" value={`${totals.declaredWeight.toFixed(2)} KG`}/>
          <BatchDrawerFact label="实收重量" value={`${totals.actualWeight.toFixed(2)} KG`}/>
          <BatchDrawerFact label="实收体积" value={`${totals.actualVolume.toFixed(3)} CBM`}/>
        </BatchDrawerSection>
        <section className="linear-drawer-section">
          <h3>挂载订单 <span>{orders.length} 票 · 每页 10 票</span></h3>
          <div className="batch-drawer-order-list">
            {visibleDrawerOrders.map(order=><BatchDrawerOrderDisclosure key={order.order_id} order={order} cargoItems={cargoItems.filter(item=>item.order_id===order.order_id)} packageLabels={packageLabels.filter(item=>item.order_id===order.order_id)} orderDocuments={orderDocumentArchive.filter(item=>item.order_id===order.order_id)} initiallyOpen={order.order_id===selectedOrderId}/>)}
            {!orders.length&&<p className="linear-drawer-empty">当前配载单没有挂载订单。</p>}
          </div>
          {orderPageCount>1&&<nav className="batch-drawer-pagination" aria-label="挂载订单分页"><span>第 {orderPage}/{orderPageCount} 页</span><button type="button" disabled={orderPage<=1} onClick={()=>setOrderPage(page=>Math.max(1,page-1))}>上一页</button><button type="button" disabled={orderPage>=orderPageCount} onClick={()=>setOrderPage(page=>Math.min(orderPageCount,page+1))}>下一页</button></nav>}
        </section>
        <BatchDrawerSection title="文件与办理进度" meta={`${fileCount} 份文件`}>
          <BatchDrawerFact label="整批共用文件" value={`${batchDocuments.length} 份`}/>
          <BatchDrawerFact label="逐票文件" value={`${orderDocuments.length} 份`}/>
          <BatchDrawerFact label="报关门禁" value={`${customsReadyCount}/${totals.orderCount} 票通过`}/>
          <BatchDrawerFact label="运踪节点" value={`${trackingCount} 条`}/>
          <BatchDrawerFact label="待处理异常" value={`${activeExceptionCount} 项`}/>
          <BatchDrawerFact label="阻断异常" value={`${blockingExceptionCount} 项`}/>
        </BatchDrawerSection>
      </div>
    </aside>
  </div>;
}

export function BatchDrawerOrderDisclosure({order,cargoItems,packageLabels,orderDocuments,initiallyOpen}:{order:BatchOrder;cargoItems:BatchCargoItem[];packageLabels:BatchExceptionPackage[];orderDocuments:OrderDocument[];initiallyOpen:boolean}){
  const cargoSummary=order.cargo_names||order.cargo_description||"货物待补齐";
  return <details className="batch-drawer-order-disclosure" data-order-id={order.order_id} open={initiallyOpen||undefined}>
    <summary>
      <span className="batch-drawer-order-identity"><strong>{order.order_number}</strong><small>{order.customer_name}</small></span>
      <span className="batch-drawer-order-cargo" title={cargoSummary}>{cargoSummary}</span>
      <span className="batch-drawer-order-label-count"><strong>{packageLabels.length}</strong><small>张货物标签</small></span>
      <em className="batch-drawer-expand-label"><span>展开</span><b>收起</b></em>
    </summary>
    <div className="batch-drawer-order-detail">
      <div className="linear-drawer-grid batch-drawer-order-facts">
        <BatchDrawerFact label="工作号" value={order.work_number}/>
        <BatchDrawerFact label="订单类型" value={order.business_type==="ltl"?"拼车":"整车"}/>
        <BatchDrawerFact label="境外目的仓" value={order.overseas_warehouse_name||"待指定"}/>
        <BatchDrawerFact label="实收件数" value={`${order.pieces} 件`}/>
        <BatchDrawerFact label="实收重量" value={`${order.gross_weight_kg.toFixed(2)} KG`}/>
        <BatchDrawerFact label="实收体积" value={`${order.volume_cbm.toFixed(3)} CBM`}/>
      </div>
      <section className="batch-drawer-cargo-block">
        <header><strong>货物信息</strong><span>{cargoItems.length} 项</span></header>
        <div className="batch-drawer-cargo-list">
          {cargoItems.map(item=>{
            const itemLabels=packageLabels.filter(label=>label.cargo_item_id===item.id);
            return <article key={item.id}>
              <header><div><strong>{item.cargo_name_cn}</strong>{item.cargo_name_en&&<small>{item.cargo_name_en}</small>}</div><span>#{item.line_no}</span></header>
              <dl>
                <div><dt>包装 / 件数</dt><dd>{item.package_type} · {item.package_count} 包 · 每包 {item.pieces_per_package} 件</dd></div>
                <div><dt>单包重量 / 体积</dt><dd>{item.gross_weight_per_package_kg.toFixed(2)} KG · {item.volume_per_package_cbm.toFixed(3)} CBM</dd></div>
                <div><dt>尺寸</dt><dd>{item.length_cm} × {item.width_cm} × {item.height_cm} CM</dd></div>
                <div><dt>HS Code</dt><dd>{item.hs_code||"—"}{item.overseas_hs_code?` / ${item.overseas_hs_code}`:""}</dd></div>
                <div><dt>品牌 / 唛头</dt><dd>{[item.brand_model,item.marks].filter(Boolean).join(" · ")||"—"}</dd></div>
                <div><dt>货物标签</dt><dd>{itemLabels.length?itemLabels.map(label=>label.barcode).join("、"):"尚未生成"}</dd></div>
              </dl>
            </article>;
          })}
          {!cargoItems.length&&<p className="linear-drawer-empty">当前订单尚无结构化货物明细，摘要为：{cargoSummary}。</p>}
        </div>
      </section>
      <section className="batch-drawer-cargo-block batch-drawer-label-block">
        <header><strong>货物标签与货物码</strong><span>{packageLabels.length} 张</span></header>
        <div className="batch-drawer-label-list">
          {packageLabels.map(label=><article key={label.id}>
            <code>{label.barcode}</code>
            <div><strong>{label.cargo_name||cargoSummary}</strong><span>{label.package_number} · {label.pieces} 件 · {label.weight_kg?.toFixed(2)||"—"} KG · {label.volume_cbm?.toFixed(3)||"—"} CBM</span></div>
            <small>{label.warehouse_name||"仓库待定"}{label.location_name?` · ${label.location_name}`:""} · {batchWarehousePackageStatusLabel(label.status)}</small>
          </article>)}
          {!packageLabels.length&&<p className="linear-drawer-empty">仓库尚未为本票货物生成可扫描标签和 OUL 货物码。</p>}
        </div>
      </section>
      <section className="batch-drawer-cargo-block batch-drawer-document-block" data-order-archive={order.order_id}>
        <header><strong>本票完整文件归档</strong><span>{orderDocuments.length} 份</span></header>
        <div className="batch-order-file-list">
          {orderDocuments.map(document=><div key={document.id}>
            <strong>{orderDocumentTypeLabel(document.document_category)}</strong>
            <a href={`/admin/document-files/order/${document.id}?mode=view`} target="_blank" rel="noreferrer">{document.file_name}</a>
            <small>{new Date(document.created_at).toLocaleString("zh-CN")}</small>
            <span className={`status-pill ${["approved","archived"].includes(document.review_status)?"success":document.review_status==="rejected"?"danger":""}`}>{documentReviewLabel(document.review_status)}</span>
          </div>)}
          {!orderDocuments.length&&<p className="linear-drawer-empty">本票尚无已归档文件。</p>}
        </div>
      </section>
    </div>
  </details>;
}

function batchWarehousePackageStatusLabel(status:string){
  return({in_stock:"在库",allocated:"已分配",dispatched:"已出库",exception:"异常"} as Record<string,string>)[status]||status;
}

function BatchDrawerSection({title,meta,children}:{title:string;meta?:string;children:ReactNode}){
  return <section className="linear-drawer-section"><h3>{title}{meta&&<span>{meta}</span>}</h3><div className="linear-drawer-grid">{children}</div></section>;
}

function BatchDrawerFact({label,value,wide=false}:{label:string;value:string|null|undefined;wide?:boolean}){
  return <div className={wide?"wide":undefined}><span>{label}</span><b>{value||"—"}</b></div>;
}

function BatchExceptionWorkbench({batch,orders,packages,exceptions,busy,manage,closeSignal}:{batch:Batch;orders:BatchOrder[];packages:BatchExceptionPackage[];exceptions:BatchException[];busy:boolean;manage:boolean;closeSignal?:unknown}){
  const [scope,setScope]=useState<"batch"|"order"|"package">("batch");
  const active=exceptions.filter(item=>isActiveExceptionStatus(item.status));
  const blocking=active.filter(item=>item.blocks_progress===1);
  return <section className="panel batch-tab-panel batch-exception-workbench" id="batch-exceptions">
    <div className="panel-header"><div><h2>配载单异常处理</h2><p>异常可作用于整批、单张订单或一个 OUL 货物标签；处理全程留痕，已完成节点不会回退。</p></div><div className="page-actions"><span className={`status-pill ${blocking.length?"danger":"success"}`}>{blocking.length?`${blocking.length} 项阻断推进`:"无阻断异常"}</span>{manage&&<Modal title={`登记配载异常 · ${batch.batch_number}`} triggerLabel="＋ 登记异常" triggerClassName="primary" size="wide" closeSignal={closeSignal}><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="batch_exception_create"/><label className="field"><span>影响范围</span><select name="exceptionScope" value={scope} onChange={event=>setScope(event.target.value as typeof scope)}><option value="batch">整张配载单</option><option value="order">指定订单</option><option value="package">指定 OUL 货物</option></select></label>{scope==="order"&&<label className="field span-2"><span>关联订单</span><select name="orderId" required><option value="">请选择订单</option>{orders.map(order=><option key={order.order_id} value={order.order_id}>{order.order_number} · {order.customer_name}</option>)}</select></label>}{scope==="package"&&<label className="field span-2"><span>OUL 货物标签</span><select name="packageId" required><option value="">请选择 OUL 标签</option>{packages.map(item=><option key={item.id} value={item.id}>{item.barcode} · {item.order_number}</option>)}</select></label>}<label className="field"><span>异常类型</span><select name="exceptionType" defaultValue="other"><option value="cargo_damage">货损</option><option value="cargo_shortage">货差/短少</option><option value="document">文件资料</option><option value="customs">报关/清关</option><option value="vehicle">车辆司机</option><option value="delay">时效延误</option><option value="route">线路/口岸</option><option value="warehouse">仓库作业</option><option value="other">其他</option></select></label><label className="field"><span>严重等级</span><select name="severity" defaultValue="medium"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></label><label className="check-field span-2"><input name="blocksProgress" type="checkbox" defaultChecked/>异常关闭前阻断本配载单继续推进</label><label className="field span-2"><span>异常说明</span><textarea name="description" rows={4} minLength={4} maxLength={500} placeholder="说明发生了什么、影响范围和当前处置建议" required/></label><button className="primary span-2" disabled={busy}>登记异常并同步订单</button></Form></Modal>}</div></div>
    <div className="batch-exception-summary"><span>全部异常 <strong>{exceptions.length}</strong></span><span>待处理 <strong>{active.length}</strong></span><span>阻断推进 <strong>{blocking.length}</strong></span><span>已结案 <strong>{exceptions.filter(item=>item.status==="resolved").length}</strong></span></div>
    <div className="table-wrap"><table><thead><tr><th>异常单</th><th>范围</th><th>类型 / 等级</th><th>异常说明</th><th>推进影响</th><th>状态 / 负责人</th><th>处理结果</th><th>操作</th></tr></thead><tbody>{exceptions.map(item=><tr key={item.id} className={item.status==="resolved"?"completed-row":item.blocks_progress?"blocked-row":""}><td><strong>{item.exception_number}</strong><small>{new Date(item.reported_at).toLocaleString("zh-CN")} · {item.reporter_name||"系统"}</small></td><td>{batchExceptionScopeLabel(item.scope)}<small>{item.scope==="batch"?batch.batch_number:item.scope==="order"?item.order_number:item.package_barcode}</small></td><td>{batchExceptionTypeLabel(item.exception_type)}<small><span className={`severity-badge ${item.severity}`}>{batchExceptionSeverityLabel(item.severity)}</span></small></td><td>{item.description}</td><td><span className={`status-pill ${item.blocks_progress?"danger":""}`}>{item.blocks_progress?"阻断推进":"仅提醒"}</span></td><td><span className={`status-pill ${item.status==="resolved"?"success":item.status==="processing"?"":"off"}`}>{batchExceptionStatusLabel(item.status)}</span><small>{item.assignee_name||"未分配"}</small></td><td>{item.resolution||"—"}{item.resolved_at&&<small>{item.resolved_by_name||"系统"} · {new Date(item.resolved_at).toLocaleString("zh-CN")}</small>}</td><td>{manage&&(item.status==="open"||item.status==="processing")?<div className="row-actions">{item.status==="open"&&<Form method="post"><input type="hidden" name="intent" value="batch_exception_progress"/><input type="hidden" name="exceptionId" value={item.id}/><button className="text-button" disabled={busy}>开始处理</button></Form>}<Modal title={`解决异常 · ${item.exception_number}`} triggerLabel="解决并关闭" triggerClassName="text-button" closeSignal={closeSignal}><Form method="post" className="stack"><input type="hidden" name="intent" value="batch_exception_resolve"/><input type="hidden" name="exceptionId" value={item.id}/><div className="alert warning">关闭后立即重新计算受影响订单与配载单门禁；历史流程节点不会回退。</div><label className="field"><span>处理结果</span><textarea name="resolution" rows={5} minLength={4} maxLength={500} required/></label><button className="primary" disabled={busy}>确认解决并关闭异常</button></Form></Modal></div>:"—"}</td></tr>)}{!exceptions.length&&<tr><td colSpan={8} className="empty-state">当前配载单没有异常。发生问题时可在这里就地登记，无需跳转订单页。</td></tr>}</tbody></table></div>
  </section>;
}

function BatchDocumentWorkbench({batchId,orders,visibleOrders,orderPagination,batchDocuments,orderDocuments,orderDocumentRequirements,customsSummaries,customsDeclarations,workflowPolicies,customsAccesses,busy,manageDocuments,manageCustoms,currentUserId,documentOwnerUserId,documentOwnerName,privileged,requiresTransloading,ready,customsCloseSignal,onOpenOrderDossier}:{batchId:string;orders:BatchOrder[];visibleOrders:BatchOrder[];orderPagination:BatchOrderPagination;batchDocuments:BatchDocument[];orderDocuments:OrderDocument[];orderDocumentRequirements:OrderLoadingDocumentRequirements[];customsSummaries:CustomsSummary[];customsDeclarations:BatchCustomsDeclaration[];workflowPolicies:BatchOrderWorkflowPolicy[];customsAccesses:BatchOrderCustomsAccess[];busy:boolean;manageDocuments:boolean;manageCustoms:boolean;currentUserId:string;documentOwnerUserId:string|null;documentOwnerName:string|null;privileged:boolean;requiresTransloading:boolean;ready:boolean;customsCloseSignal?:unknown;onOpenOrderDossier:(orderId:string)=>void}){
  const visibleBatchDocTypes=BATCH_DOCUMENT_TYPES.filter(type=>requiresTransloading||!["border_handover","transshipment_order"].includes(type.code));
  const systemDocumentCodes=new Set(["loading_manifest","vehicle_manifest","batch_waybill"]);
  const currentIsDocumentOwner=privileged||documentOwnerUserId===currentUserId;
  const hasRequiredCustomsWork=orders.some(order=>{const policy=orderBatchWorkflowPolicy(workflowPolicies,order.order_id,"customs");return policy.enabled&&policy.required;});
  const hasActionableCustoms=customsAccesses.some(access=>access.canManageDeclarations||access.canRelease);
  const customsBlockReason=customsAccesses.find(access=>access.declarationAccess.reason)?.declarationAccess.reason
    ??customsAccesses.find(access=>access.releaseAccess.reason)?.releaseAccess.reason;
  const [searchParams]=useSearchParams();
  const documentView=searchParams.get("documentView")==="shared"?"shared":"orders";
  const documentViewHref=(view:"orders"|"shared")=>{
    const next=new URLSearchParams(searchParams);
    next.set("tab","documents");
    next.delete("orderPage");
    if(view==="shared") next.set("documentView","shared");
    else next.delete("documentView");
    return `?${next.toString()}`;
  };
  return <section className="panel batch-document-workbench batch-tab-panel" id="batch-files">
    <div className="batch-detail-summary"><div><h2>报关与文件</h2></div><div className="batch-detail-summary-status"><span>{orders.length} 票订单</span><b>{ready?"门禁已通过":"存在待办资料"}</b></div></div>
    <div className="batch-detail-disclosure-body">
    <nav className="batch-document-view-tabs peer-page-tabs" aria-label="报关与文件子页面">
      <Link to={documentViewHref("orders")} className={documentView==="orders"?"active":""} aria-current={documentView==="orders"?"page":undefined}><strong>逐票报关办理</strong><span>{ready?"已通过":`${orders.length} 票`}</span></Link>
      <Link to={documentViewHref("shared")} className={documentView==="shared"?"active":""} aria-current={documentView==="shared"?"page":undefined}><strong>整批共用文件</strong><span>{visibleBatchDocTypes.length} 份</span></Link>
    </nav>
    {documentView==="orders"&&<>
    {!ready&&hasRequiredCustomsWork&&manageCustoms&&hasActionableCustoms&&<div className="alert warning batch-customs-guidance" role="status"><strong>当前由你办理：</strong><span>仅处理当前冻结工作流节点开放的报关申报或放行；选填项不会阻断交接。</span></div>}
    {!ready&&hasRequiredCustomsWork&&manageCustoms&&!hasActionableCustoms&&<div className="alert info batch-customs-guidance" role="status"><strong>当前只读：</strong><span>{customsBlockReason||"报关操作将在冻结工作流到达对应节点后自动开放。"}</span></div>}
    {!ready&&hasRequiredCustomsWork&&!manageCustoms&&currentIsDocumentOwner&&<div className="alert error batch-customs-guidance" role="alert"><strong>缺少办理权限：</strong><span>当前单证岗位未开放报关办理权限，请联系管理员。</span></div>}
    {!ready&&hasRequiredCustomsWork&&!manageCustoms&&!currentIsDocumentOwner&&<div className="alert info batch-customs-guidance" role="status"><strong>当前只读：</strong><span>由整批单证负责人“{documentOwnerName||"待分配"}”办理工作流必填报关事项。</span></div>}
    {!ready&&!hasRequiredCustomsWork&&<div className="alert warning batch-customs-guidance" role="status"><strong>仍有必填文件待处理：</strong><span>当前报关模块不构成门禁，请按各票订单显示的文件状态补齐并审核。</span></div>}
    {ready&&<div className="alert success batch-customs-guidance" role="status"><strong>门禁已通过：</strong><span>下一步由操作负责人办理口岸到达与实际出境。</span></div>}
    <section className="batch-order-documents">
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>货物 / 实收</th><th>订单文件</th><th>申报 / 放行</th><th>操作</th></tr></thead><tbody>{visibleOrders.map(order=>{
        const files=orderDocuments.filter(item=>item.order_id===order.order_id);
        const orderCustomsDeclarations=customsDeclarations.filter(item=>item.order_id===order.order_id);
        const pendingCustomsDeclarations=orderCustomsDeclarations.filter(item=>item.is_deleted!==1&&item.status!=="released"&&item.status!=="cancelled");
        const requirementGroup=orderDocumentRequirements.find(group=>group.orderId===order.order_id);
        const customsPolicy=orderBatchWorkflowPolicy(workflowPolicies,order.order_id,"customs");
        const declarationsField=runtimeWorkflowFieldPolicy(customsPolicy.fields,"customs_declarations",true);
        const releaseField=runtimeWorkflowFieldPolicy(customsPolicy.fields,"customs_release",true);
        const activeRequirements=requirementGroup?.documents.filter(document=>document.isActive)??[];
        const blockingRequirements=activeRequirements.filter(requirement=>requirement.moduleCode!=="customs"||(customsPolicy.enabled&&customsPolicy.required));
        const documentSummary=summarizeLoadingDocumentRequirements(blockingRequirements,files);
        const incompleteCodes=documentSummary.incompleteCodes;
        const customs=customsSummaries.find(item=>item.order_id===order.order_id);
        const requiredCustomsDocuments=customsPolicy.required?activeRequirements.filter(document=>document.moduleCode==="customs"&&document.isRequired):[];
        const customsFilesReady=requiredCustomsDocuments.every(document=>files.some(item=>item.document_category===document.code&&["approved","archived"].includes(item.review_status)));
        const customsDeclarationsReady=(!declarationsField.required||Boolean(customs&&customs.total>0))&&(!releaseField.required||Boolean(customs&&customs.total>0&&customs.released===customs.total));
        const customsReady=!customsPolicy.enabled||!customsPolicy.required||(customsFilesReady&&customsDeclarationsReady);
        const orderGateReady=documentSummary.complete&&customsReady;
        const workflowAccess=customsAccesses.find(access=>access.orderId===order.order_id);
        const ownsCustoms=privileged||order.customs_assignee_user_id===currentUserId;
        const canManageThisOrder=manageCustoms&&customsPolicy.enabled&&declarationsField.visible&&ownsCustoms&&Boolean(workflowAccess?.canManageDeclarations);
        const canReleaseThisOrder=batchOrderCustomsReleaseActionAvailable({
          manageCustoms,
          customsEnabled:customsPolicy.enabled,
          releaseFieldVisible:releaseField.visible,
          ownsCustoms,
          workflowCanRelease:Boolean(workflowAccess?.canRelease),
          customsFilesReady,
        });
        const canActOnThisOrder=manageDocuments||canManageThisOrder||canReleaseThisOrder;
        const customsStatus=!customsPolicy.enabled?"本单未启用报关":!declarationsField.visible?"工作流未展示报关申报明细":!customsPolicy.required?(customs?.total?`选办 · ${customs.released}/${customs.total} 张放行`:"选办 · 尚未登记"):!customsFilesReady?"必填报关文件待审核":customs?.total?`${customs.released}/${customs.total} 张放行`:"待登记并放行正式报关单";
        return <tr className={orderGateReady?"completed-row":canActOnThisOrder?"blocked-row":"readonly-row"} key={order.order_id} id={`batch-customs-${order.order_id}`}>
          <td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong><small>{order.customer_name}</small></td>
          <td><strong className="loading-cargo-names">{order.cargo_names||order.cargo_description||"未填写"}</strong><small>{order.pieces} 件 · {order.gross_weight_kg.toFixed(2)} KG · {order.volume_cbm.toFixed(3)} CBM</small></td>
          <td><span className={`status-pill ${documentSummary.complete?"success":""}`}>{documentSummary.requiredCount===0?"无必填文件":incompleteCodes.length?`待处理 ${incompleteCodes.length} 项`:`${documentSummary.requiredCount} 项必填文件已齐`}</span>{incompleteCodes.length>0&&<small>{incompleteCodes.map(orderDocumentTypeLabel).join("、")}</small>}</td>
          <td><span className={`status-pill ${customsPolicy.required&&customsReady?"success":!customsPolicy.required?"off":""}`}>{customsStatus}</span></td>
          <td><div className="batch-order-row-actions"><details className="batch-order-file-details"><summary className={canActOnThisOrder?"primary batch-customs-open-action":"secondary batch-customs-open-action"}>{canActOnThisOrder?"办理本票报关":"查看本票文件"}</summary><div className="batch-order-file-panel">
            <header className="batch-order-file-panel-header"><div><strong>{canActOnThisOrder?"办理本票报关":"查看本票文件"}</strong><span><OrderNumberLink id={order.order_id} number={order.order_number}/> · {order.customer_name}</span></div><button type="button" aria-label="关闭文件查看窗口" onClick={event=>(event.currentTarget.closest("details") as HTMLDetailsElement|null)?.removeAttribute("open")}>×</button></header>
            {!canActOnThisOrder&&workflowAccess?.declarationAccess.reason&&<div className="alert info">{workflowAccess.declarationAccess.reason}</div>}
            <div className="batch-order-file-list">{activeRequirements.map(requirement=>{
              const current=files.find(item=>item.document_category===requirement.code);
              const blocks=requirement.isRequired&&(requirement.moduleCode!=="customs"||customsPolicy.required);
              const needsUpload=!current||current.review_status==="rejected";
              return <div key={requirement.code}>
                <strong>{requirement.name}{blocks?<b className="required-mark"> *</b>:<small> · 选填</small>}</strong>
                {current?<><a href={`/admin/document-files/order/${current.id}?mode=view`} target="_blank" rel="noreferrer">{current.file_name}</a><span className={`status-pill ${["approved","archived"].includes(current.review_status)?"success":current.review_status==="rejected"?"danger":""}`}>{documentReviewLabel(current.review_status)}</span></>:<span className={`status-pill ${blocks?"off":""}`}>{blocks?"待整单单证负责人上传":"选填未提供"}</span>}
                {manageDocuments&&needsUpload&&<Form method="post" encType="multipart/form-data" className="batch-order-file-inline-action">
                  <input type="hidden" name="intent" value="batch_order_document_upload"/>
                  <input type="hidden" name="orderId" value={order.order_id}/>
                  <input type="hidden" name="documentCategory" value={requirement.code}/>
                  <input type="hidden" name="documentDescription" value={requirement.name}/>
                  <input type="hidden" name="approveImmediately" value="1"/>
                  <label><span className="sr-only">选择{requirement.name}文件</span><input type="file" name="attachment" aria-label={`选择${requirement.name}文件`} required/></label>
                  <button className="secondary" disabled={busy}>{current?.review_status==="rejected"?"重新上传并通过":"上传并通过"}</button>
                </Form>}
                {manageDocuments&&current?.review_status==="pending"&&<Form method="post" className="batch-order-file-review-action">
                  <input type="hidden" name="intent" value="batch_order_document_review"/>
                  <input type="hidden" name="orderId" value={order.order_id}/>
                  <input type="hidden" name="attachmentId" value={current.id}/>
                  <button className="primary" name="reviewStatus" value="approved" disabled={busy}>审核通过</button>
                  <button className="secondary" name="reviewStatus" value="rejected" disabled={busy}>退回</button>
                </Form>}
              </div>;
            })}{!activeRequirements.length&&<span className="status-pill success">当前工作流未启用逐票文件</span>}</div>
            <BatchOrderCustomsWorkbench orderId={order.order_id} declarations={orderCustomsDeclarations} fields={customsPolicy.fields} manage={canManageThisOrder} allowRelease={canReleaseThisOrder} busy={busy} closeSignal={customsCloseSignal}/>
            <div className="batch-order-file-links"><BatchOrderArchiveButton orderId={order.order_id} onOpen={onOpenOrderDossier}/></div>
          </div></details>{canReleaseThisOrder&&pendingCustomsDeclarations.map(declaration=><Modal key={declaration.id} title={`确认报关放行 · ${declaration.declaration_number}`} triggerLabel={pendingCustomsDeclarations.length>1?`确认放行 · ${declaration.declaration_number}`:"确认放行"} triggerClassName="primary batch-order-direct-customs-button" closeSignal={customsCloseSignal}><section className="batch-direct-release-item"><header><strong>{declaration.declaration_number}</strong><span>{customsStageLabel(declaration.clearance_stage)} · {declaration.declaration_title}</span></header><BatchCustomsReleaseForm orderId={order.order_id} declaration={declaration} fields={customsPolicy.fields} busy={busy}/></section></Modal>)}</div></td>
        </tr>})}</tbody></table></div>
      <QueryPagination {...orderPagination} pageParam="orderPage" unit="票订单"/>
    </section>
    </>}
    {documentView==="shared"&&<section className="batch-shared-documents">
      <header><div><h3>整批共用文件</h3><p>系统随仓库配载与装车数据自动生成，只读留档{requiresTransloading?"；换装文件按实际业务显示":""}。</p></div></header>
      <div className="table-wrap batch-document-table"><table><thead><tr><th>文件类型</th><th>用途说明</th><th>当前状态</th><th>文件</th></tr></thead><tbody>{visibleBatchDocTypes.map(type=>{
        const current=batchDocuments.find(item=>item.document_category===type.code);
        const isSystemDocument=systemDocumentCodes.has(type.code);
        return <tr className={current&&["approved","archived"].includes(current.review_status)?"completed-row":""} key={type.code}>
          <td><strong>{type.name}{type.required&&<b className="required-mark"> *</b>}</strong></td>
          <td>{type.hint}</td>
          <td>{current?<span className={`status-pill ${current.review_status==="approved"?"success":""}`}>{isSystemDocument?"已自动同步":documentReviewLabel(current.review_status)}</span>:<span className="status-pill off">{isSystemDocument?"待自动生成":"待上传"}</span>}</td>
          <td>{current?<a href={`/admin/document-files/batch/${current.id}?mode=view`} target="_blank" rel="noreferrer">{current.file_name}</a>:"—"}</td>
        </tr>})}</tbody></table></div>
    </section>}
    </div>
  </section>
}

export function BatchOrderArchiveButton({orderId,onOpen}:{orderId:string;onOpen:(orderId:string)=>void}){
  return <button className="secondary" type="button" onClick={()=>onOpen(orderId)} aria-haspopup="dialog">在右侧查看完整归档</button>;
}

function ActionToast({signal,message,tone}:{signal?:unknown;message?:string;tone:"success"|"error"}){
  const [visible,setVisible]=useState(Boolean(message));
  useEffect(()=>{
    if(!message)return;
    setVisible(true);
    const timer=window.setTimeout(()=>setVisible(false),4200);
    return()=>window.clearTimeout(timer);
  },[message,signal]);
  if(!message||!visible)return null;
  return <div className={`batch-action-toast ${tone}`} role={tone==="error"?"alert":"status"} aria-live={tone==="error"?"assertive":"polite"}>
    <span>{tone==="error"?"操作未完成":"操作成功"}</span>
    <p>{message}</p>
    <button type="button" aria-label="关闭提示" onClick={()=>setVisible(false)}>×</button>
  </div>;
}

export function BatchTrackingWorkbench({batchId,batchNumber,orders,visibleOrders,orderPagination,trackingMilestones,trackingFlags,workflowPolicies,milestoneAction,actualExitAction,batchVehiclePlate,overseasVehiclePlate,borderPort,customsLocation,busy,manage,warehouseReady,documentGateReady,exitConfirmed,canConfirmExit,exitBlockers,borderPorts,documentsHref,actionCloseSignal}:{
  batchId:string;
  batchNumber:string;
  orders:BatchOrder[];
  visibleOrders:BatchOrder[];
  orderPagination:BatchOrderPagination;
  trackingMilestones:BatchTrackingMilestone[];
  trackingFlags:BatchTrackingFlag[];
  workflowPolicies:BatchOrderWorkflowPolicy[];
  milestoneAction:BatchTrackingActionPolicy;
  actualExitAction:BatchTrackingActionPolicy;
  batchVehiclePlate:string|null;
  overseasVehiclePlate:string|null;
  borderPort:string|null;
  customsLocation:string|null;
  busy:boolean;
  manage:boolean;
  warehouseReady:boolean;
  documentGateReady:boolean;
  exitConfirmed:boolean;
  canConfirmExit:boolean;
  exitBlockers:string[];
  borderPorts:ReferenceOption[];
  documentsHref:string;
  actionCloseSignal?:unknown;
}){
  // 各订单的最新里程碑（按 progress 权重排序）
  const milestoneProgressWeight:Record<string,number>={departed:15,border_arrived:28,exported:40,transloaded:46,transit_customs:52,foreign_entered:64,customs_cleared:82,station_arrived:100};
  const trackingOrders=orders.filter(order=>orderBatchWorkflowPolicy(workflowPolicies,order.order_id,"tracking").enabled);
  const trackingPagination=paginateList(trackingOrders,orderPagination.page);
  const visibleTrackingOrders=trackingPagination.items;
  const milestoneField=batchWorkflowFieldPolicy(workflowPolicies,"tracking","tracking_milestone",true);
  const actualExitField=batchWorkflowFieldPolicy(workflowPolicies,"tracking","actual_exit_at",true);
  const milestoneParticipants=new Set(milestoneAction.participatingOrderIds);
  const actualExitParticipants=new Set(actualExitAction.participatingOrderIds);
  const milestoneSurfaceVisible=milestoneAction.visible&&milestoneField.visible;
  const actualExitSurfaceVisible=actualExitAction.visible&&actualExitField.visible;
  const milestoneCanWrite=manage&&milestoneAction.editable;
  const actualExitCanWrite=manage&&actualExitAction.editable;
  const actionPolicyReasons=Array.from(new Set([
    !milestoneAction.editable?milestoneAction.reason:null,
    !actualExitAction.editable?actualExitAction.reason:null,
  ].filter((reason):reason is string=>Boolean(reason))));
  const nodeOrders=trackingOrders.filter(order=>milestoneParticipants.has(order.order_id)&&runtimeWorkflowFieldPolicy(orderBatchWorkflowPolicy(workflowPolicies,order.order_id,"tracking").fields,"tracking_milestone",true).visible);
  const milestoneGateRequired=nodeOrders.some(order=>orderWorkflowFieldBlocksBatch(workflowPolicies,order.order_id,"tracking","tracking_milestone",true));
  const exitSequenceOrders=nodeOrders.filter(order=>actualExitParticipants.has(order.order_id)&&runtimeWorkflowFieldPolicy(orderBatchWorkflowPolicy(workflowPolicies,order.order_id,"tracking").fields,"actual_exit_at",true).visible&&orderWorkflowFieldBlocksBatch(workflowPolicies,order.order_id,"tracking","tracking_milestone",true));
  const visibleTrackingMilestones=trackingMilestones.filter(item=>trackingOrders.some(order=>order.order_id===item.order_id));
  const milestonesByOrder=new Map<string,BatchTrackingMilestone[]>();
  for(const m of visibleTrackingMilestones){
    const list=milestonesByOrder.get(m.order_id)||[];
    list.push(m);
    milestonesByOrder.set(m.order_id,list);
  }
  const latestByOrder=new Map<string,BatchTrackingMilestone|null>();
  for(const order of trackingOrders){
    const list=milestonesByOrder.get(order.order_id)||[];
    const latest=list.slice().sort((a,b)=>(milestoneProgressWeight[b.milestone_code]??0)-(milestoneProgressWeight[a.milestone_code]??0)||b.event_at.localeCompare(a.event_at))[0]||null;
    latestByOrder.set(order.order_id,latest);
  }
  const exitReadyOrderCount=exitSequenceOrders.filter(order=>missingBatchTrackingPrerequisites((milestonesByOrder.get(order.order_id)||[]).map(item=>item.milestone_code),"exported").length===0).length;
  const borderArrivalReady=exitSequenceOrders.length===0||exitReadyOrderCount===exitSequenceOrders.length;
  const exitSequenceAnomaly=exitConfirmed&&!borderArrivalReady;
  const flagsByOrder=new Map(trackingFlags.map(item=>[item.order_id,item]));
  const requiresTransloading=nodeOrders.some(o=>flagsByOrder.get(o.order_id)?.requires_transloading===1);
  const requiresTransitCustoms=nodeOrders.some(o=>flagsByOrder.get(o.order_id)?.requires_transit_customs===1);
  // 5 个主节点 + 2 个可选节点（按开关状态决定是否暴露）
  const visibleMilestones=milestoneSurfaceVisible?BATCH_TRACKING_MILESTONES.filter(item=>!item.optional||(item.code==="transloaded"&&requiresTransloading)||(item.code==="transit_customs"&&requiresTransitCustoms)):[];
  const defaultVehicle=batchVehiclePlate||overseasVehiclePlate||"";
  const defaultEventAt=dateTimeLocal(new Date().toISOString());
  const defaultLocation=(nodeCode:string)=>["border_arrived","exported"].includes(nodeCode)?borderPort||"":nodeCode==="customs_cleared"?customsLocation||"":"";
  const borderArrivalNode=visibleMilestones.find(node=>node.code==="border_arrived");
  return <section className="panel batch-tracking-workbench" id="batch-tracking">
    <div className="panel-header"><div><h2>口岸到达、实际出境与运踪</h2><p>页面操作项、必填状态和推进门禁均来自挂载订单的冻结工作流。</p></div><div className="batch-tracking-header-actions"><span className="status-pill">{trackingOrders.length} 票启用 · {visibleTrackingMilestones.length} 条节点</span>{milestoneCanWrite&&milestoneSurfaceVisible&&<Modal title="可选运输节点设置" triggerLabel={`可选节点${requiresTransloading||requiresTransitCustoms?" · 已启用":""}`} triggerClassName="text-button batch-optional-node-trigger" closeSignal={actionCloseSignal}>
      <div className="batch-optional-node-dialog"><p className="muted">仅在运输途中实际发生换装或转关时启用；默认不参与主流程。</p><div className="table-wrap batch-tracking-option-table"><table><thead><tr><th>可选节点</th><th>适用范围</th><th>当前设置</th><th>操作</th></tr></thead><tbody>
        <tr><td><strong>换装</strong></td><td>给本批参与运踪的订单开放“换装”节点</td><td><span className={`status-pill ${requiresTransloading?"success":"off"}`}>{requiresTransloading?"已启用":"未启用"}</span></td><td><Form method="post"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transloaded"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransloading}/><span>启用</span></label><button className="text-button" disabled={busy}>应用</button></Form></td></tr>
        <tr><td><strong>转关</strong></td><td>给本批参与运踪的订单开放“转关”节点</td><td><span className={`status-pill ${requiresTransitCustoms?"success":"off"}`}>{requiresTransitCustoms?"已启用":"未启用"}</span></td><td><Form method="post"><input type="hidden" name="intent" value="batch_tracking_option_toggle"/><input type="hidden" name="optionCode" value="transit_customs"/><label className="toggle-label"><input type="checkbox" name="enable" defaultChecked={requiresTransitCustoms}/><span>启用</span></label><button className="text-button" disabled={busy}>应用</button></Form></td></tr>
      </tbody></table></div></div>
    </Modal>}</div></div>
    {actionPolicyReasons.map(reason=><div className="alert info" role="status" key={reason}>{reason}</div>)}
    {!trackingOrders.length&&<div className="alert info">当前配载单挂载订单均未启用运踪模块，本页不显示也不接受运踪办理操作。</div>}
    {trackingOrders.length>0&&<div className="batch-transport-sequence" aria-label="出境办理顺序">
      <div className={warehouseReady?"done":"current"}><span>1</span><div><strong>装车出库</strong><small>{warehouseReady?"已完成":"待仓库办理"}</small></div></div>
      <div className={documentGateReady?"done":warehouseReady?"current":"locked"}><span>2</span><div><strong>报关放行</strong><small>{documentGateReady?"已完成":warehouseReady?"待单证办理":"等待装车"}</small></div></div>
      {milestoneSurfaceVisible&&<div className={milestoneGateRequired?(borderArrivalReady?"done":warehouseReady&&documentGateReady?"current":"locked"):"optional"}><span>3</span><div><strong>口岸到达</strong><small>{milestoneGateRequired?(borderArrivalReady?"已登记":warehouseReady&&documentGateReady?"当前待办":"等待前置步骤"):"选填，不阻断实际出境"}</small></div></div>}
      {actualExitSurfaceVisible&&<div className={exitConfirmed?"done":borderArrivalReady&&documentGateReady?"current":"locked"}><span>{milestoneSurfaceVisible?4:3}</span><div><strong>实际出境</strong><small>{exitConfirmed?"已确认":borderArrivalReady&&documentGateReady?"当前待办":milestoneSurfaceVisible?"完成口岸到达后开放":"等待前置步骤"}</small></div></div>}
    </div>}
    {trackingOrders.length>0&&!milestoneSurfaceVisible&&!actualExitSurfaceVisible&&<div className="alert info">当前冻结工作流未展示运输节点和实际出境登记，本页仅保留历史只读信息。</div>}
    {trackingOrders.length>0&&(milestoneSurfaceVisible||actualExitSurfaceVisible)&&!warehouseReady&&<div className="alert warning">仓库端尚未完成整批装车出库。当前仅可查看，完成出库后系统会按冻结工作流开放相应登记项。</div>}
    {warehouseReady&&!documentGateReady&&!exitConfirmed&&(milestoneSurfaceVisible||actualExitSurfaceVisible)&&<div className="batch-exit-prerequisite" role="status"><div><strong>当前待办：完成工作流要求的逐票报关与文件</strong><span>必填门禁通过后回到本页继续办理；选填项目不会阻断。</span></div><Link className="primary" to={documentsHref}>进入报关与文件</Link></div>}
    {warehouseReady&&documentGateReady&&!exitConfirmed&&!borderArrivalReady&&borderArrivalNode&&milestoneSurfaceVisible&&<div className="batch-exit-prerequisite" role="status"><div><strong>当前待办：登记口岸到达</strong><span>这是运输事件顺序完整性要求；一次登记只同步冻结工作流开放该节点的挂载订单。</span></div>{milestoneCanWrite?<Modal title="登记运输节点 · 口岸到达" triggerLabel="登记口岸到达" triggerClassName="primary" size="wide" closeSignal={actionCloseSignal}><BatchTrackingNodeForm nodeCode={borderArrivalNode.code} total={nodeOrders.length} fields={workflowPolicies} defaultEventAt={defaultEventAt} defaultLocation={defaultLocation(borderArrivalNode.code)} defaultVehicle={defaultVehicle} busy={busy}/></Modal>:<span className="status-pill off">当前冻结工作流只读</span>}</div>}
    {actualExitSurfaceVisible&&warehouseReady&&documentGateReady&&!exitConfirmed&&borderArrivalReady&&canConfirmExit&&actualExitCanWrite&&<BatchExitConfirmForm workflowPolicies={workflowPolicies} defaultEventAt={defaultEventAt} borderPort={borderPort} borderPorts={borderPorts} defaultVehicle={defaultVehicle} busy={busy}/>} 
    {actualExitSurfaceVisible&&warehouseReady&&documentGateReady&&!exitConfirmed&&borderArrivalReady&&(!canConfirmExit||!actualExitCanWrite)&&<div className="batch-gate-blocker batch-inline-exit-blocker"><div><strong>{canConfirmExit?"当前冻结工作流只读":"实际出境仍有前置事项"}</strong>{exitBlockers.length?<ul>{exitBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul>:<p>{actualExitAction.reason||"请由本配载单的操作负责人确认实际出境。"}</p>}</div></div>}
    {actualExitSurfaceVisible&&exitConfirmed&&borderArrivalReady&&<div className="alert success">实际出境已确认{milestoneSurfaceVisible?"；可继续登记境外运输节点":""}。</div>}
    {exitSequenceAnomaly&&<div className="alert danger" role="alert"><strong>运输节点顺序异常</strong>：批次已经登记出境，但仍有 {exitSequenceOrders.length-exitReadyOrderCount} 票缺少更早的“口岸到达”记录。请补录真实到达时间；系统不会伪造历史时间。</div>}
    {milestoneSurfaceVisible&&<><div className="batch-tracking-note"><strong>配置门禁</strong><span>字段显隐、当前节点和必填状态来自冻结工作流；选填字段不会阻断。</span><strong>结构性顺序</strong><span>一旦登记运输事件，前后节点时间必须连续且幂等，防止产生不可能的轨迹。</span></div>
    <div className="table-wrap batch-tracking-node-table"><table><thead><tr><th>顺序</th><th>运输节点</th><th>流程进度</th><th>批次登记状态</th><th>最近登记</th><th>操作</th></tr></thead><tbody>{visibleMilestones.map((node,index)=>{
      const count=nodeOrders.filter(o=>{const list=milestonesByOrder.get(o.order_id)||[];return list.some(m=>m.milestone_code===node.code);}).length;
      const total=nodeOrders.length;
      const sample=visibleTrackingMilestones.find(m=>m.milestone_code===node.code);
      const sequenceAnomaly=node.code==="exported"&&count>0&&!borderArrivalReady;
      return <tr className={sequenceAnomaly?"blocked-row":count===total?"completed-row":count>0?"partial-row":""} key={node.code}>
        <td>{String(index+1).padStart(2,"0")}</td><td><strong>{node.name}</strong></td><td>{node.progress}%</td><td><span className={`status-pill ${sequenceAnomaly?"danger":count===total?"success":""}`}>{sequenceAnomaly?`顺序异常 · ${exitReadyOrderCount}/${total} 票口岸到达`:count===total?"全票已登记":count>0?`${count}/${total} 票`:"未登记"}</span></td><td>{sample?formatShortDateTime(sample.event_at):"—"}</td>
        <td>{node.code==="exported"&&!exitConfirmed?(actualExitSurfaceVisible&&borderArrivalReady&&canConfirmExit&&actualExitCanWrite?<a className="text-button batch-exit-gate-link" href="#batch-inline-exit-confirm">确认实际出境</a>:<span className="muted">{actualExitSurfaceVisible?"完成前置步骤后开放":"当前冻结工作流不登记"}</span>):milestoneCanWrite&&node.code!=="station_arrived"&&node.code!=="exported"?<Modal title={`登记运输节点 · ${node.name}`} triggerLabel="登记节点" triggerClassName="text-button" size="wide" closeSignal={actionCloseSignal}><BatchTrackingNodeForm nodeCode={node.code} total={total} fields={workflowPolicies} defaultEventAt={defaultEventAt} defaultLocation={defaultLocation(node.code)} defaultVehicle={defaultVehicle} busy={busy}/></Modal>:<span className="muted">{node.code==="exported"?"出境确认自动登记":node.code==="station_arrived"?"仓库自动登记":"当前只读"}</span>}</td>
      </tr>;
    })}</tbody></table></div></>}
    {trackingOrders.length>0&&<details className="batch-tracking-orders batch-inline-disclosure"><summary><span><strong>逐票节点状态</strong><small>仅显示当前工作流已启用运踪模块的订单</small></span><em aria-hidden="true"/></summary>
      <div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>最新节点</th><th>节点时间</th><th>地点</th><th>车辆</th><th>历史节点</th><th>操作</th></tr></thead><tbody>{visibleTrackingOrders.map(order=>{
        const latest=latestByOrder.get(order.order_id);
        const list=milestonesByOrder.get(order.order_id)||[];
        return <tr key={order.order_id}>
          <td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong><small>{order.customer_name}</small></td>
          <td>{latest?<span className={`status-pill ${milestoneProgressWeight[latest.milestone_code]??0>=100?"success":""}`}>{latest.milestone_name}</span>:<span className="status-pill off">未登记</span>}</td>
          <td>{latest?formatShortDateTime(latest.event_at):"—"}</td>
          <td>{latest?.location||"—"}</td>
          <td>{latest?.vehicle_reference||"—"}</td>
          <td><small className="tracking-history-list">{list.map(m=>`${m.milestone_name} ${formatShortDateTime(m.event_at)}`).join(" · ")||"无"}</small></td>
          <td><Link className="text-button" to={`/admin/orders/${order.order_id}/modules/tracking`}>订单跟踪</Link></td>
        </tr>;
      })}</tbody></table></div>
      <QueryPagination {...trackingPagination} pageParam="orderPage" unit="票订单"/>
    </details>}
  </section>;
}

function BatchExitConfirmForm({workflowPolicies,defaultEventAt,borderPort,borderPorts,defaultVehicle,busy}:{workflowPolicies:BatchOrderWorkflowPolicy[];defaultEventAt:string;borderPort:string|null;borderPorts:ReferenceOption[];defaultVehicle:string;busy:boolean}){
  const actualExit=batchWorkflowFieldPolicy(workflowPolicies,"tracking","actual_exit_at",true);
  const exitPort=batchWorkflowFieldPolicy(workflowPolicies,"loading","exit_port",true);
  const mainPlate=batchWorkflowFieldPolicy(workflowPolicies,"loading","main_plate_number",true);
  const notes=batchWorkflowFieldPolicy(workflowPolicies,"tracking","tracking_notes");
  const mark=(label:string,required:boolean)=>`${label}${required?" *":""}`;
  return <section className="batch-inline-exit-confirm" id="batch-inline-exit-confirm"><header><div><strong>当前待办：确认实际出境</strong><span>保存后同步已启用运踪的挂载订单，并进入境外运输阶段。</span></div><span className="status-pill warning">待确认</span></header><Form method="post" className="form-grid compact batch-inline-exit-form"><input type="hidden" name="intent" value="exit_confirm"/>
    {actualExit.visible&&<Field name="actualExitAt" label={mark(actualExit.label||"实际出境时间",actualExit.required)} type="datetime-local" required={actualExit.required} defaultValue={defaultEventAt}/>} 
    {exitPort.visible&&<label className="field"><span>{exitPort.label||"实际出境口岸"}{exitPort.required&&<b className="required-mark"> *</b>}</span><select name="exitPort" defaultValue={borderPort||""} required={exitPort.required}><option value="">请选择</option>{borderPorts.map(item=><option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}</select></label>}
    {mainPlate.visible&&<Field name="exitVehiclePlate" label={mark(mainPlate.label||"实际出境车辆车牌",mainPlate.required)} required={mainPlate.required} defaultValue={defaultVehicle}/>} 
    {notes.visible&&<Field name="exitNotes" label={mark(notes.label||"出境备注",notes.required)} required={notes.required}/>} 
    <button className="primary" disabled={busy}>确认实际出境并同步订单</button>
  </Form></section>;
}

function BatchTrackingNodeForm({nodeCode,total,fields,defaultEventAt,defaultLocation,defaultVehicle,busy}:{nodeCode:string;total:number;fields:BatchOrderWorkflowPolicy[];defaultEventAt:string;defaultLocation:string;defaultVehicle:string;busy:boolean}){
  const milestone=batchWorkflowFieldPolicy(fields,"tracking","tracking_milestone",true);
  const eventAt=batchWorkflowFieldPolicy(fields,"tracking","tracking_event_at",true);
  const location=batchWorkflowFieldPolicy(fields,"tracking","tracking_location",true);
  const vehicle=batchWorkflowFieldPolicy(fields,"tracking","tracking_vehicle");
  const notes=batchWorkflowFieldPolicy(fields,"tracking","tracking_notes");
  const customerVisibility=batchWorkflowFieldPolicy(fields,"tracking","visible_to_customer",true);
  const mark=(label:string,required:boolean)=>`${label}${required?" *":""}`;
  return <Form method="post" className="compact-tool-form batch-tracking-form batch-tracking-modal-form">
    <input type="hidden" name="intent" value="batch_tracking_add"/>
    {milestone.visible&&<input type="hidden" name="milestoneCode" value={nodeCode}/>} 
    {eventAt.visible&&<Field name="eventAt" label={mark(eventAt.label||"事件时间",eventAt.required)} type="datetime-local" required={eventAt.required} defaultValue={defaultEventAt}/>} 
    {location.visible&&<Field name="location" label={mark(location.label||"地点",location.required)} required={location.required} defaultValue={defaultLocation}/>} 
    {vehicle.visible&&<Field name="vehicleReference" label={mark(vehicle.label||"车辆/车牌",vehicle.required)} required={vehicle.required} defaultValue={defaultVehicle}/>} 
    {notes.visible&&<label className="field"><span>{notes.label||"备注"}{notes.required&&<b className="required-mark"> *</b>}</span><input name="notes" required={notes.required} placeholder="例如换装方式、清关说明"/></label>}
    {customerVisibility.visible&&<label className="field"><span>{customerVisibility.label||"客户可见"}{customerVisibility.required&&<b className="required-mark"> *</b>}</span><select name="visibleToCustomer" defaultValue="on" required={customerVisibility.required}><option value="on">客户可见</option><option value="off">仅内部</option></select></label>}
    <button className="primary" disabled={busy}>登记到本批 {total} 票订单</button>
  </Form>;
}

function BatchOrderCustomsWorkbench({orderId,declarations,fields,manage,allowRelease,busy,closeSignal}:{orderId:string;declarations:BatchCustomsDeclaration[];fields:BatchOrderWorkflowPolicy["fields"];manage:boolean;allowRelease:boolean;busy:boolean;closeSignal?:unknown}){
  const declarationsField=runtimeWorkflowFieldPolicy(fields,"customs_declarations",true);
  if(!declarationsField.visible)return null;
  const active=declarations.filter(item=>item.is_deleted!==1&&item.status!=="cancelled");
  const released=active.filter(item=>item.status==="released").length;
  const show=(fieldKey:string,fallbackRequired=false)=>runtimeWorkflowFieldPolicy(fields,fieldKey,fallbackRequired).visible;
  const releaseVisible=show("customs_release",true);
  return <section className="batch-order-customs-workbench">
    <header><div><strong>本票报关单</strong><span>{manage?"在这里查看或编辑；待放行操作在外层操作列直接办理":"只读汇总；办理操作在订单报关作业中完成"}</span></div><span className={`status-pill ${active.length>0&&released===active.length?"success":""}`}>{active.length?`${released}/${active.length} 张放行`:"尚无有效报关单"}</span></header>
    {declarations.length>0&&<div className="batch-customs-list"><div className="batch-customs-list-header" aria-hidden="true"><span>报关单 / 作业阶段</span><span>申报主体</span><span>金额 / 毛重</span><span>状态</span><span>操作</span></div>{declarations.map(declaration=><div className="batch-customs-row" key={declaration.id}>
      <div><strong>{show("declaration_number",true)?declaration.declaration_number:"报关记录"}</strong><small>{show("declaration_stage",true)?customsStageLabel(declaration.clearance_stage):""}{show("declaration_type",true)?` · ${declaration.declaration_type}`:""}</small></div>
      <div><span>{show("declaration_title",true)?declaration.declaration_title:"—"}</span><small>{show("declaring_company",true)?declaration.declaring_company:""}</small></div>
      <div><span>{show("declared_amount",true)||show("declaration_currency",true)?`${show("declaration_currency",true)?declaration.currency:""} ${show("declared_amount",true)?Number(declaration.declared_amount).toLocaleString():""}`:"—"}</span><small>{show("declaration_gross_weight",true)?`${Number(declaration.gross_weight_kg).toLocaleString()} KG`:""}</small></div>
      <span className={`status-pill ${declaration.status==="released"&&releaseVisible?"success":""}`}>{show("declaration_status",true)||releaseVisible?customsDeclarationStatusLabel(declaration):"已保存"}</span>
      <div className="batch-customs-actions">
        <Modal title={`查看报关单 · ${declaration.declaration_number}`} triggerLabel="查看" triggerClassName="text-button" size="wide"><BatchCustomsDeclarationView declaration={declaration} fields={fields}/></Modal>
        {manage&&<Modal title={`编辑报关单 · ${declaration.declaration_number}`} triggerLabel="编辑" triggerClassName="text-button" size="wide" dialogClassName="customs-declaration-modal" closeSignal={closeSignal}><BatchCustomsDeclarationForm orderId={orderId} declaration={declaration} fields={fields} allowRelease={allowRelease} busy={busy}/></Modal>}
      </div>
    </div>)}</div>}
    {!declarations.length&&<p className="empty-state">本票尚未登记报关单。先上传“报关资料”，再新增申报单。</p>}
    {manage&&<Modal title="新增本票报关单" triggerLabel="新增报关单" triggerClassName="primary batch-customs-create-button" size="wide" dialogClassName="customs-declaration-modal" closeSignal={closeSignal}><BatchCustomsDeclarationForm orderId={orderId} fields={fields} allowRelease={allowRelease} busy={busy}/></Modal>}
  </section>;
}

function BatchCustomsDeclarationView({declaration,fields}:{declaration:BatchCustomsDeclaration;fields:BatchOrderWorkflowPolicy["fields"]}){
  const flags=[declaration.is_deleted?"删单":"",declaration.is_redeclared?"删单重报":"",declaration.is_amended?"改单":"",declaration.is_inspected?"查验":""].filter(Boolean);
  const show=(fieldKey:string,fallbackRequired=false)=>runtimeWorkflowFieldPolicy(fields,fieldKey,fallbackRequired).visible;
  return <dl className="quote-detail-grid customs-declaration-view">
    {show("declaration_stage",true)&&<div><dt>作业阶段</dt><dd>{customsStageLabel(declaration.clearance_stage)}</dd></div>}{show("declaration_number",true)&&<div><dt>报关单号</dt><dd>{declaration.declaration_number}</dd></div>}
    {show("declaration_type",true)&&<div><dt>报关单类型</dt><dd>{declaration.declaration_type}</dd></div>}{show("declaration_status",true)&&<div><dt>状态</dt><dd>{customsDeclarationStatusLabel(declaration)}</dd></div>}
    {show("declaration_title",true)&&<div><dt>申报抬头</dt><dd>{declaration.declaration_title}</dd></div>}{show("declaring_company",true)&&<div><dt>申报公司</dt><dd>{declaration.declaring_company}</dd></div>}
    {(show("declared_amount",true)||show("declaration_currency",true))&&<div><dt>申报金额</dt><dd>{show("declaration_currency",true)?declaration.currency:""} {show("declared_amount",true)?Number(declaration.declared_amount).toLocaleString():""}</dd></div>}{show("declaration_gross_weight",true)&&<div><dt>申报毛重</dt><dd>{Number(declaration.gross_weight_kg).toLocaleString()} KG</dd></div>}
    {show("declared_at",true)&&<div><dt>申报时间</dt><dd>{formatShortDateTime(declaration.declared_at)}</dd></div>}{show("customs_release",true)&&<div><dt>放行时间</dt><dd>{formatShortDateTime(declaration.released_at)}</dd></div>}
    {show("declaration_change_flags")&&<div><dt>业务标记</dt><dd>{flags.join("、")||"无"}</dd></div>}{show("declaration_change_reason")&&<div><dt>变更原因</dt><dd>{declaration.change_reason||"—"}</dd></div>}
  </dl>;
}

function BatchCustomsDeclarationForm({orderId,declaration,fields,allowRelease,busy}:{orderId:string;declaration?:BatchCustomsDeclaration;fields:BatchOrderWorkflowPolicy["fields"];allowRelease:boolean;busy:boolean}){
  const policy=(fieldKey:string,fallbackRequired=false)=>runtimeWorkflowFieldPolicy(fields,fieldKey,fallbackRequired);
  const mark=(label:string,required:boolean)=>`${label}${required?" *":""}`;
  const stage=policy("declaration_stage",true),status=policy("declaration_status",true),number=policy("declaration_number",true),type=policy("declaration_type",true),title=policy("declaration_title",true),company=policy("declaring_company",true),declaredAt=policy("declared_at",true),amount=policy("declared_amount",true),currency=policy("declaration_currency",true),weight=policy("declaration_gross_weight",true),flagsPolicy=policy("declaration_change_flags"),reason=policy("declaration_change_reason"),release=policy("customs_release",true);
  const hasPrimary=[stage,status,number,type,title,company,declaredAt,amount,currency,weight].some(item=>item.visible);
  return <Form method="post" className="form-grid compact customs-declaration-form">
    <input type="hidden" name="intent" value="batch_order_customs_declaration_save"/><input type="hidden" name="orderId" value={orderId}/>
    {declaration&&<><input type="hidden" name="declarationId" value={declaration.id}/><input type="hidden" name="customsRecordId" value={declaration.customs_record_id}/></>}
    <div className="customs-form-intro"><div><strong>{declaration?"编辑报关单":"登记正式报关单"}</strong><span>保存后同步本票报关节点与配载单门禁</span></div><span className={`customs-form-state ${declaration?.status==="released"?"released":""}`}>{declaration?.status==="released"?"已放行":"待放行"}</span></div>
    {hasPrimary&&<section className="customs-form-section">
      <header><div><b>申报信息</b><span>字段显示和必填状态来自当前订单工作流</span></div><small>* 为工作流必填项</small></header>
      <div className="customs-form-field-grid">
        {stage.visible&&<label className="field customs-field-half"><span>{stage.label||"报关作业阶段"}{stage.required&&<b className="required-mark"> *</b>}</span><select name="clearanceStage" defaultValue={declaration?.clearance_stage||"origin"} required={stage.required}><option value="origin">起运地报关</option><option value="transit">过境地报关/清关</option><option value="destination">目的地清关</option></select></label>}
        {status.visible&&<label className="field customs-field-half"><span>{status.label||"申报单状态"}{status.required&&<b className="required-mark"> *</b>}</span><select name="status" defaultValue={declaration?.status==="released"&&allowRelease?"released":"declared"} required={status.required}><option value="declared">已申报，待放行</option>{release.visible&&allowRelease&&<option value="released">已放行</option>}</select></label>}
        {number.visible&&<Field className="customs-field-half" name="declarationNumber" label={mark(number.label||"报关单号",number.required)} required={number.required} defaultValue={declaration?.declaration_number||""}/>} {type.visible&&<Field className="customs-field-half" name="declarationType" label={mark(type.label||"报关单类型",type.required)} required={type.required} defaultValue={declaration?.declaration_type||""}/>} 
        {title.visible&&<Field className="customs-field-half" name="declarationTitle" label={mark(title.label||"申报抬头",title.required)} required={title.required} defaultValue={declaration?.declaration_title||""}/>} {company.visible&&<Field className="customs-field-half" name="declaringCompany" label={mark(company.label||"申报公司",company.required)} required={company.required} defaultValue={declaration?.declaring_company||""}/>} 
        {declaredAt.visible&&<Field className="customs-field-quarter" name="declaredAt" label={mark(declaredAt.label||"申报时间",declaredAt.required)} type="datetime-local" required={declaredAt.required} defaultValue={dateTimeLocal(declaration?.declared_at||new Date().toISOString())}/>} {amount.visible&&<Field className="customs-field-quarter" name="declaredAmount" label={mark(amount.label||"申报金额",amount.required)} type="number" required={amount.required} defaultValue={String(declaration?.declared_amount??0)}/>} 
        {currency.visible&&<label className="field customs-field-quarter"><span>{currency.label||"申报币种"}{currency.required&&<b className="required-mark"> *</b>}</span><select name="currency" defaultValue={declaration?.currency||"USD"} required={currency.required}>{["USD","CNY","RUB","KZT","UZS","EUR"].map(item=><option key={item} value={item}>{item}</option>)}</select></label>}
        {weight.visible&&<Field className="customs-field-quarter" name="grossWeightKg" label={mark(weight.label||"申报毛重 KG",weight.required)} type="number" required={weight.required} defaultValue={String(declaration?.gross_weight_kg??0)}/>} 
      </div>
    </section>}
    {(flagsPolicy.visible||reason.visible)&&<section className="customs-form-section customs-form-secondary">
      <header><div><b>业务变更</b><span>仅在发生特殊报关情况时填写</span></div><small>{flagsPolicy.required||reason.required?"含工作流必填项":"选填"}</small></header>
      {flagsPolicy.visible&&<fieldset className="customs-form-flags"><legend>{flagsPolicy.label||"业务标记"}{flagsPolicy.required&&<b className="required-mark"> *</b>}</legend><div className="check-row"><label><input name="isDeleted" type="checkbox" defaultChecked={declaration?.is_deleted===1}/>删单</label><label><input name="isRedeclared" type="checkbox" defaultChecked={declaration?.is_redeclared===1}/>删单重报</label><label><input name="isAmended" type="checkbox" defaultChecked={declaration?.is_amended===1}/>改单</label><label><input name="isInspected" type="checkbox" defaultChecked={declaration?.is_inspected===1}/>查验</label></div></fieldset>}
      {reason.visible&&<label className="field customs-form-reason"><span>{reason.label||"变更原因"}{reason.required&&<b className="required-mark"> *</b>}</span><textarea name="changeReason" rows={2} required={reason.required} defaultValue={declaration?.change_reason||""} placeholder="发生删单、重报、改单或查验时填写"/></label>}
    </section>}
    <footer className="customs-form-actions"><div><b>确认信息无误后保存</b><span>保存结果会立即同步订单工作流</span></div><button className="primary" disabled={busy}>{busy?"正在保存…":"保存报关单"}</button></footer>
  </Form>;
}

function BatchCustomsReleaseForm({orderId,declaration,fields,busy}:{orderId:string;declaration:BatchCustomsDeclaration;fields:BatchOrderWorkflowPolicy["fields"];busy:boolean}){
  const release=runtimeWorkflowFieldPolicy(fields,"customs_release",true);
  return <Form method="post" className="stack">
    <input type="hidden" name="intent" value="batch_order_customs_declaration_save"/><input type="hidden" name="orderId" value={orderId}/><input type="hidden" name="declarationId" value={declaration.id}/><input type="hidden" name="customsRecordId" value={declaration.customs_record_id}/><input type="hidden" name="releaseDeclaration" value="1"/>
    <BatchCustomsDeclarationView declaration={declaration} fields={fields}/><div className="alert warning">请确认上方当前工作流允许展示的报关内容无误且已获得海关放行。确认后将重算本票门禁和工作流。</div>
    {release.visible&&<label className="field"><span>{release.label||"放行时间"}{release.required&&<b className="required-mark"> *</b>}</span><input name="releasedAt" type="datetime-local" defaultValue={dateTimeLocal(new Date().toISOString())} required={release.required}/></label>}<button className="primary" disabled={busy}>确认放行并同步工作流</button>
  </Form>;
}

function customsStageLabel(stage:string){return stage==="origin"?"起运地报关":stage==="transit"?"过境地报关/清关":"目的地清关"}
function customsDeclarationStatusLabel(declaration:BatchCustomsDeclaration){if(declaration.is_deleted||declaration.status==="cancelled")return"已删单";return declaration.status==="released"?"已放行":"已申报"}
function batchExceptionScopeLabel(scope:string){return scope==="batch"?"整批":scope==="order"?"订单":"OUL 货物"}
function batchExceptionTypeLabel(type:string){return({cargo_damage:"货损",cargo_shortage:"货差/短少",document:"文件资料",customs:"报关/清关",vehicle:"车辆司机",delay:"时效延误",route:"线路/口岸",warehouse:"仓库作业",other:"其他"} as Record<string,string>)[type]||type}
function batchExceptionSeverityLabel(severity:string){return({low:"低",medium:"中",high:"高",critical:"紧急"} as Record<string,string>)[severity]||severity}
function batchExceptionStatusLabel(status:string){return({open:"待处理",processing:"处理中",resolved:"已结案",cancelled:"已取消"} as Record<string,string>)[status]||status}

function getBatchCurrentWork({status,documentGateReady,loadPlanReady,warehouseReady,borderArrivalReady,exceptionCount}:{status:string;documentGateReady:boolean;loadPlanReady:boolean;warehouseReady:boolean;borderArrivalReady:boolean;exceptionCount:number}){
  const exited=["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const sequenceAnomaly=exited&&!borderArrivalReady;
  const title=exceptionCount?`有 ${exceptionCount} 项异常待处理`:sequenceAnomaly?"运输节点顺序异常":arrived?"配载单流程已完成":exited?"境外运输中":warehouseReady&&!documentGateReady?"待补齐文件或报关放行":warehouseReady?"待出境确认":loadPlanReady?"待仓库装车出库":"待完善配载与车辆";
  const hint=exceptionCount?"异常处理不会回退已经完成的历史节点；标记为阻断推进的异常结案后才可继续。":sequenceAnomaly?"请在“口岸到达与实际出境”补录真实到达时间。":!warehouseReady?"先由仓库完成整批装车出库。":!documentGateReady?"下一步由整批单证负责人完成逐票报关与放行。":!borderArrivalReady?"下一步由整批操作负责人登记口岸到达；完成后同页确认实际出境。":!exited?"口岸已到达，请由整批操作负责人在同一页确认实际出境。":arrived?"境外仓收货清点已完成，可继续查看订单后续交付状态。":"继续由整批操作负责人维护境外运输节点。";
  return{title,hint};
}

function BatchWorkspaceTabs({status,documentGateReady,loadPlanReady,warehouseReady,borderArrivalReady,exceptionCount,activeTab,tabHref}:{status:string;documentGateReady:boolean;loadPlanReady:boolean;warehouseReady:boolean;borderArrivalReady:boolean;exceptionCount:number;activeTab:BatchWorkspaceTab;tabHref:(tab:BatchWorkspaceTab)=>string}){
  const exited=["outbound_in_transit","overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const arrived=["overseas_arrived","waiting_pickup","pickup_completed"].includes(status);
  const sequenceAnomaly=exited&&!borderArrivalReady;
  const tabs:{code:BatchWorkspaceTab;title:string;body:string;done:boolean}[]=[
    {code:"batch",title:"配载与车辆",body:"配载订单、车辆司机与分摊",done:loadPlanReady},
    {code:"outbound",title:"装车出库",body:warehouseReady?"仓库装车与交接已完成":"等待仓库完成装车交接",done:warehouseReady},
    {code:"documents",title:"报关与文件",body:"逐票文件、申报、编辑与放行",done:documentGateReady},
    {code:"tracking",title:"口岸到达与实际出境",body:sequenceAnomaly?"已出境，口岸到达待补录":exited?"已出境，继续维护运输节点":borderArrivalReady?"口岸已到达，待确认实际出境":"登记口岸到达后确认出境",done:exited},
    {code:"overseas",title:"境外到仓",body:"全部子订单扫码收货清点",done:arrived},
    {code:"exceptions",title:"异常处理",body:exceptionCount?`${exceptionCount} 项待处理 · 批次/订单/OUL`:"批次、订单或 OUL 就地登记",done:exceptionCount===0},
  ];
  const currentWork=getBatchCurrentWork({status,documentGateReady,loadPlanReady,warehouseReady,borderArrivalReady,exceptionCount});
  return <><div className="batch-current-node"><span>当前业务节点</span><strong>{currentWork.title}</strong><small>{currentWork.hint}</small></div><nav className="batch-workspace-tabs peer-page-tabs" aria-label="配载单工作区">{tabs.map(tab=><Link key={tab.code} to={tabHref(tab.code)} className={`${activeTab===tab.code?"active":""} ${tab.done?"done":""}`.trim()} aria-current={activeTab===tab.code?"page":undefined}><span className={`status-pill ${tab.done?"success":"off"}`}>{tab.done?"已完成":"待处理"}</span><strong>{tab.title}</strong><small>{tab.body}</small></Link>)}</nav></>;
}

function BatchCustomsPortal({orders,customsSummaries}:{orders:BatchOrder[];customsSummaries:CustomsSummary[]}){
  return <section className="batch-customs-portal-table"><div className="table-wrap"><table><thead><tr><th>订单</th><th>客户</th><th>报关放行状态</th><th>操作</th></tr></thead><tbody>{orders.map(order=>{const customs=customsSummaries.find(item=>item.order_id===order.order_id);const ready=Boolean(customs&&customs.total>0&&customs.released===customs.total);return <tr className={ready?"completed-row":""} key={order.order_id}><td><strong><OrderNumberLink id={order.order_id} number={order.order_number}/></strong></td><td>{order.customer_name}</td><td><span className={`status-pill ${ready?"success":""}`}>{ready?`${customs?.released} 张已放行`:customs?.total?`${customs.released}/${customs.total} 张放行`:"待录入"}</span></td><td><a className="text-button" href={`#batch-customs-${order.order_id}`}>查看本票报关</a></td></tr>})}</tbody><tfoot><tr><td colSpan={3}>全部通过 {orders.filter(order=>{const item=customsSummaries.find(summary=>summary.order_id===order.order_id);return item&&item.total>0&&item.released===item.total}).length}/{orders.length} 票</td><td><a className="secondary" href="#batch-files">打开逐票报关工作台</a></td></tr></tfoot></table></div></section>;
}

function WarehouseOutboundAction({orderId,batchId,customsReady}:{orderId:string;batchId:string;customsReady?:boolean}){
  const returnTo=`/admin/loading/${batchId}?fromOrderId=${encodeURIComponent(orderId)}`;
  const warehouseTo=`/warehouse/outbound?orderId=${encodeURIComponent(orderId)}&returnTo=${encodeURIComponent(returnTo)}`;
  return <div className="loading-warehouse-handoff">
    {customsReady===false&&<div className="alert warning" style={{marginBottom:"0.5rem"}}>⚠️ 本票报关单尚未收齐放行，配载出库前请先到「配载单文件工作台」处理报关资料与报关单。</div>}
    <div><strong>下一步由仓库办理</strong><span>仓库按已确认的配载车辆扫码拣货、装车并完成出库交接。</span></div><Form method="post" action="/switch-site"><input type="hidden" name="target" value="warehouse"/><input type="hidden" name="warehouseTo" value={warehouseTo}/><button className="primary">去仓库端拣货装车</button></Form></div>;
}

function WarehouseOverseasInboundAction({batchId,batchNumber,warehouseId,orderIds}:{batchId:string;batchNumber:string;warehouseId:string;orderIds:string[]}){
  const returnTo=`/admin/loading/${batchId}?tab=overseas`;
  const warehouseTo=buildBatchOverseasInboundHref({batchId,warehouseId,orderIds,returnTo});
  return <div className="loading-warehouse-handoff batch-overseas-inbound-handoff">
    <div><strong>整批交接境外目的仓</strong><span>{batchNumber} 共 {orderIds.length} 票；进入后自动限定本 PZ，仓库仍须逐票扫码清点。</span></div>
    <Form method="post" action="/switch-site"><input type="hidden" name="target" value="warehouse"/><input type="hidden" name="warehouseTo" value={warehouseTo}/><button className="primary">进入本 PZ 目的仓收货</button></Form>
  </div>;
}

export function CostAllocationSection({allocations,busy,manage,blockedReason}:{allocations:Awaited<ReturnType<typeof loadCostAllocations>>;busy:boolean;manage:boolean;blockedReason:string|null}){
  const draftCount=allocations.filter(item=>item.status==="draft").length;
  return <details className="panel cost-allocation-section batch-detail-disclosure"><summary className="batch-detail-summary"><div><h2>拼车成本分摊</h2><p>仅影响内部应付与毛利，不改变客户应收。</p></div><div className="batch-detail-summary-status"><span>{allocations.length} 条</span><b>{draftCount} 个待确认</b><em aria-hidden="true"/></div></summary><div className="batch-detail-disclosure-body">
    {!manage&&blockedReason&&<div className="alert warning">{blockedReason}</div>}
    {manage&&<details className="inline-details"><summary>新增分摊草稿</summary><Form method="post" className="form-grid compact"><input type="hidden" name="intent" value="create_cost_allocation"/><label className="field"><span>费用项目</span><select name="chargeCode" required><option value="">请选择</option>{COST_CHARGES.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label><Field name="counterpartyName" label="往来单位 / 供应商" required/><Field name="totalAmount" label="费用总额" type="number" required/><Field name="currency" label="币种" required defaultValue="CNY"/><Field name="exchangeRate" label="折本位币汇率" type="number" required defaultValue="1"/><label className="field"><span>分摊方式</span><select name="method" defaultValue="auto"><option value="auto">系统建议（推荐）</option><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><label className="field span-2"><span>费用备注</span><input name="allocationNotes" placeholder="例如口岸换装运费、报关费等"/></label><button className="primary" disabled={busy}>生成分摊草稿</button></Form></details>}
    {!allocations.length&&<p className="empty-state">暂无成本分摊。全部挂载订单完成装车出库后，可在这里生成分摊草稿。</p>}
    <div className="cost-allocation-list">{allocations.map(allocation=><section className="cost-allocation-sheet" key={allocation.id}><div className="table-wrap cost-allocation-summary-table"><table><thead><tr><th>费用项目</th><th>往来单位</th><th>总额</th><th>分摊方式</th><th>实收重量</th><th>实收体积</th><th>密度</th><th>状态</th></tr></thead><tbody><tr><td><strong>{allocation.charge_name}</strong></td><td>{allocation.counterparty_name}</td><td>{allocation.currency} {allocation.total_amount.toFixed(2)}</td><td>{allocationMethodLabel(allocation.allocation_method)}</td><td>{allocation.total_actual_weight_kg.toFixed(2)} KG</td><td>{allocation.total_actual_volume_cbm.toFixed(3)} CBM</td><td>{allocation.density_kg_per_cbm.toFixed(2)} KG/CBM<small>{allocation.density_result}</small></td><td><span className={`status-pill ${allocation.status==="confirmed"?"success":""}`}>{allocation.status==="confirmed"?"已确认入账":"草稿待复核"}</span><small>{allocation.confirmed_at?`确认时间 ${allocation.confirmed_at}`:"系统建议可人工调整"}</small></td></tr></tbody></table></div>
      {allocation.status==="draft"&&manage?<><Form method="post"><input type="hidden" name="intent" value="update_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><label className="field allocation-method"><span>复核分摊方式</span><select name="method" defaultValue={allocation.allocation_method}><option value="weight">按实收重量</option><option value="volume">按实收体积</option><option value="equal">按订单均分</option></select></label><div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>建议比例</th><th>建议金额</th><th>最终金额</th><th>调整原因</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong><OrderNumberLink id={line.order_id} number={line.order_number}/></strong><small>{line.customer_name}</small><input type="hidden" name="lineId" value={line.id}/></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{(line.suggested_ratio*100).toFixed(2)}%</td><td>{line.suggested_amount.toFixed(2)}</td><td><input className="table-input amount" type="number" min="0" step="0.01" name="lineAmount" defaultValue={line.final_amount.toFixed(2)} required/></td><td><input className="table-input reason" name="lineReason" defaultValue={line.adjustment_reason||""} placeholder="修改金额时必填"/></td></tr>)}</tbody></table></div><button className="secondary" disabled={busy}>保存人工复核结果</button></Form><Form method="post" className="allocation-confirm-form"><input type="hidden" name="intent" value="confirm_cost_allocation"/><input type="hidden" name="allocationId" value={allocation.id}/><p>确认后将生成正式应付费用并进入内部毛利核算；客户应收仍以订单费用模块的应收记录为准。</p><button className="primary" disabled={busy}>确认分摊并生成应付</button></Form></>:<div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>实收重量</th><th>实收体积</th><th>最终分摊</th><th>费用状态</th></tr></thead><tbody>{allocation.lines.map(line=><tr key={line.id}><td><strong><OrderNumberLink id={line.order_id} number={line.order_number}/></strong><small>{line.customer_name}</small></td><td>{line.actual_weight_kg.toFixed(2)} KG</td><td>{line.actual_volume_cbm.toFixed(3)} CBM</td><td>{allocation.currency} {line.final_amount.toFixed(2)}</td><td>{line.expense_id?"已生成应付":"待生成"}</td></tr>)}</tbody></table></div>}
    </section>)}</div>
  </div></details>
}

const COST_CHARGES=[
  {code:"FREIGHT",name:"运费"},{code:"LOADING",name:"装车费"},{code:"REINFORCEMENT",name:"加固费"},
  {code:"TRANSIT_CUSTOMS",name:"转关费"},{code:"CUSTOMS",name:"报关费"},{code:"INBOUND_WAREHOUSE",name:"入境仓储费"},
];
function summarizeBatch(orders:BatchOrder[],vehicles:Vehicle[]){
  return {
    orderCount:orders.length,
    pieces:orders.reduce((sum,item)=>sum+Number(item.pieces||0),0),
    declaredWeight:orders.reduce((sum,item)=>sum+Number(item.declared_weight_kg||0),0),
    declaredVolume:orders.reduce((sum,item)=>sum+Number(item.declared_volume_cbm||0),0),
    actualWeight:orders.reduce((sum,item)=>sum+Number(item.gross_weight_kg||0),0),
    actualVolume:orders.reduce((sum,item)=>sum+Number(item.volume_cbm||0),0),
    vehicleCount:vehicles.length,
    usedWeight:vehicles.reduce((sum,item)=>sum+Number(item.used_weight||0),0),
    usedVolume:vehicles.reduce((sum,item)=>sum+Number(item.used_volume||0),0),
  };
}
function LoadingTotals({totals}:{totals:ReturnType<typeof summarizeBatch>}){
  return <div className="loading-total-bar">
    <span>笔数：<strong>{totals.orderCount}</strong></span>
    <span>件数：<strong>{totals.pieces}</strong></span>
    <span>报关重量：<strong>{totals.declaredWeight.toFixed(2)}</strong> KG</span>
    <span>报关体积：<strong>{totals.declaredVolume.toFixed(3)}</strong> CBM</span>
    <span>进仓重量：<strong>{totals.actualWeight.toFixed(2)}</strong> KG</span>
    <span>进仓体积：<strong>{totals.actualVolume.toFixed(3)}</strong> CBM</span>
    <span>车辆：<strong>{totals.vehicleCount}</strong></span>
  </div>;
}
function OverseasResourceFields({batch,carrierId,carrierVehicles,carrierDrivers}:{batch:Batch;carrierId:string;carrierVehicles:CarrierVehicleOption[];carrierDrivers:CarrierDriverOption[]}){
  const vehicles=carrierVehicles.filter(item=>item.carrier_id===carrierId);
  const drivers=carrierDrivers.filter(item=>item.carrier_id===carrierId);
  const initialVehicle=vehicles.find(item=>item.plate_number===batch.overseas_vehicle_plate);
  const initialDriver=drivers.find(item=>item.name===batch.overseas_driver_name);
  const [vehicleMasterId,setVehicleMasterId]=useState(initialVehicle?.id||""),[driverMasterId,setDriverMasterId]=useState(initialDriver?.id||"");
  const [vehicleType,setVehicleType]=useState(batch.overseas_vehicle_type||""),[plate,setPlate]=useState(batch.overseas_vehicle_plate||"");
  const [driverName,setDriverName]=useState(batch.overseas_driver_name||""),[driverPhone,setDriverPhone]=useState(batch.overseas_driver_phone||"");
  return <>
    <label className="field span-2"><span>境外车辆 *</span><select name="overseasVehicleMasterId" required value={vehicleMasterId} disabled={!carrierId} onChange={event=>{const id=event.target.value;setVehicleMasterId(id);const master=vehicles.find(item=>item.id===id);setVehicleType(master?.vehicle_type||"");setPlate(master?.plate_number||"");}}><option value="">{carrierId?"请选择当前境外承运商名下车辆":"请先选择境外承运商"}</option>{vehicles.map(item=><option key={item.id} value={item.id}>{item.plate_number}{item.vehicle_type?` · ${item.vehicle_type}`:""}</option>)}</select></label>
    <label className="field"><span>境外车型</span><input name="overseasVehicleType" value={vehicleType} readOnly placeholder="选择车辆后自动带出" /></label>
    <label className="field"><span>境外车牌号</span><input name="overseasVehiclePlate" value={plate} readOnly placeholder="选择车辆后自动带出" /></label>
    <label className="field span-2"><span>境外司机 *</span><select name="overseasDriverMasterId" required value={driverMasterId} disabled={!carrierId} onChange={event=>{const id=event.target.value;setDriverMasterId(id);const master=drivers.find(item=>item.id===id);setDriverName(master?.name||"");setDriverPhone(master?.phone||"");}}><option value="">{carrierId?"请选择当前境外承运商名下司机":"请先选择境外承运商"}</option>{drivers.map(item=><option key={item.id} value={item.id}>{item.name}{item.phone?` · ${item.phone}`:""}</option>)}</select></label>
    <label className="field"><span>司机姓名</span><input name="overseasDriverName" value={driverName} readOnly placeholder="选择司机后自动带出" /></label>
    <label className="field"><span>司机电话</span><input name="overseasDriverPhone" value={driverPhone} readOnly placeholder="选择司机后自动带出" /></label>
  </>;
}

function Field({name,label,required,type="text",defaultValue,className}:{name:string;label:string;required?:boolean;type?:string;defaultValue?:string;className?:string}){return <label className={`field ${className||""}`.trim()}><span>{label}</span><input name={name} required={required} type={type} defaultValue={defaultValue} min={type==="number"?0:undefined} step={type==="number"?"0.001":undefined}/></label>}
function numberOf(form:FormData,name:string){const value=Number(valueOf(form,name)||0);return Number.isFinite(value)&&value>=0?value:0}
function positiveNumberOf(form:FormData,name:string,fallback=0){const value=Number(valueOf(form,name)||fallback);return Number.isFinite(value)&&value>0?value:0}
function errorMessage(error:unknown){return error instanceof Error?error.message:"操作失败，请稍后重试"}
async function mapWithConcurrency<T,R>(
  items:readonly T[],
  concurrency:number,
  worker:(item:T,index:number)=>Promise<R>,
):Promise<R[]> {
  if(!items.length)return[];
  const results=new Array<R>(items.length);
  let nextIndex=0;
  const workerCount=Math.min(Math.max(1,Math.floor(concurrency)),items.length);
  await Promise.all(Array.from({length:workerCount},async()=>{
    while(true){
      const index=nextIndex++;
      if(index>=items.length)return;
      results[index]=await worker(items[index],index);
    }
  }));
  return results;
}
function validateDocumentFile(file:File){
  const allowed=new Set(["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","image/jpeg","image/png","image/webp"]);
  if(file.size>maxInlineOrderDocumentBytes)return"当前数据库直存模式下单个文件不能超过1.2MB";
  if(!allowed.has(file.type))return"仅支持 PDF、Word、Excel 和图片文件";
  return null;
}
async function toDataUrl(file:File){
  const bytes=new Uint8Array(await file.arrayBuffer());let binary="";
  for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  return `data:${file.type};base64,${btoa(binary)}`;
}
function documentReviewLabel(status:string){return({pending:"待审核",approved:"已通过",rejected:"已退回",archived:"已归档"} as Record<string,string>)[status]||status}
function batchDocumentTypeLabel(code:string){return BATCH_DOCUMENT_TYPES.find(item=>item.code===code)?.name||code}
function dateTimeLocal(value:string|null){return value?value.slice(0,16):""}
function formatShortDateTime(value:string|null){return value?value.slice(0,16).replace("T"," "):"待填写"}
export function meta(){return[{title:"配载批次详情 | International TMS"}]}
