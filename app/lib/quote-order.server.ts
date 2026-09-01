import { env } from "cloudflare:workers";
import {
  ensureOrderModules,
  syncCostsModuleStatus,
  syncOrderWorkflowSnapshot,
} from "./order-modules.server";
import {
  ensureWorkflowForBusinessType,
  recordWorkflowEvent,
} from "./business-workflow.server";
import { nextDocumentNumber } from "./documents.server";
import { ensureShipmentForOrder } from "./shipment-sync.server";

type QuoteReceivable = {
  id: string;
  quote_number: string;
  customer_name: string;
  currency: string;
  total_amount: number;
};

type QuoteCharge = {
  id: string;
  charge_code: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  exchange_rate: number;
  sort_order: number;
};

type AcceptedQuote = {
  id: string;
  quote_number: string;
  customer_id: string;
  customer_name: string;
  customer_contact_name: string | null;
  customer_contact_phone: string | null;
  salesperson_user_id: string | null;
  workflow_definition_id: string | null;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  pickup_address: string | null;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  destination_warehouse_id: string | null;
  destination_warehouse_note: string | null;
  warehouse_name: string | null;
  warehouse_address: string | null;
  transport_mode: string;
  road_load_type: "ftl" | "ltl";
  service_level: string | null;
  cargo_description: string;
  pieces: number;
  gross_weight_kg: number;
  volume_cbm: number;
  estimated_length_cm: number;
  estimated_width_cm: number;
  estimated_height_cm: number;
  customs_clearance_mode: "company" | "customer";
  currency: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  notes: string | null;
};

export type CreatedOrder = { id: string; orderNumber: string; created: boolean };

const defaultServices: Record<string, string> = {
  pickup: "提货",
  warehouse: "仓储",
  packing: "包装",
  customs: "报关",
  destination_customs: "目的地清关",
  destination_warehouse: "目的地仓储",
  other: "其他服务",
};

