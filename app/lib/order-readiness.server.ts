import { env } from "cloudflare:workers";
import {
  orderDocumentPlacements,
  preDepartureDocumentTypeCodes,
  orderDocumentTypeLabel,
} from "./order-documents";
import { customsDeclarationGate } from "./customs-declarations";
import { customsModuleGateRequirements } from "./customs-module-policy";
import {
  loadOrderModuleWorkflowFields,
  type WorkflowFieldState,
} from "./workflow-fields.server";
import {
  isFrozenWorkflowFieldScopeMarker,
  runtimeWorkflowFieldPolicy,
  workflowFieldKeyCandidates,
} from "./workflow-field-runtime";
import type { OrderModuleCode } from "./order-modules";
import {
  domesticTransportGateFieldLabel,
  domesticTransportGateFields,
  missingDomesticTransportGateFields,
  type DomesticTransportGateAssignment,
  type DomesticTransportGateFieldKey,
} from "./domestic-transport-readiness";

export type ReadinessResult = {
  ready: boolean;
  reasons: string[];
};

export type FtlLoadPlanSubmissionValues = {
  exitPort: string | null;
  customsLocation: string | null;
  carrierId: string | null;
  vehicleType: string | null;
  vehicleCount: number | null;
  vehiclePlate: string | null;
  driverName: string | null;
  driverPhone: string | null;
  plannedDepartureAt: string | null;
  plannedArrivalAt: string | null;
};

export type FtlLoadPlanContext =
  | { mode: "strict" }
  | { mode: "entry" }
  | { mode: "submit"; values: FtlLoadPlanSubmissionValues };

const LOAD_PLAN_GATE_MODULES = [
  "consignment",
  "cargo",
  "assignment",
  "transport",
  "warehouse",
  "loading",
] as const;

type OperationalOrder = {
  business_type: string;
  customs_enabled: number;
  warehouse_enabled: number;
  exit_port: string | null;
  overseas_warehouse_id: string | null;
};

async function operationalOrder(organizationId: string, orderId: string) {
  return env.DB.prepare(
    `SELECT o.business_type,o.exit_port,o.overseas_warehouse_id,
       CASE WHEN EXISTS(
         SELECT 1 FROM order_module_instances mi
         WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
           AND mi.module_code='customs' AND mi.enabled=1
       ) THEN 1 ELSE 0 END customs_enabled,
       CASE WHEN EXISTS(
         SELECT 1 FROM order_module_instances mi
         WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
           AND mi.module_code='warehouse' AND mi.enabled=1
       ) THEN 1 ELSE 0 END warehouse_enabled
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id=?`,
  ).bind(organizationId, orderId).first<OperationalOrder>();
}

type ReadinessWorkflowRequirements = {
  fields(moduleCode: OrderModuleCode): readonly WorkflowFieldState[];
  scopedFields(moduleCode: OrderModuleCode): readonly WorkflowFieldState[];
  moduleRequired(moduleCode: OrderModuleCode): boolean;
  targetStepName(moduleCode: OrderModuleCode): string | null;
  configurationReasons(moduleCode: OrderModuleCode): string[];
  required(
    moduleCode: OrderModuleCode,
    fieldKey: string,
    fallbackRequired?: boolean,
  ): boolean;
  missingRequired(
    moduleCode: OrderModuleCode,
  ): WorkflowFieldState[];
};

const readinessModuleLabels: Partial<Record<OrderModuleCode, string>> = {
  warehouse: "国内仓入库",
  loading: "装车与出库",
  transport: "国内运输",
  customs: "报关",
};

