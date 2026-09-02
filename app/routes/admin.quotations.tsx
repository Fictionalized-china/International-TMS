import { env } from "cloudflare:workers";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Route } from "./+types/admin.quotations";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { transportChargeNameOptions } from "../lib/charge-options";
import { nextDocumentNumber } from "../lib/documents.server";
import { recordWorkflowEvent } from "../lib/business-workflow.server";
import {
  acceptQuotation,
  voidQuotation,
  withdrawQuotationAcceptance,
} from "../lib/quotation-lifecycle.server";
import {
  listQuotationWorkflowFields,
  listQuotationWorkflowFieldValues,
  listQuotationWorkflowInstanceFields,
  prepareQuotationWorkflowFieldValues,
  savePreparedQuotationWorkflowFieldValues,
} from "../lib/quotation-workflow-fields.server";
import {
  activeQuotationCustomWorkflowFields,
  parseQuotationWorkflowFieldOptions,
  quotationWorkflowFieldPolicy,
  quotationWorkflowDisplayValue,
  quotationWorkflowFieldHasValue,
  quotationWorkflowFieldInputName,
  type QuotationWorkflowField,
  type QuotationWorkflowFieldValue,
} from "../lib/quotation-workflow-fields";
import {
  quotationNativeFieldKeySet,
  quotationNativeFieldPresent,
  type QuotationNativeFieldKey,
} from "../lib/quotation-native-field-catalog";
import {
  changedQuotationNativeFieldKeys,
  parseQuotationChargeUpdate,
  quotationDetailFacts,
} from "../lib/quotation-edit-safety";
import { requirePositiveInteger, requirePositiveNumber, validatePhone, valueOf } from "../lib/validation";

type Quote = {
  id: string;
  customer_id: string;
  quote_number: string;
  customer_name: string;
  customer_contact_name: string | null;
  customer_contact_phone: string | null;
  salesperson_name: string | null;
  salesperson_user_id: string | null;
  workflow_definition_id: string | null;
  workflow_name: string | null;
  workflow_version_number: number | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  pickup_address: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_warehouse_name: string | null;
  destination_warehouse_id: string | null;
  destination_warehouse_note: string | null;
  customs_clearance_mode: "company" | "customer";
  transport_mode: string;
  road_load_type: "ftl" | "ltl";
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  estimated_length_cm: number;
  estimated_width_cm: number;
  estimated_height_cm: number;
  total_amount: number;
  valid_until: string | null;
  notes: string | null;
  quotation_charge_items: number;
  lifecycle_status: "pending" | "accepted" | "withdrawn" | "void";
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  current_step_code: string | null;
  created_at: string;
};

type QuoteCharge = {
  id: string;
  quotation_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  notes: string | null;
  sort_order: number;
};

type CustomerOption = {
  id: string;
  name: string;
  pickup_address: string | null;
  pickup_country_code: string | null;
  pickup_state_code: string | null;
  pickup_city: string | null;
  contact_name: string | null;
  contact_phone: string | null;
};
type CustomerContactOption = {
  id: string;
  customer_id: string;
  name: string;
  phone: string | null;
  is_primary: number;
};