export async function createOrderFromAcceptedQuote(input: {
  organizationId: string;
  quotationId: string;
  actorUserId: string;
  source: "admin" | "portal";
  request?: Request;
}): Promise<CreatedOrder> {
  const quote = await loadAcceptedQuote(input.organizationId, input.quotationId);
  if (!quote) throw new Error("报价无效或尚未被接受");

  const existing = await env.DB.prepare(
    "SELECT id,order_number,workflow_instance_id FROM transport_orders WHERE organization_id=? AND quotation_id=? LIMIT 1",
  ).bind(input.organizationId, input.quotationId).first<{
    id: string;
    order_number: string;
    workflow_instance_id: string | null;
  }>();
  if (existing) {
    await env.DB.prepare(
      `UPDATE transport_orders
       SET quote_withdrawn=0,status=CASE WHEN status='cancelled' THEN 'draft' ELSE status END,
           current_step_code=CASE WHEN status='cancelled' OR quote_withdrawn=1 OR current_step_code='quote_withdrawn' THEN 'order_creation' ELSE current_step_code END,
           current_step_name=CASE WHEN status='cancelled' OR quote_withdrawn=1 OR current_step_code='quote_withdrawn' THEN '委托资料补充' ELSE current_step_name END,
           updated_at=?
       WHERE id=? AND organization_id=?`,
    ).bind(new Date().toISOString(), existing.id, input.organizationId).run();
    await repairGeneratedOrder({ ...input, orderId: existing.id, orderNumber: existing.order_number, quote });
    return { id: existing.id, orderNumber: existing.order_number, created: false };
  }

  const [contact, pickupAddress, chargeRows] = await Promise.all([
    env.DB.prepare(
      "SELECT name,phone FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,created_at LIMIT 1",
    ).bind(quote.customer_id).first<{ name: string; phone: string | null }>(),
    env.DB.prepare(
      `SELECT id,address_line1 FROM customer_addresses
       WHERE customer_id=? AND (?='' OR address_line1=?)
       ORDER BY is_default DESC,created_at
       LIMIT 1`,
    ).bind(
      quote.customer_id,quote.pickup_address || "",quote.pickup_address || "",
    ).first<{ id: string; address_line1: string }>(),
    env.DB.prepare(
      "SELECT id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order FROM quotation_charges WHERE quotation_id=? ORDER BY sort_order,id",
    ).bind(quote.id).all<QuoteCharge>(),
  ]);
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const orderNumber = await nextDocumentNumber(input.organizationId, "order");
  const cargoId = crypto.randomUUID();
  const pickupAddressText = quote.pickup_address || pickupAddress?.address_line1 || "待补充提货地址";
  const destinationAddress = quote.warehouse_address || quote.destination_warehouse_note || quote.warehouse_name || quote.destination_city || "待补充目的地";
  const contactName = quote.customer_contact_name || contact?.name || quote.customer_name;
  const contactPhone = quote.customer_contact_phone || contact?.phone || null;
  const pieces = Math.max(1, Number(quote.pieces || 1));

  const snapshotJson = JSON.stringify({
    quoteNumber: quote.quote_number,
    roadLoadType: quote.road_load_type,
    originCountry: quote.origin_country,
    originState: quote.origin_state,
    originCity: quote.origin_city,
    pickupAddress: pickupAddressText,
    customerContactName: contactName,
    customerContactPhone: contactPhone,
    destinationCountry: quote.destination_country,
    destinationState: quote.destination_state,
    destinationCity: quote.destination_city,
    destinationWarehouseId: quote.destination_warehouse_id,
    estimatedLengthCm: quote.estimated_length_cm,
    estimatedWidthCm: quote.estimated_width_cm,
    estimatedHeightCm: quote.estimated_height_cm,
    customsClearanceMode: quote.customs_clearance_mode,
    cargoDescription: quote.cargo_description,
    pieces: quote.pieces,
    grossWeightKg: quote.gross_weight_kg,
    volumeCbm: quote.volume_cbm,
    currency: quote.currency,
    subtotal: quote.subtotal,
    taxAmount: quote.tax_amount,
    totalAmount: quote.total_amount,
    salespersonUserId: quote.salesperson_user_id,
    workflowDefinitionId: quote.workflow_definition_id,
    notes: quote.notes,
    charges: chargeRows.results,
  });

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO transport_orders(
         id,organization_id,order_number,order_date,business_nature,business_type,
         overseas_warehouse_id,overseas_warehouse_address_note,customer_id,quotation_id,
         shipper_name,shipper_contact,shipper_phone,shipper_customer_id,pickup_address_id,
         origin_country,origin_state,origin_city,origin_address,
         consignee_name,consignee_contact,consignee_phone,
         destination_country,destination_state,destination_city,destination_address,
         cargo_description,pieces,gross_weight_kg,volume_cbm,transport_mode,service_level,
         status,source,special_instructions,created_by_user_id,salesperson_user_id,
         current_assignee_user_id,current_step_code,current_step_name,workflow_updated_at,
         created_at,updated_at,customs_clearance_mode,quote_withdrawn
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      orderId,input.organizationId,orderNumber,now.slice(0,10),"export",quote.road_load_type,
      quote.destination_warehouse_id,quote.destination_warehouse_note,quote.customer_id,quote.id,
       quote.customer_name,contactName,contactPhone,quote.customer_id,pickupAddress?.id || null,
       quote.origin_country,quote.origin_state,quote.origin_city,pickupAddressText,
      quote.customer_name,contactName,contactPhone,
      quote.destination_country,quote.destination_state,quote.destination_city,destinationAddress,
      quote.cargo_description,pieces,quote.gross_weight_kg,quote.volume_cbm,quote.transport_mode,quote.service_level,
      "draft",input.source,quote.notes,input.actorUserId,quote.salesperson_user_id,
      quote.salesperson_user_id,"order_creation","委托资料补充",now,
      now,now,quote.customs_clearance_mode,0,
    ),
    env.DB.prepare(
      `INSERT INTO order_cargo_items(
         id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,
         gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,
         volume_per_package_cbm,declared_value,currency,origin_country,notes,created_at,updated_at
       ) VALUES(?,?,?,?,?,'other',1,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
    ).bind(
      cargoId,input.organizationId,orderId,1,quote.cargo_description,pieces,
      quote.gross_weight_kg,quote.gross_weight_kg,quote.estimated_length_cm,quote.estimated_width_cm,
      quote.estimated_height_cm,quote.volume_cbm,quote.currency,quote.origin_country,"由已接受报价自动生成",now,now,
    ),
    env.DB.prepare(
      "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,1,?)",
    ).bind(crypto.randomUUID(),input.organizationId,orderId,cargoId,`${orderNumber}-P001`,now),
    env.DB.prepare(
      `INSERT INTO transport_order_quote_snapshots(
         order_id,organization_id,quotation_id,quote_number,road_load_type,currency,
         subtotal,tax_amount,total_amount,snapshot_json,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      orderId,input.organizationId,quote.id,quote.quote_number,quote.road_load_type,quote.currency,
      quote.subtotal,quote.tax_amount,quote.total_amount,snapshotJson,now,
    ),
    env.DB.prepare(
      `INSERT INTO order_workflow_history(
         id,organization_id,order_id,action_code,action_name,from_status,to_status,to_step_code,
         actor_user_id,assignee_user_id,notes,occurred_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),input.organizationId,orderId,"quote_accepted_auto_create","客户接受报价，系统自动创建订单",
      "draft","draft","order_creation",input.actorUserId,quote.salesperson_user_id,
      `来源报价 ${quote.quote_number}`,now,
    ),
    env.DB.prepare(
      `INSERT INTO order_workflow_history(
         id,organization_id,order_id,action_code,action_name,from_status,to_status,to_step_code,
         actor_user_id,notes,occurred_at
       ) VALUES(?,?,?,?,?,'draft','draft','order_creation',?,?,?)`,
    ).bind(
      `${orderId}:mark-label-generated`,input.organizationId,orderId,
      "order_mark_label_generated","客户接受报价，系统自动生成入仓唛头标签",
      input.actorUserId,`唛头号 ${orderNumber}（与订单号一致）`,now,
    ),
    ...Object.entries(defaultServices)
      .filter(([code]) => quote.customs_clearance_mode === "company" || code !== "destination_customs")
      .map(([code, name]) => env.DB.prepare(
        "INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES(?,?,?,?,?,?)",
      ).bind(crypto.randomUUID(),input.organizationId,orderId,code,name,now)),
    ...receivableStatements({ organizationId: input.organizationId, orderId, quote, charges: chargeRows.results, actorUserId: input.actorUserId, now }),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) {
      const raced = await env.DB.prepare(
        "SELECT id,order_number FROM transport_orders WHERE organization_id=? AND quotation_id=? LIMIT 1",
      ).bind(input.organizationId,input.quotationId).first<{ id: string; order_number: string }>();
      if (raced) return { id: raced.id, orderNumber: raced.order_number, created: false };
    }
    throw error;
  }

  try {
    await repairGeneratedOrder({ ...input, orderId, orderNumber, quote });
  } catch (error) {
    await rollbackGeneratedOrder(input.organizationId, orderId);
    throw error;
  }
  return { id: orderId, orderNumber, created: true };
}

async function loadAcceptedQuote(organizationId: string, quotationId: string) {
  return env.DB.prepare(
    `SELECT q.id,q.quote_number,q.customer_id,c.name customer_name,
            COALESCE(q.customer_contact_name,(SELECT cc.name FROM customer_contacts cc WHERE cc.customer_id=q.customer_id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1),c.name) customer_contact_name,
            COALESCE(q.customer_contact_phone,(SELECT cc.phone FROM customer_contacts cc WHERE cc.customer_id=q.customer_id ORDER BY cc.is_primary DESC,cc.created_at LIMIT 1)) customer_contact_phone,
            q.salesperson_user_id,q.workflow_definition_id,
            q.origin_country,q.origin_state,q.origin_city,q.pickup_address,
            q.destination_country,q.destination_state,q.destination_city,
            q.destination_warehouse_id,q.destination_warehouse_note,
            w.name warehouse_name,w.address warehouse_address,
            q.transport_mode,q.road_load_type,q.service_level,q.cargo_description,
            q.pieces,q.gross_weight_kg,q.volume_cbm,
            q.estimated_length_cm,q.estimated_width_cm,q.estimated_height_cm,
            q.customs_clearance_mode,q.currency,q.subtotal,q.tax_amount,q.total_amount,q.notes
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id AND c.organization_id=q.organization_id
       LEFT JOIN warehouses w ON w.id=q.destination_warehouse_id AND w.organization_id=q.organization_id
      WHERE q.id=? AND q.organization_id=?
        AND q.status='accepted' AND q.lifecycle_status='accepted'`,
  ).bind(quotationId, organizationId).first<AcceptedQuote>();
}

async function repairGeneratedOrder(input: {
  organizationId: string;
  quotationId: string;
  actorUserId: string;
  source: "admin" | "portal";
  request?: Request;
  orderId: string;
  orderNumber: string;
  quote: AcceptedQuote;
}) {
  const now = new Date().toISOString();
  const destinationAddress = input.quote.warehouse_address || input.quote.destination_warehouse_note || input.quote.warehouse_name || input.quote.destination_city;
  await env.DB.prepare(
    `UPDATE transport_orders
        SET shipper_contact=?,shipper_phone=?,consignee_contact=?,consignee_phone=?,
            requested_pickup_date=COALESCE(requested_pickup_date,?),
            destination_address=?,updated_at=?
      WHERE id=? AND organization_id=?`,
  ).bind(
    input.quote.customer_contact_name || input.quote.customer_name,
    input.quote.customer_contact_phone,
    input.quote.customer_contact_name || input.quote.customer_name,
    input.quote.customer_contact_phone,
    now,
    destinationAddress,
    now,
    input.orderId,
    input.organizationId,
  ).run();
  let workflowId: string;
  if (input.quote.workflow_definition_id) {
    const selectedWorkflow = await env.DB.prepare(
      `SELECT id FROM workflow_definitions
       WHERE id=? AND organization_id=?
         AND validation_status='valid' AND lifecycle_status IN ('published','retired')
         AND road_load_type=?`,
    ).bind(
      input.quote.workflow_definition_id,
      input.organizationId,
      input.quote.road_load_type,
    ).first<{ id: string }>();
    if (!selectedWorkflow) throw new Error("报价锁定的工作流版本无效或与订单类型不匹配");
    workflowId = selectedWorkflow.id;
  } else {
    workflowId = await ensureWorkflowForBusinessType(input.organizationId, input.quote.road_load_type);
  }
  const workflowInstanceId = await recordWorkflowEvent({
    organizationId: input.organizationId,
    event: "order.created",
    customerId: input.quote.customer_id,
    quotationId: input.quote.id,
    orderId: input.orderId,
    actorUserId: input.actorUserId,
    source: input.source,
    workflowId,
    metadata: { number: input.orderNumber, autoCreatedFromQuote: true },
  });
  if (workflowInstanceId) {
    await env.DB.prepare(
      "UPDATE transport_orders SET workflow_instance_id=? WHERE id=? AND organization_id=?",
    ).bind(workflowInstanceId,input.orderId,input.organizationId).run();
  }
  await ensureOrderModules(input.organizationId, input.orderId);
  await inheritAcceptedQuoteReceivables(input.organizationId, input.orderId, input.quote.id, input.actorUserId);
  await ensureShipmentForOrder({
    organizationId: input.organizationId,
    orderId: input.orderId,
    actorUserId: input.actorUserId,
    request: input.request,
  });
}

async function rollbackGeneratedOrder(organizationId: string, orderId: string) {
  const instance = await env.DB.prepare(
    `SELECT id,quotation_id FROM workflow_instances
     WHERE organization_id=? AND order_id=?`,
  ).bind(organizationId,orderId).first<{id:string;quotation_id:string|null}>();
  if (instance?.quotation_id) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workflow_instances SET order_id=NULL,current_step_key='quotation',status='active',
          completed_at=NULL,updated_at=? WHERE id=? AND organization_id=?`,
      ).bind(now,instance.id,organizationId),
      env.DB.prepare(
        `UPDATE workflow_instance_step_states
         SET status=CASE step_key WHEN 'quotation' THEN 'active' ELSE 'pending' END,
           completed_at=NULL,updated_at=? WHERE instance_id=?`,
      ).bind(now,instance.id),
      env.DB.prepare(
        `UPDATE workflow_instance_module_states
         SET status=CASE WHEN instance_step_state_id IN (
           SELECT id FROM workflow_instance_step_states WHERE instance_id=? AND step_key='quotation'
         ) THEN 'active' ELSE 'pending' END,updated_at=?
         WHERE instance_step_state_id IN (
           SELECT id FROM workflow_instance_step_states WHERE instance_id=?
         )`,
      ).bind(instance.id,now,instance.id),
      env.DB.prepare(
        `UPDATE workflow_instance_task_states
         SET status=CASE WHEN instance_module_state_id IN (
           SELECT ms.id FROM workflow_instance_module_states ms
           JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
           WHERE ss.instance_id=? AND ss.step_key='quotation'
         ) THEN 'active' ELSE 'pending' END,
         completed_by_user_id=NULL,completed_at=NULL,updated_at=?
         WHERE instance_module_state_id IN (
           SELECT ms.id FROM workflow_instance_module_states ms
           JOIN workflow_instance_step_states ss ON ss.id=ms.instance_step_state_id
           WHERE ss.instance_id=?
         )`,
      ).bind(instance.id,now,instance.id),
      env.DB.prepare(
        `INSERT INTO workflow_history(
          id,instance_id,step_key,step_name,actor_user_id,source,metadata,occurred_at
         ) VALUES(?,?,'quotation','询价报价',NULL,'system',?,?)`,
      ).bind(
        crypto.randomUUID(),instance.id,
        JSON.stringify({orderCreationRolledBack:true,orderId}),now,
      ),
    ]);
  } else {
    await env.DB.prepare("DELETE FROM workflow_instances WHERE organization_id=? AND order_id=?")
      .bind(organizationId,orderId).run();
  }
  await env.DB.prepare("DELETE FROM shipments WHERE organization_id=? AND order_id=?")
    .bind(organizationId,orderId).run();
  await env.DB.prepare("DELETE FROM transport_orders WHERE organization_id=? AND id=?")
    .bind(organizationId,orderId).run();
}

