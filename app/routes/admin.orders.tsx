import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useLocation } from "react-router";
import type { Route } from "./+types/admin.orders";
import { Modal } from "../components/Modal";
import { OrganizationAssigneePicker } from "../components/OrganizationAssigneePicker";
import { ActionToast } from "../components/ActionToast";
import type { OrganizationAssigneeMember } from "../lib/organization-assignee";
import {
  batchInitialResponsibilityDisabledReasons,
  buildBatchInitialResponsibilityRestrictions,
  type BatchInitialResponsibilityRestrictions,
} from "../lib/batch-responsibility";
import { loadBatchesInitialResponsibilityRestrictions } from "../lib/batch-responsibility.server";
import { OrderRouteFilterFields } from "../components/OrderRouteFilterFields";
import { requireSessionUser } from "../lib/auth.server";
import { assignedBatchViewPermission, canOperateCurrentOrder, currentOrderActionSql, orderVisibilitySql } from "../lib/order-access.server";
import { orderRouteFilterCount, readOrderRouteFilters } from "../lib/order-route-filters";
import {
  batchAssignmentStatus,
  batchExecutionStatus,
  orderWorkloadViewHref,
  resolveBatchWorkloadRole,
  resolveOrderWorkloadView,
  type BatchWorkloadRole,
  type OrderWorkloadView,
} from "../lib/order-workload-view";
import { orderDetailQueueHref, orderQueueContextFromList } from "../lib/order-queue-navigation";
import { ordinaryOrderBatchExclusionSql } from "../lib/batch-order-list";
import { chunkD1Values, d1Placeholders } from "../lib/d1-bindings";

type OrderRow = {
  id: string;
  order_number: string;
  order_date: string | null;
  customer_name: string;
  quote_number: string | null;
  business_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  origin_state: string | null;
  origin_city: string;
  exit_port: string | null;
  exit_port_name: string | null;
  destination_state: string | null;
  destination_city: string;
  overseas_warehouse_name: string | null;
  status: string;
  current_step_name: string | null;
  current_assignee_user_id: string | null;
  assignee_name: string | null;
  exception_status: string | null;
  completion_status: string | null;
  quote_withdrawn: number;
  created_at: string;
  updated_at: string;
};

type FilterOption = { value: string; label: string };

type BatchAssignmentRow = {
  id: string;
  batch_number: string;
  origin_location: string;
  destination_location: string;
  status: string;
  road_status: string;
  approval_status: string;
  operation_assignee_user_id: string | null;
  document_assignee_user_id: string | null;
  operation_supervisor_name: string | null;
  operation_assignee_name: string | null;
  document_assignee_name: string | null;
  approved_by_name: string | null;
  order_count: number;
  order_numbers: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  updated_at: string;
};

type BatchMountedOrder = {
  batch_id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  current_step_name: string | null;
  current_assignee_name: string | null;
};

type BatchAssignmentViewRow = BatchAssignmentRow & {
  initialResponsibilityRestrictions: BatchInitialResponsibilityRestrictions;
  mountedOrders: BatchMountedOrder[];
};

type SupervisorWorkItem =
  | { kind: "order"; sortAt: string; order: OrderRow & { can_operate_current_node: boolean } }
  | { kind: "batch"; sortAt: string; batch: BatchAssignmentViewRow };