type UserOption = { id: string; display_name: string; email: string };
type WarehouseOption = { id: string; name: string; country_code: string | null; city: string | null; address: string | null };
type GeoOption = { code: string; name: string; parent_code: string | null };
type WorkflowOption = {
  id: string;
  name: string;
  version_number: number;
  road_load_type: "ftl" | "ltl";
  lifecycle_status: "published" | "retired";
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "quote.view");
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("q") || "").trim();
  const lifecycle = (url.searchParams.get("status") || "").trim();
  const where = ["q.organization_id=?"];
  const binds: unknown[] = [current.organizationId];
  if (keyword) {
    where.push("(q.quote_number LIKE ? OR c.name LIKE ? OR q.cargo_description LIKE ? OR o.order_number LIKE ?)");
    const like = `%${keyword}%`;
    binds.push(like, like, like, like);
  }
  if (["pending", "accepted", "withdrawn", "void"].includes(lifecycle)) {
    where.push("q.lifecycle_status=?");
    binds.push(lifecycle);
  }
  // D1 allows only a small number of concurrent connections per Worker
  // invocation. Load independent lookup groups in bounded waves instead of
  // opening every quotation-page query at once.
  const [quotes, quotationCharges, customers, contacts] = await Promise.all([
    env.DB.prepare(
      `SELECT q.id,q.customer_id,q.quote_number,c.name customer_name,q.customer_contact_name,q.customer_contact_phone,
        q.salesperson_user_id,u.display_name salesperson_name,
        q.workflow_definition_id,wd.name workflow_name,wd.version_number workflow_version_number,
        q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
        q.destination_country,q.destination_state,q.destination_city,
        q.destination_warehouse_id,w.name destination_warehouse_name,q.destination_warehouse_note,q.customs_clearance_mode,
        q.transport_mode,q.road_load_type,q.cargo_description,q.pieces,q.gross_weight_kg,q.volume_cbm,
        q.estimated_length_cm,q.estimated_width_cm,q.estimated_height_cm,q.total_amount,q.valid_until,q.notes,
        (SELECT COUNT(*) FROM quotation_charges qc
         WHERE qc.quotation_id=q.id AND qc.quantity>0 AND qc.unit_price>0) quotation_charge_items,
        q.lifecycle_status,o.id order_id,o.order_number,o.status order_status,o.current_step_code,q.created_at
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id
       LEFT JOIN users u ON u.id=q.salesperson_user_id
       LEFT JOIN workflow_definitions wd ON wd.id=q.workflow_definition_id AND wd.organization_id=q.organization_id
       LEFT JOIN warehouses w ON w.id=q.destination_warehouse_id
       LEFT JOIN transport_orders o ON o.organization_id=q.organization_id AND o.quotation_id=q.id
       WHERE ${where.join(" AND ")}
       ORDER BY q.created_at DESC LIMIT 200`,
    ).bind(...binds).all<Quote>(),
    env.DB.prepare(
      `SELECT id,quotation_id,description,quantity,unit_price,notes,sort_order
       FROM quotation_charges
       WHERE quotation_id IN (
         SELECT id FROM quotations WHERE organization_id=?
       ) ORDER BY quotation_id,sort_order,id`,
    ).bind(current.organizationId).all<QuoteCharge>(),
    env.DB.prepare(
      `SELECT c.id,c.name,
        (SELECT a.address_line1 FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_address,
        (SELECT a.country_code FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_country_code,
        (SELECT a.state FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_state_code,
        (SELECT a.city FROM customer_addresses a WHERE a.customer_id=c.id AND a.type='shipping' ORDER BY a.is_default DESC,a.updated_at DESC,a.created_at DESC LIMIT 1) pickup_city,
        (SELECT cc.name FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1) contact_name,
        (SELECT cc.phone FROM customer_contacts cc WHERE cc.customer_id=c.id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1) contact_phone
       FROM customers c WHERE c.organization_id=? AND c.status='active' ORDER BY c.name`,
    ).bind(current.organizationId).all<CustomerOption>(),
    env.DB.prepare(
      `SELECT cc.id,cc.customer_id,cc.name,cc.phone,cc.is_primary
       FROM customer_contacts cc
       JOIN customers c ON c.id=cc.customer_id
       WHERE c.organization_id=? AND c.status='active'
       ORDER BY cc.customer_id,cc.is_primary DESC,cc.updated_at DESC,cc.name`,
    ).bind(current.organizationId).all<CustomerContactOption>(),
  ]);
  const [users, warehouses, countries, provinces] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id,u.display_name,u.email FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=? AND m.status='active' AND u.status='active' ORDER BY u.display_name,u.email`,
    ).bind(current.organizationId).all<UserOption>(),
    env.DB.prepare(
      `SELECT id,name,country_code,city,address FROM warehouses
       WHERE organization_id=? AND warehouse_role='overseas_destination' AND status='active' ORDER BY name`,
    ).bind(current.organizationId).all<WarehouseOption>(),
    geoOptions(current.organizationId, "country"),
    geoOptions(current.organizationId, "province"),
  ]);
  const [cities, workflows, workflowFields] = await Promise.all([
    geoOptions(current.organizationId, "city"),
    env.DB.prepare(
      `SELECT id,name,version_number,road_load_type,lifecycle_status FROM workflow_definitions
       WHERE organization_id=? AND lifecycle_status IN ('published','retired')
         AND validation_status='valid' AND road_load_type IN ('ftl','ltl')
       ORDER BY road_load_type,
         CASE lifecycle_status WHEN 'published' THEN 0 ELSE 1 END,
         COALESCE(published_at,updated_at) DESC,version_number DESC,name`,
    ).bind(current.organizationId).all<WorkflowOption>(),
    listQuotationWorkflowFields(current.organizationId),
  ]);
  const quoteRows = quotes.results ?? [];
  const [workflowValues,quotationWorkflowFields] = await Promise.all([
    listQuotationWorkflowFieldValues(
      current.organizationId,
      quoteRows.map((quote) => quote.id),
    ),
    listQuotationWorkflowInstanceFields(
      current.organizationId,
      quoteRows.map((quote) => quote.id),
    ),
  ]);
  return {
    current,
    quotes: quoteRows,
    quotationCharges: quotationCharges.results ?? [],
    customers: customers.results ?? [],
    contacts: contacts.results ?? [],
    users: users.results ?? [],
    warehouses: warehouses.results ?? [],
    countries,
    provinces,
    cities,
    workflows: workflows.results ?? [],
    workflowFields,
    quotationWorkflowFields,
    workflowValues,
    filters: { keyword, lifecycle },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "quote.manage");
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const actionQuotationId = valueOf(form, "id") || undefined;
  try {
    if (intent === "workflow_fields_update") {
      const quotationId = valueOf(form, "id");
      const quote = await env.DB.prepare(
        `SELECT q.*,
          (SELECT COUNT(*) FROM quotation_charges c
           WHERE c.quotation_id=q.id AND c.quantity>0 AND c.unit_price>0) quotation_charge_items
         FROM quotations q WHERE q.id=? AND q.organization_id=?`,
      ).bind(quotationId,current.organizationId).first<Record<string, unknown> & {
        id:string; workflow_definition_id:string|null; lifecycle_status:string;
      }>();
      if (!quote?.workflow_definition_id) throw new Error("报价未锁定工作流版本");
      if (!["pending","withdrawn"].includes(quote.lifecycle_status))
        throw new Error("只有待确认或已撤回报价可以补充第一步字段");
      const [liveFields,instanceFields,existingValues] = await Promise.all([
        listQuotationWorkflowFields(current.organizationId),
        listQuotationWorkflowInstanceFields(current.organizationId,[quotationId]),
        listQuotationWorkflowFieldValues(current.organizationId,[quotationId]),
      ]);
      const selectedFields = instanceFields.length
        ? instanceFields
        : liveFields.filter((field) => field.workflow_id === quote.workflow_definition_id);
      const prepared = await prepareQuotationWorkflowFieldValues({
        form,
        fields:activeQuotationCustomWorkflowFields(selectedFields),
        existingValues,
      });
      const existingValueByFieldId = new Map(existingValues.map((value) => [value.field_id,value]));
      const existingValueByFieldKey = new Map(existingValues.map((value) => [value.field_key,value]));
      const changedCustomFieldKeys = prepared
        .filter((item) => {
          const existing = existingValueByFieldId.get(item.field.id) ||
            existingValueByFieldKey.get(item.field.field_key) || null;
          if (item.file) return true;
          if (item.keepExistingFile) return false;
          return String(existing?.value_text ?? "").trim() !== String(item.valueText ?? "").trim();
        })
        .map((item) => item.field.field_key);
      const editResult = await saveQuotationNativeWorkflowUpdate({
        organizationId:current.organizationId,
        quotationId,
        quote,
        fields:selectedFields,
        form,
      });
      await savePreparedQuotationWorkflowFieldValues({
        organizationId:current.organizationId,
        quotationId,
        workflowId:quote.workflow_definition_id,
        actorUserId:current.userId,
        values:prepared,
        guard:{ quotationUpdatedAt:editResult.updatedAt },
      });
      await writeAudit({
        request,
        action:"quotation.workflow_fields.update",
        resourceType:"quotation",
        resourceId:quotationId,
        organizationId:current.organizationId,
        actorUserId:current.userId,
        metadata:{
          workflowId:quote.workflow_definition_id,
          nativeFieldsChanged:editResult.changedNativeFieldKeys.length > 0,
          changedNativeFieldKeys:editResult.changedNativeFieldKeys,
          customFieldsChanged:changedCustomFieldKeys.length > 0,
          changedCustomFieldKeys,
          chargesChanged:editResult.chargesChanged,
          chargeCountBefore:editResult.chargeCountBefore,
          chargeCountAfter:editResult.chargeCountAfter,
        },
      });
      return { intent, quotationId: actionQuotationId, success: "询价报价第一步的配置字段已保存" };
    }
    if (intent === "create") {
      const customerId = valueOf(form, "customerId");
      const salespersonId = valueOf(form, "salespersonId");
      const transportMode = valueOf(form, "transportMode");
      const roadLoadType = valueOf(form, "roadLoadType");
      const workflowDefinitionId = valueOf(form, "workflowDefinitionId");
      const customerContactName = valueOf(form, "customerContactName");
      const customerContactPhone = valueOf(form, "customerContactPhone");
      const pickupAddress = valueOf(form, "pickupAddress");
      const originCountry = valueOf(form, "originCountry");
      const originState = valueOf(form, "originState");
      const originCity = valueOf(form, "originCity");
      const destinationCountry = valueOf(form, "destinationCountry");
      const destinationState = valueOf(form, "destinationState");
      const destinationCity = valueOf(form, "destinationCity");
      const destinationWarehouseId = valueOf(form, "destinationWarehouseId");
      const destinationWarehouseNote = valueOf(form, "destinationWarehouseNote");
      const customsClearanceMode = valueOf(form, "customsClearanceMode");
      const cargoDescription = valueOf(form, "cargoDescription");
      const rawPieces = valueOf(form, "pieces");
      const rawWeight = valueOf(form, "weight");
      const rawLength = valueOf(form, "length");
      const rawWidth = valueOf(form, "width");
      const rawHeight = valueOf(form, "height");
      const rawVolume = valueOf(form, "volume");
      const validUntil = valueOf(form, "validUntil");
      const notes = valueOf(form, "notes");
      if (!customerId || transportMode !== "ROAD" || !["ftl", "ltl"].includes(roadLoadType)) {
        throw new Error("请选择客户、汽运和整车/拼车类型");
      }
      if (!workflowDefinitionId) throw new Error("请选择本报价使用的工作流版本");
      const [customer, workflow] = await Promise.all([
        env.DB.prepare("SELECT id FROM customers WHERE id=? AND organization_id=? AND status='active'").bind(customerId,current.organizationId).first(),
        env.DB.prepare(
          `SELECT id FROM workflow_definitions
           WHERE id=? AND organization_id=? AND lifecycle_status IN ('published','retired')
             AND validation_status='valid' AND road_load_type=?`,
        ).bind(workflowDefinitionId,current.organizationId,roadLoadType).first(),
      ]);
      if (!customer) throw new Error("客户已停用或不存在");
      if (!workflow) throw new Error("所选工作流与整车/拼车类型不匹配，或该版本无效");
      const selectedWorkflowFields = (await listQuotationWorkflowFields(current.organizationId))
        .filter((field) => field.workflow_id === workflowDefinitionId);
      const policy = (
        fieldKey: Parameters<typeof quotationWorkflowFieldPolicy>[1],
        fallback: Parameters<typeof quotationWorkflowFieldPolicy>[2],
      ) => quotationWorkflowFieldPolicy(selectedWorkflowFields,fieldKey,fallback);
      const activeValue = (fieldKey: Parameters<typeof policy>[0], value: string, fallback: Parameters<typeof policy>[1]) =>
        policy(fieldKey,fallback).isActive ? value : "";
      const requiredText = (fieldKey: Parameters<typeof policy>[0], value: string, label: string, fallback: Parameters<typeof policy>[1]) => {
        if (policy(fieldKey,fallback).isRequired && !value.trim()) throw new Error(`请填写“${label}”`);
      };
      const numberValue = (
        fieldKey: Parameters<typeof policy>[0],
        raw: string,
        label: string,
        fallback: Parameters<typeof policy>[1],
        integer = false,
      ) => {
        const currentPolicy = policy(fieldKey,fallback);
        if (!currentPolicy.isActive || !raw.trim()) {
          if (currentPolicy.isRequired) throw new Error(`请填写“${label}”`);
          return integer ? 1 : 0;
        }
        return integer ? requirePositiveInteger(raw,label) : requirePositiveNumber(raw,label);
      };

      const effectiveSalespersonId = activeValue("quotation_salesperson_user_id",salespersonId,"required") || current.userId;
      const effectiveContactName = activeValue("quotation_customer_contact_name",customerContactName,"required");
      const effectiveContactPhone = activeValue("quotation_customer_contact_phone",customerContactPhone,"required");
      const effectivePickupAddress = activeValue("quotation_pickup_address",pickupAddress,"required");
      const effectiveOriginCountry = activeValue("quotation_origin_region",originCountry,"required");
      const effectiveOriginState = activeValue("quotation_origin_region",originState,"required");
      const effectiveOriginCity = activeValue("quotation_origin_region",originCity,"required");
      const effectiveDestinationCountry = activeValue("quotation_destination_region",destinationCountry,"required");
      const effectiveDestinationState = activeValue("quotation_destination_region",destinationState,"required");
      const effectiveDestinationCity = activeValue("quotation_destination_region",destinationCity,"required");
      const effectiveWarehouseId = activeValue("quotation_destination_warehouse_id",destinationWarehouseId,"required");
      const effectiveWarehouseNote = activeValue("quotation_destination_warehouse_note",destinationWarehouseNote,"optional");
      const effectiveCustomsMode = activeValue("quotation_customs_clearance_mode",customsClearanceMode,"required") || "company";
      const effectiveCargoDescription = activeValue("quotation_cargo_description",cargoDescription,"required");
      const effectiveNotes = activeValue("quotation_notes",notes,"optional");
      const effectiveValidUntil = activeValue("quotation_valid_until",validUntil,"optional");

      requiredText("quotation_customer_contact_name",effectiveContactName,"客户联系人","required");
      requiredText("quotation_customer_contact_phone",effectiveContactPhone,"联系电话","required");
      requiredText("quotation_pickup_address",effectivePickupAddress,"提货地址","required");
      requiredText("quotation_cargo_description",effectiveCargoDescription,"货物描述","required");
      requiredText("quotation_destination_warehouse_id",effectiveWarehouseId,"目的仓库","required");
      if (effectiveContactPhone) {
        const phoneError = validatePhone(effectiveContactPhone,"客户联系电话");
        if (phoneError) throw new Error(phoneError);
      }
      if (!["company","customer"].includes(effectiveCustomsMode)) throw new Error("请选择清关办理方式");
      const validateRegion = async (
        fieldKey: "quotation_origin_region" | "quotation_destination_region",
        country: string,
        state: string,
        city: string,
        label: string,
      ) => {
        const currentPolicy = policy(fieldKey,"required");
        if (!currentPolicy.isActive) return;
        const hasAny = [country,state,city].some(Boolean);
        if (currentPolicy.isRequired && ![country,state,city].every(Boolean)) throw new Error(`请完整选择${label}`);
        if (hasAny) {
          if (![country,state,city].every(Boolean)) throw new Error(`${label}需完整选择国家、省州和城市`);
          await assertGeoHierarchy(current.organizationId,country,state,city,label);
        }
      };
      await Promise.all([
        validateRegion("quotation_origin_region",effectiveOriginCountry,effectiveOriginState,effectiveOriginCity,"起运地"),
        validateRegion("quotation_destination_region",effectiveDestinationCountry,effectiveDestinationState,effectiveDestinationCity,"目的地"),
      ]);
      const [salesperson,warehouse] = await Promise.all([
        env.DB.prepare("SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=? AND m.organization_id=? AND u.status='active' AND m.status='active'").bind(effectiveSalespersonId,current.organizationId).first(),
        effectiveWarehouseId
          ? env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND organization_id=? AND warehouse_role='overseas_destination' AND status='active'").bind(effectiveWarehouseId,current.organizationId).first()
          : Promise.resolve(null),
      ]);
      if (!salesperson) throw new Error("业务员已停用或不存在");
      if (effectiveWarehouseId && !warehouse) throw new Error("目的仓已停用或不存在");
      const pieces = numberValue("quotation_pieces",rawPieces,"预计件数","required",true);
      const weight = numberValue("quotation_gross_weight_kg",rawWeight,"预计重量","required");
      const length = numberValue("quotation_length_cm",rawLength,"预计长度","required");
      const width = numberValue("quotation_width_cm",rawWidth,"预计宽度","required");
      const height = numberValue("quotation_height_cm",rawHeight,"预计高度","required");
      const volume = numberValue("quotation_volume_cbm",rawVolume,"预计体积","required");
      const preparedWorkflowValues = await prepareQuotationWorkflowFieldValues({
        form,
        fields:selectedWorkflowFields,
      });
      const chargeNames = form.getAll("chargeName").map(String);
      const quantities = form.getAll("chargeQuantity").map(Number);
      const unitPrices = form.getAll("chargeUnitPrice").map(Number);
      const chargeNotes = form.getAll("chargeNotes").map(String);
      const chargePolicy = policy("quotation_charge_items","required");
      const charges = chargePolicy.isActive ? chargeNames.map((name, index) => {
        const quantity = quantities[index];
        const unitPrice = unitPrices[index];
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
          if (chargePolicy.isRequired) throw new Error(`第 ${index + 1} 条费用的数量或单价无效`);
          return null;
        }
        return { name, quantity, unitPrice, amount: quantity * unitPrice, notes: chargeNotes[index] || null };
      }).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [];
      if (chargePolicy.isRequired && (!charges.length || charges.some((item) => !item.name)))
        throw new Error("至少填写一条有效的客户应收费用");
      const total = charges.reduce((sum, item) => sum + item.amount, 0);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const notificationId = crypto.randomUUID();
      const number = await nextDocumentNumber(current.organizationId, "quote");
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO quotations(
              id,organization_id,quote_number,customer_id,origin_country,origin_state,origin_city,pickup_address,
              destination_country,destination_state,destination_city,destination_warehouse_id,destination_warehouse_note,
              estimated_length_cm,estimated_width_cm,estimated_height_cm,customs_clearance_mode,
              transport_mode,road_load_type,cargo_description,pieces,gross_weight_kg,volume_cbm,currency,
              subtotal,tax_amount,total_amount,valid_until,status,lifecycle_status,notes,salesperson_user_id,workflow_definition_id,
              created_by_user_id,created_at,updated_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CNY',?,0,?,?, 'sent','pending',?,?,?,?,?,?)`,
          ).bind(
            id,current.organizationId,number,customerId,effectiveOriginCountry,effectiveOriginState || null,effectiveOriginCity,effectivePickupAddress || null,
            effectiveDestinationCountry,effectiveDestinationState || null,effectiveDestinationCity,effectiveWarehouseId || null,effectiveWarehouseNote || null,
            length,width,height,effectiveCustomsMode,transportMode,roadLoadType,effectiveCargoDescription,pieces,weight,volume,
            total,total,effectiveValidUntil || null,effectiveNotes || null,effectiveSalespersonId,workflowDefinitionId,current.userId,now,now,
          ),
          env.DB.prepare(
            "UPDATE quotations SET customer_contact_name=?,customer_contact_phone=? WHERE id=? AND organization_id=?",
          ).bind(effectiveContactName || null,effectiveContactPhone || null,id,current.organizationId),
          ...charges.map((charge, index) => env.DB.prepare(
            `INSERT INTO quotation_charges(
              id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,notes,created_at
             ) VALUES(?,?,?,?,?,?,?,1,?,?,?)`,
          ).bind(crypto.randomUUID(),id,`RECEIVABLE_${index + 1}`,charge.name,charge.quantity,charge.unitPrice,charge.amount,(index + 1) * 10,charge.notes,now)),
          env.DB.prepare(
            `INSERT INTO portal_notifications(
              id,organization_id,customer_id,user_id,type,title,message,link,is_read,created_at
             ) VALUES(?,?,?,?,?,?,?,?,0,?)`,
          ).bind(notificationId,current.organizationId,customerId,null,"quote","新报价待确认",`报价 ${number} 等待确认。`,`/portal/quotes`,now),
        ]);
        await savePreparedQuotationWorkflowFieldValues({
          organizationId:current.organizationId,
          quotationId:id,
          workflowId:workflowDefinitionId,
          actorUserId:current.userId,
          values:preparedWorkflowValues,
        });
        const workflowInstanceId = await recordWorkflowEvent({
          organizationId:current.organizationId,
          workflowId:workflowDefinitionId,
          event:"quote.created",
          customerId,
          quotationId:id,
          actorUserId:current.userId,
          source:"admin",
          metadata:{ number,roadLoadType,workflowVersionLocked:true },
        });
        if (!workflowInstanceId) throw new Error("所选工作流缺少询价报价第一节点");
      } catch (error) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM workflow_instances WHERE organization_id=? AND quotation_id=?")
            .bind(current.organizationId,id),
          env.DB.prepare("DELETE FROM portal_notifications WHERE id=? AND organization_id=?")
            .bind(notificationId,current.organizationId),
          env.DB.prepare("DELETE FROM quotations WHERE id=? AND organization_id=?")
            .bind(id,current.organizationId),
        ]);
        throw error;
      }
      return { intent, quotationId: actionQuotationId, success: `报价 ${number} 已保存并进入待客户确认` };
    }
    const quotationId = valueOf(form, "id");
    if (!quotationId) throw new Error("缺少报价编号");
    if (intent === "accept") {
      const result = await acceptQuotation({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin", request });
      return { intent, quotationId: actionQuotationId, success: `客户报价已确认，${result.created ? "自动创建" : "恢复"}订单 ${result.orderNumber}，入仓唛头已生成` };
    }
    if (intent === "withdraw") {
      const result = await withdrawQuotationAcceptance({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin" });
      return { intent, quotationId: actionQuotationId, success: `报价接受已撤回，订单 ${result.orderNumber || ""} 已保留` };
    }
    if (intent === "void") {
      await voidQuotation({ organizationId: current.organizationId, quotationId, actorUserId: current.userId, source: "admin" });
      return { intent, quotationId: actionQuotationId, success: "报价已作废" };
    }
    throw new Error("未知操作");
  } catch (error) {
    return { intent, quotationId: actionQuotationId, formError: error instanceof Error ? error.message : String(error) };
  }
}

async function saveQuotationNativeWorkflowUpdate(input: {
  organizationId:string;
  quotationId:string;
  quote:Record<string, unknown>;
  fields:QuotationWorkflowField[];
  form:FormData;
}) {
  const expectedUpdatedAt=String(input.quote.updated_at||"");
  if (!expectedUpdatedAt) throw new Error("报价缺少并发版本标识，请刷新后重试");
  if (valueOf(input.form,"nativeFieldsIncluded") !== "1") {
    const chargeCount=Number(input.quote.quotation_charge_items || 0);
    return {
      updatedAt:expectedUpdatedAt,
      changedNativeFieldKeys:[] as QuotationNativeFieldKey[],
      chargesChanged:false,
      chargeCountBefore:chargeCount,
      chargeCountAfter:chargeCount,
    };
  }
  const nativeFields = input.fields.filter((field) => quotationNativeFieldKeySet.has(field.field_key));
  const policy = (fieldKey:QuotationNativeFieldKey, fallback:"required"|"optional") =>
    quotationWorkflowFieldPolicy(nativeFields,fieldKey,fallback);
  const next:Record<string, unknown> = {...input.quote};
  const setText = (
    fieldKey:QuotationNativeFieldKey,
    formName:string,
    column:string,
    fallback:"required"|"optional",
    emptyValue:string|null = null,
  ) => {
    if (!policy(fieldKey,fallback).isActive || !input.form.has(formName)) return;
    next[column] = valueOf(input.form,formName).trim() || emptyValue;
  };
  const setPositive = (
    fieldKey:QuotationNativeFieldKey,
    formName:string,
    column:string,
    label:string,
    fallback:"required"|"optional",
    integer = false,
  ) => {
    if (!policy(fieldKey,fallback).isActive || !input.form.has(formName)) return;
    const raw = valueOf(input.form,formName).trim();
    if (!raw) {
      next[column] = integer ? 1 : 0;
      return;
    }
    next[column] = integer ? requirePositiveInteger(raw,label) : requirePositiveNumber(raw,label);
  };

  setText("quotation_customer_contact_name","customerContactName","customer_contact_name","required");
  setText("quotation_customer_contact_phone","customerContactPhone","customer_contact_phone","required");
  setText("quotation_salesperson_user_id","salespersonId","salesperson_user_id","required");
  setText("quotation_customs_clearance_mode","customsClearanceMode","customs_clearance_mode","required","company");
  setText("quotation_origin_region","originCountry","origin_country","required","");
  setText("quotation_origin_region","originState","origin_state","required","");
  setText("quotation_origin_region","originCity","origin_city","required","");
  setText("quotation_pickup_address","pickupAddress","pickup_address","required");
  setText("quotation_destination_region","destinationCountry","destination_country","required","");
  setText("quotation_destination_region","destinationState","destination_state","required","");
  setText("quotation_destination_region","destinationCity","destination_city","required","");
  setText("quotation_destination_warehouse_id","destinationWarehouseId","destination_warehouse_id","required");
  setText("quotation_destination_warehouse_note","destinationWarehouseNote","destination_warehouse_note","optional");
  setText("quotation_cargo_description","cargoDescription","cargo_description","required","");
  setText("quotation_notes","notes","notes","optional");
  setText("quotation_valid_until","validUntil","valid_until","optional");
  setPositive("quotation_pieces","pieces","pieces","预计件数","required",true);
  setPositive("quotation_gross_weight_kg","weight","gross_weight_kg","预计重量","required");
  setPositive("quotation_length_cm","length","estimated_length_cm","预计长度","required");
  setPositive("quotation_width_cm","width","estimated_width_cm","预计宽度","required");
  setPositive("quotation_height_cm","height","estimated_height_cm","预计高度","required");
  setPositive("quotation_volume_cbm","volume","volume_cbm","预计体积","required");

  const chargePolicy = policy("quotation_charge_items","required");
  const chargeIds = input.form.getAll("chargeId").map(String);
  const chargeNames = input.form.getAll("chargeName").map(String);
  const chargeQuantities = input.form.getAll("chargeQuantity").map(Number);
  const chargeUnitPrices = input.form.getAll("chargeUnitPrice").map(Number);
  const chargeNotes = input.form.getAll("chargeNotes").map(String);
  const existingCharges = chargePolicy.isActive
    ? (await env.DB.prepare(
        `SELECT c.id,c.description,c.quantity,c.unit_price,c.notes,c.sort_order
         FROM quotation_charges c
         JOIN quotations q ON q.id=c.quotation_id
         WHERE c.quotation_id=? AND q.organization_id=?
         ORDER BY c.sort_order,c.id`,
      ).bind(input.quotationId,input.organizationId).all<{
        id:string; description:string; quantity:number; unit_price:number;
        notes:string|null; sort_order:number;
      }>()).results
    : [];
  const chargeUpdate = chargePolicy.isActive
    ? parseQuotationChargeUpdate({
        existing:existingCharges,
        ids:chargeIds,
        names:chargeNames,
        quantities:chargeQuantities,
        unitPrices:chargeUnitPrices,
        notes:chargeNotes,
        required:chargePolicy.isRequired,
      })
    : { charges:[],changed:false };
  const charges = chargeUpdate.charges;
  const chargeCountBefore = chargePolicy.isActive
    ? existingCharges.length
    : Number(input.quote.quotation_charge_items || 0);
  const chargeCountAfter = chargePolicy.isActive ? charges.length : chargeCountBefore;
  if (chargePolicy.isActive) next.quotation_charge_items = charges.length;

  const missing = nativeFields
    .filter((field) => Boolean(field.is_active && field.is_required))
    .filter((field) => !quotationNativeFieldPresent(field.field_key,next));
  if (missing.length) throw new Error(`请补齐询价报价第一步必填项：${missing.map((field) => field.label).join("、")}`);
  const phone = String(next.customer_contact_phone || "").trim();
  if (phone) {
    const phoneError = validatePhone(phone,"客户联系电话");
    if (phoneError) throw new Error(phoneError);
  }
  const customsMode = String(next.customs_clearance_mode || "");
  if (policy("quotation_customs_clearance_mode","required").isActive && !["company","customer"].includes(customsMode))
    throw new Error("请选择清关办理方式");
  const validateRegion = async (
    fieldKey:"quotation_origin_region"|"quotation_destination_region",
    prefix:"origin"|"destination",
    label:string,
  ) => {
    if (!policy(fieldKey,"required").isActive) return;
    const country = String(next[`${prefix}_country`] || "");
    const state = String(next[`${prefix}_state`] || "");
    const city = String(next[`${prefix}_city`] || "");
    if ([country,state,city].some(Boolean)) {
      if (![country,state,city].every(Boolean)) throw new Error(`${label}需完整选择国家、省州和城市`);
      await assertGeoHierarchy(input.organizationId,country,state,city,label);
    }
  };
  await Promise.all([
    validateRegion("quotation_origin_region","origin","起运地"),
    validateRegion("quotation_destination_region","destination","目的地"),
  ]);
  if (policy("quotation_salesperson_user_id","required").isActive && next.salesperson_user_id) {
    const user = await env.DB.prepare(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
       WHERE u.id=? AND m.organization_id=? AND u.status='active' AND m.status='active'`,
    ).bind(next.salesperson_user_id,input.organizationId).first();
    if (!user) throw new Error("业务员已停用或不存在");
  }
  if (policy("quotation_destination_warehouse_id","required").isActive && next.destination_warehouse_id) {
    const warehouse = await env.DB.prepare(
      `SELECT id FROM warehouses WHERE id=? AND organization_id=?
       AND warehouse_role='overseas_destination' AND status='active'`,
    ).bind(next.destination_warehouse_id,input.organizationId).first();
    if (!warehouse) throw new Error("目的仓已停用或不存在");
  }

  const changedNativeFieldKeys = changedQuotationNativeFieldKeys(input.quote,next);
  const now = new Date().toISOString();
  const total = chargePolicy.isActive
    ? charges.reduce((sum,item) => sum+item.amount,0)
    : Number(next.total_amount || 0);
  const statements:D1PreparedStatement[] = [env.DB.prepare(
    `UPDATE quotations SET
      customer_contact_name=?,customer_contact_phone=?,salesperson_user_id=?,customs_clearance_mode=?,
      origin_country=?,origin_state=?,origin_city=?,pickup_address=?,
      destination_country=?,destination_state=?,destination_city=?,destination_warehouse_id=?,destination_warehouse_note=?,
      cargo_description=?,notes=?,pieces=?,gross_weight_kg=?,estimated_length_cm=?,estimated_width_cm=?,estimated_height_cm=?,
      volume_cbm=?,valid_until=?,subtotal=?,total_amount=?,updated_at=?
     WHERE id=? AND organization_id=?
       AND lifecycle_status IN ('pending','withdrawn') AND updated_at=?`,
  ).bind(
    next.customer_contact_name ?? null,next.customer_contact_phone ?? null,next.salesperson_user_id ?? null,
    next.customs_clearance_mode || "company",next.origin_country || "",next.origin_state || null,next.origin_city || "",
    next.pickup_address ?? null,next.destination_country || "",next.destination_state || null,next.destination_city || "",
    next.destination_warehouse_id ?? null,next.destination_warehouse_note ?? null,next.cargo_description || "",next.notes ?? null,
    Number(next.pieces || 1),Number(next.gross_weight_kg || 0),Number(next.estimated_length_cm || 0),
    Number(next.estimated_width_cm || 0),Number(next.estimated_height_cm || 0),Number(next.volume_cbm || 0),
    next.valid_until ?? null,total,total,now,input.quotationId,input.organizationId,expectedUpdatedAt,
  )];
  if (chargePolicy.isActive) {
    statements.push(...charges.map((charge,index) => charge.id
      ? env.DB.prepare(
          `UPDATE quotation_charges SET description=?,quantity=?,unit_price=?,amount=?,sort_order=?,notes=?
           WHERE id=? AND quotation_id=? AND EXISTS(
             SELECT 1 FROM quotations q
             WHERE q.id=? AND q.organization_id=?
               AND q.lifecycle_status IN ('pending','withdrawn') AND q.updated_at=?
           )`,
        ).bind(
          charge.name,charge.quantity,charge.unitPrice,charge.amount,(index+1)*10,
          charge.notes,charge.id,input.quotationId,input.quotationId,input.organizationId,now,
        )
      : env.DB.prepare(
          `INSERT INTO quotation_charges(
            id,quotation_id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order,notes,created_at
           )
           SELECT ?,?,?,?,?,?,?,1,?,?,?
           WHERE EXISTS(
             SELECT 1 FROM quotations q
             WHERE q.id=? AND q.organization_id=?
               AND q.lifecycle_status IN ('pending','withdrawn') AND q.updated_at=?
           )`,
        ).bind(
          crypto.randomUUID(),input.quotationId,`RECEIVABLE_${index+1}`,charge.name,
          charge.quantity,charge.unitPrice,charge.amount,(index+1)*10,charge.notes,now,
          input.quotationId,input.organizationId,now,
        ),
    ));
  }
  const results=await env.DB.batch(statements);
  if (Number(results[0]?.meta.changes||0)!==1)
    throw new Error("报价状态已被其他窗口更新，当前补充内容未覆盖，请刷新后确认");
  return {
    updatedAt:now,
    changedNativeFieldKeys,
    chargesChanged:chargeUpdate.changed,
    chargeCountBefore,
    chargeCountAfter,
  };
}

export default function QuotationsPage({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [createQuoteOpen,setCreateQuoteOpen]=useState(false);
  const dismissedCreateResult=useRef(actionData);
  const actionError=actionData&&"formError" in actionData?actionData.formError:undefined;
  const actionSuccess=actionData&&"success" in actionData?actionData.success:undefined;
  const createFormError=createQuoteOpen&&actionData?.intent==="create"&&actionError&&
    actionData!==dismissedCreateResult.current?actionError:undefined;
  const updateCreateQuoteOpen=(nextOpen:boolean)=>{
    if(!nextOpen)dismissedCreateResult.current=actionData;
    setCreateQuoteOpen(nextOpen);
  };
  const stats = useMemo(() => ({
    pending: loaderData.quotes.filter((quote) => quote.lifecycle_status === "pending").length,
    accepted: loaderData.quotes.filter((quote) => quote.lifecycle_status === "accepted").length,
    orders: loaderData.quotes.filter((quote) => quote.order_id).length,
  }), [loaderData.quotes]);
  return <div className="page prototype-page">
    <div className="breadcrumb">管理后台 / 工作台 / <b>询价与报价</b></div>
    <div className="page-head">
      <div><span className="eyebrow">QUOTE DESK / 询价与报价</span><h1>询价与报价</h1><p>报价被接受后立即生成唯一运输订单，不再二次创建订单。</p></div>
      <div className="head-actions"><Modal title="创建运输报价" triggerLabel="创建报价" triggerClassName="btn primary" closeSignal={actionData?.intent==="create"?actionSuccess:undefined} isOpen={createQuoteOpen} onOpenChange={updateCreateQuoteOpen} size="xwide" dialogClassName="quote-form-modal" guardFormChanges><QuoteForm loaderData={loaderData} busy={busy} formError={createFormError} /></Modal></div>
    </div>
    {(actionSuccess || actionError) && <div className={`gate ${actionError ? "" : "ok"}`}>{actionError || actionSuccess}</div>}
    <div className="kpis quotation-kpis">
      <div className="panel"><span>待客户确认</span><b>{stats.pending}</b></div>
      <div className="panel"><span>已接受</span><b>{stats.accepted}</b></div>
      <div className="panel"><span>自动生成订单</span><b>{stats.orders}</b></div>
      <div className="panel"><span>规则</span><b>一报一单</b></div>
    </div>
    <Form className="panel filters quotation-filters" method="get" action=".">
      <div className="field"><label>报价号 / 客户 / 货物 / 订单号</label><input className="control" name="q" defaultValue={loaderData.filters.keyword} /></div>
      <div className="field"><label>状态</label><select className="control" name="status" defaultValue={loaderData.filters.lifecycle}><option value="">全部</option><option value="pending">待确认</option><option value="accepted">已接受</option><option value="withdrawn">已撤回</option><option value="void">已作废</option></select></div>
      <button className="btn primary">筛选</button><Link className="btn" to="/admin/quotations">重置</Link>
    </Form>
    <section className="panel table-panel">
      <div className="panel-head"><div><h2>报价单 <span className="count">{loaderData.quotes.length}</span></h2><p>首次保存即锁定整车/拼车工作流版本；接受后自动进入第二步“委托资料补充”。</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>报价单号</th><th>客户 / 业务员</th><th>运输方案</th><th>货物 / 线路</th><th>应收总额</th><th>状态</th><th>关联订单</th><th>操作</th></tr></thead><tbody>
        {loaderData.quotes.map((quote) => {
          const snapshotFields = loaderData.quotationWorkflowFields.filter((field) => field.quotation_id === quote.id);
          const fields = snapshotFields.length
            ? snapshotFields
            : loaderData.workflowFields.filter((field) => field.workflow_id === quote.workflow_definition_id);
          const values = loaderData.workflowValues.filter((value) => value.quotation_id === quote.id);
          const charges = loaderData.quotationCharges.filter((charge) => charge.quotation_id === quote.id);
          const visible=(key:QuotationNativeFieldKey,fallback:"required"|"optional")=>quotationWorkflowFieldPolicy(fields,key,fallback).isActive;
          const routeVisible=visible("quotation_origin_region","required")||visible("quotation_destination_region","required")||visible("quotation_destination_warehouse_id","required");
          const measures=[
            visible("quotation_pieces","required")?`${quote.pieces} 件`:null,
            visible("quotation_gross_weight_kg","required")?`${quote.gross_weight_kg} KG`:null,
            visible("quotation_volume_cbm","required")?`${quote.volume_cbm} CBM`:null,
          ].filter(Boolean).join(" · ");
          return <tr key={quote.id}><td><span className="order-id">{quote.quote_number}</span><span className="subline">{new Date(quote.created_at).toLocaleString("zh-CN")}</span></td><td><span className="cell-main">{quote.customer_name}</span>{visible("quotation_salesperson_user_id","required")&&<span className="subline">{quote.salesperson_name || "待指定业务员"}</span>}</td><td><span className={`pill ${quote.road_load_type === "ltl" ? "ltl" : ""}`}>{quote.road_load_type === "ltl" ? "拼车" : "整车"}</span><span className="subline">{quote.workflow_name ? `${quote.workflow_name} v${quote.workflow_version_number} · 已锁定` : "历史报价 · 接受时自动匹配流程"}</span></td><td>{visible("quotation_cargo_description","required")&&<span className="cell-main">{quote.cargo_description}</span>}{routeVisible&&<span className="subline">{quote.origin_city} → {quote.destination_city}{visible("quotation_destination_warehouse_id","required")?` · ${quote.destination_warehouse_name || "目的仓待补"}`:""}</span>}</td><td>{visible("quotation_charge_items","required")&&<span className="cell-main">CNY {quote.total_amount.toLocaleString()}</span>}{measures&&<span className="subline">{measures}</span>}</td><td><span className={`status ${statusTone(quote.lifecycle_status)}`}>{statusLabel(quote.lifecycle_status)}</span></td><td>{quote.order_id ? <Link className="order-id" to={`/admin/orders/${quote.order_id}`}>{quote.order_number}</Link> : <span className="subline">尚未生成</span>}</td><td><QuoteActions quote={quote} fields={fields} values={values} charges={charges} loaderData={loaderData} actionData={actionData} busy={busy} /></td></tr>;
        })}
      </tbody></table></div>
      {!loaderData.quotes.length && <div className="empty-state">暂无符合条件的报价。</div>}
    </section>
  </div>;
}

function QuoteActions({ quote, fields, values, charges, loaderData, actionData, busy }: {
  quote: Quote;
  fields: QuotationWorkflowField[];
  values: QuotationWorkflowFieldValue[];
  charges: QuoteCharge[];
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData: Route.ComponentProps["actionData"];
  busy: boolean;
}) {
  const [workflowEditorOpen,setWorkflowEditorOpen]=useState(false);
  const dismissedWorkflowResult=useRef(actionData);
  const workflowResultMatches=actionData?.intent==="workflow_fields_update"&&
    actionData.quotationId===quote.id&&actionData!==dismissedWorkflowResult.current;
  const workflowError=workflowEditorOpen&&workflowResultMatches&&"formError" in actionData
    ? actionData.formError
    : undefined;
  const workflowSuccess=workflowResultMatches&&"success" in actionData
    ? actionData.success
    : undefined;
  const workflowErrorRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(workflowError)workflowErrorRef.current?.focus()},[workflowError]);
  const updateWorkflowEditorOpen=(nextOpen:boolean)=>{
    if(!nextOpen)dismissedWorkflowResult.current=actionData;
    setWorkflowEditorOpen(nextOpen);
  };
  const activeFields = fields.filter((field) => Boolean(field.is_active));
  const nativeFields = activeFields.filter((field) => quotationNativeFieldKeySet.has(field.field_key));
  const customFields = activeQuotationCustomWorkflowFields(activeFields);
  const missing = activeFields.filter((field) => Boolean(field.is_required) && (
    quotationNativeFieldKeySet.has(field.field_key)
      ? !quotationNativeFieldPresent(field.field_key, quote)
      : !quotationWorkflowFieldHasValue(
          field,
          values.find((value) => value.field_id === field.id || value.field_key === field.field_key) || null,
        )
  ));
  return <div className="toolbar-actions quotation-table-actions">
    <Modal title={`报价详情 · ${quote.quote_number}`} triggerLabel="查看" triggerClassName="btn"><QuoteDetail quote={quote} fields={fields} values={values} customers={loaderData.customers} warehouses={loaderData.warehouses} /></Modal>
    {activeFields.length > 0 && ["pending","withdrawn"].includes(quote.lifecycle_status) && <Modal title={`补充第一步配置项 · ${quote.quote_number}`} triggerLabel={missing.length ? `补充配置项 ${missing.length}` : "配置项"} triggerClassName={missing.length ? "btn danger" : "btn"} closeSignal={workflowSuccess} isOpen={workflowEditorOpen} onOpenChange={updateWorkflowEditorOpen} size="xwide" guardFormChanges><Form method="post" encType="multipart/form-data" className="quotation-workflow-update-form" data-enter-flow><input type="hidden" name="intent" value="workflow_fields_update"/><input type="hidden" name="id" value={quote.id}/><input type="hidden" name="nativeFieldsIncluded" value="1"/>{workflowError&&<div ref={workflowErrorRef} className="alert error" role="alert" tabIndex={-1}><strong>配置项尚未保存</strong><span>{workflowError}</span><small>已填写内容仍保留，请按提示修改后重试。</small></div>}<div className="quote-workflow-form-head"><strong>第 1 步 · 询价报价</strong><span>{quote.workflow_name} v{quote.workflow_version_number} · 版本已锁定</span></div>{nativeFields.length > 0 && <QuotationNativeWorkflowInputs quote={quote} fields={nativeFields} charges={charges} users={loaderData.users} warehouses={loaderData.warehouses} countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities}/>}<QuotationWorkflowFieldInputs fields={customFields} values={values} customers={loaderData.customers} warehouses={loaderData.warehouses}/><div className="modal-form-actions"><button className="btn primary" disabled={busy}>保存配置项</button></div></Form></Modal>}
    {quote.lifecycle_status === "pending" && <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy || missing.length > 0} title={missing.length ? `尚缺：${missing.map((field) => field.label).join("、")}` : undefined}>代客户确认</button></Form>}
    {quote.lifecycle_status === "accepted" && quote.order_status === "draft" && <Form method="post"><input type="hidden" name="intent" value="withdraw"/><input type="hidden" name="id" value={quote.id}/><ConfirmAction className="btn" title="撤回报价接受" description={`将撤回 ${quote.quote_number} 的客户接受状态；已生成订单会保留为草稿并留下审计记录。`} triggerLabel="撤回接受" confirmLabel="确认撤回" pending={busy}/></Form>}
    {quote.lifecycle_status === "withdrawn" && <Form method="post"><input type="hidden" name="intent" value="accept"/><input type="hidden" name="id" value={quote.id}/><button className="btn primary" disabled={busy}>重新接受</button></Form>}
    {["pending", "withdrawn"].includes(quote.lifecycle_status) && <Form method="post"><input type="hidden" name="intent" value="void"/><input type="hidden" name="id" value={quote.id}/><ConfirmAction className="btn danger" title="作废报价" description={`作废后 ${quote.quote_number} 不能再被客户接受；报价资料和审计记录仍会永久保留。`} triggerLabel="作废" confirmLabel="确认作废" pending={busy}/></Form>}
  </div>;
}

function QuoteDetail({ quote, fields, values, customers, warehouses }: {
  quote: Quote;
  fields: QuotationWorkflowField[];
  values: QuotationWorkflowFieldValue[];
  customers: CustomerOption[];
  warehouses: WarehouseOption[];
}) {
  const visible = (key:QuotationNativeFieldKey,fallback:"required"|"optional") =>
    quotationWorkflowFieldPolicy(fields,key,fallback).isActive;
  const customFields = activeQuotationCustomWorkflowFields(fields);
  const detailFacts = quotationDetailFacts(quote,visible);
  return <div className="drawer-grid quote-detail-grid">
    <ReadCell label="客户" value={quote.customer_name}/>
    {visible("quotation_salesperson_user_id","required") && <ReadCell label="业务员" value={quote.salesperson_name || "—"}/>}
    {visible("quotation_customer_contact_name","required") && <ReadCell label="客户联系人" value={quote.customer_contact_name || "—"}/>}
    {visible("quotation_customer_contact_phone","required") && <ReadCell label="联系电话" value={quote.customer_contact_phone || "—"}/>}
    <ReadCell label="运输方案" value={`汽运 · ${quote.road_load_type === "ltl" ? "拼车" : "整车"}`}/>
    {visible("quotation_customs_clearance_mode","required") && <ReadCell label="清关责任" value={quote.customs_clearance_mode === "company" ? "公司代办清关" : "客户自理清关"}/>}
    <ReadCell label="工作流版本" value={quote.workflow_name ? `${quote.workflow_name} · v${quote.workflow_version_number}` : "历史报价 · 接受时自动匹配"}/>
    {visible("quotation_pickup_address","required") && <ReadCell label="提货地址" value={quote.pickup_address || "—"}/>}
    {visible("quotation_destination_warehouse_id","required") && <ReadCell label="目的仓" value={quote.destination_warehouse_name || "—"}/>}
    {detailFacts.map((fact) => <ReadCell key={fact.key} label={fact.label} value={fact.value}/>)}
    {visible("quotation_destination_warehouse_note","optional") && <ReadCell label="目的仓备注" value={quote.destination_warehouse_note || "—"}/>}
    {visible("quotation_cargo_description","required") && <ReadCell label="货物" value={quote.cargo_description}/>}
    {visible("quotation_charge_items","required") && <ReadCell label="应收总额" value={`CNY ${quote.total_amount.toLocaleString()}`}/>}
    {visible("quotation_notes","optional") && <ReadCell label="报价备注" value={quote.notes || "—"}/>}
    {visible("quotation_valid_until","optional") && <ReadCell label="报价有效期" value={quote.valid_until || "—"}/>}
    {customFields.map((field) => {
      const value = values.find((item) => item.field_id === field.id || item.field_key === field.field_key) || null;
      const referenced = field.field_type === "customer"
        ? customers.find((item) => item.id === value?.value_text)?.name
        : field.field_type === "warehouse"
          ? warehouses.find((item) => item.id === value?.value_text)?.name
          : null;
      return <ReadCell key={field.id} label={`${field.label}${field.is_required ? "（必填）" : ""}`} value={referenced || quotationWorkflowDisplayValue(field,value)}/>;
    })}
  </div>;
}

function ReadCell({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><b>{value}</b></div>;
}

function QuoteForm({ loaderData, busy, formError }: { loaderData: Awaited<ReturnType<typeof loader>>; busy: boolean; formError?: string }) {
  const errorSummaryRef=useRef<HTMLDivElement>(null);
  const [customerId, setCustomerId] = useState(loaderData.customers[0]?.id || "");
  const [pickupAddress, setPickupAddress] = useState(loaderData.customers[0]?.pickup_address || "");
  const [customerContactName, setCustomerContactName] = useState(loaderData.customers[0]?.contact_name || "");
  const [customerContactPhone, setCustomerContactPhone] = useState(loaderData.customers[0]?.contact_phone || "");
  const [roadLoadType, setRoadLoadType] = useState<"" | "ltl" | "ftl">("");
  const [workflowDefinitionId, setWorkflowDefinitionId] = useState("");
  const [pieces, setPieces] = useState("1");
  const [lengthCm, setLengthCm] = useState("");
  const [widthCm, setWidthCm] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [charges, setCharges] = useState([{ name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }]);
  const total = charges.reduce((sum, charge) => sum + Number(charge.quantity || 0) * Number(charge.unitPrice || 0), 0);
  const calculatedVolume = [pieces, lengthCm, widthCm, heightCm].every((value) => Number(value) > 0)
    ? (Number(pieces) * Number(lengthCm) * Number(widthCm) * Number(heightCm) / 1_000_000).toFixed(4)
    : "";
  const selectedCustomerContacts = loaderData.contacts.filter((contact) => contact.customer_id === customerId);
  const selectedCustomer = loaderData.customers.find((customer) => customer.id === customerId);
  const compatibleWorkflows = useMemo(
    () => loaderData.workflows.filter((workflow) => workflow.road_load_type === roadLoadType),
    [loaderData.workflows, roadLoadType],
  );
  const selectedWorkflow = compatibleWorkflows.find((workflow) => workflow.id === workflowDefinitionId);
  const selectedWorkflowFields = loaderData.workflowFields.filter(
    (field) => field.workflow_id === workflowDefinitionId,
  );
  const selectedCustomWorkflowFields = activeQuotationCustomWorkflowFields(selectedWorkflowFields);
  const quotePolicy = (
    fieldKey: Parameters<typeof quotationWorkflowFieldPolicy>[1],
    fallback: Parameters<typeof quotationWorkflowFieldPolicy>[2],
  ) => quotationWorkflowFieldPolicy(selectedWorkflowFields,fieldKey,fallback);
  const policies = {
    contactName: quotePolicy("quotation_customer_contact_name","required"),
    contactPhone: quotePolicy("quotation_customer_contact_phone","required"),
    salesperson: quotePolicy("quotation_salesperson_user_id","required"),
    customsMode: quotePolicy("quotation_customs_clearance_mode","required"),
    originRegion: quotePolicy("quotation_origin_region","required"),
    pickupAddress: quotePolicy("quotation_pickup_address","required"),
    destinationRegion: quotePolicy("quotation_destination_region","required"),
    destinationWarehouse: quotePolicy("quotation_destination_warehouse_id","required"),
    destinationNote: quotePolicy("quotation_destination_warehouse_note","optional"),
    cargoDescription: quotePolicy("quotation_cargo_description","required"),
    notes: quotePolicy("quotation_notes","optional"),
    pieces: quotePolicy("quotation_pieces","required"),
    weight: quotePolicy("quotation_gross_weight_kg","required"),
    length: quotePolicy("quotation_length_cm","required"),
    width: quotePolicy("quotation_width_cm","required"),
    height: quotePolicy("quotation_height_cm","required"),
    volume: quotePolicy("quotation_volume_cbm","required"),
    charges: quotePolicy("quotation_charge_items","required"),
    validUntil: quotePolicy("quotation_valid_until","optional"),
  };
  const routeFieldsVisible = policies.originRegion.isActive || policies.pickupAddress.isActive ||
    policies.destinationRegion.isActive || policies.destinationWarehouse.isActive || policies.destinationNote.isActive;
  const cargoFieldsVisible = policies.cargoDescription.isActive || policies.notes.isActive ||
    policies.pieces.isActive || policies.weight.isActive || policies.length.isActive ||
    policies.width.isActive || policies.height.isActive || policies.volume.isActive;
  const cargoMetricsVisible = policies.pieces.isActive || policies.weight.isActive ||
    policies.length.isActive || policies.width.isActive || policies.height.isActive || policies.volume.isActive;
  const volumeCanAutoCalculate = policies.pieces.isActive && policies.length.isActive &&
    policies.width.isActive && policies.height.isActive;
  useEffect(() => {
    if (!compatibleWorkflows.some((workflow) => workflow.id === workflowDefinitionId)) {
      setWorkflowDefinitionId(compatibleWorkflows[0]?.id || "");
    }
  }, [roadLoadType, workflowDefinitionId, compatibleWorkflows]);
  useEffect(()=>{
    if(formError)errorSummaryRef.current?.focus();
  },[formError]);
  const selectCustomer = (id: string) => {
    setCustomerId(id);
    const customer = loaderData.customers.find((item) => item.id === id);
    setPickupAddress(customer?.pickup_address || "");
    setCustomerContactName(customer?.contact_name || "");
    setCustomerContactPhone(customer?.contact_phone || "");
  };
  const selectRoadLoadType = (value: "" | "ltl" | "ftl") => {
    setRoadLoadType(value);
    setWorkflowDefinitionId("");
  };
  return <Form method="post" encType="multipart/form-data" className="prototype-quote-form" data-keyboard-submit data-enter-flow>
    <input type="hidden" name="intent" value="create"/>
    {formError && <div ref={errorSummaryRef} className="alert error" role="alert" tabIndex={-1}><strong>报价尚未保存</strong><span>{formError}</span><small>已填写内容仍保留在当前弹窗，请按提示修改后重试。</small></div>}
    <div className="quote-form-note"><b>第 1 步 · 询价报价</b>　选择整车或拼车后加载对应流程；首次保存即锁定所选版本，后续发布新版本不会改动本报价。</div>
    <div className="quote-ledger">
    <QuoteLedgerSection className="quote-plan-section" title="客户与运输方案" note="报价确认后不再重复创建订单">
      <div className="quote-field-grid quote-plan-grid">
        <Field label="客户"><select className="control" name="customerId" value={customerId} onChange={(event) => selectCustomer(event.target.value)} required><option value="">请选择客户</option>{loaderData.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
        {policies.contactName.isActive && <Field label="客户联系人"><ContactCombobox name="customerContactName" value={customerContactName} contacts={selectedCustomerContacts} mode="name" required={policies.contactName.isRequired} onChange={(value, contact) => { setCustomerContactName(value); if (contact?.phone) setCustomerContactPhone(contact.phone); }} /></Field>}
        {policies.contactPhone.isActive && <Field label="联系电话"><ContactCombobox name="customerContactPhone" value={customerContactPhone} contacts={selectedCustomerContacts} mode="phone" required={policies.contactPhone.isRequired} onChange={(value, contact) => { setCustomerContactPhone(value); if (contact) setCustomerContactName(contact.name); }} /></Field>}
        {policies.salesperson.isActive && <Field label="业务员"><select className="control" name="salespersonId" defaultValue={loaderData.current.userId} required={policies.salesperson.isRequired}><option value="">请选择业务员</option>{loaderData.users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select></Field>}
        <Field label="运输方式"><select className="control" name="transportMode" defaultValue="ROAD" required><option value="ROAD">汽运</option><option value="RAIL" disabled>铁运（流程未开放）</option><option value="AIR" disabled>空运（流程未开放）</option></select></Field>
        <Field label="订单类型"><select className="control" name="roadLoadType" value={roadLoadType} onChange={(event) => selectRoadLoadType(event.target.value as "" | "ltl" | "ftl")} required><option value="" disabled>请选择订单类型</option><option value="ltl">拼车</option><option value="ftl">整车</option></select></Field>
        {policies.customsMode.isActive && <Field label="清关办理方式"><select className="control" name="customsClearanceMode" defaultValue="company" required={policies.customsMode.isRequired}><option value="company">公司代办清关</option><option value="customer">客户自理清关</option></select></Field>}
        <Field label="工作流版本"><select className="control" name="workflowDefinitionId" value={workflowDefinitionId} onChange={(event) => setWorkflowDefinitionId(event.target.value)} disabled={!roadLoadType} required><option value="">{!roadLoadType ? "请先选择订单类型" : compatibleWorkflows.length ? "请选择工作流版本" : "当前类型暂无可用工作流"}</option>{compatibleWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · v{workflow.version_number}{workflow.lifecycle_status === "published" ? " · 当前发布" : " · 历史版本"}</option>)}</select></Field>
      </div>
    </QuoteLedgerSection>
    <QuoteLedgerSection className="quote-workflow-fields-section" title="工作流配置项" note={selectedWorkflow ? `${selectedWorkflow.name} v${selectedWorkflow.version_number} · 随订单类型和版本切换` : roadLoadType ? "请先选择工作流版本" : "请先选择订单类型"}>
      {!selectedWorkflow
        ? <div className="quote-workflow-empty">选择订单类型后，系统将自动载入该类型当前发布的工作流。</div>
        : selectedCustomWorkflowFields.length
          ? <QuotationWorkflowFieldInputs fields={selectedCustomWorkflowFields} values={[]} customers={loaderData.customers} warehouses={loaderData.warehouses}/>
          : <div className="quote-workflow-empty">当前版本没有额外自定义项；下方标准报价字段的显示与必填状态已由本工作流实时控制。</div>}
    </QuoteLedgerSection>
    {routeFieldsVisible && <QuoteLedgerSection className="quote-route-section" title="运输路线" note="地区按国家 / 地区 → 省 / 州 → 城市逐级选择">
      <div className="quote-route-matrix" role="group" aria-label="报价运输路线">
        <div className="quote-route-matrix-row quote-route-matrix-head" aria-hidden="true">
          <span>填写项目</span>
          <b>起运信息</b>
          <b>目的信息</b>
        </div>
        <div className="quote-route-matrix-row">
          <span className="quote-route-matrix-label">地区</span>
          <div className="quote-route-matrix-cell" data-column="起运信息">{policies.originRegion.isActive
            ? <GeoCascadeFields key={`origin-${customerId}`} prefix="origin" countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} initialCountry={selectedCustomer?.pickup_country_code} initialProvince={selectedCustomer?.pickup_state_code} initialCity={selectedCustomer?.pickup_city} required={policies.originRegion.isRequired} />
            : <span className="muted">工作流已隐藏</span>}</div>
          <div className="quote-route-matrix-cell" data-column="目的信息">{policies.destinationRegion.isActive
            ? <GeoCascadeFields prefix="destination" countries={loaderData.countries} provinces={loaderData.provinces} cities={loaderData.cities} required={policies.destinationRegion.isRequired} />
            : <span className="muted">工作流已隐藏</span>}</div>
        </div>
        <div className="quote-route-matrix-row">
          <span className="quote-route-matrix-label">交接地点</span>
          {policies.pickupAddress.isActive
            ? <Field label="提货地址" className="quote-route-matrix-cell quote-route-address"><textarea className="control textarea" name="pickupAddress" rows={2} value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} required={policies.pickupAddress.isRequired} /></Field>
            : <div className="quote-route-matrix-cell quote-route-address"><span className="muted">提货地址已隐藏</span></div>}
          <div className="quote-route-matrix-cell quote-route-destination-details">
            {policies.destinationWarehouse.isActive && <Field label="目的仓库" className="quote-route-warehouse"><select className="control quote-warehouse-select" name="destinationWarehouseId" required={policies.destinationWarehouse.isRequired}><option value="">请选择境外目的仓</option>{loaderData.warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></Field>}
            {policies.destinationNote.isActive && <Field label="目的地备注" className="quote-route-note"><textarea className="control textarea" name="destinationWarehouseNote" rows={2} required={policies.destinationNote.isRequired} /></Field>}
          </div>
        </div>
      </div>
    </QuoteLedgerSection>}
    {cargoFieldsVisible && <QuoteLedgerSection title="货物预估与报价说明" note="货物数据为预估值，仓库收货后登记实际数据">
      <div className="quote-description-grid">
        {policies.cargoDescription.isActive && <Field label="货物描述"><textarea className="control textarea" name="cargoDescription" rows={3} placeholder="填写货物名称、品类、材质、用途等说明" required={policies.cargoDescription.isRequired} /></Field>}
        {policies.notes.isActive && <Field label="报价备注"><textarea className="control textarea" name="notes" rows={3} placeholder="填写报价范围、特殊约定或其他说明" required={policies.notes.isRequired} /></Field>}
      </div>
      {cargoMetricsVisible && <div className="quote-cargo-grid">
        <div className="table-wrap quote-cargo-metrics-table"><table className="inline-table"><thead><tr>
          {policies.pieces.isActive && <th>预计件数</th>}
          {policies.weight.isActive && <th>预计重量 KG</th>}
          {policies.length.isActive && <th>预计长度 CM</th>}
          {policies.width.isActive && <th>预计宽度 CM</th>}
          {policies.height.isActive && <th>预计高度 CM</th>}
          {policies.volume.isActive && <th>预计体积 CBM{volumeCanAutoCalculate ? "（自动计算）" : ""}</th>}
        </tr></thead><tbody><tr>
          {policies.pieces.isActive && <td><input aria-label="预计件数" className="control" name="pieces" type="number" min="1" value={pieces} onChange={(event) => setPieces(event.target.value)} required={policies.pieces.isRequired}/></td>}
          {policies.weight.isActive && <td><input aria-label="预计重量 KG" className="control" name="weight" type="number" min="0.001" step="0.001" required={policies.weight.isRequired}/></td>}
          {policies.length.isActive && <td><input aria-label="预计长度 CM" className="control" name="length" type="number" min="0.01" step="0.01" value={lengthCm} onChange={(event) => setLengthCm(event.target.value)} required={policies.length.isRequired}/></td>}
          {policies.width.isActive && <td><input aria-label="预计宽度 CM" className="control" name="width" type="number" min="0.01" step="0.01" value={widthCm} onChange={(event) => setWidthCm(event.target.value)} required={policies.width.isRequired}/></td>}
          {policies.height.isActive && <td><input aria-label="预计高度 CM" className="control" name="height" type="number" min="0.01" step="0.01" value={heightCm} onChange={(event) => setHeightCm(event.target.value)} required={policies.height.isRequired}/></td>}
          {policies.volume.isActive && <td>{volumeCanAutoCalculate
            ? <input aria-label="预计体积 CBM" className="control quote-calculated-volume" name="volume" type="number" min="0.0001" step="0.0001" value={calculatedVolume} readOnly required={policies.volume.isRequired}/>
            : <input aria-label="预计体积 CBM" className="control" name="volume" type="number" min="0.0001" step="0.0001" required={policies.volume.isRequired}/>}</td>}
        </tr></tbody></table></div>
      </div>}
    </QuoteLedgerSection>}
    {(policies.charges.isActive || policies.validUntil.isActive) && <QuoteLedgerSection
      title="客户应收费用"
      note="接受后直接继承到订单结算"
      action={policies.charges.isActive ? <button className="btn quote-charge-add" type="button" onClick={() => setCharges((rows) => [...rows, { name: transportChargeNameOptions[0]?.[0] || "国际汽运费", quantity: 1, unitPrice: 0, notes: "" }])}>＋ 添加费用</button> : undefined}
    >
      {policies.charges.isActive && <><div className="table-wrap quote-charge-table-wrap"><table className="inline-table quote-charge-table"><thead><tr><th>费用名称</th><th>数量</th><th>单价</th><th>金额</th><th>备注</th><th>操作</th></tr></thead><tbody>{charges.map((charge, index) => <tr key={index}><td><select className="control" name="chargeName" value={charge.name} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} required={policies.charges.isRequired}>{transportChargeNameOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><input className="control" name="chargeQuantity" type="number" min="0.01" step="0.01" value={charge.quantity} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: Number(event.target.value) } : row))} required={policies.charges.isRequired}/></td><td><input className="control" name="chargeUnitPrice" type="number" min="0.01" step="0.01" value={charge.unitPrice} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, unitPrice: Number(event.target.value) } : row))} required={policies.charges.isRequired}/></td><td><b>{(charge.quantity * charge.unitPrice).toLocaleString()}</b></td><td><input className="control" name="chargeNotes" value={charge.notes} onChange={(event) => setCharges((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, notes: event.target.value } : row))}/></td><td><button className="btn danger" type="button" disabled={charges.length === 1} onClick={() => setCharges((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</button></td></tr>)}</tbody></table></div>
      <div className="quote-charge-summary"><small>共 {charges.length} 个费用项目，系统按“数量 × 单价”自动汇总</small><strong>报价总额 CNY {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div></>}
      {policies.validUntil.isActive && <div className="quote-validity-row"><Field label="报价有效期"><input className="control" name="validUntil" type="date" required={policies.validUntil.isRequired}/></Field></div>}
    </QuoteLedgerSection>}
    </div>
    <div className="modal-form-actions"><button className="btn primary large" disabled={busy}>保存报价并等待客户确认</button></div>
  </Form>;
}

function QuotationNativeWorkflowInputs({
  quote,
  fields,
  charges: initialCharges,
  users,
  warehouses,
  countries,
  provinces,
  cities,
}: {
  quote: Quote;
  fields: QuotationWorkflowField[];
  charges: QuoteCharge[];
  users: UserOption[];
  warehouses: WarehouseOption[];
  countries: GeoOption[];
  provinces: GeoOption[];
  cities: GeoOption[];
}) {
  const policy = (key: QuotationNativeFieldKey, fallback: "required" | "optional") =>
    quotationWorkflowFieldPolicy(fields,key,fallback);
  const p = {
    contactName:policy("quotation_customer_contact_name","required"),
    contactPhone:policy("quotation_customer_contact_phone","required"),
    salesperson:policy("quotation_salesperson_user_id","required"),
    customs:policy("quotation_customs_clearance_mode","required"),
    origin:policy("quotation_origin_region","required"),
    pickup:policy("quotation_pickup_address","required"),
    destination:policy("quotation_destination_region","required"),
    warehouse:policy("quotation_destination_warehouse_id","required"),
    warehouseNote:policy("quotation_destination_warehouse_note","optional"),
    cargo:policy("quotation_cargo_description","required"),
    notes:policy("quotation_notes","optional"),
    pieces:policy("quotation_pieces","required"),
    weight:policy("quotation_gross_weight_kg","required"),
    length:policy("quotation_length_cm","required"),
    width:policy("quotation_width_cm","required"),
    height:policy("quotation_height_cm","required"),
    volume:policy("quotation_volume_cbm","required"),
    charges:policy("quotation_charge_items","required"),
    validUntil:policy("quotation_valid_until","optional"),
  };
  const [chargeRows,setChargeRows] = useState(() => initialCharges.length
    ? initialCharges.map((charge) => ({
        id:charge.id,
        name:charge.description,
        quantity:Number(charge.quantity),
        unitPrice:Number(charge.unit_price),
        notes:charge.notes || "",
      }))
    : [{ id:"",name:transportChargeNameOptions[0]?.[0] || "国际汽运费",quantity:1,unitPrice:0,notes:"" }]);
  const anyParty = p.contactName.isActive || p.contactPhone.isActive || p.salesperson.isActive || p.customs.isActive;
  const anyRoute = p.origin.isActive || p.pickup.isActive || p.destination.isActive || p.warehouse.isActive || p.warehouseNote.isActive;
  const anyCargo = p.cargo.isActive || p.notes.isActive || p.pieces.isActive || p.weight.isActive || p.length.isActive || p.width.isActive || p.height.isActive || p.volume.isActive;
  return <div className="quote-native-workflow-inputs">
    {anyParty && <QuoteLedgerSection title="客户与经办" note="以下项目直接保存回本报价，不写入扩展字段表">
      <div className="quote-field-grid">
        {p.contactName.isActive && <Field label="客户联系人"><input className="control" name="customerContactName" defaultValue={quote.customer_contact_name || ""} required={p.contactName.isRequired}/></Field>}
        {p.contactPhone.isActive && <Field label="联系电话"><input className="control" name="customerContactPhone" type="tel" defaultValue={quote.customer_contact_phone || ""} required={p.contactPhone.isRequired}/></Field>}
        {p.salesperson.isActive && <Field label="业务员"><select className="control" name="salespersonId" defaultValue={quote.salesperson_user_id || ""} required={p.salesperson.isRequired}><option value="">请选择业务员</option>{users.map((user) => <option key={user.id} value={user.id}>{user.display_name} · {user.email}</option>)}</select></Field>}
        {p.customs.isActive && <Field label="清关办理方式"><select className="control" name="customsClearanceMode" defaultValue={quote.customs_clearance_mode || "company"} required={p.customs.isRequired}><option value="company">公司代办清关</option><option value="customer">客户自理清关</option></select></Field>}
      </div>
    </QuoteLedgerSection>}
    {anyRoute && <QuoteLedgerSection title="运输路线" note="补录后接受报价时按工作流当前规则重新校验">
      <div className="quote-route-matrix" role="group" aria-label="补充报价运输路线">
        <div className="quote-route-matrix-row quote-route-matrix-head" aria-hidden="true"><span>填写项目</span><b>起运信息</b><b>目的信息</b></div>
        <div className="quote-route-matrix-row"><span className="quote-route-matrix-label">地区</span>
          <div className="quote-route-matrix-cell">{p.origin.isActive && <GeoCascadeFields prefix="origin" countries={countries} provinces={provinces} cities={cities} initialCountry={quote.origin_country} initialProvince={quote.origin_state} initialCity={quote.origin_city} required={p.origin.isRequired}/>}</div>
          <div className="quote-route-matrix-cell">{p.destination.isActive && <GeoCascadeFields prefix="destination" countries={countries} provinces={provinces} cities={cities} initialCountry={quote.destination_country} initialProvince={quote.destination_state} initialCity={quote.destination_city} required={p.destination.isRequired}/>}</div>
        </div>
        <div className="quote-route-matrix-row"><span className="quote-route-matrix-label">交接地点</span>
          <div className="quote-route-matrix-cell">{p.pickup.isActive && <Field label="提货地址"><textarea className="control textarea" name="pickupAddress" rows={2} defaultValue={quote.pickup_address || ""} required={p.pickup.isRequired}/></Field>}</div>
          <div className="quote-route-matrix-cell quote-route-destination-details">
            {p.warehouse.isActive && <Field label="目的仓库"><select className="control" name="destinationWarehouseId" defaultValue={quote.destination_warehouse_id || ""} required={p.warehouse.isRequired}><option value="">请选择境外目的仓</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></Field>}
            {p.warehouseNote.isActive && <Field label="目的地备注"><textarea className="control textarea" name="destinationWarehouseNote" rows={2} defaultValue={quote.destination_warehouse_note || ""} required={p.warehouseNote.isRequired}/></Field>}
          </div>
        </div>
      </div>
    </QuoteLedgerSection>}
    {anyCargo && <QuoteLedgerSection title="货物与预估" note="只补录工作流当前显示的原生字段">
      <div className="quote-description-grid">
        {p.cargo.isActive && <Field label="货物描述"><textarea className="control textarea" name="cargoDescription" rows={2} defaultValue={quote.cargo_description || ""} required={p.cargo.isRequired}/></Field>}
        {p.notes.isActive && <Field label="报价备注"><textarea className="control textarea" name="notes" rows={2} defaultValue={quote.notes || ""} required={p.notes.isRequired}/></Field>}
      </div>
      <div className="quote-field-grid">
        {p.pieces.isActive && <Field label="预计件数"><input className="control" name="pieces" type="number" min="1" defaultValue={quote.pieces} required={p.pieces.isRequired}/></Field>}
        {p.weight.isActive && <Field label="预计重量 KG"><input className="control" name="weight" type="number" min="0.001" step="0.001" defaultValue={quote.gross_weight_kg || ""} required={p.weight.isRequired}/></Field>}
        {p.length.isActive && <Field label="预计长度 CM"><input className="control" name="length" type="number" min="0.01" step="0.01" defaultValue={quote.estimated_length_cm || ""} required={p.length.isRequired}/></Field>}
        {p.width.isActive && <Field label="预计宽度 CM"><input className="control" name="width" type="number" min="0.01" step="0.01" defaultValue={quote.estimated_width_cm || ""} required={p.width.isRequired}/></Field>}
        {p.height.isActive && <Field label="预计高度 CM"><input className="control" name="height" type="number" min="0.01" step="0.01" defaultValue={quote.estimated_height_cm || ""} required={p.height.isRequired}/></Field>}
        {p.volume.isActive && <Field label="预计体积 CBM"><input className="control" name="volume" type="number" min="0.0001" step="0.0001" defaultValue={quote.volume_cbm || ""} required={p.volume.isRequired}/></Field>}
      </div>
    </QuoteLedgerSection>}
    {(p.charges.isActive || p.validUntil.isActive) && <QuoteLedgerSection title="费用与有效期" note="费用修改后自动重新汇总报价总额">
      {p.charges.isActive && <div className="table-wrap"><table className="inline-table quote-charge-table"><thead><tr><th>费用名称</th><th>数量</th><th>单价</th><th>备注</th><th>操作</th></tr></thead><tbody>{chargeRows.map((charge,index) => <tr key={index}>
        <td><input type="hidden" name="chargeId" value={charge.id}/><select className="control" name="chargeName" value={charge.name} onChange={(event) => setChargeRows((rows) => rows.map((row,i) => i === index ? {...row,name:event.target.value} : row))} required={p.charges.isRequired}>{transportChargeNameOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></td>
        <td><input className="control" name="chargeQuantity" type="number" min="0.01" step="0.01" value={charge.quantity} onChange={(event) => setChargeRows((rows) => rows.map((row,i) => i === index ? {...row,quantity:Number(event.target.value)} : row))} required={p.charges.isRequired}/></td>
        <td><input className="control" name="chargeUnitPrice" type="number" min="0.01" step="0.01" value={charge.unitPrice} onChange={(event) => setChargeRows((rows) => rows.map((row,i) => i === index ? {...row,unitPrice:Number(event.target.value)} : row))} required={p.charges.isRequired}/></td>
        <td><input className="control" name="chargeNotes" value={charge.notes} onChange={(event) => setChargeRows((rows) => rows.map((row,i) => i === index ? {...row,notes:event.target.value} : row))}/></td>
        <td><button className="btn danger" type="button" disabled={Boolean(charge.id) || chargeRows.length === 1} title={charge.id ? "既有费用保留审计标识，只允许修改；如需冲销请在订单结算阶段处理" : undefined} onClick={() => setChargeRows((rows) => rows.filter((_,i) => i !== index))}>删除</button></td>
      </tr>)}</tbody></table><button className="btn" type="button" onClick={() => setChargeRows((rows) => [...rows,{id:"",name:transportChargeNameOptions[0]?.[0] || "国际汽运费",quantity:1,unitPrice:0,notes:""}])}>＋ 添加费用</button></div>}
      {p.validUntil.isActive && <Field label="报价有效期"><input className="control" name="validUntil" type="date" defaultValue={quote.valid_until || ""} required={p.validUntil.isRequired}/></Field>}
    </QuoteLedgerSection>}
  </div>;
}

function QuotationWorkflowFieldInputs({ fields, values, customers, warehouses }: {
  fields: QuotationWorkflowField[];
  values: QuotationWorkflowFieldValue[];
  customers: CustomerOption[];
  warehouses: WarehouseOption[];
}) {
  return <div className="quote-workflow-field-grid">
    {fields.map((field) => {
      const name = quotationWorkflowFieldInputName(field.id);
      const existing = values.find((value) => value.field_id === field.id) || null;
      const options = parseQuotationWorkflowFieldOptions(field.options_text);
      const selectedValues = field.field_type === "multiselect"
        ? parseStoredMultipleValues(existing?.value_text)
        : [];
      const label = `${field.label}${field.is_required ? "" : "（选填）"}`;
      let control: React.ReactNode;
      if (field.field_type === "textarea") {
        control = <textarea className="control textarea" name={name} defaultValue={existing?.value_text || ""} rows={2} required={Boolean(field.is_required)}/>;
      } else if (field.field_type === "attachment") {
        control = <div className="quote-workflow-file-control">
          {existing?.file_name && <a href={`/admin/quotation-field-files/${existing.id}`} target="_blank" rel="noreferrer">已上传：{existing.file_name}</a>}
          <input className="control" name={name} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp" required={Boolean(field.is_required && !existing?.file_name)}/>
        </div>;
      } else if (field.field_type === "customer") {
        control = <select className="control" name={name} defaultValue={existing?.value_text || ""} required={Boolean(field.is_required)}><option value="">请选择客户</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>;
      } else if (field.field_type === "warehouse") {
        control = <select className="control" name={name} defaultValue={existing?.value_text || ""} required={Boolean(field.is_required)}><option value="">请选择仓库</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select>;
      } else if (field.field_type === "multiselect" && options.length) {
        control = <select className="control quote-workflow-multiselect" name={name} defaultValue={selectedValues} multiple required={Boolean(field.is_required)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
      } else if (field.field_type === "select" && options.length) {
        control = <select className="control" name={name} defaultValue={existing?.value_text || ""} required={Boolean(field.is_required)}><option value="">请选择</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
      } else {
        const type = field.field_type === "datetime" ? "datetime-local"
          : field.field_type === "date" ? "date"
            : ["number","amount"].includes(field.field_type) ? "number" : "text";
        control = <input className="control" name={name} type={type} step={type === "number" ? "any" : undefined} defaultValue={existing?.value_text || ""} required={Boolean(field.is_required)}/>;
      }
      return <Field key={field.id} label={label} className={field.field_type === "textarea" || field.field_type === "attachment" ? "span-2" : ""}>
        {control}
        {field.help_text && <small className="field-hint">{field.help_text}</small>}
      </Field>;
    })}
  </div>;
}

function parseStoredMultipleValues(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [value];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function QuoteLedgerSection({ title, note, action, className = "", children }: { title: string; note: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section className={`quote-ledger-section ${className}`}><div className="quote-ledger-heading"><b>{title}</b><div className="quote-section-heading"><span>{note}</span>{action}</div></div><div className="quote-ledger-body">{children}</div></section>;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function ContactCombobox({
  name,
  value,
  contacts,
  mode,
  required,
  onChange,
}: {
  name: string;
  value: string;
  contacts: CustomerContactOption[];
  mode: "name" | "phone";
  required: boolean;
  onChange: (value: string, contact?: CustomerContactOption) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `quote-${name}-options`;
  const selectableContacts = contacts.filter((contact) => mode === "name" || Boolean(contact.phone));
  const findContact = (nextValue: string) => selectableContacts.find((contact) => (
    mode === "name" ? contact.name === nextValue : contact.phone === nextValue
  ));
  return <div className="quote-contact-combobox">
    <input
      ref={inputRef}
      className="control"
      name={name}
      type={mode === "phone" ? "tel" : "text"}
      inputMode={mode === "phone" ? "tel" : undefined}
      pattern={mode === "phone" ? "[+0-9 \\(\\)\\-]{6,30}" : undefined}
      title={mode === "phone" ? "只能输入数字、空格、括号、短横线和开头的加号" : undefined}
      list={listId}
      value={value}
      placeholder={mode === "name" ? "选择或输入联系人" : "选择或输入联系电话"}
      onChange={(event) => onChange(event.target.value, findContact(event.target.value))}
      required={required}
    />
    <button
      type="button"
      title={contacts.length ? "展开客户联系人" : "该客户暂无联系人，可直接输入"}
      aria-label={contacts.length ? "展开客户联系人" : "该客户暂无联系人，可直接输入"}
      onClick={() => {
        inputRef.current?.focus();
        try {
          inputRef.current?.showPicker?.();
        } catch {
          // Some browsers expose showPicker but do not allow it for text inputs.
        }
      }}
    ><ChevronDown aria-hidden="true" size={14}/></button>
    <datalist id={listId}>
      {selectableContacts.map((contact) => <option key={`${name}-${contact.id}`} value={mode === "name" ? contact.name : contact.phone || ""}>{mode === "name" ? contact.phone || "未登记电话" : contact.name}{contact.is_primary ? " · 主要联系人" : ""}</option>)}
    </datalist>
  </div>;
}

function GeoCascadeFields({
  prefix,
  countries,
  provinces,
  cities,
  initialCountry = "",
  initialProvince = "",
  initialCity = "",
  required,
}: {
  prefix: "origin" | "destination";
  countries: GeoOption[];
  provinces: GeoOption[];
  cities: GeoOption[];
  initialCountry?: string | null;
  initialProvince?: string | null;
  initialCity?: string | null;
  required: boolean;
}) {
  const initialCountryCode = countries.find((option) => option.code === initialCountry || option.name === initialCountry)?.code || "";
  const initialProvinceCode = provinces.find((option) => option.parent_code === initialCountryCode && (option.code === initialProvince || option.name === initialProvince))?.code || "";
  const initialCityCode = cities.find((option) => option.parent_code === initialProvinceCode && (option.code === initialCity || option.name === initialCity))?.code || "";
  const [countryCode, setCountryCode] = useState(initialCountryCode);
  const [provinceCode, setProvinceCode] = useState(initialProvinceCode);
  const [cityCode, setCityCode] = useState(initialCityCode);
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const countryOptions = countries;
  const provinceOptions = provinces.filter((option) => option.parent_code === countryCode);
  const cityOptions = cities.filter((option) => option.parent_code === provinceCode);
  const countryName = countries.find((option) => option.code === countryCode)?.name || "";
  const provinceName = provinces.find((option) => option.code === provinceCode)?.name || "";
  const cityName = cities.find((option) => option.code === cityCode)?.name || "";
  const placeLabel = prefix === "origin" ? "起运" : "目的";
  const selectionLabel = [countryName, provinceName, cityName].filter(Boolean).join(" / ");
  const panelId = `${prefix}-geo-cascade`;

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return <div ref={pickerRef} className={`quote-geo-picker ${cityCode ? "is-complete" : "is-incomplete"} ${isOpen ? "is-open" : ""}`}>
    <button
      aria-controls={panelId}
      aria-expanded={isOpen}
      className="quote-geo-trigger"
      type="button"
      onClick={() => setIsOpen((current) => !current)}
    >
      <span className="quote-geo-trigger-label">{placeLabel}地区</span>
      <b>{selectionLabel || "请选择国家 / 地区"}</b>
      <ChevronDown aria-hidden="true" size={14}/>
    </button>
    {isOpen && <div className="quote-geo-cascade" id={panelId} role="group" aria-label={`选择${placeLabel}地区`}>
      <GeoCascadePanel
        title="1  国家 / 地区"
        options={countryOptions}
        activeValue={countryCode}
        emptyText="暂无国家 / 地区数据"
        showNext
        onSelect={(option) => {
          setCountryCode(option.code);
          setProvinceCode("");
          setCityCode("");
        }}
      />
      {countryCode && <GeoCascadePanel
        title="2  省 / 州"
        options={provinceOptions}
        activeValue={provinceCode}
        emptyText="该国家暂无省 / 州数据"
        showNext
        onSelect={(option) => {
          setProvinceCode(option.code);
          setCityCode("");
        }}
      />}
      {provinceCode && <GeoCascadePanel
        title="3  城市"
        options={cityOptions}
        activeValue={cityCode}
        emptyText="该省 / 州暂无城市数据"
        onSelect={(option) => {
          setCityCode(option.code);
          setIsOpen(false);
        }}
      />}
    </div>}
    <select
      aria-label={`${placeLabel}国家 / 地区校验`}
      className="quote-geo-native-validator"
      name={`${prefix}Country`}
      value={countryName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required={required}
      tabIndex={-1}
    ><option value=""/>{countryName && <option value={countryName}>{countryName}</option>}</select>
    <select
      aria-label={`${placeLabel}省 / 州校验`}
      className="quote-geo-native-validator"
      name={`${prefix}State`}
      value={provinceName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required={required}
      tabIndex={-1}
    ><option value=""/>{provinceName && <option value={provinceName}>{provinceName}</option>}</select>
    <select
      aria-label={`${placeLabel}城市校验`}
      className="quote-geo-native-validator"
      name={`${prefix}City`}
      value={cityName}
      onChange={() => undefined}
      onInvalid={() => setIsOpen(true)}
      required={required}
      tabIndex={-1}
    ><option value=""/>{cityName && <option value={cityName}>{cityName}</option>}</select>
  </div>;
}

function GeoCascadePanel({
  title,
  options,
  activeValue,
  emptyText,
  showNext = false,
  onSelect,
}: {
  title: string;
  options: GeoOption[];
  activeValue: string;
  emptyText: string;
  showNext?: boolean;
  onSelect: (option: GeoOption) => void;
}) {
  return <section className="quote-geo-panel">
    <header>{title}</header>
    {options.length > 0
      ? <div className="quote-geo-panel-options" role="listbox" aria-label={title}>{options.map((option) => <button
          aria-selected={activeValue === option.code}
          className={activeValue === option.code ? "selected" : ""}
          key={`${title}-${option.code}`}
          role="option"
          type="button"
          onClick={() => onSelect(option)}
        ><span>{option.name}</span>{showNext && <ChevronRight aria-hidden="true" size={13}/>}</button>)}</div>
      : <p>{emptyText}</p>}
  </section>;
}

async function geoOptions(organizationId: string, level: string) {
  return (await env.DB.prepare(
    "SELECT code,name,parent_code FROM reference_data WHERE organization_id=? AND category=? AND status='active' ORDER BY sort_order,name",
  ).bind(organizationId,level).all<GeoOption>()).results ?? [];
}

async function assertGeoHierarchy(organizationId: string, countryName: string, provinceName: string, cityName: string, label: string) {
  const row = await env.DB.prepare(
    `SELECT city.code
     FROM reference_data country
     JOIN reference_data province
       ON province.organization_id=country.organization_id
      AND province.category='province'
      AND province.parent_code=country.code
      AND province.status='active'
     JOIN reference_data city
       ON city.organization_id=province.organization_id
      AND city.category='city'
      AND city.parent_code=province.code
      AND city.status='active'
     WHERE country.organization_id=?
       AND country.category='country'
       AND country.status='active'
       AND country.name=?
       AND province.name=?
       AND city.name=?
     LIMIT 1`,
  ).bind(organizationId, countryName, provinceName, cityName).first();
  if (!row) throw new Error(`${label}的国家、省州和城市不属于同一条地理层级，请重新选择`);
}

function statusLabel(status: Quote["lifecycle_status"]) {
  return { pending: "待客户确认", accepted: "客户已接受", withdrawn: "接受已撤回", void: "已作废" }[status];
}

function statusTone(status: Quote["lifecycle_status"]) {
  if (status === "accepted") return "green";
  if (status === "pending") return "orange";
  if (status === "void") return "red";
  return "blue";
}

export function meta() { return [{ title: "询价与报价 | 新翎航 TMS" }]; }