async function workflowRequirements(
  organizationId: string,
  orderId: string,
  moduleCodes: OrderModuleCode[],
): Promise<ReadinessWorkflowRequirements> {
  const entries = await Promise.all(
    moduleCodes.map(async (moduleCode) => [
      moduleCode,
      await loadOrderModuleWorkflowFields(organizationId, orderId, moduleCode),
    ] as const),
  );
  const fieldsByModule = new Map<OrderModuleCode, WorkflowFieldState[]>(entries);
  const moduleRows = await env.DB.prepare(
    `SELECT module_code,enabled,is_required FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND module_code IN (${moduleCodes.map(() => "?").join(",")})`,
  ).bind(organizationId, orderId, ...moduleCodes).all<{
    module_code: OrderModuleCode;
    enabled: number;
    is_required: number;
  }>();
  const moduleModes = new Map(moduleRows.results.map((row) => [row.module_code, row]));
  const moduleRequired = (moduleCode: OrderModuleCode) => {
    const configured = moduleModes.get(moduleCode);
    // Orders created before module-instance snapshots retain the legacy gate.
    return configured ? configured.enabled === 1 && configured.is_required === 1 : true;
  };
  const scopes = new Map<OrderModuleCode, {
    fields: WorkflowFieldState[];
    targetStepName: string | null;
    reasons: string[];
  }>();
  for (const moduleCode of moduleCodes) {
    const fields = fieldsByModule.get(moduleCode) ?? [];
    const markers = fields.filter(isFrozenWorkflowFieldScopeMarker);
    if (!markers.length) {
      scopes.set(moduleCode, { fields, targetStepName: null, reasons: [] });
      continue;
    }
    const uniquePlacements = [...new Map(
      markers.map((marker) => [marker.stepKey, marker]),
    ).values()];
    const label = readinessModuleLabels[moduleCode] ?? moduleCode;
    if (
      moduleCode === "consignment" &&
      uniquePlacements.length > 1 &&
      uniquePlacements.every((placement) => placement.stepKey !== "__frozen_unplaced_module__")
    ) {
      const placementKeys = new Set(uniquePlacements.map((placement) => placement.stepKey));
      const configuredFields = fields.filter((field) => !isFrozenWorkflowFieldScopeMarker(field));
      const misplaced = configuredFields.filter((field) => field.isActive && !placementKeys.has(field.stepKey));
      const duplicatePlacementKeys = configuredFields
        .map((field) => `${field.stepKey}:${field.fieldKey}`)
        .filter((key, index, values) => values.indexOf(key) !== index);
      const reasons = [
        ...(misplaced.length ? ["委托冻结工作流配置异常：字段未放在委托模块办理节点"] : []),
        ...(duplicatePlacementKeys.length ? ["委托冻结工作流配置异常：同一节点存在重复字段"] : []),
      ];
      scopes.set(moduleCode, {
        fields: reasons.length ? markers : fields,
        targetStepName: null,
        reasons,
      });
      continue;
    }
    if (
      uniquePlacements.length !== 1 ||
      uniquePlacements[0].stepKey === "__frozen_unplaced_module__"
    ) {
      scopes.set(moduleCode, {
        fields: markers,
        targetStepName: null,
        reasons: [uniquePlacements.length > 1
          ? `${label}冻结工作流配置异常：模块存在重复办理节点`
          : `${label}冻结工作流配置异常：模块缺少有效办理节点`],
      });
      continue;
    }
    const placement = uniquePlacements[0];
    const misplaced = fields.filter(
      (field) =>
        !isFrozenWorkflowFieldScopeMarker(field) &&
        field.isActive &&
        field.stepKey !== placement.stepKey,
    );
    const duplicateKeys = [...new Set(
      fields
        .filter((field) => !isFrozenWorkflowFieldScopeMarker(field))
        .map((field) => field.fieldKey)
        .filter((fieldKey, index, values) => values.indexOf(fieldKey) !== index),
    )];
    const reasons = [
      ...(misplaced.length
        ? [`${label}冻结工作流配置异常：字段未放在“${placement.stepName}”办理节点`]
        : []),
      ...(duplicateKeys.length
        ? [`${label}冻结工作流配置异常：字段重复（${duplicateKeys.join("、")}）`]
        : []),
    ];
    scopes.set(moduleCode, {
      fields: reasons.length
        ? markers
        : fields.filter(
            (field) =>
              isFrozenWorkflowFieldScopeMarker(field) ||
              field.stepKey === placement.stepKey,
          ),
      targetStepName: placement.stepName,
      reasons,
    });
  }
  return {
    fields(moduleCode) {
      return fieldsByModule.get(moduleCode) ?? [];
    },
    scopedFields(moduleCode) {
      return scopes.get(moduleCode)?.fields ?? [];
    },
    moduleRequired,
    targetStepName(moduleCode) {
      return scopes.get(moduleCode)?.targetStepName ?? null;
    },
    configurationReasons(moduleCode) {
      return moduleRequired(moduleCode)
        ? scopes.get(moduleCode)?.reasons ?? []
        : [];
    },
    required(moduleCode, fieldKey, fallbackRequired = false) {
      if (!moduleRequired(moduleCode)) return false;
      const scopedFields = scopes.get(moduleCode)?.fields ?? [];
      if (moduleCode === "consignment" && scopedFields.some(isFrozenWorkflowFieldScopeMarker)) {
        const candidates = new Set(workflowFieldKeyCandidates(fieldKey));
        const configured = scopedFields.filter(
          (field) =>
            !isFrozenWorkflowFieldScopeMarker(field) &&
            candidates.has(field.fieldKey),
        );
        return configured.some((field) => field.isActive && field.isRequired);
      }
      return runtimeWorkflowFieldPolicy(
        scopedFields,
        fieldKey,
        fallbackRequired,
      ).required;
    },
    missingRequired(moduleCode) {
      if (!moduleRequired(moduleCode)) return [];
      return (scopes.get(moduleCode)?.fields ?? []).filter(
        (field) =>
          !isFrozenWorkflowFieldScopeMarker(field) &&
          field.isActive &&
          field.isRequired &&
          !field.present,
      );
    },
  };
}