type BatchAssignmentActionData = { success?: string; formError?: string };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") || "").trim();
  const type = url.searchParams.get("type") || "";
  const handlingScope = url.searchParams.get("handlingScope") === "mine" ? "mine" : "";
  const requestedWorkStatus = url.searchParams.get("workStatus") || "";
  const workStatus = ["pending", "active", "completed", "exception"].includes(requestedWorkStatus)
    ? requestedWorkStatus
    : "";
  const status = url.searchParams.get("status") || "";
  const step = url.searchParams.get("step") || "";
  const exception = url.searchParams.get("exception") || "";
  const routeFilters = readOrderRouteFilters(url.searchParams);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = 10;
  const batchPage = Math.max(1, Number(url.searchParams.get("batchPage") || 1));
  const batchPageSize = 10;
  const legacyBatchKeyword = (url.searchParams.get("batchKeyword") || "").trim();
  const requestedBatchStatus = url.searchParams.get("batchStatus") || "";
  const batchStatus = batchStatusOptions.some((option) => option.value === requestedBatchStatus)
    ? requestedBatchStatus
    : "";
  const privileged = ["BOSS", "DEVELOPER"].includes(current.positionCode ?? "")
    || current.roleCodes.some((code) => ["owner", "boss", "developer"].includes(code));
  const canApproveBatches = privileged || current.permissions.includes("transport.batch.approve");
  const canViewAssignedBatches = current.permissions.includes(assignedBatchViewPermission);
  const batchWorkloadRole = resolveBatchWorkloadRole({
    positionCode: current.positionCode,
    privileged,
    canApproveBatches,
    canViewAssignedBatches,
  });
  const canViewBatchWorkload = batchWorkloadRole !== null;
  const unifiedSupervisorWorkload = batchWorkloadRole === "supervisor";
  const batchKeyword = unifiedSupervisorWorkload ? keyword : legacyBatchKeyword;
  const where = ["o.organization_id=?"];
  const values: unknown[] = [current.organizationId];
  const visibility = orderVisibilitySql(current, "o");
  where.push(visibility.sql);
  values.push(...visibility.values);
  const ordinaryBatchExclusionSql = ordinaryOrderBatchExclusionSql("o");
  if (canViewBatchWorkload) {
    where.push(ordinaryBatchExclusionSql);
  }
  if (keyword) {
    where.push("(o.order_number LIKE ? OR c.name LIKE ? OR o.cargo_description LIKE ? OR q.quote_number LIKE ?)");
    const pattern = `%${keyword}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (type === "batch" || (unifiedSupervisorWorkload && batchStatus)) {
    where.push("1=0");
  } else if (["ftl", "ltl"].includes(type)) {
    where.push("o.business_type=?");
    values.push(type);
  }
  if (!unifiedSupervisorWorkload && handlingScope === "mine") {
    const actionable = currentOrderActionSql(current, "o");
    where.push(actionable.sql);
    values.push(...actionable.values);
  }
  if (unifiedSupervisorWorkload && workStatus === "pending") {
    where.push("o.status NOT IN ('completed','cancelled') AND o.current_assignee_user_id=?");
    values.push(current.userId);
  }
  if (unifiedSupervisorWorkload && workStatus === "active") where.push("o.status NOT IN ('completed','cancelled')");
  if (unifiedSupervisorWorkload && workStatus === "completed") where.push("o.status='completed'");
  if (unifiedSupervisorWorkload && workStatus === "exception") where.push("(o.status='cancelled' OR COALESCE(o.exception_status,'normal')!='normal')");
  if (status) {
    where.push("o.status=?");
    values.push(status);
  }
  if (step) {
    where.push("COALESCE(o.current_step_name,'')=?");
    values.push(step);
  }
  if (exception === "yes") where.push("COALESCE(o.exception_status,'normal')!='normal'");
  if (exception === "no") where.push("COALESCE(o.exception_status,'normal')='normal'");
  if (routeFilters.origin) {
    const pattern = `%${routeFilters.origin}%`;
    where.push("(o.origin_country LIKE ? OR o.origin_state LIKE ? OR o.origin_city LIKE ? OR o.origin_address LIKE ?)");
    values.push(pattern, pattern, pattern, pattern);
  }
  if (routeFilters.exitPort) {
    const pattern = `%${routeFilters.exitPort}%`;
    where.push("(o.exit_port LIKE ? OR EXISTS (SELECT 1 FROM reference_data route_port WHERE route_port.organization_id=o.organization_id AND route_port.category='border_port' AND route_port.code=o.exit_port AND route_port.name LIKE ?))");
    values.push(pattern, pattern);
  }
  if (routeFilters.destination) {
    const pattern = `%${routeFilters.destination}%`;
    where.push("(o.destination_country LIKE ? OR o.destination_state LIKE ? OR o.destination_city LIKE ? OR o.destination_address LIKE ? OR EXISTS (SELECT 1 FROM warehouses route_warehouse WHERE route_warehouse.organization_id=o.organization_id AND route_warehouse.id=o.overseas_warehouse_id AND route_warehouse.name LIKE ?))");
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  const clause = where.join(" AND ");
  const orderFetchLimit = unifiedSupervisorWorkload ? page * pageSize : pageSize;
  const orderFetchOffset = unifiedSupervisorWorkload ? 0 : (page - 1) * pageSize;
  const [rows, countRow, stepRows] = await Promise.all([
    env.DB.prepare(
      `SELECT o.id,o.order_number,o.order_date,c.name customer_name,q.quote_number,o.business_type,
        o.cargo_description,o.pieces,o.gross_weight_kg,o.volume_cbm,o.origin_state,o.origin_city,
        o.exit_port,bp.name exit_port_name,o.destination_state,o.destination_city,ow.name overseas_warehouse_name,o.status,
        o.current_step_name,o.current_assignee_user_id,u.display_name assignee_name,o.exception_status,o.completion_status,
        COALESCE(o.quote_withdrawn,0) quote_withdrawn,o.created_at,o.updated_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
       LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
       LEFT JOIN reference_data bp ON bp.organization_id=o.organization_id AND bp.category='border_port' AND bp.code=o.exit_port
       LEFT JOIN users u ON u.id=o.current_assignee_user_id
       WHERE ${clause}
       ORDER BY o.updated_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...values, orderFetchLimit, orderFetchOffset).all<OrderRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) count FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
       WHERE ${clause}`,
    ).bind(...values).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT DISTINCT o.current_step_name value,o.current_step_name label
       FROM transport_orders o
       WHERE o.organization_id=? AND ${visibility.sql}
         ${canViewBatchWorkload ? `AND ${ordinaryBatchExclusionSql}` : ""}
         AND o.current_step_name IS NOT NULL
       ORDER BY current_step_name`,
    ).bind(current.organizationId, ...visibility.values).all<FilterOption>(),
  ]);
  const batchOwnerColumn = batchWorkloadRole === "operation"
    ? "operation_assignee_user_id"
    : batchWorkloadRole === "document"
      ? "document_assignee_user_id"
      : "operation_supervisor_user_id";
  const batchOwnerSql = privileged ? "" : `AND b.${batchOwnerColumn}=?`;
  const batchScopeBinds = privileged ? [current.organizationId] : [current.organizationId, current.userId];
  const batchFilterConditions: string[] = [];
  const batchFilterBinds: unknown[] = [];
  if (unifiedSupervisorWorkload && (["ftl", "ltl"].includes(type) || status || step || exception)) {
    batchFilterConditions.push("1=0");
  }
  if (unifiedSupervisorWorkload && workStatus === "pending") {
    batchFilterConditions.push("b.approval_status='submitted' AND b.status!='cancelled'");
  }
  if (unifiedSupervisorWorkload && workStatus === "active") {
    batchFilterConditions.push("b.approval_status='approved' AND b.status!='cancelled' AND b.road_status NOT IN ('pickup_completed','cancelled')");
  }
  if (unifiedSupervisorWorkload && workStatus === "completed") {
    batchFilterConditions.push("b.approval_status='approved' AND b.road_status='pickup_completed' AND b.status!='cancelled'");
  }
  if (unifiedSupervisorWorkload && workStatus === "exception") {
    batchFilterConditions.push("(b.approval_status='rejected' OR b.status='cancelled' OR b.road_status='cancelled')");
  }
  if (batchKeyword) {
    const pattern = `%${batchKeyword}%`;
    batchFilterConditions.push(`(
      b.batch_number LIKE ? OR b.origin_location LIKE ? OR b.destination_location LIKE ? OR EXISTS(
        SELECT 1 FROM transport_batch_orders search_batch_order
        JOIN transport_orders search_order
          ON search_order.id=search_batch_order.order_id
         AND search_order.organization_id=search_batch_order.organization_id
        WHERE search_batch_order.batch_id=b.id
          AND search_batch_order.organization_id=b.organization_id
          AND search_batch_order.status!='removed'
          AND (search_order.order_number LIKE ? OR search_order.cargo_description LIKE ?)
      )
    )`);
    batchFilterBinds.push(pattern, pattern, pattern, pattern, pattern);
  }
  if (unifiedSupervisorWorkload && routeFilters.origin) {
    batchFilterConditions.push("b.origin_location LIKE ?");
    batchFilterBinds.push(`%${routeFilters.origin}%`);
  }
  if (unifiedSupervisorWorkload && routeFilters.exitPort) {
    batchFilterConditions.push("COALESCE(b.border_port,'') LIKE ?");
    batchFilterBinds.push(`%${routeFilters.exitPort}%`);
  }
  if (unifiedSupervisorWorkload && routeFilters.destination) {
    batchFilterConditions.push("b.destination_location LIKE ?");
    batchFilterBinds.push(`%${routeFilters.destination}%`);
  }
  const batchStatusSql: Record<string, string> = {
    draft: "b.approval_status='draft' AND b.status!='cancelled'",
    submitted: "b.approval_status='submitted' AND b.status!='cancelled'",
    assigned: "b.approval_status='approved' AND b.operation_assignee_user_id IS NOT NULL AND b.document_assignee_user_id IS NOT NULL AND b.status!='cancelled'",
    rejected: "b.approval_status='rejected' AND b.status!='cancelled'",
    waiting_loading: "b.approval_status='approved' AND b.road_status='waiting_loading' AND b.status!='cancelled'",
    preplanned: "b.approval_status='approved' AND b.road_status='preplanned' AND b.status!='cancelled'",
    loaded_waiting_exit: "b.approval_status='approved' AND b.road_status='loaded_waiting_exit' AND b.status!='cancelled'",
    outbound_in_transit: "b.approval_status='approved' AND b.road_status='outbound_in_transit' AND b.status!='cancelled'",
    overseas_arrived: "b.approval_status='approved' AND b.road_status='overseas_arrived' AND b.status!='cancelled'",
    waiting_pickup: "b.approval_status='approved' AND b.road_status='waiting_pickup' AND b.status!='cancelled'",
    pickup_completed: "b.approval_status='approved' AND b.road_status='pickup_completed' AND b.status!='cancelled'",
    cancelled: "(b.status='cancelled' OR b.road_status='cancelled')",
  };
  if (batchStatus && batchStatusSql[batchStatus]) batchFilterConditions.push(batchStatusSql[batchStatus]);
  const batchFilterSql = batchFilterConditions.length ? `AND ${batchFilterConditions.join(" AND ")}` : "";
  const batchPrioritySql = batchWorkloadRole === "supervisor"
    ? "b.approval_status='submitted' AND b.status!='cancelled'"
    : "b.approval_status='approved' AND b.status!='cancelled' AND b.road_status NOT IN ('cancelled','overseas_arrived','waiting_pickup','pickup_completed')";
  const batchFetchLimit = unifiedSupervisorWorkload ? page * batchPageSize : batchPageSize;
  const batchFetchOffset = unifiedSupervisorWorkload ? 0 : (batchPage - 1) * batchPageSize;
  const batchOrderSql = unifiedSupervisorWorkload
    ? "b.updated_at DESC"
    : `CASE WHEN ${batchPrioritySql} THEN 0 ELSE 1 END,
       CASE WHEN ${batchPrioritySql} THEN COALESCE(b.submitted_at,b.updated_at) END ASC,
       COALESCE(b.approved_at,b.updated_at) DESC`;
  const [batchAssignmentRows, batchCountRow, responsibilityMemberRows] = canViewBatchWorkload
    ? await Promise.all([
        env.DB.prepare(
          `SELECT b.id,b.batch_number,b.origin_location,b.destination_location,
              b.status,b.road_status,b.approval_status,b.operation_assignee_user_id,b.document_assignee_user_id,
              supervisor.display_name operation_supervisor_name,
              operator.display_name operation_assignee_name,
              document_owner.display_name document_assignee_name,
              approved_by.display_name approved_by_name,
              COUNT(DISTINCT bo.order_id) order_count,
              GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
              b.submitted_at,b.approved_at,b.updated_at
           FROM transport_batches b
           JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.organization_id=b.organization_id AND bo.status!='removed'
           JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id AND o.business_type='ltl'
           LEFT JOIN users supervisor ON supervisor.id=b.operation_supervisor_user_id
           LEFT JOIN users operator ON operator.id=b.operation_assignee_user_id
           LEFT JOIN users document_owner ON document_owner.id=b.document_assignee_user_id
           LEFT JOIN users approved_by ON approved_by.id=b.approved_by_user_id
           WHERE b.organization_id=? AND b.batch_number LIKE 'PZ-%' ${batchOwnerSql} ${batchFilterSql}
           GROUP BY b.id
           ORDER BY ${batchOrderSql}
           LIMIT ? OFFSET ?`,
        ).bind(...batchScopeBinds, ...batchFilterBinds, batchFetchLimit, batchFetchOffset).all<BatchAssignmentRow>(),
        env.DB.prepare(
          `SELECT COUNT(*) count,
                  SUM(CASE WHEN ${batchPrioritySql} THEN 1 ELSE 0 END) priority_count
             FROM transport_batches b
            WHERE b.organization_id=? AND b.batch_number LIKE 'PZ-%' ${batchOwnerSql} ${batchFilterSql}
              AND EXISTS(
                SELECT 1 FROM transport_batch_orders bo
                JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
                WHERE bo.batch_id=b.id AND bo.organization_id=b.organization_id
                  AND bo.status!='removed' AND o.business_type='ltl'
              )`,
        ).bind(...batchScopeBinds, ...batchFilterBinds).first<{ count: number; priority_count: number | null }>(),
        canApproveBatches
          ? env.DB.prepare(
              `SELECT u.id,u.display_name,
                  d.id department_id,d.code department_code,d.name department_name,
                  p.id position_id,p.code position_code,p.name position_name
               FROM memberships m
               JOIN users u ON u.id=m.user_id AND u.status='active'
               JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id AND d.status='active'
               JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
                 AND p.department_code=d.code
               WHERE m.organization_id=? AND m.status='active' AND p.code IN ('OPERATION','DOC')
               ORDER BY d.sort_order,p.sort_order,u.display_name`,
            ).bind(current.organizationId).all<OrganizationAssigneeMember>()
          : Promise.resolve({ results: [] as OrganizationAssigneeMember[] }),
      ])
    : [
        { results: [] as BatchAssignmentRow[] },
        { count: 0, priority_count: 0 },
        { results: [] as OrganizationAssigneeMember[] },
      ];
  const total = countRow?.count || 0;
  const mountedOrderRows = canApproveBatches && batchAssignmentRows.results.length
    ? (await Promise.all(chunkD1Values(batchAssignmentRows.results.map((batch) => batch.id), 1).map((batchIds) => env.DB.prepare(
        `SELECT bo.batch_id,o.id order_id,o.order_number,c.name customer_name,o.cargo_description,
                o.pieces,o.gross_weight_kg,o.volume_cbm,o.current_step_name,
                current_owner.display_name current_assignee_name
           FROM transport_batch_orders bo
           JOIN transport_orders o ON o.id=bo.order_id AND o.organization_id=bo.organization_id
           JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
           LEFT JOIN users current_owner ON current_owner.id=o.current_assignee_user_id
          WHERE bo.organization_id=? AND bo.status!='removed'
            AND bo.batch_id IN (${d1Placeholders(batchIds.length)})
          ORDER BY bo.batch_id,o.order_number`,
      ).bind(current.organizationId, ...batchIds).all<BatchMountedOrder>()))).flatMap((result) => result.results)
    : [];
  const mountedOrdersByBatch = mountedOrderRows.reduce<Record<string, BatchMountedOrder[]>>((groups, order) => {
    (groups[order.batch_id] ||= []).push(order);
    return groups;
  }, {});
  const initialResponsibilityRestrictionsByBatch = canApproveBatches
    ? await loadBatchesInitialResponsibilityRestrictions(
        env.DB,
        current.organizationId,
        batchAssignmentRows.results
          .filter((batch) => batch.approval_status === "submitted")
          .map((batch) => batch.id),
      )
    : {};
  const batchAssignments: BatchAssignmentViewRow[] = batchAssignmentRows.results.map((batch) => ({
    ...batch,
    initialResponsibilityRestrictions:
      initialResponsibilityRestrictionsByBatch[batch.id]
      ?? buildBatchInitialResponsibilityRestrictions([]),
    mountedOrders: mountedOrdersByBatch[batch.id] || [],
  }));
  const orders = rows.results.map((order) => ({
    ...order,
    can_operate_current_node: canOperateCurrentOrder(current, order),
  }));
  const unifiedTotal = total + (batchCountRow?.count || 0);
  const supervisorWorkItems: SupervisorWorkItem[] = unifiedSupervisorWorkload
    ? [
        ...orders.map((order): SupervisorWorkItem => ({ kind: "order", sortAt: order.updated_at, order })),
        ...batchAssignments.map((batch): SupervisorWorkItem => ({
          kind: "batch",
          sortAt: batch.updated_at,
          batch,
        })),
      ]
        .sort((left, right) => right.sortAt.localeCompare(left.sortAt)
          || (left.kind === right.kind ? 0 : left.kind === "order" ? -1 : 1))
        .slice((page - 1) * pageSize, page * pageSize)
    : [];
  const workloadView = resolveOrderWorkloadView({
    requestedView: url.searchParams.get("view"),
    canViewBatchWorkload,
    priorityBatchCount: batchCountRow?.priority_count || 0,
  });
  return {
    orders,
    filters: { keyword, type, handlingScope, workStatus, status, step, exception, batchKeyword: unifiedSupervisorWorkload ? "" : batchKeyword, batchStatus, view: workloadView, batchPage: String(batchPage), ...routeFilters },
    steps: stepRows.results,
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    canApproveBatches,
    canViewBatchWorkload,
    batchWorkloadRole,
    batchAssignments,
    batchPage,
    batchPages: Math.max(1, Math.ceil((batchCountRow?.count || 0) / batchPageSize)),
    batchTotal: batchCountRow?.count || 0,
    priorityBatchCount: batchCountRow?.priority_count || 0,
    supervisorWorkItems,
    unifiedSupervisorWorkload,
    unifiedTotal,
    unifiedPages: Math.max(1, Math.ceil(unifiedTotal / pageSize)),
    operationMembers: responsibilityMemberRows.results.filter((member) => member.position_code === "OPERATION"),
    documentMembers: responsibilityMemberRows.results.filter((member) => member.position_code === "DOC"),
    workloadView,
  };
}

