import { env } from "cloudflare:workers";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import { overseasInboundRequiresCustomsClearance } from "./overseas-inbound-policy";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";
import { workflowInstanceCapabilityStageAccess } from "./workflow-instance-stage-gate";
import { loadLockedWorkflowStageContext } from "./workflow-instance-stage-gate.server";

export type OverseasInboundCustomsOrder = {
  orderId: string;
  orderNumber?: string | null;
  customsClearanceMode: "company" | "customer";
};

export type OverseasInboundCustomsGate = {
  orderId: string;
  required: boolean;
  cleared: boolean;
  blocked: boolean;
  configurationValid: boolean;
  targetStepKey: string | null;
  targetStepName: string | null;
  message: string | null;
};

type GateConfigurationRow = {
  workflow_instance_id: string | null;
  matched_instance_id: string | null;
  matched_instance_status: string | null;
  module_enabled: number;
  module_required: number;
};

type PendingGate = {
  order: OverseasInboundCustomsOrder;
  targetStepKey: string | null;
  targetStepName: string | null;
  fieldLabel: string;
  locked: boolean;
};

function orderLabel(order: OverseasInboundCustomsOrder) {
  return order.orderNumber?.trim() || order.orderId;
}

function openGate(
  order: OverseasInboundCustomsOrder,
  targetStepKey: string | null = null,
  targetStepName: string | null = null,
): OverseasInboundCustomsGate {
  return {
    orderId: order.orderId,
    required: false,
    cleared: false,
    blocked: false,
    configurationValid: true,
    targetStepKey,
    targetStepName,
    message: null,
  };
}

function invalidGate(
  order: OverseasInboundCustomsOrder,
  detail: string,
): OverseasInboundCustomsGate {
  return {
    orderId: order.orderId,
    required: true,
    cleared: false,
    blocked: true,
    configurationValid: false,
    targetStepKey: null,
    targetStepName: null,
    message: `订单 ${orderLabel(order)} 的${detail}，请联系管理员修复后再办理境外目的仓入库`,
  };
}

function requiredGate(
  pending: PendingGate,
  cleared: boolean,
): OverseasInboundCustomsGate {
  const target = pending.targetStepName
    ? `（节点“${pending.targetStepName}”）`
    : "";
  return {
    orderId: pending.order.orderId,
    required: true,
    cleared,
    blocked: !cleared,
    configurationValid: true,
    targetStepKey: pending.targetStepKey,
    targetStepName: pending.targetStepName,
    message: cleared
      ? null
      : `订单 ${orderLabel(pending.order)} 的${pending.locked ? "冻结工作流" : "历史业务门禁"}要求先完成“${pending.fieldLabel}”${target}，完成后才能办理境外目的仓入库`,
  };
}

/**
 * Resolve the destination-clearance prerequisite from the exact order
 * workflow contract. All callers (warehouse UI, POST validation, FTL service
 * and PZ service) consume this one result so a second hard-coded gate cannot
 * contradict the frozen configuration.
 */