const loadPlanLoadingFieldKeys = new Set([
  "exit_port",
  "customs_location",
  "transit_locations",
  "route_code",
  "loading_batch",
  "consolidation_warehouse",
  "main_carrier_id",
  "main_vehicle_type",
  "main_plate_number",
  "main_driver_name",
  "main_driver_phone",
  "vehicle_capacity_weight",
  "vehicle_capacity_volume",
  "planned_exit_at",
  "planned_arrival_at",
  "loading_instruction",
  "loading_notes",
  "overseas_carrier_name",
  "overseas_vehicle_type",
  "overseas_vehicle_count",
  "overseas_vehicle_plate",
  "overseas_driver_name",
  "overseas_driver_phone",
]);

const specificallyCheckedLtlLoadPlanFields = new Set([
  "loading_batch",
  "consolidation_warehouse",
  "main_carrier_id",
  "main_vehicle_type",
  "main_plate_number",
  "main_driver_name",
  "main_driver_phone",
  "exit_port",
  "customs_location",
  "planned_exit_at",
  "planned_arrival_at",
]);

const ftlCreationFieldValueKeys = {
  exit_port: "exitPort",
  customs_location: "customsLocation",
  main_carrier_id: "carrierId",
  main_vehicle_type: "vehicleType",
  main_plate_number: "vehiclePlate",
  main_driver_name: "driverName",
  main_driver_phone: "driverPhone",
  planned_exit_at: "plannedDepartureAt",
  planned_arrival_at: "plannedArrivalAt",
  overseas_carrier_name: "carrierId",
  overseas_vehicle_type: "vehicleType",
  overseas_vehicle_count: "vehicleCount",
  overseas_vehicle_plate: "vehiclePlate",
  overseas_driver_name: "driverName",
  overseas_driver_phone: "driverPhone",
} as const satisfies Record<string, keyof FtlLoadPlanSubmissionValues>;

function isFtlCreationField(
  fieldKey: string,
): fieldKey is keyof typeof ftlCreationFieldValueKeys {
  return fieldKey in ftlCreationFieldValueKeys;
}

function submittedFtlCreationFieldPresent(
  context: Extract<FtlLoadPlanContext, { mode: "submit" }>,
  fieldKey: keyof typeof ftlCreationFieldValueKeys,
) {
  const valueKey = ftlCreationFieldValueKeys[fieldKey];
  const value = context.values[valueKey];
  if (valueKey === "vehicleCount") return Number(value) > 0;
  return Boolean(String(value ?? "").trim());
}