function receivableStatements(input: {
  organizationId: string;
  orderId: string;
  quote: AcceptedQuote;
  charges: QuoteCharge[];
  actorUserId: string;
  now: string;
}) {
  if (input.charges.length) {
    return input.charges.map((charge) => env.DB.prepare(
      `INSERT OR IGNORE INTO business_expenses(
         id,organization_id,order_id,direction,stage,charge_code,charge_name,
         counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
         base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
       ) VALUES(?,?,?,'receivable','estimated',?,?,?,?,?,?,?,?,?,?,?,?,?,'quotation_charge',?)`,
    ).bind(
      crypto.randomUUID(),input.organizationId,input.orderId,charge.charge_code,charge.description,
      input.quote.customer_name,input.quote.currency,charge.quantity,charge.unit_price,charge.amount,
      charge.exchange_rate,charge.amount * charge.exchange_rate,`继承已接受报价 ${input.quote.quote_number}`,
      input.actorUserId,input.now,input.now,charge.id,
    ));
  }
  return [env.DB.prepare(
    `INSERT OR IGNORE INTO business_expenses(
       id,organization_id,order_id,direction,stage,charge_code,charge_name,
       counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
       base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
     ) VALUES(?,?,?,'receivable','estimated','QUOTATION_TOTAL','报价应收',?,?,1,?,?,1,?,?,?,?,?,'quotation',?)`,
  ).bind(
    crypto.randomUUID(),input.organizationId,input.orderId,input.quote.customer_name,input.quote.currency,
    input.quote.total_amount,input.quote.total_amount,input.quote.total_amount,
    `继承已接受报价 ${input.quote.quote_number}`,input.actorUserId,input.now,input.now,input.quote.id,
  )];
}

export async function inheritAcceptedQuoteReceivables(
  organizationId: string,
  orderId: string,
  quotationId: string,
  actorUserId: string,
) {
  const quote = await env.DB.prepare(
    `SELECT q.id,q.quote_number,c.name customer_name,q.currency,q.total_amount
       FROM quotations q JOIN customers c ON c.id=q.customer_id
      WHERE q.id=? AND q.organization_id=?
        AND q.status='accepted' AND q.lifecycle_status='accepted'`,
  ).bind(quotationId, organizationId).first<QuoteReceivable>();
  if (!quote) throw new Error("报价无效或尚未被接受");
  const charges = await env.DB.prepare(
    `SELECT id,charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order
       FROM quotation_charges WHERE quotation_id=? ORDER BY sort_order,id`,
  ).bind(quotationId).all<QuoteCharge>();
  const now = new Date().toISOString();
  const acceptedQuote = await loadAcceptedQuote(organizationId, quotationId);
  if (!acceptedQuote) throw new Error("报价数据不完整");
  await env.DB.batch(receivableStatements({ organizationId, orderId, quote: acceptedQuote, charges: charges.results, actorUserId, now }));
  await syncCostsModuleStatus(organizationId, orderId, now);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}