export async function loadOverseasInboundCustomsGates(
  organizationId: string,
  orders: readonly OverseasInboundCustomsOrder[],
): Promise<OverseasInboundCustomsGate[]> {
  const uniqueOrders = [...new Map(
    orders.filter((order) => order.orderId).map((order) => [order.orderId, order]),
  ).values()];
  if (!uniqueOrders.length) return [];

  const resolved = new Map<string, OverseasInboundCustomsGate>();
  const pending: PendingGate[] = [];

  // Process orders in sequence. loadOrderModuleWorkflowFields already performs
  // its own bounded parallel reads, so this avoids exhausting D1 connections
  // on a large consolidated transport batch.
  for (const order of uniqueOrders) {
    const configuration = await env.DB.prepare(
      `SELECT o.workflow_instance_id,wi.id matched_instance_id,
              wi.status matched_instance_status,
              COALESCE(mi.enabled,0) module_enabled,
              COALESCE(mi.is_required,0) module_required
       FROM transport_orders o
       LEFT JOIN workflow_instances wi
         ON wi.id=o.workflow_instance_id
        AND wi.organization_id=o.organization_id
        AND wi.order_id=o.id
       LEFT JOIN order_module_instances mi
         ON mi.organization_id=o.organization_id
        AND mi.order_id=o.id
        AND mi.module_code='customs'
       WHERE o.organization_id=? AND o.id=?`,
    ).bind(organizationId, order.orderId).first<GateConfigurationRow>();

    if (!configuration) {
      resolved.set(order.orderId, invalidGate(order, "订单或清关配置不存在"));
      continue;
    }
    const bound = configuration.workflow_instance_id !== null;
    if (
      bound && (
        !configuration.workflow_instance_id?.trim() ||
        !configuration.matched_instance_id ||
        configuration.matched_instance_status !== "active"
      )
    ) {
      resolved.set(order.orderId, invalidGate(order, "冻结工作流实例无效"));
      continue;
    }
    if (order.customsClearanceMode === "customer") {
      resolved.set(order.orderId, openGate(order));
      continue;
    }

    const fields = await loadOrderModuleWorkflowFields(
      organizationId,
      order.orderId,
      "customs",
    );
    const configuredReleaseFields = fields.filter(
      (field) => field.fieldKey === "customs_release",
    );
    if (bound && configuredReleaseFields.length > 1) {
      resolved.set(
        order.orderId,
        invalidGate(order, "冻结工作流海关放行字段重复"),
      );
      continue;
    }
    const requiredByMode = overseasInboundRequiresCustomsClearance({
      customsClearanceMode: order.customsClearanceMode,
      moduleEnabled: configuration.module_enabled === 1,
      moduleRequired: configuration.module_required === 1,
      fields,
    });
    if (!requiredByMode) {
      resolved.set(order.orderId, openGate(order));
      continue;
    }

    const releaseField = fields.find((field) =>
      field.fieldKey === "customs_release" && field.isActive && field.isRequired
    );
    if (!bound) {
      pending.push({
        order,
        targetStepKey: releaseField?.stepKey ?? null,
        targetStepName: releaseField?.stepName ?? null,
        fieldLabel: releaseField?.label || "目的地清关放行",
        locked: false,
      });
      continue;
    }

    const context = await loadLockedWorkflowStageContext(
      env.DB,
      organizationId,
      order.orderId,
      "customs",
    );
    const access = workflowInstanceCapabilityStageAccess({
      context,
      moduleCode: "customs",
      fieldKeys: ["customs_release"],
    });
    const current = context.steps.find((step) => step.stepKey === context.currentStepKey);
    const target = context.steps.find((step) => step.stepKey === access.targetStepKey);
    if (access.available && target && releaseField) {
      pending.push({
        order,
        targetStepKey: target.stepKey,
        targetStepName: target.stepName,
        fieldLabel: releaseField.label || "目的地清关放行",
        locked: true,
      });
      continue;
    }
    if (current && target && current.sortOrder < target.sortOrder) {
      resolved.set(order.orderId, openGate(order, target.stepKey, target.stepName));
      continue;
    }
    resolved.set(
      order.orderId,
      invalidGate(order, `冻结工作流清关门禁配置异常${access.reason ? `（${access.reason}）` : ""}`),
    );
  }

  const clearedOrderIds = new Set<string>();
  for (const orderChunk of chunkD1Values(pending, 1)) {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT order_id
       FROM order_tracking_milestones
       WHERE organization_id=?
         AND order_id IN (${d1Placeholders(orderChunk.length)})
         AND milestone_code='customs_cleared'`,
    ).bind(
      organizationId,
      ...orderChunk.map((item) => item.order.orderId),
    ).all<{ order_id: string }>();
    for (const row of rows.results) clearedOrderIds.add(row.order_id);
  }
  for (const item of pending) {
    resolved.set(
      item.order.orderId,
      requiredGate(item, clearedOrderIds.has(item.order.orderId)),
    );
  }
  return uniqueOrders.map((order) =>
    resolved.get(order.orderId) ?? invalidGate(order, "清关门禁解析失败")
  );
}