export default function Orders({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const active = loaderData.orders.filter((order) => !["completed", "cancelled"].includes(order.status)).length;
  const completed = loaderData.orders.filter((order) => order.status === "completed").length;
  const exceptions = loaderData.orders.filter((order) => order.exception_status && order.exception_status !== "normal").length;
  const advancedFilterCount = orderRouteFilterCount(loaderData.filters);
  const orderQueue = orderQueueContextFromList({
    returnTo: `${location.pathname}${location.search}`,
    orderIds: loaderData.unifiedSupervisorWorkload
      ? loaderData.supervisorWorkItems
          .filter((item): item is Extract<SupervisorWorkItem, { kind: "order" }> => item.kind === "order")
          .map((item) => item.order.id)
      : loaderData.orders.map((order) => order.id),
  });
  return (
    <div className="page prototype-page order-list-page">
      <div className="breadcrumb">汽运业务 / 运输订单</div>
      <header className="page-head">
        <div><h1>运输订单</h1><p>订单由客户接受报价后自动生成；在一张表内筛选、查看并进入当前业务节点。</p></div>
        <Link className="btn primary" to="/admin/quotations">前往询价与报价</Link>
      </header>
      {loaderData.canViewBatchWorkload && !loaderData.unifiedSupervisorWorkload && <OrderWorkloadTabs
        active={loaderData.workloadView}
        batchCount={loaderData.batchTotal}
        orderCount={loaderData.total}
        filters={loaderData.filters}
      />}
      {loaderData.unifiedSupervisorWorkload ? (
        <SupervisorUnifiedQueue
          items={loaderData.supervisorWorkItems}
          operationMembers={loaderData.operationMembers}
          documentMembers={loaderData.documentMembers}
          pendingBatchCount={loaderData.priorityBatchCount}
          orderCount={loaderData.total}
          batchCount={loaderData.batchTotal}
          total={loaderData.unifiedTotal}
          page={loaderData.page}
          pages={loaderData.unifiedPages}
          filters={loaderData.filters}
          steps={loaderData.steps}
          orderQueue={orderQueue}
        />
      ) : loaderData.workloadView === "batches" ? (
        <BatchExecutionQueue
          batches={loaderData.batchAssignments}
          role={loaderData.batchWorkloadRole}
          activeCount={loaderData.priorityBatchCount}
          total={loaderData.batchTotal}
          page={loaderData.batchPage}
          pages={loaderData.batchPages}
          filters={loaderData.filters}
        />
      ) : <>
      <section className="kpis compact-kpis" aria-label="普通订单概览">
        <div><span>当前结果</span><b>{loaderData.total}</b><small>符合筛选条件</small></div>
        <div><span>业务处理中</span><b>{active}</b><small>当前页</small></div>
        <div><span>已完成</span><b>{completed}</b><small>当前页</small></div>
        <div><span>异常订单</span><b>{exceptions}</b><small>当前页</small></div>
      </section>
      <Form method="get" action="." className="filters order-table-filters">
        {loaderData.canViewBatchWorkload && <input type="hidden" name="view" value="orders"/>}
        <label className="field wide"><span>快速查找</span><input className="control" name="keyword" data-keyboard-search defaultValue={loaderData.filters.keyword} placeholder="订单号、客户或货物"/></label>
        <FilterSelect name="type" label="订单类型" value={loaderData.filters.type} options={[{ value: "ftl", label: "整车" }, { value: "ltl", label: "拼车" }]}/>
        <FilterSelect name="handlingScope" label="办理范围" value={loaderData.filters.handlingScope} options={[{ value: "mine", label: "待我办理" }]}/>
        <FilterSelect name="status" label="订单状态" value={loaderData.filters.status} options={statusOptions}/>
        <FilterSelect name="step" label="当前节点" value={loaderData.filters.step} options={loaderData.steps}/>
        <FilterSelect name="exception" label="异常" value={loaderData.filters.exception} options={[{ value: "no", label: "无异常" }, { value: "yes", label: "有异常" }]}/>
        <button className="btn primary">筛选</button>
        <Link className="btn" to={loaderData.canViewBatchWorkload ? "/admin/orders?view=orders" : "/admin/orders"}>重置</Link>
        <details className="order-route-advanced-filter" open={advancedFilterCount > 0}>
          <summary><span>更多筛选条件</span><small>{advancedFilterCount ? `已启用 ${advancedFilterCount} 项` : "出发地、出境口岸、目的地"}</small></summary>
          <div className="order-route-filter-grid"><OrderRouteFilterFields filters={loaderData.filters}/></div>
        </details>
      </Form>
      <section className="table-panel order-table-panel">
        <div className="table-panel-head"><div><b>普通订单</b><span>有当前节点办理权限时显示橙色入口；其他订单仅供查看。</span></div><span>{loaderData.total} 单</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>订单号</th><th>客户</th><th>类型</th><th>货物与实物数据</th><th>线路与目的仓</th><th>当前节点</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {loaderData.orders.map((order) => (
                <tr
                  key={order.id}
                  className={[
                    order.can_operate_current_node ? "order-todo-row" : "",
                    order.status !== "completed" && order.exception_status && order.exception_status !== "normal" ? "row-alert" : "",
                  ].filter(Boolean).join(" ")}
                >
                  <td><Link className="order-id order-number-only" title={order.order_number} to={orderDetailQueueHref(order.id, orderQueue)}>{order.order_number}</Link></td>
                  <td><b>{order.customer_name}</b><small className="subline">{order.order_date || order.created_at.slice(0, 10)}</small></td>
                  <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车" : "整车"}</span></td>
                  <td><b>{order.cargo_description || "未填写"}</b><small className="subline">{order.pieces} 件 · {order.gross_weight_kg} KG · {order.volume_cbm} CBM</small></td>
                  <td><b>{order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city}</b><small className="subline">{order.exit_port_name || order.exit_port || "口岸待定"} · {order.overseas_warehouse_name || "目的仓未填写"}</small></td>
                  <td><b>{order.quote_withdrawn ? "报价接受已撤回" : order.current_step_name || "待同步"}</b><small className="subline">{order.completion_status === "completed" ? "业务与结算已完成" : "按工作流推进"}</small></td>
                  <td>{order.assignee_name || "待分配"}</td>
                  <td><div className="order-list-status-cell"><span className={`status ${statusTone(order.status, order.exception_status)}`}>{statusLabel(order.status)}</span>{order.can_operate_current_node && <span className="order-todo-badge">待办</span>}</div></td>
                  <td><Link className={`btn small${order.can_operate_current_node ? " primary" : ""}`} to={orderDetailQueueHref(order.id, orderQueue)}>{order.can_operate_current_node ? "办理当前节点" : "查看订单"}</Link></td>
                </tr>
              ))}
              {!loaderData.orders.length && <tr><td className="empty" colSpan={9}>当前筛选条件下没有订单</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination page={loaderData.page} pages={loaderData.pages} filters={loaderData.filters}/>
      </section>
      </>}
    </div>
  );
}

function OrderWorkloadTabs({ active, batchCount, orderCount, filters }: { active: OrderWorkloadView; batchCount: number; orderCount: number; filters: Record<string, string> }) {
  const tabs: Array<{ key: OrderWorkloadView; label: string; count: number }> = [
    { key: "orders", label: "普通订单", count: orderCount },
    { key: "batches", label: "配载订单", count: batchCount },
  ];
  return <nav className="order-workload-tabs peer-page-tabs" aria-label="普通订单与配载订单分类">
    {tabs.map((tab) => <Link
      key={tab.key}
      className={active === tab.key ? "active" : ""}
      aria-current={active === tab.key ? "page" : undefined}
      to={orderWorkloadViewHref(tab.key, filters)}
    ><span>{tab.label}</span><b>{tab.count}</b></Link>)}
  </nav>;
}

function SupervisorUnifiedQueue({ items, operationMembers, documentMembers, pendingBatchCount, orderCount, batchCount, total, page, pages, filters, steps, orderQueue }: {
  items: SupervisorWorkItem[];
  operationMembers: OrganizationAssigneeMember[];
  documentMembers: OrganizationAssigneeMember[];
  pendingBatchCount: number;
  orderCount: number;
  batchCount: number;
  total: number;
  page: number;
  pages: number;
  filters: Record<string, string>;
  steps: FilterOption[];
  orderQueue: ReturnType<typeof orderQueueContextFromList>;
}) {
  const fetcher = useFetcher<BatchAssignmentActionData>();
  const [selected, setSelected] = useState<BatchAssignmentViewRow | null>(null);
  const success = fetcher.data?.success;
  const busy = fetcher.state !== "idle";
  const operationDisabledReasons = selected
    ? batchInitialResponsibilityDisabledReasons(selected.initialResponsibilityRestrictions, "operation")
    : {};
  const documentDisabledReasons = selected
    ? batchInitialResponsibilityDisabledReasons(selected.initialResponsibilityRestrictions, "document")
    : {};
  const hasFreshOperationCandidate = operationMembers.some((member) => !operationDisabledReasons[member.id]);
  const hasFreshDocumentCandidate = documentMembers.some((member) => !documentDisabledReasons[member.id]);
  const responsibilityConfigurationErrors = selected?.initialResponsibilityRestrictions.configurationErrors ?? [];
  const freshInitialAssigneesAvailable = hasFreshOperationCandidate && hasFreshDocumentCandidate && responsibilityConfigurationErrors.length === 0;
  const advancedFilterCount = [
    filters.step,
    filters.origin,
    filters.exitPort,
    filters.destination,
  ].filter(Boolean).length;

  useEffect(() => {
    if (success) setSelected(null);
  }, [success]);

  return <section className="table-panel supervisor-workload-panel" aria-label="操作主管订单与配载单工作清单">
    <div className="table-panel-head supervisor-workload-head">
      <div><b>主管工作清单</b><span>普通订单与配载单统一显示，需要办理的项目以橙色入口提示。</span></div>
      <span className="supervisor-workload-summary">共 {total} 项 · {orderCount} 单 · {batchCount} 张配载 · {pendingBatchCount} 张待分配</span>
    </div>
    <Form method="get" action="." className="supervisor-workload-filters" role="search">
      <label className="field supervisor-workload-search">
        <span>统一查找</span>
        <input
          className="control"
          name="keyword"
          data-keyboard-search
          defaultValue={filters.keyword}
          placeholder="订单号、配载单号、客户、货物或线路"
        />
      </label>
      <FilterSelect name="type" label="工作项" value={filters.type} options={[
        { value: "ftl", label: "整车订单" },
        { value: "ltl", label: "拼车单票" },
        { value: "batch", label: "配载单" },
      ]}/>
      <FilterSelect name="workStatus" label="办理状态" value={filters.workStatus} options={[
        { value: "pending", label: "待我办理" },
        { value: "active", label: "业务进行中" },
        { value: "completed", label: "已完成" },
        { value: "exception", label: "异常 / 退回" },
      ]}/>
      <button className="btn primary">筛选</button>
      <Link className="btn" to="/admin/orders">重置</Link>
      <details className="supervisor-workload-advanced" open={advancedFilterCount > 0}>
        <summary>更多条件{advancedFilterCount ? `（${advancedFilterCount}）` : ""}</summary>
        <div className="supervisor-workload-advanced-grid">
          <FilterSelect name="step" label="普通订单节点" value={filters.step} options={steps}/>
          <OrderRouteFilterFields filters={{
            origin: filters.origin || "",
            exitPort: filters.exitPort || "",
            destination: filters.destination || "",
          }}/>
        </div>
      </details>
    </Form>
    <ActionToast message={success} tone="success"/>
    {!!items.length && <div className="table-wrap"><table className="supervisor-workload-table">
      <thead><tr><th>类型 / 编号</th><th>客户 / 挂载范围</th><th>货物与线路</th><th>当前节点 / 负责人</th><th>状态 / 更新时间</th><th>操作</th></tr></thead>
      <tbody>{items.map((item) => {
        if (item.kind === "order") {
          const order = item.order;
          return <tr key={`order:${order.id}`} className={[
            order.can_operate_current_node ? "order-todo-row" : "",
            order.status !== "completed" && order.exception_status && order.exception_status !== "normal" ? "row-alert" : "",
          ].filter(Boolean).join(" ")}>
            <td><span className={`pill ${order.business_type === "ltl" ? "ltl" : ""}`}>{order.business_type === "ltl" ? "拼车单票" : "整车订单"}</span><Link className="order-id supervisor-workload-id" title={order.order_number} to={orderDetailQueueHref(order.id, orderQueue)}>{order.order_number}</Link></td>
            <td><b>{order.customer_name}</b><small className="subline">{order.order_date || order.created_at.slice(0, 10)}</small></td>
            <td><b>{order.cargo_description || "未填写货物"}</b><small className="subline">{order.origin_state || ""}{order.origin_city} → {order.destination_state || ""}{order.destination_city} · {order.pieces} 件 / {order.gross_weight_kg} KG / {order.volume_cbm} CBM</small></td>
            <td><b>{order.quote_withdrawn ? "报价接受已撤回" : order.current_step_name || "待同步"}</b><small className="subline">{order.assignee_name || "负责人待分配"}</small></td>
            <td><div className="order-list-status-cell"><span className={`status ${statusTone(order.status, order.exception_status)}`}>{statusLabel(order.status)}</span>{order.can_operate_current_node && <span className="order-todo-badge">待办</span>}</div><small className="subline">{batchDate(order.updated_at)}</small></td>
            <td><Link className={`btn small${order.can_operate_current_node ? " primary" : ""}`} to={orderDetailQueueHref(order.id, orderQueue)}>{order.can_operate_current_node ? "办理当前节点" : "查看订单"}</Link></td>
          </tr>;
        }
        const batch = item.batch;
        const state = batchAssignmentStatus({
          approvalStatus: batch.approval_status,
          batchStatus: batch.status,
          operationAssigneeUserId: batch.operation_assignee_user_id,
          documentAssigneeUserId: batch.document_assignee_user_id,
        });
        return <tr key={`batch:${batch.id}`} className={state.actionable ? "order-todo-row" : "batch-history-row"}>
          <td><span className="pill batch">配载单</span>{state.actionable
            ? <button type="button" className="order-id text-button supervisor-workload-id" onClick={() => setSelected(batch)}>{batch.batch_number}</button>
            : <Link className="order-id text-button supervisor-workload-id" to={`/admin/loading/${batch.id}`}>{batch.batch_number}</Link>}</td>
          <td><b>{batch.order_count} 票订单</b><small className="subline batch-order-numbers" title={batch.order_numbers || ""}>{batch.order_numbers || "—"}</small></td>
          <td><b>{batch.origin_location}<span className="batch-route-arrow">→</span>{batch.destination_location}</b><small className="subline">整张配载单统一推进</small></td>
          <td><b>{state.actionable ? "待主管统一分配" : state.label}</b><small className="subline">操作：{batch.operation_assignee_name || "待分配"} · 单证：{batch.document_assignee_name || "待分配"}</small></td>
          <td><span className={`batch-assignment-status ${state.key}`}>{state.label}</span><small className="subline">{batchDate(batch.approved_at || batch.submitted_at || batch.updated_at)}</small></td>
          <td><div className="button-row">{state.actionable && <button type="button" className="btn small primary" onClick={() => setSelected(batch)}>整批分配</button>}<Link className="btn small" to={`/admin/loading/${batch.id}`}>查看详情</Link></div></td>
        </tr>;
      })}</tbody>
    </table></div>}
    {!items.length && <div className="empty-state batch-assignment-empty"><strong>没有匹配的工作项</strong><p>可调整统一查找或更多筛选条件后重试。</p></div>}
    <SupervisorPagination page={page} pages={pages} filters={filters}/>
    <Modal
      title={selected ? `配载单一键分配 · ${selected.batch_number}` : "配载单一键分配"}
      isOpen={Boolean(selected)}
      onOpenChange={(open) => { if (!open) setSelected(null); }}
      size="wide"
      initialFocusSelector="select"
    >
      {selected && <fetcher.Form method="post" action={`/admin/loading/${selected.id}`} className="batch-assignment-form">
        <input type="hidden" name="intent" value="batch_approve"/>
        <div className="batch-assignment-summary">
          <div><span>配载单</span><b>{selected.batch_number}</b></div>
          <div><span>挂载范围</span><b>{selected.order_count} 票订单</b></div>
          <div><span>线路</span><b>{selected.origin_location} → {selected.destination_location}</b></div>
        </div>
        <section className="batch-assignment-orders" aria-label="配载单挂载订单明细">
          <header><div><strong>挂载订单明细</strong><span>确认货物、客户、当前节点与原负责人后，再统一分配整批负责人。</span></div><b>{selected.mountedOrders.length} 票</b></header>
          <div className="table-wrap"><table>
            <thead><tr><th>订单 / 客户</th><th>货物</th><th>件数 / 重量 / 体积</th><th>当前节点 / 原负责人</th></tr></thead>
            <tbody>{selected.mountedOrders.map((order) => <tr key={order.order_id}>
              <td><b>{order.order_number}</b><small>{order.customer_name}</small></td>
              <td><b>{order.cargo_description || "未填写货物描述"}</b></td>
              <td><b>{order.pieces} 件</b><small>{Number(order.gross_weight_kg).toFixed(2)} KG · {Number(order.volume_cbm).toFixed(3)} CBM</small></td>
              <td><b>{order.current_step_name || "待同步"}</b><small>{order.current_assignee_name || "待分配"}</small></td>
            </tr>)}</tbody>
          </table></div>
        </section>
        <div className="alert info batch-assignment-rule">系统按每票订单锁定的工作流快照识别未完成操作/单证职责。可以选择挂载订单现有负责人，也可以选择其他合格人员；提交后，两人分别统一接管整张配载单的操作与单证职责。</div>
        {responsibilityConfigurationErrors.length > 0
          ? <div className="alert error" role="alert"><strong>工作流配置阻断：</strong>{responsibilityConfigurationErrors.join("；")}</div>
          : !freshInitialAssigneesAvailable && <div className="alert warning" role="alert">当前组织没有同时可用的操作负责人和单证负责人；请先检查人员状态、岗位和权限。</div>}
        <OrganizationAssigneePicker members={operationMembers} name="operationAssigneeUserId" idPrefix={`orders-batch-operation-${selected.id}`} personLabel="整批操作负责人" disabledUserReasons={operationDisabledReasons} required/>
        <OrganizationAssigneePicker members={documentMembers} name="documentAssigneeUserId" idPrefix={`orders-batch-document-${selected.id}`} personLabel="整批单证负责人" disabledUserReasons={documentDisabledReasons} required/>
        {fetcher.data?.formError && <div className="alert error">{fetcher.data.formError}</div>}
        <div className="batch-assignment-actions">
          <button type="button" className="btn" onClick={() => setSelected(null)} disabled={busy}>取消</button>
          <button className="btn primary" disabled={busy || !freshInitialAssigneesAvailable}>{busy ? "正在同步分配…" : `审核通过并同步 ${selected.order_count} 票订单`}</button>
        </div>
      </fetcher.Form>}
    </Modal>
  </section>;
}

function BatchExecutionQueue({ batches, role, activeCount, total, page, pages, filters }: {
  batches: BatchAssignmentRow[];
  role: BatchWorkloadRole;
  activeCount: number;
  total: number;
  page: number;
  pages: number;
  filters: Record<string, string>;
}) {
  const isDocumentRole = role === "document";
  return <section className="table-panel batch-assignment-panel batch-execution-panel" aria-label="配载订单工作台">
    <div className="table-panel-head">
      <div><b>配载订单</b><span>{isDocumentRole
        ? "按整张 PZ 配载单办理逐票文件、报关申报与放行；挂载订单不再作为普通订单重复出现。"
        : "按整张 PZ 配载单跟进装车、实际出境及运踪；挂载订单不再作为普通订单重复出现。"}</span></div>
      <span>{activeCount} 张处理中 · 共 {total} 张</span>
    </div>
    <BatchWorkloadFilters filters={filters}/>
    {!!batches.length && <div className="table-wrap"><table className="batch-assignment-table batch-execution-table">
      <thead><tr><th>状态</th><th>配载单 / 线路</th><th>挂载订单</th><th>当前节点 / 下一步</th><th>整单负责人</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>{batches.map((batch) => {
        const state = batchExecutionStatus({
          approvalStatus: batch.approval_status,
          batchStatus: batch.status,
          roadStatus: batch.road_status,
        });
        const next = batchExecutionNextStep(batch, role);
        return <tr key={batch.id} className={state.active ? "order-todo-row" : "batch-history-row"}>
          <td><span className={`batch-assignment-status ${state.key}`}>{state.label}</span></td>
          <td><Link className="order-id text-button" to={`/admin/loading/${batch.id}`}>{batch.batch_number}</Link><small className="subline">{batch.origin_location}<span className="batch-route-arrow">→</span>{batch.destination_location}</small></td>
          <td><b>{batch.order_count} 票</b><small className="subline batch-order-numbers" title={batch.order_numbers || ""}>{batch.order_numbers || "—"}</small></td>
          <td><b>{next.title}</b><small className="subline">{next.hint}</small></td>
          <td><b>操作：{batch.operation_assignee_name || "待分配"}</b><small className="subline">单证：{batch.document_assignee_name || "待分配"}</small></td>
          <td><b>{batchDate(batch.updated_at)}</b><small className="subline">整批状态实时同步</small></td>
          <td><Link className={`btn small${state.active ? " primary" : ""}`} to={`/admin/loading/${batch.id}`}>{state.active ? "办理配载单" : "查看详情"}</Link></td>
        </tr>;
      })}</tbody>
    </table></div>}
    {!batches.length && <div className="empty-state batch-assignment-empty"><strong>暂无分配给你的配载订单</strong><p>操作主管完成整批分配后，PZ 配载单会自动进入这里。</p></div>}
    <BatchPagination page={page} pages={pages} filters={filters}/>
  </section>;
}

function BatchWorkloadFilters({ filters }: { filters: Record<string, string> }) {
  return <Form method="get" action="." className="filters batch-workload-filters" role="search">
    <input type="hidden" name="view" value="batches"/>
    <label className="field wide">
      <span>快速查找</span>
      <input
        className="control"
        name="batchKeyword"
        data-keyboard-search
        defaultValue={filters.batchKeyword}
        placeholder="配载单号、订单号、线路或货物"
      />
    </label>
    <FilterSelect name="batchStatus" label="配载状态" value={filters.batchStatus} options={batchStatusOptions}/>
    <button className="btn primary">查询</button>
    <Link className="btn" to="/admin/orders?view=batches">重置</Link>
  </Form>;
}

function batchExecutionNextStep(batch: BatchAssignmentRow, role: BatchWorkloadRole) {
  const status = batchExecutionStatus({
    approvalStatus: batch.approval_status,
    batchStatus: batch.status,
    roadStatus: batch.road_status,
  });
  if (!status.active) {
    return status.key === "arrived" || status.key === "pickup" || status.key === "completed"
      ? { title: status.label, hint: "整批职责已结束，后续转回单票客服、财务或归档办理" }
      : { title: status.label, hint: "当前仅保留历史记录" };
  }
  if (role === "document") {
    if (batch.road_status === "loaded_waiting_exit") return { title: "办理报关资料与放行", hint: "在配载单内逐票登记申报并确认全部放行" };
    if (batch.road_status === "outbound_in_transit") return { title: "查看运输进度", hint: "报关职责已完成，配载单正在境外运输" };
    return { title: "准备发运文件与报关", hint: "在配载单内统一检查全部挂载订单" };
  }
  if (batch.road_status === "loaded_waiting_exit") return { title: "登记口岸到达，等待报关放行", hint: "全部放行后确认实际出境，再继续整批运踪" };
  if (batch.road_status === "outbound_in_transit") return { title: "登记整批运踪", hint: "持续跟进运输节点直至境外仓入库" };
  return { title: "跟进仓库装车出库", hint: "装车完成后在本配载单继续办理出境与运踪" };
}

function BatchPagination({ page, pages, filters }: { page: number; pages: number; filters: Record<string, string> }) {
  if (pages <= 1) return null;
  const href = (target: number) => {
    const params = new URLSearchParams(filters);
    params.set("view", "batches");
    params.delete("page");
    params.set("batchPage", String(target));
    return `?${params}`;
  };
  return <div className="pagination"><Link className={`btn ${page <= 1 ? "disabled" : ""}`} to={href(Math.max(1, page - 1))}>上一页</Link><span>第 {page} / {pages} 页</span><Link className={`btn ${page >= pages ? "disabled" : ""}`} to={href(Math.min(pages, page + 1))}>下一页</Link></div>;
}

function SupervisorPagination({ page, pages, filters }: { page: number; pages: number; filters: Record<string, string> }) {
  if (pages <= 1) return null;
  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value && !["view", "batchPage", "batchKeyword"].includes(key)) params.set(key, value);
    }
    params.set("page", String(target));
    return `?${params}`;
  };
  return <div className="pagination"><Link className={`btn ${page <= 1 ? "disabled" : ""}`} to={href(Math.max(1, page - 1))}>上一页</Link><span>第 {page} / {pages} 页</span><Link className={`btn ${page >= pages ? "disabled" : ""}`} to={href(Math.min(pages, page + 1))}>下一页</Link></div>;
}

function batchDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "待记录";
}

function FilterSelect({ name, label, value, options }: { name: string; label: string; value: string; options: FilterOption[] }) {
  return <label className="field"><span>{label}</span><select className="control filled" name={name} defaultValue={value}><option value="">全部</option>{options.map((option) => <option key={`${name}-${option.value}`} value={option.value}>{option.label}</option>)}</select></label>;
}

function Pagination({ page, pages, filters }: { page: number; pages: number; filters: Record<string, string> }) {
  if (pages <= 1) return null;
  const href = (target: number) => {
    const params = new URLSearchParams(filters);
    params.set("page", String(target));
    return `?${params}`;
  };
  return <div className="pagination"><Link className={`btn ${page <= 1 ? "disabled" : ""}`} to={href(Math.max(1, page - 1))}>上一页</Link><span>第 {page} / {pages} 页</span><Link className={`btn ${page >= pages ? "disabled" : ""}`} to={href(Math.min(pages, page + 1))}>下一页</Link></div>;
}

const statusOptions = [
  { value: "draft", label: "草稿" },
  { value: "submitted", label: "待审核" },
  { value: "confirmed", label: "已审核，待派单" },
  { value: "in_execution", label: "执行中" },
  { value: "completed", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

const batchStatusOptions = [
  { value: "draft", label: "草稿" },
  { value: "submitted", label: "待审核分配" },
  { value: "assigned", label: "已分配" },
  { value: "rejected", label: "已退回" },
  { value: "waiting_loading", label: "待装车" },
  { value: "preplanned", label: "已预排装车" },
  { value: "loaded_waiting_exit", label: "已装车，待出境" },
  { value: "outbound_in_transit", label: "境外运输中" },
  { value: "overseas_arrived", label: "已到境外仓" },
  { value: "waiting_pickup", label: "待客户自提" },
  { value: "pickup_completed", label: "已签收" },
  { value: "cancelled", label: "已取消" },
];

function statusLabel(status: string) {
  return statusOptions.find((option) => option.value === status)?.label || status;
}

function statusTone(status: string, exceptionStatus: string | null) {
  if (status === "completed") return "green";
  if (exceptionStatus && exceptionStatus !== "normal") return "red";
  if (["cancelled"].includes(status)) return "red";
  if (["draft", "submitted"].includes(status)) return "orange";
  return "blue";
}

export function meta() { return [{ title: "运输订单 | 新翎航 TMS" }]; }
