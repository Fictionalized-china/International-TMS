import { env } from "cloudflare:workers";
import { Form, Link, useNavigation } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/admin.orders";
import { requireSessionUser } from "../lib/auth.server";
import { nextDocumentNumber } from "../lib/documents.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { ensureWorkflowForBusinessType, recordWorkflowEvent } from "../lib/business-workflow.server";
import { ensureShipmentForOrder } from "../lib/shipment-sync.server";
import { listOrderWorkflowTransitions } from "../lib/order-workflow.server";
import {
  statusLabel,
  type OrderWorkflowTransition,
} from "../lib/order-workflow";
import { Modal, useModalScrollLock } from "../components/Modal";
import { ensureOrderModules } from "../lib/order-modules.server";
import { runOrderWorkflowAction } from "../lib/order-workflow-action.server";
import {
  cargoImageSourceTypes,
  MAX_CARGO_IMAGES_PER_ITEM,
  MAX_CARGO_IMAGE_SOURCE_BYTES,
  MAX_CARGO_IMAGE_STORED_BYTES,
  parseCargoImagePayloads,
  type CargoImagePayload,
} from "../lib/cargo-images";
import { loadOrderGuidance } from "../lib/order-guidance.server";
import { completionStatusLabels, type OrderCompletionStatus } from "../lib/order-review";
import { inheritAcceptedQuoteReceivables } from "../lib/quote-order.server";
import {
  listTemplateWorkflowFields,
  saveOrderCustomWorkflowFieldValue,
  type WorkflowFieldRule,
} from "../lib/workflow-fields.server";