export async function checkOrderLoadPlan(
  organizationId: string,
  orderId: string,
  vehiclePlate?: string,
  transportBatchId?: string | null,
  context: FtlLoadPlanContext = { mode: "strict" },
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const workflow = await workflowRequirements(organizationId, orderId, [
    "consignment",
    "warehouse",
    "loading",
    "transport",
  ]);
  const required = (
    moduleCode: OrderModuleCode,
    fieldKey: string,
    fallbackRequired = false,
  ) => workflow.required(moduleCode, fieldKey, fallbackRequired);

  const reasons: string[] = [];
  reasons.push(
    ...workflow.configurationReasons("consignment"),
    ...workflow.configurationReasons("warehouse"),
    ...workflow.configurationReasons("loading"),
    ...workflow.configurationReasons("transport"),
  );
  const deferFtlLoadingFormBlocker = order.business_type === "ftl" && context.mode !== "strict";
  const blocker = await env.DB.prepare(
    `SELECT module_name FROM order_module_instances
     WHERE organization_id=? AND order_id=? AND enabled=1 AND is_required=1
       AND status IN ('blocked','exception')
       AND NOT (?=1 AND module_code='loading' AND status='blocked')
       AND module_code IN (${LOAD_PLAN_GATE_MODULES.map(() => "?").join(",")})
     LIMIT 1`,
  ).bind(
    organizationId,
    orderId,
    deferFtlLoadingFormBlocker ? 1 : 0,
    ...LOAD_PLAN_GATE_MODULES,
  ).first<{ module_name: string }>();
  if (blocker) reasons.push(`${blocker.module_name}存在当前阶段阻断或异常`);

  if (order.warehouse_enabled === 1) {
    const missingWarehouseFields = workflow.missingRequired("warehouse");
    if (missingWarehouseFields.length) {
      reasons.push(
        `${workflow.targetStepName("warehouse")
          ? `“${workflow.targetStepName("warehouse")}”`
          : "国内仓入库"}必填项未完成：${missingWarehouseFields
          .map((field) => field.label)
          .join("、")}`,
      );
    } else if (workflow.moduleRequired("warehouse") && workflow.fields("warehouse").length === 0) {
      // Historical orders without a workflow-field snapshot retain the former
      // warehouse receipt gate. Once a snapshot exists it is authoritative.
      const actual = await env.DB.prepare(
        "SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id AND s.organization_id=r.organization_id WHERE r.organization_id=? AND s.order_id=? AND r.status='completed' AND r.cargo_complete=1 LIMIT 1",
      ).bind(organizationId, orderId).first();
      if (!actual) reasons.push("仓库尚未登记实际收货数量、重量和体积");
    }
  }

  if (
    order.business_type === "pending" &&
    required("consignment", "business_type", true)
  )
    reasons.push("已接受报价尚未确定本单是整车还是拼车");
  const ftlContext = order.business_type === "ftl" ? context : { mode: "strict" as const };
  const loadingExitPortMissing = required("loading", "exit_port", true) && (
    ftlContext.mode === "entry"
      ? false
      : ftlContext.mode === "submit"
        ? !submittedFtlCreationFieldPresent(ftlContext, "exit_port")
        : !order.exit_port
  );
  if (
    (!order.exit_port && required("consignment", "exit_port", true)) ||
    loadingExitPortMissing
  )
    reasons.push("订单尚未确定出境口岸");
  if (
    !order.overseas_warehouse_id &&
    required("consignment", "overseas_warehouse_id", true)
  )
    reasons.push("订单尚未确定境外目的仓");

  let missingLoadPlanFields = workflow
    .missingRequired("loading")
    .filter((field) => loadPlanLoadingFieldKeys.has(field.fieldKey));
  if (order.business_type === "ftl" && ftlContext.mode === "entry") {
    missingLoadPlanFields = missingLoadPlanFields.filter(
      (field) => !isFtlCreationField(field.fieldKey),
    );
  } else if (
    order.business_type === "ftl" &&
    ftlContext.mode === "submit" &&
    workflow.moduleRequired("loading")
  ) {
    missingLoadPlanFields = workflow.scopedFields("loading").filter(
      (field) =>
        !isFrozenWorkflowFieldScopeMarker(field) &&
        field.isActive &&
        field.isRequired &&
        loadPlanLoadingFieldKeys.has(field.fieldKey) &&
        (isFtlCreationField(field.fieldKey)
          ? !submittedFtlCreationFieldPresent(ftlContext, field.fieldKey)
          : !field.present),
    );
  }

  if (order.business_type === "ltl") {
    const plan = await env.DB.prepare(
      `SELECT b.id,
         COUNT(DISTINCT v.id) vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.plate_number),'') IS NOT NULL THEN v.id END) plated_vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.vehicle_type),'') IS NOT NULL THEN v.id END) typed_vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.driver_name),'') IS NOT NULL THEN v.id END) driver_vehicle_count,
         COUNT(DISTINCT CASE WHEN NULLIF(TRIM(v.driver_phone),'') IS NOT NULL THEN v.id END) phoned_vehicle_count,
         MAX(CASE WHEN b.carrier_id IS NOT NULL THEN 1 ELSE 0 END) carrier_ready,
         MAX(CASE WHEN b.warehouse_id IS NOT NULL THEN 1 ELSE 0 END) warehouse_ready,
         MAX(CASE WHEN b.border_port IS NOT NULL THEN 1 ELSE 0 END) port_ready,
         MAX(CASE WHEN b.customs_location IS NOT NULL THEN 1 ELSE 0 END) customs_location_ready,
         MAX(CASE WHEN b.planned_departure_at IS NOT NULL THEN 1 ELSE 0 END) departure_ready,
         MAX(CASE WHEN b.planned_arrival_at IS NOT NULL THEN 1 ELSE 0 END) arrival_ready,
         MAX(CASE WHEN UPPER(v.plate_number)=UPPER(?) THEN 1 ELSE 0 END) plate_match
       FROM transport_batch_orders bo
       JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id AND b.status!='cancelled'
       LEFT JOIN transport_batch_vehicles v ON v.batch_id=b.id AND v.organization_id=b.organization_id AND v.status!='cancelled'
       WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
         AND (?='' OR b.id=?)
       GROUP BY b.id LIMIT 1`,
    ).bind(vehiclePlate || "", organizationId, orderId, transportBatchId || "", transportBatchId || "").first<{
      id: string;
      vehicle_count: number;
      plated_vehicle_count: number;
      typed_vehicle_count: number;
      driver_vehicle_count: number;
      phoned_vehicle_count: number;
      carrier_ready: number;
      warehouse_ready: number;
      port_ready: number;
      customs_location_ready: number;
      departure_ready: number;
      arrival_ready: number;
      plate_match: number;
    }>();
    const loadingRequired = missingLoadPlanFields.length > 0 || [
      "loading_batch",
      "consolidation_warehouse",
      "main_carrier_id",
      "main_vehicle_type",
      "main_plate_number",
      "main_driver_name",
      "main_driver_phone",
      "planned_exit_at",
      "planned_arrival_at",
    ].some((fieldKey) => required("loading", fieldKey));
    if (!plan && loadingRequired) reasons.push("零担订单尚未生成配载批次");
    else {
      if (!plan) return { ready: reasons.length === 0, reasons };
      const vehicleRequired = ["main_vehicle_type", "main_plate_number", "main_driver_name", "main_driver_phone"].some((fieldKey) => required("loading", fieldKey));
      if (!plan.vehicle_count && vehicleRequired) reasons.push("配载批次尚未添加车辆");
      if (required("loading", "main_vehicle_type") && plan.typed_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记车型");
      if (required("loading", "main_plate_number") && plan.plated_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记车牌");
      if (required("loading", "main_driver_name") && plan.driver_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记司机");
      if (required("loading", "main_driver_phone") && plan.phoned_vehicle_count !== plan.vehicle_count) reasons.push("配载车辆尚未完整登记司机电话");
      if (required("loading", "main_carrier_id") && !plan.carrier_ready) reasons.push("配载批次尚未确定出境承运商");
      if (required("loading", "consolidation_warehouse") && !plan.warehouse_ready) reasons.push("配载批次尚未确定集货仓库");
      if (required("loading", "exit_port", true) && !plan.port_ready) reasons.push("配载批次尚未确定出境口岸");
      if (required("loading", "customs_location") && !plan.customs_location_ready) reasons.push("配载批次尚未确定起运地清关地");
      if (required("loading", "planned_exit_at") && !plan.departure_ready) reasons.push("配载批次尚未确定计划出境发车时间");
      if (required("loading", "planned_arrival_at") && !plan.arrival_ready) reasons.push("配载批次尚未确定计划到达时间");
      if (vehiclePlate && required("loading", "main_plate_number") && !plan.plate_match) reasons.push(`车牌 ${vehiclePlate} 不在当前配载计划中`);
      const otherMissingFields = missingLoadPlanFields.filter(
        (field) => !specificallyCheckedLtlLoadPlanFields.has(field.fieldKey),
      );
      if (otherMissingFields.length) {
        const loadingGateName = workflow.targetStepName("loading");
        reasons.push(
          `${loadingGateName ? `“${loadingGateName}”` : "配载方案"}必填项未完成：${otherMissingFields
            .map((field) => field.label)
            .join("、")}`,
        );
      }
    }
  } else if (order.business_type === "ftl") {
    const requiredDomesticFields = domesticTransportGateFields
      .filter((field) => required("transport", field.fieldKey))
      .map((field) => field.fieldKey as DomesticTransportGateFieldKey);
    if (requiredDomesticFields.length) {
      const assignment = await env.DB.prepare(
        `SELECT carrier_id,carrier_name,vehicle_type,plate_number,driver_name,driver_phone,
                planned_departure_at,planned_arrival_at
         FROM order_transport_assignments
         WHERE organization_id=? AND order_id=? AND leg_type='first_mile' AND status!='cancelled'
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(organizationId, orderId).first<DomesticTransportGateAssignment>();
      const missingFields = missingDomesticTransportGateFields(
        requiredDomesticFields,
        assignment ?? null,
      );
      if (missingFields.length) {
        reasons.push(
          `国内运输安排缺少必填信息：${missingFields.map(domesticTransportGateFieldLabel).join("、")}`,
        );
      }
    }
    if (vehiclePlate && required("loading", "main_plate_number")) {
      const outboundAssignment = await env.DB.prepare(
        `SELECT plate_number FROM order_transport_assignments
         WHERE organization_id=? AND order_id=? AND leg_type='main' AND status!='cancelled'
           AND NULLIF(TRIM(plate_number),'') IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(organizationId, orderId).first<{ plate_number: string }>();
      if (
        outboundAssignment &&
        outboundAssignment.plate_number.toUpperCase() !== vehiclePlate.toUpperCase()
      ) {
        reasons.push(
          `车牌与出境运输计划不一致（计划车牌 ${outboundAssignment.plate_number}）`,
        );
      }
    }
    const otherMissingFields = missingLoadPlanFields.filter(
      (field) => field.fieldKey !== "exit_port",
    );
    if (otherMissingFields.length) {
      const loadingGateName = workflow.targetStepName("loading");
      reasons.push(
        `${loadingGateName ? `“${loadingGateName}”` : "整车装车方案"}必填项未完成：${otherMissingFields
          .map((field) => field.label)
          .join("、")}`,
      );
    }
  }

  return { ready: reasons.length === 0, reasons };
}

export async function checkOrderDeparture(
  organizationId: string,
  orderId: string,
  vehiclePlate?: string,
  options?: { warehouseDispatchConfirmed?: boolean },
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const loadPlan = await checkOrderLoadPlan(organizationId, orderId, vehiclePlate);
  const reasons = [...loadPlan.reasons];
  const documentGate = await checkOrderPreDepartureDocuments(organizationId, orderId);
  reasons.push(...documentGate.reasons);
  const workflow = await workflowRequirements(organizationId, orderId, [
    "loading",
    "customs",
  ]);
  const required = (
    moduleCode: OrderModuleCode,
    fieldKey: string,
    fallbackRequired = false,
  ) => workflow.required(moduleCode, fieldKey, fallbackRequired);
  reasons.push(...workflow.configurationReasons("customs"));

  const missingDepartureLoadingFields = workflow
    .missingRequired("loading")
    .filter((field) => !loadPlanLoadingFieldKeys.has(field.fieldKey))
    .filter(
      (field) =>
        field.fieldKey !== "loading_scan_confirmation" ||
        order.warehouse_enabled !== 1,
    )
    .filter(
      (field) =>
        !options?.warehouseDispatchConfirmed ||
        field.fieldKey !== "loading_scan_confirmation",
    );
  if (missingDepartureLoadingFields.length) {
    const loadingGateName = workflow.targetStepName("loading");
    reasons.push(
      `${loadingGateName ? `“${loadingGateName}”` : "装车出库"}必填项未完成：${missingDepartureLoadingFields
        .map((field) => field.label)
        .join("、")}`,
    );
  }

  if (order.customs_enabled === 1) {
    const { declarationsRequired, releaseRequired } = customsModuleGateRequirements(
      workflow.scopedFields("customs"),
      { moduleRequired: workflow.moduleRequired("customs") },
    );
    const missingCustomsFields = workflow
      .missingRequired("customs")
      .filter((field) => field.fieldType !== "attachment");
    if (
      declarationsRequired ||
      releaseRequired ||
      missingCustomsFields.length > 0
    ) {
      const declarations = await env.DB.prepare(
        `SELECT r.clearance_stage,d.status,d.is_deleted
         FROM order_customs_declarations d
         JOIN order_customs_records r ON r.id=d.customs_record_id AND r.organization_id=d.organization_id
        WHERE d.organization_id=? AND d.order_id=?`,
      ).bind(organizationId, orderId).all<{
        clearance_stage: string;
        status: string;
        is_deleted: number;
      }>();
      const validDeclarations = declarations.results.filter(
        (item) => !item.is_deleted && item.status !== "cancelled",
      );
      const gate = customsDeclarationGate(declarations.results, "origin");
      if (
        declarationsRequired &&
        validDeclarations.length === 0 &&
        !releaseRequired
      ) {
        reasons.push("尚未录入有效报关单");
      }
      if (releaseRequired) {
        if (gate.total === 0) {
          reasons.push("尚未录入有效起运地报关单");
        } else if (!gate.ready) {
          reasons.push(
            `起运地报关尚未全部放行（已放行 ${gate.released}/${gate.total} 张）`,
          );
        }
      }
      const otherMissingFields = missingCustomsFields.filter(
        (field) =>
          !["customs_declarations", "customs_release"].includes(field.fieldKey),
      );
      if (otherMissingFields.length) {
        const customsGateName = workflow.targetStepName("customs");
        reasons.push(
          `${customsGateName ? `“${customsGateName}”` : "报关"}必填资料未补齐：${otherMissingFields
            .map((field) => field.label)
            .join("、")}`,
        );
      }
    }
  }

  const warehouseDispatchRequired = required(
    "loading",
    "loading_scan_confirmation",
    true,
  );
  if (
    order.warehouse_enabled === 1 &&
    warehouseDispatchRequired &&
    !options?.warehouseDispatchConfirmed
  ) {
    const outbound = await env.DB.prepare(
      `SELECT 1
       FROM order_module_instances mi
       WHERE mi.organization_id=? AND mi.order_id=? AND mi.module_code='warehouse'
         AND mi.enabled=1
         AND (
           mi.status='completed'
           OR EXISTS(
             SELECT 1
             FROM warehouse_dispatches d
             JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
             JOIN warehouse_packages p ON p.id=di.package_id AND p.organization_id=di.organization_id
             JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
             WHERE d.organization_id=mi.organization_id
               AND s.order_id=mi.order_id
               AND d.status='dispatched'
           )
         )
       LIMIT 1`,
    ).bind(organizationId, orderId).first();
    if (!outbound) reasons.push("仓库尚未完成实际装车与出库交接");
  }

  return { ready: reasons.length === 0, reasons };
}

/**
 * Resolve the vehicle plate that should be carried into the next tracking event.
 * A value explicitly recorded on a tracking event wins; otherwise prefer the
 * warehouse's actual dispatch vehicle, then the batch/order transport plan.
 */
export async function resolveOrderTrackingVehicleReference(
  organizationId: string,
  orderId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(
       (SELECT NULLIF(TRIM(m.vehicle_reference),'')
          FROM order_tracking_milestones m
         WHERE m.organization_id=? AND m.order_id=?
           AND NULLIF(TRIM(m.vehicle_reference),'') IS NOT NULL
         ORDER BY m.event_at DESC,m.created_at DESC LIMIT 1),
       (SELECT NULLIF(TRIM(d.vehicle_plate),'')
          FROM warehouse_dispatches d
          JOIN warehouse_dispatch_items di
            ON di.dispatch_id=d.id AND di.organization_id=d.organization_id
          JOIN warehouse_packages p
            ON p.id=di.package_id AND p.organization_id=di.organization_id
          JOIN shipments s
            ON s.id=p.shipment_id AND s.organization_id=p.organization_id
         WHERE d.organization_id=? AND s.order_id=? AND d.status!='cancelled'
           AND NULLIF(TRIM(d.vehicle_plate),'') IS NOT NULL
         ORDER BY COALESCE(d.dispatched_at,d.updated_at,d.created_at) DESC LIMIT 1),
       (SELECT NULLIF(TRIM(b.overseas_vehicle_plate),'')
          FROM transport_batch_orders bo
          JOIN transport_batches b
            ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
         WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
           AND b.status!='cancelled'
           AND NULLIF(TRIM(b.overseas_vehicle_plate),'') IS NOT NULL
         ORDER BY b.updated_at DESC LIMIT 1),
       (SELECT NULLIF(TRIM(v.plate_number),'')
          FROM transport_batch_orders bo
          JOIN transport_batches b
            ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
          JOIN transport_batch_vehicles v
            ON v.batch_id=b.id AND v.organization_id=b.organization_id
         WHERE bo.organization_id=? AND bo.order_id=? AND bo.status!='removed'
           AND b.status!='cancelled' AND v.status!='cancelled'
           AND NULLIF(TRIM(v.plate_number),'') IS NOT NULL
         ORDER BY b.updated_at DESC,v.updated_at DESC LIMIT 1),
       (SELECT NULLIF(TRIM(a.plate_number),'')
          FROM order_transport_assignments a
         WHERE a.organization_id=? AND a.order_id=? AND a.leg_type='main'
           AND a.status!='cancelled' AND NULLIF(TRIM(a.plate_number),'') IS NOT NULL
         ORDER BY a.updated_at DESC,a.created_at DESC LIMIT 1)
     ) vehicle_reference`,
  )
    .bind(
      organizationId, orderId,
      organizationId, orderId,
      organizationId, orderId,
      organizationId, orderId,
      organizationId, orderId,
    )
    .first<{ vehicle_reference: string | null }>();
  return row?.vehicle_reference || null;
}

export async function checkOrderPreDepartureDocuments(
  organizationId: string,
  orderId: string,
): Promise<ReadinessResult> {
  const order = await operationalOrder(organizationId, orderId);
  if (!order) return { ready: false, reasons: ["订单不存在"] };
  const workflow = await workflowRequirements(organizationId, orderId, [
    "consignment",
    "transport",
    "customs",
  ]);
  const preDepartureModules = new Set<OrderModuleCode>(["consignment", "transport", "customs"]);
  const configurationReasons = [
    ...workflow.configurationReasons("consignment"),
    ...workflow.configurationReasons("transport"),
    ...(order.customs_enabled === 1 ? workflow.configurationReasons("customs") : []),
  ];
  if (configurationReasons.length) {
    return { ready: false, reasons: [...new Set(configurationReasons)] };
  }
  const requiredDocuments = orderDocumentPlacements
    .filter((placement) => preDepartureDocumentTypeCodes.has(placement.documentCode))
    .filter((placement) => preDepartureModules.has(placement.moduleCode))
    .filter((placement) => placement.moduleCode !== "customs" || order.customs_enabled === 1)
    .filter((placement) =>
      workflow.required(
        placement.moduleCode,
        placement.fieldKey,
        placement.requiredByDefault,
      ),
    )
    .map((placement) => placement.documentCode);
  if (!requiredDocuments.length) return { ready: true, reasons: [] };
  const approved = await env.DB.prepare(
    `SELECT DISTINCT document_category FROM order_document_metadata
     WHERE organization_id=? AND order_id=? AND review_status IN ('approved','archived')`,
  ).bind(organizationId, orderId).all<{ document_category: string }>();
  const approvedSet = new Set(approved.results.map((item) => item.document_category));
  const missing = requiredDocuments.filter((code) => !approvedSet.has(code));
  const reasons = missing.length
    ? [`发运前文件尚未审核通过：${missing.map(orderDocumentTypeLabel).join("、")}`]
    : [];
  return { ready: reasons.length === 0, reasons };
}