type Order = {
  id: string;
  order_number: string;
  customer_name: string;
  customer_reference: string | null;
  quote_number: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  transport_mode: string;
  service_level: string | null;
  requested_pickup_date: string | null;
  requested_delivery_date: string | null;
  status: string;
  source: string;
  current_step_code: string;
  current_step_name: string;
  assignee_name: string | null;
  workflow_updated_at: string | null;
  is_overdue: number;
  exception_status: string;
  completion_status: OrderCompletionStatus;
  attachment_count: number;
  active_module_count: number;
  incomplete_required_module_count: number;
  created_at: string;
  next_stage: string;
  next_action: string;
  next_owner: string;
  next_blocker: string | null;
  next_href: string;
};
type Member = {
  id: string;
  display_name: string;
  department_name: string | null;
};
type GeoReference = { code: string; name: string; parent_code: string | null };
type PickupAddressOption = {
  id: string;
  customer_id: string;
  label: string;
  country_code: string;
  state: string | null;
  city: string;
  address_line1: string;
  address_line2: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  is_default: number;
};
type WarehouseOption = {
  id: string;
  code: string;
  name: string;
  country_code: string | null;
  city: string | null;
  address: string | null;
};
type WorkflowTemplateOption = {
  id: string;
  code: string;
  name: string;
  status: string;
  step_count: number;
  field_count: number;
  road_load_type: "ltl" | "ftl";
};
const allowedStatuses = [
  "draft",
  "submitted",
  "confirmed",
  "in_execution",
  "completed",
  "cancelled",
];
const orderServiceNames: Record<string, string> = {
  booking: "订舱",
  container: "用箱",
  pickup: "提货",
  warehouse: "仓储",
  packing: "包装",
  customs: "报关",
  insurance: "保险",
  destination_customs: "目的地清关",
  destination_warehouse: "目的地仓储",
  other: "其他服务",
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view"),
    url = new URL(request.url),
    q = (url.searchParams.get("q") ?? "").trim(),
    status = url.searchParams.get("status") ?? "",
    step = url.searchParams.get("step") ?? "",
    assignee = url.searchParams.get("assignee") ?? "",
    page = Math.max(1, Number(url.searchParams.get("page")) || 1),
    pageSize = [20, 50, 100].includes(Number(url.searchParams.get("pageSize")))
      ? Number(url.searchParams.get("pageSize"))
      : 20;
  const defaultWorkflowId = await ensureWorkflowForBusinessType(current.organizationId, null);
  const where = ["o.organization_id=?"],
    bindings: unknown[] = [current.organizationId];
  if (q) {
    where.push(
      "(o.order_number LIKE ? OR c.name LIKE ? OR o.customer_reference LIKE ? OR o.cargo_description LIKE ? OR o.origin_city LIKE ? OR o.destination_city LIKE ?)",
    );
    const term = `%${q}%`;
    bindings.push(term, term, term, term, term, term);
  }
  if (allowedStatuses.includes(status)) {
    where.push("o.status=?");
    bindings.push(status);
  }
  if (step) {
    where.push("o.current_step_code=?");
    bindings.push(step);
  }
  if (assignee) {
    where.push("o.current_assignee_user_id=?");
    bindings.push(assignee);
  }
  const base = `FROM transport_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN quotations q ON q.id=o.quotation_id LEFT JOIN users au ON au.id=o.current_assignee_user_id WHERE ${where.join(" AND ")}`;
  const [
    orders,
    count,
    customers,
    pickupAddresses,
    quotes,
    countries,
    modes,
    services,
    provinces,
    cities,
    borderPorts,
    overseasWarehouses,
    members,
    transitions,
    workflowTemplates,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT o.id,o.order_number,c.name customer_name,o.customer_reference,q.quote_number,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,o.cargo_description,o.pieces,o.gross_weight_kg,o.volume_cbm,o.transport_mode,o.service_level,o.requested_pickup_date,o.requested_delivery_date,o.status,o.source,o.current_step_code,o.current_step_name,au.display_name assignee_name,o.workflow_updated_at,o.is_overdue,o.exception_status,o.completion_status,(SELECT COUNT(*) FROM order_attachments a WHERE a.order_id=o.id) attachment_count,(SELECT COUNT(*) FROM order_module_instances m WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1) active_module_count,(SELECT COUNT(*) FROM order_module_instances m WHERE m.order_id=o.id AND m.organization_id=o.organization_id AND m.enabled=1 AND m.is_required=1 AND m.status!='completed') incomplete_required_module_count,o.created_at ${base} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, pageSize, (page - 1) * pageSize)
      .all<Order>(),
    env.DB.prepare(`SELECT COUNT(*) total ${base}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    env.DB.prepare(
      "SELECT id,code,name FROM customers WHERE organization_id=? AND status='active' ORDER BY name",
    )
      .bind(current.organizationId)
      .all<{ id: string; code: string; name: string }>(),
    env.DB.prepare(
      `SELECT ca.id,ca.customer_id,ca.label,ca.country_code,ca.state,ca.city,ca.address_line1,ca.address_line2,ca.contact_name,ca.contact_phone,ca.is_default
       FROM customer_addresses ca
       JOIN customers c ON c.id=ca.customer_id
       WHERE c.organization_id=? AND c.status='active' AND ca.type='shipping'
       ORDER BY ca.customer_id,ca.is_default DESC,ca.label`,
    )
      .bind(current.organizationId)
      .all<PickupAddressOption>(),
    env.DB.prepare(
      "SELECT q.id,q.quote_number,q.customer_id,c.name customer_name,q.salesperson_user_id,sales.display_name salesperson_name,q.road_load_type,q.currency,q.total_amount,q.origin_country,q.origin_city,q.destination_country,q.destination_city,q.transport_mode,q.service_level,q.cargo_description,q.pieces,q.gross_weight_kg,q.volume_cbm,q.notes FROM quotations q JOIN customers c ON c.id=q.customer_id LEFT JOIN users sales ON sales.id=q.salesperson_user_id WHERE q.organization_id=? AND q.status='accepted' AND NOT EXISTS(SELECT 1 FROM transport_orders o WHERE o.quotation_id=q.id) ORDER BY q.accepted_at DESC",
    )
      .bind(current.organizationId)
      .all<{
        id: string;
        quote_number: string;
        customer_id: string;
        customer_name: string;
         salesperson_user_id:string|null;
         salesperson_name:string|null;
         road_load_type:"ftl"|"ltl";
         currency: string;
         total_amount: number;
         origin_country:string;
         origin_city:string;
         destination_country:string;
         destination_city:string;
         transport_mode:string;
         service_level:string|null;
         cargo_description:string;
         pieces:number;
         gross_weight_kg:number;
         volume_cbm:number;
         notes:string|null;
       }>(),
    ref(current.organizationId, "country"),
    ref(current.organizationId, "transport_mode"),
    ref(current.organizationId, "service_level"),
    ref(current.organizationId, "province"),
    ref(current.organizationId, "city"),
    ref(current.organizationId, "border_port"),
    env.DB.prepare(
      `SELECT id,code,name,country_code,city,address
       FROM warehouses
       WHERE organization_id=? AND status='active' AND warehouse_role='overseas_destination'
       ORDER BY country_code,city,code`,
    )
      .bind(current.organizationId)
      .all<WarehouseOption>(),
    env.DB.prepare(
      "SELECT u.id,u.display_name,d.name department_name FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY d.sort_order,u.display_name",
    )
      .bind(current.organizationId)
      .all<Member>(),
    listOrderWorkflowTransitions(current.organizationId),
    env.DB.prepare(
      `SELECT wd.id,wd.code,wd.name,wd.status,wd.road_load_type,
        COUNT(DISTINCT ws.id) step_count,
        COUNT(DISTINCT f.id) field_count
       FROM workflow_definitions wd
       LEFT JOIN workflow_steps ws ON ws.workflow_id=wd.id AND ws.is_active=1
       LEFT JOIN workflow_step_fields f ON f.workflow_id=wd.id AND f.is_active=1
       WHERE wd.organization_id=? AND wd.status='active' AND wd.lifecycle_status='published'
       GROUP BY wd.id,wd.code,wd.name,wd.status,wd.road_load_type
       ORDER BY CASE WHEN wd.code='tms-default' THEN 0 ELSE 1 END, wd.updated_at DESC`,
    )
      .bind(current.organizationId)
      .all<WorkflowTemplateOption>(),
  ]);
  const total = count?.total ?? 0;
  const workflowFields = await listTemplateWorkflowFields(
    workflowTemplates.results.map((template) => template.id),
  );
  const guidanceByOrder = await loadOrderGuidance(
    env.DB,
    current.organizationId,
    orders.results,
  );
  const orderRows = orders.results.map((order) => {
    const guidance = guidanceByOrder.get(order.id)!;
    return {
      ...order,
      next_stage: guidance.stage.shortTitle,
      next_action: guidance.action,
      next_owner: guidance.owner,
      next_blocker: guidance.blocker,
      next_href: guidance.href,
    };
  });
  return {
    current,
    orders: orderRows,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    filters: { q, status, step, assignee },
    customers: customers.results,
    pickupAddresses: pickupAddresses.results,
    quotes: quotes.results,
    countries: countries.results,
    modes: modes.results,
    services: services.results,
    provinces: provinces.results,
    cities: cities.results,
    borderPorts: borderPorts.results,
    overseasWarehouses: overseasWarehouses.results,
    members: members.results,
    transitions,
    workflowTemplates: workflowTemplates.results,
    defaultWorkflowId,
    workflowFields,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "order.manage"),
    form = await request.formData(),
    intent = valueOf(form, "intent"),
    now = new Date().toISOString();
  if (intent === "workflow_action")
    return runOrderWorkflowAction({
      request,
      organizationId: current.organizationId,
      actorUserId: current.userId,
      orderId: valueOf(form, "id"),
      actionCode: valueOf(form, "actionCode"),
      assigneeUserId: valueOf(form, "assigneeUserId") || null,
      notes: valueOf(form, "notes"),
    });
  if (intent !== "create") return { formError: "无效的订单操作" };
  const quotationId = valueOf(form, "quotationId"),
    formCustomerId = valueOf(form, "customerId"),
    reference = "",
    shipperCustomerId = valueOf(form, "shipperCustomerId"),
    shipperFallback = valueOf(form, "shipper"),
    pickupAddressId = valueOf(form, "pickupAddressId"),
    shipperContact = valueOf(form, "shipperContact"),
    shipperPhone = valueOf(form, "shipperPhone"),
    originCountryForm = valueOf(form, "originCountry"),
    originStateCode = valueOf(form, "originState"),
    originCityForm = valueOf(form, "originCity"),
    originAddress = valueOf(form, "originAddress"),
    consigneeContact = valueOf(form, "consigneeContact"),
    consigneePhone = valueOf(form, "consigneePhone"),
    destinationCountryForm = valueOf(form, "destinationCountry"),
    destinationStateCode = valueOf(form, "destinationState"),
    destinationCityForm = valueOf(form, "destinationCity"),
    destinationAddress = valueOf(form, "destinationAddress"),
    modeForm = "ROAD",
    serviceForm = "STANDARD",
    pickupDate = valueOf(form, "pickupDate"),
    deliveryDate = valueOf(form, "deliveryDate"),
    cargoReadyAt = valueOf(form, "cargoReadyAt"),
    roAgent = valueOf(form, "roAgent"),
    instructions = valueOf(form, "instructions"),
    orderDate = valueOf(form, "orderDate") || now.slice(0, 10),
    businessNature = valueOf(form, "businessNature") || "export",
    transportTerms = "",
    tradeTerms = "",
    exitPort = "",
    overseasWarehouseId = valueOf(form, "overseasWarehouseId"),
    overseasWarehouseAddressNote = valueOf(form, "overseasWarehouseAddressNote"),
    transitLocations = "",
    customsLocation = "",
    routeNotes = "",
    workflowTemplateId = valueOf(form, "workflowTemplateId"),
    assignee = null;
  const quote = quotationId
    ? await env.DB.prepare(
        "SELECT id,quote_number,customer_id,salesperson_user_id,road_load_type,currency,subtotal,tax_amount,total_amount,origin_country,origin_city,destination_country,destination_city,cargo_description,pieces,gross_weight_kg,volume_cbm,transport_mode,service_level,notes FROM quotations WHERE id=? AND organization_id=? AND status='accepted'",
      )
        .bind(quotationId, current.organizationId)
        .first<Record<string, string | number | null>>()
    : null;
  if (!quotationId) return { formError: "请选择已接受报价；订单的整车/拼车类型和应收费用必须从报价继承" };
  if (!quote) return { formError: "报价无效、尚未接受或已被其他订单使用" };
  const businessType = quote.road_load_type === "ftl"
    ? "ftl"
    : quote.road_load_type === "ltl"
      ? "ltl"
      : "";
  if (!businessType)
    return { formError: "该报价尚未选择整车或拼车方案，请先编辑报价" };
  const customerId = String(quote.customer_id ?? formCustomerId ?? ""),
    originCountry = String(quote?.origin_country ?? originCountryForm),
    originCity = String(quote?.origin_city ?? originCityForm),
    destinationCountry = String(
      quote?.destination_country ?? destinationCountryForm,
    ),
    destinationCity = String(quote?.destination_city ?? destinationCityForm),
    mode = String(quote?.transport_mode ?? modeForm),
    service = String(quote?.service_level ?? serviceForm);
  const customer = await env.DB.prepare(
    "SELECT id,name FROM customers WHERE id=? AND organization_id=? AND status='active'",
  )
    .bind(customerId, current.organizationId)
    .first<{ id: string; name: string }>();
  if (!customer) return { formError: "客户无效" };
  const selectedWorkflow = await resolveWorkflowTemplate(
    current.organizationId,
    workflowTemplateId,
    businessType,
  );
  if (!selectedWorkflow)
    return { formError: "请选择启用的工作流模板" };
  const selectedWorkflowFields = await listTemplateWorkflowFields([
    selectedWorkflow.id,
  ]);
  const fieldRule = (fieldKey: string, moduleCode?: string) =>
    selectedWorkflowFields.find(
      (field) =>
        field.fieldKey === fieldKey &&
        (!moduleCode || field.moduleCode === moduleCode),
    );
  const fieldIsActive = (fieldKey: string, moduleCode?: string) =>
    Boolean(fieldRule(fieldKey, moduleCode)?.isActive);
  const fieldIsRequired = (fieldKey: string, moduleCode?: string) => {
    if (
      fieldKey === "document_consignment_letter" ||
      fieldKey === "document_contract"
    )
      return false;
    const rule = fieldRule(fieldKey, moduleCode);
    return Boolean(rule?.isActive && rule.isRequired);
  };
  if (
    fieldIsRequired("shipper_customer_id", "consignment") &&
    !shipperCustomerId &&
    !shipperFallback
  )
    return { formError: "请填写必填项：发货人" };
  const shipperCustomer = shipperCustomerId
    ? await env.DB.prepare("SELECT id,name FROM customers WHERE id=? AND organization_id=? AND status='active'").bind(shipperCustomerId, current.organizationId).first<{ id: string; name: string }>()
    : shipperFallback
      ? await env.DB.prepare("SELECT id,name FROM customers WHERE name=? AND organization_id=? AND status='active' LIMIT 1").bind(shipperFallback, current.organizationId).first<{ id: string; name: string }>()
      : customer;
  if (!shipperCustomer) return { formError: "请选择客户列表中的发货人" };
  const pickupAddress = pickupAddressId
    ? await env.DB.prepare("SELECT id FROM customer_addresses WHERE id=? AND customer_id=? AND type='shipping'").bind(pickupAddressId, shipperCustomer.id).first<{ id: string }>()
    : null;
  if (pickupAddressId && !pickupAddress) return { formError: "所选常用提货地不属于当前发货人，请重新选择" };
  const shipper = shipperCustomer.name;
  const consigneeName = shipper;
  const overseasWarehouse = overseasWarehouseId
    ? await env.DB.prepare(
        `SELECT id,name FROM warehouses
         WHERE organization_id=? AND id=? AND status='active' AND warehouse_role='overseas_destination'`,
      )
        .bind(current.organizationId, overseasWarehouseId)
        .first<{ id: string; name: string }>()
    : null;
  if (overseasWarehouseId && !overseasWarehouse)
    return { formError: "请选择有效的境外目的仓" };
  if (!pickupDate) return { formError: "请填写预约提货时间" };
  if (!overseasWarehouseId) return { formError: "请选择境外目的仓" };
  const consignmentLetterField = form.get("consignmentLetter");
  const consignmentLetterFile =
    consignmentLetterField instanceof File && consignmentLetterField.size > 0
      ? consignmentLetterField
      : null;
  if (!consignmentLetterFile)
    return { formError: "请上传客户委托书 / 委托单（必填）" };
  if (consignmentLetterFile.size > 5 * 1024 * 1024)
    return { formError: "委托书文件不能超过 5MB" };
  const allowedConsignmentTypes = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
  ]);
  if (
    consignmentLetterFile.type &&
    !allowedConsignmentTypes.has(consignmentLetterFile.type)
  )
    return {
      formError: "委托书仅支持 PDF / PNG / JPG / WEBP 格式",
    };
  const [originStateRow, destinationStateRow] = await Promise.all([
        fieldIsActive("origin_state", "consignment") && originStateCode
          ? geographicParent(
              current.organizationId,
              "province",
              originStateCode,
              originCountry,
            )
          : null,
        fieldIsActive("destination_state", "consignment") && destinationStateCode
          ? geographicParent(
              current.organizationId,
              "province",
              destinationStateCode,
              destinationCountry,
            )
          : null,
      ]);
  if (
    ((originStateCode && !originStateRow) ||
      (destinationStateCode && !destinationStateRow))
  )
    return { formError: "请选择与国家对应的省/州" };
  const [originCityValid, destinationCityValid] = await Promise.all([
      fieldIsActive("origin_city", "consignment") && originCity
        ? geographicCity(
            current.organizationId,
            originCity,
            originStateCode,
          )
        : true,
      fieldIsActive("destination_city", "consignment") && destinationCity
        ? geographicCity(
            current.organizationId,
            destinationCity,
            destinationStateCode,
          )
        : true,
    ]);
  if (!originCityValid || !destinationCityValid)
    return { formError: "请选择与省/州对应的城市" };
  const originState = originStateRow?.name ?? null,
    destinationState = destinationStateRow?.name ?? null;
  const imagePayloads = quote
    ? []
    : form.getAll("cargoImages").map((entry, index) => {
        const parsed = parseCargoImagePayloads(String(entry || "[]"));
        return parsed.ok
          ? parsed
          : {
              ...parsed,
              error: `货物 ${index + 1}：${parsed.error}`,
            };
      });
  const invalidImages = imagePayloads.find((result) => !result.ok);
  if (invalidImages && !invalidImages.ok)
    return { formError: invalidImages.error };

  const cargoRows = quote
    ? [
        {
          name: String(quote.cargo_description),
          nameEn: "",
          hsCode: "",
          overseasHsCode: "",
          packageType: "other",
          packageCount: Number(quote.pieces),
          piecesPerPackage: 1,
          weight: Number(quote.gross_weight_kg) / Number(quote.pieces),
          netWeight: 0,
          length: 0,
          width: 0,
          height: 0,
          volume: Number(quote.volume_cbm) / Number(quote.pieces),
          declaredValue: 0,
          currency: "USD",
          originCountry: "",
          brandModel: "",
          marks: "",
          specialAttributes: "",
          notes: "",
          images: [] as CargoImageDraft[],
        },
      ]
    : form.getAll("cargoName").map((entry, index) => {
        const count = Math.floor(
            Number(form.getAll("cargoPackageCount")[index] || 0),
          ),
          piecesPerPackage = Math.floor(
            Number(form.getAll("cargoPiecesPerPackage")[index] || 0),
          ),
          length = Number(form.getAll("cargoLength")[index] || 0),
          width = Number(form.getAll("cargoWidth")[index] || 0),
          height = Number(form.getAll("cargoHeight")[index] || 0),
          enteredVolume = Number(form.getAll("cargoVolume")[index] || 0);
        return {
          name: String(entry).trim(),
          nameEn: String(form.getAll("cargoNameEn")[index] || "").trim(),
          hsCode: String(form.getAll("cargoHsCode")[index] || "").trim(),
          overseasHsCode: String(form.getAll("cargoOverseasHsCode")[index] || "").trim(),
          packageType: String(
            form.getAll("cargoPackageType")[index] || "carton",
          ),
          packageCount: count,
          piecesPerPackage,
          weight: Number(form.getAll("cargoWeight")[index] || 0),
          netWeight: Number(form.getAll("cargoNetWeight")[index] || 0),
          length,
          width,
          height,
          volume: enteredVolume || (length * width * height) / 1_000_000,
          declaredValue: Number(form.getAll("cargoDeclaredValue")[index] || 0),
          currency: String(form.getAll("cargoCurrency")[index] || "USD"),
          originCountry: String(form.getAll("cargoOriginCountry")[index] || ""),
          brandModel: String(form.getAll("cargoBrandModel")[index] || "").trim(),
          marks: String(form.getAll("cargoMarks")[index] || "").trim(),
          specialAttributes: String(form.getAll("cargoSpecialAttributes")[index] || "").trim(),
          notes: String(form.getAll("cargoNotes")[index] || "").trim(),
          images: imagePayloads[index]?.images ?? [],
        };
      });
  const cargo = cargoRows
      .map((x) => x.name)
      .filter(Boolean)
      .join("、"),
    pieces = cargoRows.reduce(
      (n, x) => n + x.packageCount * x.piecesPerPackage,
      0,
    ),
    weight = cargoRows.reduce((n, x) => n + x.packageCount * x.weight, 0),
    volume = cargoRows.reduce((n, x) => n + x.packageCount * x.volume, 0),
    packageTotal = cargoRows.reduce((n, x) => n + x.packageCount, 0);
  const creationDocumentPayloads: {
    file: File;
    category: string;
    label: string;
    dataUrl: string;
  }[] = [];
  const consignmentValues: Record<string, unknown> = {
    customer_id: customerId,
    quotation_id: quotationId,
    order_date: orderDate,
    business_nature: businessNature,
    shipper_customer_id: shipperCustomerId || shipperFallback,
    pickup_address_id: pickupAddressId,
    shipper_contact: shipperContact,
    shipper_phone: shipperPhone,
    origin_country: originCountry,
    origin_state: originState,
    origin_city: originCity,
    origin_address: originAddress,
    consignee_name: consigneeName,
    consignee_contact: consigneeContact,
    consignee_phone: consigneePhone,
    destination_country: destinationCountry,
    destination_state: destinationState,
    destination_city: destinationCity,
    destination_address: destinationAddress,
    overseas_warehouse_id: overseasWarehouse?.id,
    overseas_warehouse_address_note: overseasWarehouseAddressNote,
    requested_pickup_date: pickupDate,
    cargo_ready_at: cargoReadyAt,
    requested_delivery_date: deliveryDate,
    ro_agent: roAgent,
    special_instructions: instructions,
  };
  const customCreationValues = new Map<string, string>();
  for (const field of selectedWorkflowFields) {
    if (
      field.stepKey !== "order_creation" ||
      field.isBuiltIn ||
      !field.isActive
    )
      continue;
    const value = valueOf(form, workflowCustomInputName(field));
    customCreationValues.set(field.id, value);
    if (field.moduleCode === "consignment")
      consignmentValues[field.fieldKey] = value;
  }
  const missingConsignment = selectedWorkflowFields.filter(
    (field) =>
      field.moduleCode === "consignment" &&
      field.isActive &&
      field.isRequired &&
      field.fieldKey !== "document_consignment_letter" &&
      field.fieldKey !== "document_contract" &&
      !workflowValuePresent(consignmentValues[field.fieldKey], field.fieldType),
  );
  if (missingConsignment.length)
    return {
      formError: `请填写必填项：${missingConsignment.map((field) => field.label).join("、")}`,
    };
  const activeCargoRules = selectedWorkflowFields.filter(
    (field) => field.moduleCode === "cargo" && field.isActive,
  );
  const requiredCargoRules = activeCargoRules.filter(
    (field) => field.isRequired && field.isBuiltIn,
  );
  if (requiredCargoRules.length && !cargoRows.length)
    return { formError: "请至少新增一条货物，并补齐当前工作流要求的货物必填项" };
  const missingCargoLabels = requiredCargoRules
    .filter((field) =>
      cargoRows.some((row) => !cargoWorkflowValuePresent(row, field.fieldKey)),
    )
    .map((field) => field.label);
  if (missingCargoLabels.length)
    return { formError: `请补齐每条货物的必填项：${missingCargoLabels.join("、")}` };
  const missingCustomFields = selectedWorkflowFields.filter(
    (field) =>
      field.stepKey === "order_creation" &&
      !field.isBuiltIn &&
      field.isActive &&
      field.isRequired &&
      !workflowValuePresent(customCreationValues.get(field.id), field.fieldType),
  );
  if (missingCustomFields.length)
    return {
      formError: `请填写模板补充必填项：${missingCustomFields.map((field) => field.label).join("、")}`,
    };
  if (
    packageTotal > 500 ||
    cargoRows.some(
      (row) =>
        !Number.isInteger(row.packageCount) ||
        row.packageCount < 1 ||
        !Number.isInteger(row.piecesPerPackage) ||
        row.piecesPerPackage < 1 ||
        row.weight < 0 ||
        row.netWeight < 0 ||
        row.volume < 0 ||
        row.declaredValue < 0,
    )
  )
    return { formError: "货物数量或重量、体积、货值格式不正确；单票最多500个包装" };
  const id = crypto.randomUUID(),
    number = await nextDocumentNumber(current.organizationId, "order");
  await env.DB.prepare(
    `INSERT INTO transport_orders(id,organization_id,order_number,order_date,business_nature,business_type,transport_terms,trade_terms,exit_port,overseas_warehouse_id,overseas_warehouse_address_note,transit_locations,customs_location,route_notes,customer_id,quotation_id,customer_reference,shipper_name,shipper_contact,shipper_phone,shipper_customer_id,pickup_address_id,origin_country,origin_state,origin_city,origin_address,consignee_name,consignee_contact,consignee_phone,destination_country,destination_state,destination_city,destination_address,cargo_description,pieces,gross_weight_kg,volume_cbm,transport_mode,service_level,requested_pickup_date,requested_delivery_date,cargo_ready_at,ro_agent,source,special_instructions,created_by_user_id,salesperson_user_id,current_assignee_user_id,workflow_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      current.organizationId,
      number,
      orderDate,
      businessNature,
      businessType,
      transportTerms || null,
      tradeTerms || null,
      exitPort,
      overseasWarehouse?.id || null,
      overseasWarehouseAddressNote || null,
      transitLocations || null,
      customsLocation || null,
      routeNotes || null,
      customerId,
      quotationId || null,
      reference || null,
      shipper,
      shipperContact || null,
      shipperPhone || null,
      shipperCustomer.id,
      pickupAddress?.id || null,
      originCountry,
      originState,
      originCity,
      originAddress,
      consigneeName,
      consigneeContact || null,
      consigneePhone || null,
      destinationCountry,
      destinationState,
      destinationCity,
      destinationAddress,
      cargo || "待补录",
      pieces || 1,
      weight,
      volume,
      mode,
      service || null,
      pickupDate || null,
      deliveryDate || null,
      cargoReadyAt || null,
      roAgent || null,
      "admin",
      instructions || null,
      current.userId,
      quote.salesperson_user_id || null,
      assignee,
      now,
      now,
      now,
    )
    .run();
  const cargoStatements: D1PreparedStatement[] = [];
  let packageSequence = 1;
  cargoRows.forEach((row, lineIndex) => {
    const cargoItemId = crypto.randomUUID();
    cargoStatements.push(
      env.DB.prepare(
        `INSERT INTO order_cargo_items(
          id,organization_id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,
          package_type,package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,
          length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,origin_country,
          brand_model,marks,special_attributes,notes,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        cargoItemId,
        current.organizationId,
        id,
        lineIndex + 1,
        row.name,
        row.nameEn || null,
        row.hsCode || null,
        row.overseasHsCode || null,
        row.packageType,
        row.packageCount,
        row.piecesPerPackage,
        row.weight,
        row.netWeight,
        row.length,
        row.width,
        row.height,
        row.volume,
        row.declaredValue,
        row.currency,
        row.originCountry || null,
        row.brandModel || null,
        row.marks || null,
        row.specialAttributes || null,
        row.notes || null,
        now,
        now,
      ),
    );
    for (let index = 1; index <= row.packageCount; index++) {
      cargoStatements.push(
        env.DB.prepare(
          "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          id,
          cargoItemId,
          `${number}-P${String(packageSequence).padStart(3, "0")}`,
          index,
          now,
        ),
      );
      packageSequence++;
    }
    row.images.forEach((image, imageIndex) =>
      cargoStatements.push(
        env.DB.prepare(
          "INSERT INTO order_cargo_images(id,organization_id,order_id,cargo_item_id,file_name,content_type,size_bytes,data_url,sort_order,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          id,
          cargoItemId,
          image.name,
          image.type,
          image.size,
          image.dataUrl,
          imageIndex,
          current.userId,
          now,
        ),
      ),
    );
  });
  for (const document of creationDocumentPayloads) {
    const attachmentId = crypto.randomUUID();
    cargoStatements.push(
      env.DB.prepare(
        "INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)",
      ).bind(
        attachmentId,
        current.organizationId,
        id,
        customerId,
        document.file.name,
        document.file.type,
        document.file.size,
        document.dataUrl,
        current.userId,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,0,'pending',?)",
      ).bind(
        attachmentId,
        current.organizationId,
        id,
        document.category,
        document.label,
        now,
      ),
    );
  }
  const selectedServices = form.getAll("services").map(String);
  const servicesToCreate = selectedServices.length
    ? selectedServices
    : [
        "pickup",
        "warehouse",
        "packing",
        "customs",
        "destination_customs",
        "destination_warehouse",
        "other",
      ];
  for (const code of servicesToCreate) {
    const serviceName = orderServiceNames[code];
    if (serviceName)
      cargoStatements.push(
        env.DB.prepare(
          "INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES(?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          current.organizationId,
          id,
          code,
          serviceName,
          now,
        ),
      );
  }
  try {
    await env.DB.batch(cargoStatements);
  } catch (error) {
    // The order header is created before its dependent cargo batch. Remove the
    // incomplete header on any batch failure so a retry cannot leave a ghost order.
    await env.DB.prepare(
      "DELETE FROM transport_orders WHERE id=? AND organization_id=?",
    )
      .bind(id, current.organizationId)
      .run();
    if (String(error).includes("SQLITE_TOOBIG"))
      return {
        formError: "货物图片超过数据库安全限制，请重新选择图片后再创建订单",
      };
    throw error;
  }
  await captureAcceptedQuoteSnapshot({
    organizationId: current.organizationId,
    orderId: id,
    quotationId,
    quote,
    createdAt: now,
  });
  const workflowInstanceId = await recordWorkflowEvent({
    organizationId: current.organizationId,
    event: "order.created",
    customerId,
    quotationId: quotationId || null,
    orderId: id,
    actorUserId: current.userId,
    source: "admin",
    workflowId: selectedWorkflow.id,
    metadata: { number, workflowTemplateName: selectedWorkflow.name },
  });
  if (workflowInstanceId)
    await env.DB.prepare(
      "UPDATE transport_orders SET workflow_instance_id=? WHERE id=?",
    )
      .bind(workflowInstanceId, id)
      .run();
  if (workflowInstanceId && customCreationValues.size) {
    const snapshotFields = await env.DB.prepare(
      `SELECT id,field_key,module_code
       FROM workflow_instance_fields
       WHERE instance_id=? AND is_active=1`,
    )
      .bind(workflowInstanceId)
      .all<{ id: string; field_key: string; module_code: string }>();
    for (const templateField of selectedWorkflowFields) {
      const value = customCreationValues.get(templateField.id);
      if (templateField.isBuiltIn || !value?.trim()) continue;
      const snapshotField = snapshotFields.results.find(
        (field) =>
          field.field_key === templateField.fieldKey &&
          field.module_code === templateField.moduleCode,
      );
      if (!snapshotField) continue;
      await saveOrderCustomWorkflowFieldValue({
        organizationId: current.organizationId,
        orderId: id,
        fieldId: snapshotField.id,
        value,
        actorUserId: current.userId,
      });
    }
  }
  await env.DB.prepare(
    "INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,to_step_code,actor_user_id,assignee_user_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      current.organizationId,
      id,
      "create",
      "创建订单",
      "draft",
      "draft",
      "draft",
      current.userId,
      assignee,
      now,
    )
    .run();
  await writeAudit({
    request,
    action: "order.create",
    resourceType: "transport_order",
    resourceId: id,
    organizationId: current.organizationId,
    actorUserId: current.userId,
    metadata: {
      number,
      source: "admin",
      workflowTemplateId: selectedWorkflow.id,
      workflowTemplateName: selectedWorkflow.name,
    },
  });
  await ensureOrderModules(current.organizationId, id);
  if (quotationId)
    await inheritAcceptedQuoteReceivables(
      current.organizationId,
      id,
      quotationId,
      current.userId,
    );
  await ensureShipmentForOrder({
    organizationId: current.organizationId,
    orderId: id,
    actorUserId: current.userId,
    request,
  });
  if (consignmentLetterFile) {
    const attachmentId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO order_attachments(id,organization_id,order_id,customer_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,'admin',?)",
      ).bind(
        attachmentId,
        current.organizationId,
        id,
        customerId,
        consignmentLetterFile.name,
        consignmentLetterFile.type || "application/octet-stream",
        consignmentLetterFile.size,
        await toDataUrl(consignmentLetterFile),
        current.userId,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO order_document_metadata(attachment_id,organization_id,order_id,document_category,description,public_to_customer,review_status,updated_at) VALUES(?,?,?,?,?,1,'pending',?)",
      ).bind(
        attachmentId,
        current.organizationId,
        id,
        "consignment_letter",
        "新建订单时随单提交的委托书",
        now,
      ),
    ]);
  }
  return { success: `订单 ${number} 已创建`, createdOrderId: id };
}

async function resolveWorkflowTemplate(
  organizationId: string,
  workflowTemplateId: string,
  businessType = "ltl",
) {
  if (workflowTemplateId) {
    const selected = await env.DB.prepare(
      "SELECT id,code,name,road_load_type FROM workflow_definitions WHERE id=? AND organization_id=? AND status='active' AND lifecycle_status='published'",
    )
      .bind(workflowTemplateId, organizationId)
      .first<{ id: string; code: string; name: string; road_load_type:string }>();
    if (selected && selected.road_load_type === businessType)
      return selected;
  }
  const id = await ensureWorkflowForBusinessType(organizationId, businessType);
  return env.DB.prepare(
      "SELECT id,name FROM workflow_definitions WHERE id=? AND organization_id=? AND status='active' AND lifecycle_status='published'",
    )
      .bind(id, organizationId)
      .first<{ id: string; name: string }>();
}

async function captureAcceptedQuoteSnapshot(input: {
  organizationId: string;
  orderId: string;
  quotationId: string;
  quote: Record<string, string | number | null>;
  createdAt: string;
}) {
  const charges = await env.DB.prepare(
    `SELECT charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order
     FROM quotation_charges
     WHERE quotation_id=?
     ORDER BY sort_order,id`,
  )
    .bind(input.quotationId)
    .all<Record<string, string | number | null>>();
  const snapshot = {
    quoteNumber: String(input.quote.quote_number),
    roadLoadType: String(input.quote.road_load_type),
    currency: String(input.quote.currency),
    subtotal: Number(input.quote.subtotal),
    taxAmount: Number(input.quote.tax_amount),
    totalAmount: Number(input.quote.total_amount),
    salespersonUserId: input.quote.salesperson_user_id ? String(input.quote.salesperson_user_id) : null,
    originCountry: String(input.quote.origin_country),
    originCity: String(input.quote.origin_city),
    destinationCountry: String(input.quote.destination_country),
    destinationCity: String(input.quote.destination_city),
    transportMode: String(input.quote.transport_mode),
    cargoDescription: String(input.quote.cargo_description),
    pieces: Number(input.quote.pieces),
    grossWeightKg: Number(input.quote.gross_weight_kg),
    volumeCbm: Number(input.quote.volume_cbm),
    notes: input.quote.notes ? String(input.quote.notes) : null,
    charges: charges.results,
  };
  await env.DB.prepare(
    `INSERT INTO transport_order_quote_snapshots(
       order_id,organization_id,quotation_id,quote_number,road_load_type,currency,
       subtotal,tax_amount,total_amount,snapshot_json,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      input.orderId,
      input.organizationId,
      input.quotationId,
      String(input.quote.quote_number),
      String(input.quote.road_load_type),
      String(input.quote.currency),
      Number(input.quote.subtotal),
      Number(input.quote.tax_amount),
      Number(input.quote.total_amount),
      JSON.stringify(snapshot),
      input.createdAt,
    )
    .run();
}

function workflowValuePresent(value: unknown, fieldType = "text") {
  if (value === null || value === undefined) return false;
  if (typeof value === "number")
    return fieldType === "number" || fieldType === "amount"
      ? Number.isFinite(value) && value > 0
      : Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim().length > 0;
}

function cargoWorkflowValuePresent(
  row: CargoDraft | Omit<CargoDraft, "id">,
  fieldKey: string,
) {
  const values: Record<string, unknown> = {
    cargo_name_cn: row.name,
    cargo_name_en: row.nameEn,
    hs_code: row.hsCode,
    overseas_hs_code: row.overseasHsCode,
    package_type: row.packageType,
    package_count: row.packageCount,
    pieces_per_package: row.piecesPerPackage,
    gross_weight_per_package_kg: row.weight,
    net_weight_per_package_kg: row.netWeight,
    length_cm: row.length,
    width_cm: row.width,
    height_cm: row.height,
    volume_per_package_cbm: effectiveCargoVolume(row),
    declared_value: row.declaredValue,
    currency: row.currency,
    origin_country_cargo: row.originCountry,
    brand_model: row.brandModel,
    marks: row.marks,
    special_attributes: row.specialAttributes,
    cargo_images: row.images,
    cargo_notes: row.notes,
  };
  return workflowValuePresent(values[fieldKey],
    [
      "package_count",
      "pieces_per_package",
      "gross_weight_per_package_kg",
      "net_weight_per_package_kg",
      "length_cm",
      "width_cm",
      "height_cm",
      "volume_per_package_cbm",
      "declared_value",
    ].includes(fieldKey)
      ? "number"
      : "text",
  );
}

function geographicParent(
  organizationId: string,
  category: "province",
  code: string,
  parentCode: string,
) {
  if (!code || !parentCode) return null;
  return env.DB.prepare(
    "SELECT code,name FROM reference_data WHERE organization_id=? AND category=? AND code=? AND parent_code=? AND status='active'",
  )
    .bind(organizationId, category, code, parentCode)
    .first<{ code: string; name: string }>();
}
function geographicCity(
  organizationId: string,
  city: string,
  provinceCode: string,
) {
  if (!city || !provinceCode) return null;
  return env.DB.prepare(
    "SELECT 1 FROM reference_data WHERE organization_id=? AND category='city' AND (name=? OR code=?) AND parent_code=? AND status='active'",
  )
    .bind(organizationId, city, city, provinceCode)
    .first();
}
function ref(org: string, category: string) {
  return env.DB.prepare(
    "SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,code",
  )
    .bind(org, category)
    .all<GeoReference>();
}
export function meta() {
  return [{ title: "运输订单工作台 | International TMS" }];
}

export default function Orders({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle",
    manage = loaderData.current.permissions.includes("order.manage"),
    data = actionData as
      | undefined
      | {
          success?: string;
          formError?: string;
          createdOrderId?: string;
        };
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">ORDER WORKBENCH</p>
          <h1>运输订单工作台</h1>
          <p>用表格处理业务数据，由工作流控制状态、负责人和下一步动作。</p>
        </div>
        <div className="page-actions">
          <span className="status-pill">共 {loaderData.total} 票</span>
          {manage && (
            <Modal
              title="新增运输订单"
              triggerLabel="＋ 新增订单"
              triggerClassName="primary"
              size="xwide"
              closeSignal={data?.createdOrderId}
            >
              <CreateOrder
                data={loaderData}
                busy={busy}
                formError={data?.formError}
              />
            </Modal>
          )}
        </div>
      </header>
      {(data?.success || data?.formError) && (
        <div className={`alert ${data.formError ? "error" : "success"}`}>
          {data.formError ?? data.success}
        </div>
      )}
      <section className="panel order-workbench">
        <div className="order-workbench-tools">
          <div>
            <h2>订单列表</h2>
            <p>按条件筛选订单，并直接打开当前工作节点。</p>
          </div>
        </div>
        <Form method="get" className="order-filters">
          <input
            name="q"
            defaultValue={loaderData.filters.q}
            placeholder="订单号、客户、货物、城市…"
          />
          <select name="status" defaultValue={loaderData.filters.status}>
            <option value="">全部状态</option>
            {allowedStatuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select name="step" defaultValue={loaderData.filters.step}>
            <option value="">全部节点</option>
            {uniqueSteps(loaderData.transitions).map((x) => (
              <option key={x.code} value={x.code}>
                {x.name}
              </option>
            ))}
          </select>
          <select name="assignee" defaultValue={loaderData.filters.assignee}>
            <option value="">全部处理人</option>
            {loaderData.members.map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
              </option>
            ))}
          </select>
          <select name="pageSize" defaultValue={loaderData.pageSize}>
            <option value="20">20 条/页</option>
            <option value="50">50 条/页</option>
            <option value="100">100 条/页</option>
          </select>
          <button className="secondary">查询</button>
          <Link className="text-button" to="/admin/orders">
            重置
          </Link>
        </Form>
        <div className="table-wrap order-table">
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>客户</th>
                <th>业务/线路</th>
                <th>货物</th>
                <th>计划</th>
                <th>业务状态</th>
                <th>当前节点</th>
                <th>当前负责人</th>
                <th>下一步动作</th>
                <th>提醒</th>
                <th className="sticky-action">操作</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.orders.map((o) => {
                const actions = loaderData.transitions.filter(
                  (x) =>
                    x.from_status === o.status &&
                    (x.action_code !== "complete" ||
                      (o.active_module_count > 0 &&
                        o.incomplete_required_module_count === 0)),
                );
                return (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/admin/orders/${o.id}`}>
                        <strong>{o.order_number}</strong>
                      </Link>
                      <small>
                        {o.customer_reference || o.quote_number || "—"}
                      </small>
                    </td>
                    <td>
                      <strong>{o.customer_name}</strong>
                      <small>
                        {o.source === "portal" ? "客户门户" : "后台创建"}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {o.transport_mode}
                        {o.service_level ? ` · ${o.service_level}` : ""}
                      </strong>
                      <small>
                        {o.origin_country} {o.origin_state || ""}{" "}
                        {o.origin_city} → {o.destination_country}{" "}
                        {o.destination_state || ""} {o.destination_city}
                      </small>
                    </td>
                    <td>
                      <strong>{o.cargo_description}</strong>
                      <small>
                        {o.pieces} 件 · {o.gross_weight_kg} KG · {o.volume_cbm}{" "}
                        CBM
                      </small>
                    </td>
                    <td>
                      <strong>{o.requested_pickup_date || "待定"}</strong>
                      <small>送达 {o.requested_delivery_date || "待定"}</small>
                    </td>
                    <td>
                      <span
                        className={`status-pill ${o.status === "cancelled" ? "off" : ""}`}
                      >
                        {statusLabel(o.status)}
                      </span>
                      <small>{completionStatusLabels[o.completion_status]}</small>
                    </td>
                    <td>
                      <strong>{o.current_step_name}</strong>
                      <small>
                        {o.workflow_updated_at
                          ? new Date(o.workflow_updated_at).toLocaleString(
                              "zh-CN",
                            )
                          : "—"}
                      </small>
                    </td>
                    <td>{o.assignee_name || o.next_owner || "未分配"}</td>
                    <td>
                      <Link className="order-next-link" to={o.next_href}>
                        <strong>{o.next_action}</strong>
                        <small>{o.next_stage} · {o.next_owner}</small>
                      </Link>
                      {o.next_blocker && (
                        <small className="danger-text">阻断：{o.next_blocker}</small>
                      )}
                    </td>
                    <td>
                      {o.is_overdue ? (
                        <span className="status-pill off">已超时</span>
                      ) : o.exception_status !== "normal" ? (
                        <span className="status-pill off">异常</span>
                      ) : (
                        <span className="muted">正常</span>
                      )}
                    </td>
                    <td className="sticky-action">
                      <div className="row-actions">
                        <Link
                          className="text-button"
                          to={`/admin/orders/${o.id}`}
                        >
                          详情
                        </Link>
                        {manage &&
                          actions
                            .slice(0, 3)
                            .map((a) => (
                              <ActionButton
                                key={a.action_code}
                                order={o}
                                transition={a}
                                members={loaderData.members}
                                busy={busy}
                                success={data?.success}
                              />
                            ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loaderData.orders.length && (
          <p className="empty-state">没有符合条件的订单。</p>
        )}
        <Pagination
          page={loaderData.page}
          pages={loaderData.pages}
          filters={loaderData.filters}
          pageSize={loaderData.pageSize}
        />
      </section>
    </>
  );
}

function ActionButton({
  order,
  transition,
  members,
  busy,
  success,
}: {
  order: Order;
  transition: OrderWorkflowTransition;
  members: Member[];
  busy: boolean;
  success?: string;
}) {
  if (!transition.requires_assignee)
    return (
      <Form method="post">
        <input type="hidden" name="intent" value="workflow_action" />
        <input type="hidden" name="id" value={order.id} />
        <input type="hidden" name="actionCode" value={transition.action_code} />
        <button
          className={`text-button ${transition.to_status === "cancelled" ? "danger" : ""}`}
          disabled={busy}
        >
          {transition.action_name}
        </button>
      </Form>
    );
  return (
    <Modal
      title={`${transition.action_name} · ${order.order_number}`}
      triggerLabel={transition.action_name}
      triggerClassName="text-button"
      closeSignal={success}
    >
      {({ close }) => (
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="workflow_action" />
          <input type="hidden" name="id" value={order.id} />
          <input type="hidden" name="actionCode" value={transition.action_code} />
          {transition.action_code === "dispatch" && (
            <div className="alert warning workflow-confirm-warning">
              <strong>确认后订单将进入已派单状态</strong>
              <span>系统不会强制要求准备阶段全部完成；派单后可先办理国内提货运输，出境发运须在配载或直装、装车出库完成后开始。</span>
            </div>
          )}
          <label className="field">
            <span>下一处理人</span>
            <select name="assigneeUserId" required>
              <option value="">请选择</option>
              {members.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.display_name}
                  {x.department_name ? ` · ${x.department_name}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>流转备注</span>
            <textarea name="notes" rows={3} maxLength={500} />
          </label>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={close}>
              返回
            </button>
            <button className="primary" disabled={busy}>
              确认{transition.action_name}
            </button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
type CargoImageDraft = CargoImagePayload;
type CargoDraft = {
  id: string;
  name: string;
  nameEn: string;
  hsCode: string;
  overseasHsCode: string;
  packageType: string;
  packageCount: number;
  piecesPerPackage: number;
  weight: number;
  netWeight: number;
  length: number;
  width: number;
  height: number;
  volume: number;
  declaredValue: number;
  currency: string;
  originCountry: string;
  brandModel: string;
  marks: string;
  specialAttributes: string;
  notes: string;
  images: CargoImageDraft[];
};
const emptyCargo = (): CargoDraft => ({
  id: crypto.randomUUID(),
  name: "",
  nameEn: "",
  hsCode: "",
  overseasHsCode: "",
  packageType: "carton",
  packageCount: 1,
  piecesPerPackage: 1,
  weight: 0,
  netWeight: 0,
  length: 0,
  width: 0,
  height: 0,
  volume: 0,
  declaredValue: 0,
  currency: "USD",
  originCountry: "",
  brandModel: "",
  marks: "",
  specialAttributes: "",
  notes: "",
  images: [],
});
function CreateOrder({
  data,
  busy,
  formError,
}: {
  data: Route.ComponentProps["loaderData"];
  busy: boolean;
  formError?: string;
}) {
  const [cargoRows, setCargoRows] = useState<CargoDraft[]>([]),
    [cargoDraft, setCargoDraft] = useState<CargoDraft | null>(null),
    [cargoImageError, setCargoImageError] = useState(""),
    [cargoImagesBusy, setCargoImagesBusy] = useState(false),
    [submitError, setSubmitError] = useState(""),
    [shipperCustomerId, setShipperCustomerId] = useState(""),
    [pickupAddressId, setPickupAddressId] = useState(""),
    [shipperContact, setShipperContact] = useState(""),
    [shipperPhone, setShipperPhone] = useState(""),
    [originAddress, setOriginAddress] = useState(""),
    [pickupAddressOpen, setPickupAddressOpen] = useState(false),
    [workflowTemplateId, setWorkflowTemplateId] = useState(data.defaultWorkflowId),
    [selectedQuotationId,setSelectedQuotationId]=useState(""),
    [customerId,setCustomerId]=useState(""),
    [instructions,setInstructions]=useState("");
  const templateFields = data.workflowFields.filter((field) => field.workflowId === workflowTemplateId);
  const fieldMode = (fieldKey: string) => templateFields.find((field) => field.fieldKey === fieldKey)?.mode ?? "hidden";
  const shows = (fieldKey: string) => fieldMode(fieldKey) !== "hidden";
  const requires = (fieldKey: string) => fieldMode(fieldKey) === "required";
  const selectedPickupAddress = data.pickupAddresses.find((item) => item.id === pickupAddressId);
  const selectedQuotation=data.quotes.find((item)=>item.id===selectedQuotationId);
  const quoteProvince=(country:string,city:string)=>data.cities.find((item)=>item.name===city&&data.provinces.some((province)=>province.code===item.parent_code&&province.parent_code===country))?.parent_code||"";
  const pickupAddressOptions = data.pickupAddresses.filter((item) => item.customer_id === shipperCustomerId);
  useModalScrollLock(Boolean(cargoDraft));
  const updateCargo = (key: keyof CargoDraft, value: string | number) =>
    setCargoDraft((row) => (row ? { ...row, [key]: value } : row));
  const cargoDraftHasRequiredValues = (row: CargoDraft) =>
    templateFields
      .filter(
        (field) =>
          field.moduleCode === "cargo" &&
          field.isActive &&
          field.isRequired &&
          field.isBuiltIn,
      )
      .every((field) => cargoWorkflowValuePresent(row, field.fieldKey));
  const saveCargo = () => {
    if (
      !cargoDraft ||
      !cargoDraftHasRequiredValues(cargoDraft) ||
      cargoDraft.packageCount < 1 ||
      cargoDraft.piecesPerPackage < 1
    )
      return;
    const normalizedCargo = {
      ...cargoDraft,
      name: cargoDraft.name.trim() || "待补录货物",
      packageType: cargoDraft.packageType || "other",
    };
    setCargoRows((rows) =>
      rows.some((x) => x.id === cargoDraft.id)
        ? rows.map((x) => (x.id === cargoDraft.id ? normalizedCargo : x))
        : [...rows, normalizedCargo],
    );
    setCargoDraft(null);
  };
  const selectQuotation=(quotationId:string)=>{
    setSelectedQuotationId(quotationId);
    const quote=data.quotes.find((item)=>item.id===quotationId);
    if(!quote){setCustomerId("");setShipperCustomerId("");setPickupAddressId("");setCargoRows([]);setInstructions("");return;}
    const matchingWorkflow=data.workflowTemplates.find((template)=>template.road_load_type===quote.road_load_type);
    if(matchingWorkflow) setWorkflowTemplateId(matchingWorkflow.id);
    setCustomerId(quote.customer_id);
    setShipperCustomerId(quote.customer_id);
    setPickupAddressId("");
    setShipperContact("");
    setShipperPhone("");
    setOriginAddress("");
    setInstructions(quote.notes||"");
    setCargoRows([{...emptyCargo(),name:quote.cargo_description,packageType:"other",packageCount:1,piecesPerPackage:Math.max(1,quote.pieces),weight:quote.gross_weight_kg,volume:quote.volume_cbm,currency:quote.currency}]);
  };
  const addCargoImages = async (files: FileList | null) => {
    if (!files || !cargoDraft) return;
    setCargoImageError("");
    const selected = [...files];
    if (cargoDraft.images.length + selected.length > MAX_CARGO_IMAGES_PER_ITEM) {
      setCargoImageError(`每条货物最多上传 ${MAX_CARGO_IMAGES_PER_ITEM} 张图片`);
      return;
    }
    if (
      selected.some(
        (file) =>
          !cargoImageSourceTypes.has(file.type) ||
          file.size > MAX_CARGO_IMAGE_SOURCE_BYTES,
      )
    ) {
      setCargoImageError("仅支持 JPG、PNG 或 WebP，原图单张不能超过 10 MB");
      return;
    }
    setCargoImagesBusy(true);
    try {
      const images = await Promise.all(selected.map(fileToCargoImage));
      setCargoDraft((row) =>
        row ? { ...row, images: [...row.images, ...images] } : row,
      );
    } catch (error) {
      setCargoImageError(
        error instanceof Error
          ? error.message
          : "图片压缩失败，请更换图片后重试",
      );
    } finally {
      setCargoImagesBusy(false);
    }
  };
  return (
    <Form
      method="post"
      encType="multipart/form-data"
      className="order-create-form"
      onSubmit={(event) => {
        const form = new FormData(event.currentTarget);
        if (!form.get("quotationId")) {
          event.preventDefault();
          setSubmitError("请选择已接受报价；订单类型与应收费用将从报价自动继承");
          return;
        }
        setSubmitError("");
      }}
    >
      <input type="hidden" name="intent" value="create" />
      {(submitError || formError) && (
        <div className="alert error span-2" role="alert" aria-live="polite">
          {submitError || formError}
        </div>
      )}
      {!data.overseasWarehouses.length && (
        <div className="alert error span-2">
          创建订单前需要先维护 <Link to="/admin/warehouses">境外目的仓</Link>。
        </div>
      )}
      <section className="order-create-template-row">
        <label className="field">
          <span>工作流模板</span>
          <select
            name="workflowTemplateId"
            value={workflowTemplateId}
            onChange={(event) => setWorkflowTemplateId(event.target.value)}
          >
            <option value={data.defaultWorkflowId}>使用默认订单流程</option>
            {!data.workflowTemplates.length && (
              <option value="">请先在业务工作流中启用模板</option>
            )}
            {data.workflowTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.road_load_type==="ftl"?"整车型":"拼车型"} · {template.name} · {template.step_count} 节点 · {template.field_count} 字段
              </option>
            ))}
          </select>
          <small>订单流程由已接受报价中的整车/拼车方案自动确定。</small>
        </label>
        <div className="workflow-create-field-summary">
          <strong>{templateFields.filter((field) => field.isActive && field.isRequired).length} 项必填</strong>
          <span>{templateFields.filter((field) => field.isActive && !field.isRequired).length} 项选填</span>
          <span>{templateFields.filter((field) => !field.isActive).length} 项不显示</span>
          <small>红色 * 为必填，切换模板后表单立即变化。</small>
        </div>
      </section>
      <section className="order-create-section">
        <header><strong>1. 订单基础</strong><span>报价、客户、接单日期与业务性质</span></header>
        <div className="order-create-table-grid">
      {shows("quotation_id") && <label className="field"><span>已接受报价<b className="required-mark">*</b></span><select name="quotationId" value={selectedQuotationId} onChange={(event)=>selectQuotation(event.target.value)} required><option value="">请选择已接受报价</option>{data.quotes.map((q)=><option key={q.id} value={q.id}>{q.quote_number} · {q.road_load_type==="ftl"?"整车":"拼车"} · {q.customer_name} · {q.currency} {q.total_amount.toLocaleString()}</option>)}</select>{selectedQuotation&&<small>已继承{selectedQuotation.road_load_type==="ftl"?"整车":"拼车"}方案、客户、路线、货物、应收费用及报价备注。</small>}</label>}
      {shows("customer_id") && <label className="field"><span>客户{requires("customer_id")&&<b className="required-mark">*</b>}</span><select name="customerId" value={customerId} onChange={(event)=>{const id=event.target.value;setCustomerId(id);setShipperCustomerId(id);setPickupAddressId("");setShipperContact("");setShipperPhone("");setOriginAddress("");}} disabled={Boolean(selectedQuotationId)} required={requires("customer_id")&&!selectedQuotationId}><option value="">{selectedQuotationId?"已由报价自动确定":"请选择"}</option>{data.customers.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{selectedQuotationId&&<input type="hidden" name="customerId" value={customerId}/>}</label>}
      {shows("order_date") && <label className="field">
        <span>接单日期{requires("order_date") && <b className="required-mark">*</b>}</span>
        <input
          name="orderDate"
          type="date"
          defaultValue={new Date().toISOString().slice(0, 10)}
          required={requires("order_date")}
        />
      </label>}
      {shows("business_nature") && <Sel
        label="业务性质"
        name="businessNature"
        defaultValue="export"
        optional={!requires("business_nature")}
        items={[
          ["export", "出口"],
          ["import", "进口"],
          ["transit", "过境"],
          ["domestic", "国内"],
        ]}
      />}
        </div>
      </section>
      <section className="order-create-section">
        <header><strong>2. 提货信息</strong><span>发货方、联系方式与国内提货地</span></header>
        <div className="order-create-table-grid">
      {(shows("shipper_customer_id") || shows("shipper_contact") || shows("shipper_phone")) && <div className="field order-party-field">
        <span>发货方{requires("shipper_customer_id") && <b className="required-mark">*</b>}</span>
        <div className="order-party-controls">
          {shows("shipper_customer_id") && <select name="shipperCustomerId" value={shipperCustomerId} onChange={(event) => {
            setShipperCustomerId(event.target.value);
            setPickupAddressId("");
            setPickupAddressOpen(false);
            setShipperContact("");
            setShipperPhone("");
            setOriginAddress("");
          }} required={requires("shipper_customer_id")}>
            <option value="">请选择发货方</option>
            {data.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>}
          {shows("shipper_contact") && <input name="shipperContact" placeholder={`发货联系人${requires("shipper_contact") ? " *" : ""}`} value={shipperContact} onChange={(event) => setShipperContact(event.target.value)} required={requires("shipper_contact")} />}
          {shows("shipper_phone") && <input name="shipperPhone" placeholder={`联系电话${requires("shipper_phone") ? " *" : ""}`} value={shipperPhone} onChange={(event) => setShipperPhone(event.target.value)} required={requires("shipper_phone")} />}
        </div>
      </div>}
      {(shows("pickup_address_id") || shows("origin_address")) && <div className="field span-2 order-address-field">
        <span>提货地址{requires("origin_address") && <b className="required-mark">*</b>}</span>
        <input type="hidden" name="pickupAddressId" value={pickupAddressId} />
        <div className={`order-address-combobox${pickupAddressOpen ? " open" : ""}`}>
          <input
            name="originAddress"
            value={originAddress}
            onChange={(event) => {
              setOriginAddress(event.target.value);
              setPickupAddressId("");
            }}
            placeholder="手动填写提货地址"
            required={requires("origin_address")}
            autoComplete="off"
          />
          <button
            type="button"
            className="order-address-toggle"
            aria-label="展开常用提货地"
            aria-expanded={pickupAddressOpen}
            onClick={() => setPickupAddressOpen((open) => !open)}
          >
            <span aria-hidden="true">▾</span>
          </button>
          {pickupAddressOpen && <div className="order-address-options">
            {!shipperCustomerId ? (
              <p>请先选择发货方，或直接在上方手动填写地址。</p>
            ) : pickupAddressOptions.length ? (
              pickupAddressOptions.map((address) => (
                <button key={address.id} type="button" onClick={() => {
                  setPickupAddressId(address.id);
                  setShipperContact(address.contact_name || "");
                  setShipperPhone(address.contact_phone || "");
                  setOriginAddress([address.address_line1, address.address_line2].filter(Boolean).join(" "));
                  setPickupAddressOpen(false);
                }}>
                  <strong>{address.label}{address.is_default ? " · 默认" : ""}</strong>
                  <span>{[address.city, address.address_line1, address.address_line2].filter(Boolean).join(" ")}</span>
                </button>
              ))
            ) : (
              <p>该发货方暂无常用提货地，可直接在上方手动填写。</p>
            )}
          </div>}
        </div>
        <small>直接输入地址，或点击右侧箭头从发货方地址簿选择。</small>
      </div>}
      {(shows("origin_country") || shows("origin_state") || shows("origin_city")) && <GeographicFields
        key={`origin-${selectedQuotationId}-${shipperCustomerId}-${pickupAddressId}`}
        prefix="origin"
        label="起运"
        countries={data.countries}
        provinces={data.provinces}
        cities={data.cities}
        initialCountry={selectedQuotation?.origin_country||selectedPickupAddress?.country_code}
        initialProvince={selectedQuotation?quoteProvince(selectedQuotation.origin_country,selectedQuotation.origin_city):(selectedPickupAddress?.state ?? undefined)}
        initialCity={selectedQuotation?.origin_city||selectedPickupAddress?.city}
        required={requires("origin_country") || requires("origin_state") || requires("origin_city")}
      />}
        </div>
      </section>
      <section className="order-create-section">
        <header><strong>3. 收货与目的地</strong><span>收货联系人、送货地址与境外目的仓</span></header>
        <div className="order-create-table-grid">
      {(shows("consignee_contact") || shows("consignee_phone")) && <div className="field order-party-field">
        <span>收货联系人</span>
        <div className="order-party-controls">
          {shows("consignee_contact") && <input name="consigneeContact" placeholder={`收货联系人${requires("consignee_contact") ? " *" : ""}`} required={requires("consignee_contact")} />}
          {shows("consignee_phone") && <input name="consigneePhone" placeholder={`联系电话${requires("consignee_phone") ? " *" : ""}`} required={requires("consignee_phone")} />}
        </div>
      </div>}
      {(shows("destination_country") || shows("destination_state") || shows("destination_city")) && <GeographicFields
        key={`destination-${selectedQuotationId}`}
        prefix="destination"
        label="目的"
        countries={data.countries}
        provinces={data.provinces}
        cities={data.cities}
        initialCountry={selectedQuotation?.destination_country}
        initialProvince={selectedQuotation?quoteProvince(selectedQuotation.destination_country,selectedQuotation.destination_city):""}
        initialCity={selectedQuotation?.destination_city}
        required={requires("destination_country") || requires("destination_state") || requires("destination_city")}
      />}
      {shows("destination_address") && <label className="field">
        <span>送货地址{requires("destination_address") && <b className="required-mark">*</b>}</span>
        <textarea name="destinationAddress" rows={3} required={requires("destination_address")} />
      </label>}
      {(shows("overseas_warehouse_id")||shows("overseas_warehouse_address_note")) && <div className="field order-warehouse-field">
        <span>境外目的仓{requires("overseas_warehouse_id") && <b className="required-mark">*</b>}</span>
        {shows("overseas_warehouse_id")&&<select name="overseasWarehouseId" required={requires("overseas_warehouse_id")}>
          <option value="">请选择启用的境外目的仓</option>
          {data.overseasWarehouses.map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.name} · {[warehouse.country_code, warehouse.city].filter(Boolean).join(" ") || warehouse.code}
            </option>
          ))}
        </select>}
        {shows("overseas_warehouse_address_note")&&<textarea
          name="overseasWarehouseAddressNote"
          rows={3}
          placeholder="可补充门牌、联系人、提货窗口等订单专属说明"
        />}
      </div>}
      {shows("document_consignment_letter") && <label className="field span-2">
        <span>委托书 / 委托单上传{requires("document_consignment_letter") && <b className="required-mark">*</b>}</span>
        <input
          type="file"
          name="consignmentLetter"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          required={requires("document_consignment_letter")}
        />
        <small>必填：客户签字确认的运输委托书，或客户直接发来的委托单/委托函（PDF / 图片）。文件 ≤ 5MB，新建订单时与发货、收货、目的仓一起提交。</small>
      </label>}
        </div>
      </section>
      {templateFields.some((field) => field.moduleCode === "cargo" && field.isActive) && <section className="cargo-entry order-create-section">
        <div className="cargo-entry-header">
          <div>
            <strong>4. 货物信息</strong>
            <small>
              按相同规格包装分行录入，系统自动汇总并生成每箱/托盘编号。
            </small>
          </div>
          <button
            type="button"
            className="cargo-add-button"
            onClick={() => setCargoDraft(emptyCargo())}
          >
            新增货物
          </button>
        </div>
        {cargoRows.map(cargoHiddenInputs)}
        <div className="table-wrap cargo-entry-table">
          <table>
            <thead>
              <tr>
                <th>品名 / HS Code</th>
                <th>包装</th>
                <th>件数</th>
                <th>单包装毛重</th>
                <th>尺寸 / 体积</th>
                <th>图片</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {cargoRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                    <small>
                      {row.nameEn || "—"} · {row.hsCode || "无 HS Code"}
                    </small>
                  </td>
                  <td>
                    {packageLabels[row.packageType] || row.packageType} ×{" "}
                    {row.packageCount}
                  </td>
                  <td>{row.packageCount * row.piecesPerPackage}</td>
                  <td>{row.weight} KG</td>
                  <td>
                    {row.length}×{row.width}×{row.height} cm
                    <small>
                      {effectiveCargoVolume(row).toFixed(4)} CBM/包装
                    </small>
                  </td>
                  <td>
                    {row.images.length ? (
                      <div className="cargo-table-images">
                        {row.images.slice(0, 3).map((image, index) => (
                          <img
                            key={`${image.name}-${index}`}
                            src={image.dataUrl}
                            alt={image.name}
                          />
                        ))}
                        {row.images.length > 3 && (
                          <span>+{row.images.length - 3}</span>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setCargoDraft({ ...row })}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="text-button danger"
                        onClick={() =>
                          setCargoRows((rows) =>
                            rows.filter((x) => x.id !== row.id),
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!cargoRows.length && (
            <p className="empty-state">暂无货物，点击“新增货物”录入品名、包装、件数、重量和体积。</p>
          )}
        </div>
      </section>}
      <section className="order-create-section">
        <header><strong>5. 时间与备注</strong><span>提货计划、货好时间、送达要求与补充说明</span></header>
        <div className="order-create-table-grid">
      {shows("requested_pickup_date") && <label className="field">
        <span>预约提货时间{requires("requested_pickup_date") && <b className="required-mark">*</b>}</span>
        <input name="pickupDate" type="datetime-local" required={requires("requested_pickup_date")} />
      </label>}
      {shows("cargo_ready_at") && <label className="field">
        <span>货好时间{requires("cargo_ready_at") && <b className="required-mark">*</b>}</span>
        <input name="cargoReadyAt" type="datetime-local" required={requires("cargo_ready_at")} />
        <small>选填，用于操作员判断提货准备情况，不作为提交审批门禁。</small>
      </label>}
      {shows("ro_agent") && <label className="field">
        <span>RO 代理{requires("ro_agent") && <b className="required-mark">*</b>}</span>
        <input name="roAgent" placeholder="选填，填写代理名称或联系人" required={requires("ro_agent")} />
      </label>}
      {shows("requested_delivery_date") && <label className="field">
        <span>要求送达日{requires("requested_delivery_date") && <b className="required-mark">*</b>}</span>
        <input name="deliveryDate" type="date" required={requires("requested_delivery_date")} />
      </label>}
      {shows("special_instructions") && <label className="field span-2">
        <span>备注{requires("special_instructions") && <b className="required-mark">*</b>}</span>
        <textarea name="instructions" rows={4} value={instructions} onChange={(event)=>setInstructions(event.target.value)} required={requires("special_instructions")} />
      </label>}
        </div>
      </section>
      {templateFields.some(
        (field) =>
          field.stepKey === "order_creation" &&
          field.isActive &&
          !field.isBuiltIn,
      ) && (
        <section className="workflow-custom-creation-fields order-create-section">
          <header>
            <strong>模板补充字段</strong>
            <small>这些字段由当前工作流模板定义，保存后随订单冻结。</small>
          </header>
          <div className="order-create-table-grid">
            {templateFields
              .filter(
                (field) =>
                  field.stepKey === "order_creation" &&
                  field.isActive &&
                  !field.isBuiltIn,
              )
              .map((field) => (
                <WorkflowCreationCustomField key={field.id} field={field} />
              ))}
          </div>
        </section>
      )}
      <footer className="order-create-submit-bar">
        <span>保存后订单进入资料录入，由工作流控制后续节点。</span>
        <button
          className="primary"
          disabled={
            busy ||
            (templateFields.some((field) => field.moduleCode === "cargo" && field.isActive && field.isRequired) && !cargoRows.length) ||
            (requires("overseas_warehouse_id") && !data.overseasWarehouses.length)
          }
        >
          创建订单
        </button>
      </footer>
      {cargoDraft && (
        <div
          className="modal-backdrop cargo-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCargoDraft(null);
          }}
          onWheel={(event) => {
            const scrollBody = event.currentTarget.querySelector<HTMLElement>(
              ":scope > .modal-card > .modal-body",
            );
            if (!scrollBody || scrollBody.scrollHeight <= scrollBody.clientHeight)
              return;
            event.preventDefault();
            event.stopPropagation();
            scrollBody.scrollTop += event.deltaY;
          }}
        >
          <section className="modal-card wide" role="dialog" aria-modal="true">
            <header className="modal-header">
              <h2>
                {cargoRows.some((x) => x.id === cargoDraft.id)
                  ? "编辑货物"
                  : "新增货物"}
              </h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setCargoDraft(null)}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              <div className="cargo-entry-fields dialog-fields">
                {shows("cargo_name_cn") && <CargoInput
                  label="中文品名"
                  value={cargoDraft.name}
                  onChange={(v) => updateCargo("name", v)}
                  required={requires("cargo_name_cn")}
                />}
                {shows("cargo_name_en") && <CargoInput
                  label="英文品名"
                  value={cargoDraft.nameEn}
                  onChange={(v) => updateCargo("nameEn", v)}
                  required={requires("cargo_name_en")}
                />}
                {shows("hs_code") && <CargoInput
                  label="HS Code"
                  value={cargoDraft.hsCode}
                  onChange={(v) => updateCargo("hsCode", v)}
                  required={requires("hs_code")}
                />}
                {shows("overseas_hs_code") && <CargoInput
                  label="境外 HS Code"
                  value={cargoDraft.overseasHsCode}
                  onChange={(v) => updateCargo("overseasHsCode", v)}
                  required={requires("overseas_hs_code")}
                />}
                {shows("package_type") && <label>
                  <span>包装类型{requires("package_type") && <b className="required-mark">*</b>}</span>
                  <select
                    value={cargoDraft.packageType}
                    onChange={(e) => updateCargo("packageType", e.target.value)}
                    required={requires("package_type")}
                  >
                    {Object.entries(packageLabels).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>}
                {shows("package_count") && <CargoNumber
                  label="包装数量"
                  value={cargoDraft.packageCount}
                  onChange={(v) => updateCargo("packageCount", v)}
                  min={1}
                  required={requires("package_count")}
                />}
                {shows("pieces_per_package") && <CargoNumber
                  label="每包装件数"
                  value={cargoDraft.piecesPerPackage}
                  onChange={(v) => updateCargo("piecesPerPackage", v)}
                  min={1}
                  required={requires("pieces_per_package")}
                />}
                {shows("gross_weight_per_package_kg") && <CargoNumber
                  label="单包装毛重 KG"
                  value={cargoDraft.weight}
                  onChange={(v) => updateCargo("weight", v)}
                  step="0.001"
                  required={requires("gross_weight_per_package_kg")}
                />}
                {shows("net_weight_per_package_kg") && <CargoNumber
                  label="单包装净重 KG"
                  value={cargoDraft.netWeight}
                  onChange={(v) => updateCargo("netWeight", v)}
                  step="0.001"
                  required={requires("net_weight_per_package_kg")}
                />}
                {shows("length_cm") && <CargoNumber
                  label="长 cm"
                  value={cargoDraft.length}
                  onChange={(v) => updateCargo("length", v)}
                  step="0.1"
                  required={requires("length_cm")}
                />}
                {shows("width_cm") && <CargoNumber
                  label="宽 cm"
                  value={cargoDraft.width}
                  onChange={(v) => updateCargo("width", v)}
                  step="0.1"
                  required={requires("width_cm")}
                />}
                {shows("height_cm") && <CargoNumber
                  label="高 cm"
                  value={cargoDraft.height}
                  onChange={(v) => updateCargo("height", v)}
                  step="0.1"
                  required={requires("height_cm")}
                />}
                {shows("volume_per_package_cbm") && <CargoNumber
                  label="单包装体积 CBM"
                  value={cargoDraft.volume}
                  onChange={(v) => updateCargo("volume", v)}
                  step="0.0001"
                  required={requires("volume_per_package_cbm")}
                />}
                {shows("declared_value") && <CargoNumber
                  label="申报货值"
                  value={cargoDraft.declaredValue}
                  onChange={(v) => updateCargo("declaredValue", v)}
                  step="0.01"
                  required={requires("declared_value")}
                />}
                {shows("currency") && <label>
                  <span>货值币种{requires("currency") && <b className="required-mark">*</b>}</span>
                  <select value={cargoDraft.currency} onChange={(event) => updateCargo("currency", event.target.value)} required={requires("currency")}>
                    {["CNY", "USD", "KZT", "UZS", "RUB"].map((currency) => <option key={currency}>{currency}</option>)}
                  </select>
                </label>}
                {shows("origin_country_cargo") && <CargoInput label="货物原产国" value={cargoDraft.originCountry} onChange={(v) => updateCargo("originCountry", v)} required={requires("origin_country_cargo")} />}
                {shows("brand_model") && <CargoInput label="品牌 / 型号" value={cargoDraft.brandModel} onChange={(v) => updateCargo("brandModel", v)} required={requires("brand_model")} />}
                {shows("marks") && <CargoInput label="唛头" value={cargoDraft.marks} onChange={(v) => updateCargo("marks", v)} required={requires("marks")} />}
                {shows("special_attributes") && <CargoInput label="货物属性" value={cargoDraft.specialAttributes} onChange={(v) => updateCargo("specialAttributes", v)} required={requires("special_attributes")} />}
                {shows("cargo_notes") && <label><span>货物备注{requires("cargo_notes") && <b className="required-mark">*</b>}</span><textarea value={cargoDraft.notes} onChange={(event) => updateCargo("notes", event.target.value)} required={requires("cargo_notes")} rows={3} /></label>}
                <div className="cargo-volume-preview">
                  <span>计算体积</span>
                  <strong>
                    {effectiveCargoVolume(cargoDraft).toFixed(4)} CBM/包装
                  </strong>
                  <small>体积为 0 时按长×宽×高计算</small>
                </div>
                {shows("cargo_images") && <div className="cargo-image-field">
                  <div className="cargo-image-heading">
                    <span>货物图片</span>
                    <label className="secondary upload-image-button">
                      ＋ 选择图片
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        disabled={cargoImagesBusy}
                        onChange={(event) => {
                          void addCargoImages(event.target.files);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  <small>
                    最多 5 张，支持 JPG/PNG/WebP；原图不超过 10 MB，系统会自动压缩后保存
                  </small>
                  {cargoImagesBusy && <p className="field-help">正在压缩图片，请稍候…</p>}
                  {cargoImageError && (
                    <p className="field-error">{cargoImageError}</p>
                  )}
                  <div className="cargo-image-preview">
                    {cargoDraft.images.map((image, index) => (
                      <figure key={`${image.name}-${index}`}>
                        <img src={image.dataUrl} alt={image.name} />
                        <figcaption title={image.name}>{image.name}</figcaption>
                        <button
                          type="button"
                          aria-label={`删除 ${image.name}`}
                          onClick={() =>
                            setCargoDraft((row) =>
                              row
                                ? {
                                    ...row,
                                    images: row.images.filter(
                                      (_, i) => i !== index,
                                    ),
                                  }
                                : row,
                            )
                          }
                        >
                          ×
                        </button>
                      </figure>
                    ))}
                  </div>
                </div>}
              </div>
              <footer className="dialog-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCargoDraft(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    cargoImagesBusy ||
                    !cargoDraftHasRequiredValues(cargoDraft) ||
                    cargoDraft.packageCount < 1 ||
                    cargoDraft.piecesPerPackage < 1
                  }
                  onClick={saveCargo}
                >
                  保存货物
                </button>
              </footer>
            </div>
          </section>
        </div>
      )}
    </Form>
  );
}

function workflowCustomInputName(field: Pick<WorkflowFieldRule, "id">) {
  return `workflowCustom:${field.id}`;
}

function WorkflowCreationCustomField({ field }: { field: WorkflowFieldRule }) {
  const name = workflowCustomInputName(field);
  const label = (
    <span>
      {field.label}
      {field.isRequired && <b className="required-mark">*</b>}
    </span>
  );
  const help = field.helpText ? <small>{field.helpText}</small> : null;
  const options = (field.optionsText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, text] = line.split("|");
      return [value, text || value] as const;
    });
  if (field.fieldType === "textarea" || field.fieldType === "multiselect")
    return (
      <label className="field span-2">
        {label}
        <textarea
          name={name}
          rows={3}
          required={field.isRequired}
          placeholder={
            field.fieldType === "multiselect" ? "多项内容用逗号分隔" : undefined
          }
        />
        {help}
      </label>
    );
  if (field.fieldType === "select" && options.length)
    return (
      <label className="field">
        {label}
        <select name={name} required={field.isRequired} defaultValue="">
          <option value="">请选择</option>
          {options.map(([value, text]) => (
            <option key={value} value={value}>{text}</option>
          ))}
        </select>
        {help}
      </label>
    );
  const inputType =
    field.fieldType === "date"
      ? "date"
      : field.fieldType === "datetime"
        ? "datetime-local"
        : ["number", "amount"].includes(field.fieldType)
          ? "number"
          : "text";
  return (
    <label className="field">
      {label}
      <input
        name={name}
        type={inputType}
        step={field.fieldType === "amount" ? "0.01" : inputType === "number" ? "any" : undefined}
        required={field.isRequired}
      />
      {help}
    </label>
  );
}
const packageLabels: Record<string, string> = {
  carton: "纸箱",
  pallet: "托盘",
  wooden_case: "木箱",
  wooden_frame: "木架",
  bag: "袋",
  bare: "裸件",
  other: "其他",
};
function effectiveCargoVolume(row: CargoDraft | Omit<CargoDraft, "id">) {
  return row.volume || (row.length * row.width * row.height) / 1_000_000;
}

async function toDataUrl(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${file.type};base64,${btoa(binary)}`;
}

function cargoHiddenInputs(row: CargoDraft) {
  return (
    <span className="hidden-cargo-inputs" key={`hidden-${row.id}`}>
      <input type="hidden" name="cargoName" value={row.name} />
      <input type="hidden" name="cargoNameEn" value={row.nameEn} />
      <input type="hidden" name="cargoHsCode" value={row.hsCode} />
      <input type="hidden" name="cargoOverseasHsCode" value={row.overseasHsCode} />
      <input type="hidden" name="cargoPackageType" value={row.packageType} />
      <input type="hidden" name="cargoPackageCount" value={row.packageCount} />
      <input
        type="hidden"
        name="cargoPiecesPerPackage"
        value={row.piecesPerPackage}
      />
      <input type="hidden" name="cargoWeight" value={row.weight} />
      <input type="hidden" name="cargoNetWeight" value={row.netWeight} />
      <input type="hidden" name="cargoLength" value={row.length} />
      <input type="hidden" name="cargoWidth" value={row.width} />
      <input type="hidden" name="cargoHeight" value={row.height} />
      <input type="hidden" name="cargoVolume" value={row.volume} />
      <input type="hidden" name="cargoDeclaredValue" value={row.declaredValue} />
      <input type="hidden" name="cargoCurrency" value={row.currency} />
      <input type="hidden" name="cargoOriginCountry" value={row.originCountry} />
      <input type="hidden" name="cargoBrandModel" value={row.brandModel} />
      <input type="hidden" name="cargoMarks" value={row.marks} />
      <input type="hidden" name="cargoSpecialAttributes" value={row.specialAttributes} />
      <input type="hidden" name="cargoNotes" value={row.notes} />
      <input
        type="hidden"
        name="cargoImages"
        value={JSON.stringify(row.images)}
      />
    </span>
  );
}
async function fileToCargoImage(file: File): Promise<CargoImageDraft> {
  if (
    file.size <= MAX_CARGO_IMAGE_STORED_BYTES &&
    cargoImageSourceTypes.has(file.type)
  )
    return cargoBlobToPayload(file, file.name);

  const image = await loadCargoImage(file);
  let scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  let smallest: Blob | null = null;
  for (let resizeAttempt = 0; resizeAttempt < 5; resizeAttempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法压缩图片，请更换图片后重试");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.7, 0.58, 0.46]) {
      const blob = await canvasToCargoBlob(canvas, quality);
      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= MAX_CARGO_IMAGE_STORED_BYTES)
        return cargoBlobToPayload(blob, cargoImageName(file.name, blob.type));
    }
    scale *= 0.78;
  }
  if (smallest && smallest.size <= MAX_CARGO_IMAGE_STORED_BYTES)
    return cargoBlobToPayload(
      smallest,
      cargoImageName(file.name, smallest.type),
    );
  throw new Error("图片内容过于复杂，自动压缩后仍然过大，请降低分辨率后重试");
}

function loadCargoImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片无法读取，请更换图片后重试"));
    };
    image.src = url;
  });
}

function canvasToCargoBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("图片压缩失败，请更换图片后重试")),
      "image/webp",
      quality,
    ),
  );
}

function cargoBlobToPayload(blob: Blob, name: string) {
  return new Promise<CargoImageDraft>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ name, type: blob.type, size: blob.size, dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择"));
    reader.readAsDataURL(blob);
  });
}

function cargoImageName(original: string, type: string) {
  const base = original.replace(/\.[^.]+$/, "") || "cargo";
  return `${base}.${type === "image/webp" ? "webp" : "jpg"}`;
}
function CargoInput({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function CargoNumber({
  label,
  value,
  onChange,
  min = 0,
  step = "1",
  required = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: string;
  required?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        required={required}
        onWheel={(event) => event.currentTarget.blur()}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}
function Pagination({
  page,
  pages,
  filters,
  pageSize,
}: {
  page: number;
  pages: number;
  filters: { q: string; status: string; step: string; assignee: string };
  pageSize: number;
}) {
  const link = (p: number) =>
    `?${new URLSearchParams({ ...filters, page: String(p), pageSize: String(pageSize) }).toString()}`;
  return (
    <footer className="pagination">
      <span>
        第 {page} / {pages} 页
      </span>
      <div>
        {page > 1 && (
          <Link className="secondary" to={link(page - 1)}>
            上一页
          </Link>
        )}
        {page < pages && (
          <Link className="secondary" to={link(page + 1)}>
            下一页
          </Link>
        )}
      </div>
    </footer>
  );
}
function uniqueSteps(transitions: OrderWorkflowTransition[]) {
  const map = new Map<string, string>([["draft", "草稿"]]);
  for (const x of transitions) map.set(x.target_step_code, x.target_step_name);
  return [...map].map(([code, name]) => ({ code, name }));
}
function GeographicFields({
  prefix,
  label,
  countries,
  provinces,
  cities,
  initialCountry = "",
  initialProvince = "",
  initialCity = "",
  required = true,
}: {
  prefix: "origin" | "destination";
  label: string;
  countries: GeoReference[];
  provinces: GeoReference[];
  cities: GeoReference[];
  initialCountry?: string;
  initialProvince?: string;
  initialCity?: string;
  required?: boolean;
}) {
  const [country, setCountry] = useState(initialCountry);
  const [province, setProvince] = useState(initialProvince);
  const [city, setCity] = useState(initialCity);
  const availableProvinces = provinces.filter(
    (item) => item.parent_code === country,
  );
  const availableCities = cities.filter(
    (item) => item.parent_code === province,
  );
  return (
    <div className="field geographic-field-group">
      <span>{label}国家 / 省州 / 城市{required&&<b className="required-mark">*</b>}</span>
      <div className="geographic-field-stack">
        <select
          aria-label={`${label}国家`}
          name={`${prefix}Country`}
          value={country}
          onChange={(event) => {
            setCountry(event.target.value);
            setProvince("");
            setCity("");
          }}
          required={required}
        >
          <option value="">请选择国家/地区</option>
          {countries.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}
            </option>
          ))}
        </select>
        
        <select
          aria-label={`${label}省/州`}
          name={`${prefix}State`}
          value={province}
          onChange={(event) => {
            setProvince(event.target.value);
            setCity("");
          }}
          required={required}
          disabled={!country}
        >
          <option value="">{country ? "请选择省/州" : "请先选择国家"}</option>
          {availableProvinces.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}
            </option>
          ))}
        </select>
        <select aria-label={`${label}城市`} name={`${prefix}City`} value={city} onChange={(event) => setCity(event.target.value)} required={required} disabled={!province}>
          <option value="">{province ? "请选择城市" : "请先选择省/州"}</option>
          {availableCities.map((item) => (
            <option key={item.code} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
function Sel({
  label,
  name,
  items,
  optional,
  defaultValue,
}: {
  label: string;
  name: string;
  items: [string, string][];
  optional?: boolean;
  defaultValue?:string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} required={!optional} defaultValue={defaultValue||""}>
        <option value="">{optional ? "未指定" : "请选择"}</option>
        {items.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

function transportModeLabel(code: string, name: string) {
  if (code.toUpperCase() === "ROAD") return "公路运输";
  return name;
}
function Num({
  label,
  name,
  value = "0",
  step = "1",
}: {
  label: string;
  name: string;
  value?: string;
  step?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type="number"
        min="0"
        step={step}
        defaultValue={value}
      />
    </label>
  );
}
