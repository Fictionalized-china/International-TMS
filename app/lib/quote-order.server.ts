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
};

type AcceptedQuote = {
  id: string;
  quote_number: string;
  customer_id: string;
  customer_name: string;
  salesperson_user_id: string | null;
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

type CreatedOrder = { id: string; orderNumber: string; created: boolean };

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
  const quote = await env.DB.prepare(
    `SELECT q.id,q.quote_number,q.customer_id,c.name customer_name,q.salesperson_user_id,
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
      WHERE q.id=? AND q.organization_id=? AND q.status='accepted'`,
  ).bind(input.quotationId, input.organizationId).first<AcceptedQuote>();
  if (!quote) throw new Error("报价无效或尚未接受");
  if (!quote.pickup_address || !quote.destination_warehouse_id)
    throw new Error("报价缺少提货地址或目的仓，不能自动创建订单");

  const existing = await env.DB.prepare(
    "SELECT id,order_number,workflow_instance_id FROM transport_orders WHERE organization_id=? AND quotation_id=? LIMIT 1",
  ).bind(input.organizationId, input.quotationId).first<{ id: string; order_number: string; workflow_instance_id: string | null }>();
  if (existing) {
    const repairNow = new Date().toISOString();
    await captureAcceptedQuoteSnapshot(input.organizationId,existing.id,quote,repairNow);
    let workflowInstanceId=existing.workflow_instance_id;
    if(!workflowInstanceId)workflowInstanceId=await recordWorkflowEvent({organizationId:input.organizationId,event:"order.created",customerId:quote.customer_id,quotationId:quote.id,orderId:existing.id,actorUserId:input.actorUserId,source:input.source,metadata:{number:existing.order_number,autoCreatedFromQuote:true,repaired:true}});
    if(workflowInstanceId&&!existing.workflow_instance_id)await env.DB.prepare("UPDATE transport_orders SET workflow_instance_id=? WHERE id=? AND organization_id=?").bind(workflowInstanceId,existing.id,input.organizationId).run();
    await ensureOrderModules(input.organizationId,existing.id);
    await inheritAcceptedQuoteReceivables(input.organizationId,existing.id,quote.id,input.actorUserId);
    await ensureShipmentForOrder({organizationId:input.organizationId,orderId:existing.id,actorUserId:input.actorUserId,request:input.request});
    return {id:existing.id,orderNumber:existing.order_number,created:false};
  }

  const [contact, pickupAddress] = await Promise.all([
    env.DB.prepare(
      "SELECT name,phone FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC,created_at LIMIT 1",
    ).bind(quote.customer_id).first<{ name: string; phone: string | null }>(),
    env.DB.prepare(
      "SELECT id FROM customer_addresses WHERE customer_id=? AND address_line1=? ORDER BY is_default DESC,created_at LIMIT 1",
    ).bind(quote.customer_id, quote.pickup_address).first<{ id: string }>(),
  ]);
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const orderNumber = await nextDocumentNumber(input.organizationId, "order");
  const workflowId = await ensureWorkflowForBusinessType(input.organizationId, quote.road_load_type);
  const cargoId = crypto.randomUUID();
  const destinationAddress = quote.warehouse_address || quote.destination_warehouse_note || quote.warehouse_name || quote.destination_city;
  const packageCount = 1;
  const pieces = Math.max(1, Number(quote.pieces || 1));

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
         current_assignee_user_id,workflow_updated_at,created_at,updated_at,customs_clearance_mode
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      orderId,input.organizationId,orderNumber,now.slice(0,10),"export",quote.road_load_type,
      quote.destination_warehouse_id,quote.destination_warehouse_note,quote.customer_id,quote.id,
      quote.customer_name,contact?.name || null,contact?.phone || null,quote.customer_id,pickupAddress?.id || null,
      quote.origin_country,quote.origin_state,quote.origin_city,quote.pickup_address,
      quote.customer_name,contact?.name || null,contact?.phone || null,
      quote.destination_country,quote.destination_state,quote.destination_city,destinationAddress,
      quote.cargo_description,pieces,quote.gross_weight_kg,quote.volume_cbm,quote.transport_mode,quote.service_level,
      "draft",input.source,quote.notes, input.actorUserId,quote.salesperson_user_id,
      quote.salesperson_user_id,now,now,now,quote.customs_clearance_mode,
    ),
    env.DB.prepare(
      `INSERT INTO order_cargo_items(
         id,organization_id,order_id,line_no,cargo_name_cn,package_type,package_count,pieces_per_package,
         gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,
         volume_per_package_cbm,declared_value,currency,origin_country,notes,created_at,updated_at
       ) VALUES(?,?,?,?,?,'other',?,?,?,?,?,?,?,?,0,?,?,?,?,?)`,
    ).bind(
      cargoId,input.organizationId,orderId,1,quote.cargo_description,packageCount,pieces,
      quote.gross_weight_kg,quote.gross_weight_kg,quote.estimated_length_cm,quote.estimated_width_cm,
      quote.estimated_height_cm,quote.volume_cbm,quote.currency,quote.origin_country,"由已接受报价自动生成",now,now,
    ),
    env.DB.prepare(
      "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,1,?)",
    ).bind(crypto.randomUUID(),input.organizationId,orderId,cargoId,`${orderNumber}-P001`,now),
    ...Object.entries(defaultServices).filter(([code])=>quote.customs_clearance_mode==="company"||code!=="destination_customs").map(([code, name]) => env.DB.prepare(
      "INSERT INTO order_services(id,organization_id,order_id,service_code,service_name,created_at) VALUES(?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(),input.organizationId,orderId,code,name,now)),
    env.DB.prepare(
      "INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,to_step_code,actor_user_id,assignee_user_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(),input.organizationId,orderId,"create","接受报价后自动创建订单","draft","draft","draft",input.actorUserId,quote.salesperson_user_id,now),
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

  await captureAcceptedQuoteSnapshot(input.organizationId, orderId, quote, now);
  const workflowInstanceId = await recordWorkflowEvent({
    organizationId: input.organizationId,
    event: "order.created",
    customerId: quote.customer_id,
    quotationId: quote.id,
    orderId,
    actorUserId: input.actorUserId,
    source: input.source,
    workflowId,
    metadata: { number: orderNumber, autoCreatedFromQuote: true },
  });
  if (workflowInstanceId) await env.DB.prepare(
    "UPDATE transport_orders SET workflow_instance_id=? WHERE id=? AND organization_id=?",
  ).bind(workflowInstanceId,orderId,input.organizationId).run();
  await ensureOrderModules(input.organizationId, orderId);
  await inheritAcceptedQuoteReceivables(input.organizationId, orderId, quote.id, input.actorUserId);
  await ensureShipmentForOrder({
    organizationId: input.organizationId,
    orderId,
    actorUserId: input.actorUserId,
    request: input.request,
  });
  return { id: orderId, orderNumber, created: true };
}

async function captureAcceptedQuoteSnapshot(
  organizationId: string,
  orderId: string,
  quote: AcceptedQuote,
  createdAt: string,
) {
  const charges = await env.DB.prepare(
    "SELECT charge_code,description,quantity,unit_price,amount,exchange_rate,sort_order FROM quotation_charges WHERE quotation_id=? ORDER BY sort_order,id",
  ).bind(quote.id).all<Record<string, string | number | null>>();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO transport_order_quote_snapshots(
       order_id,organization_id,quotation_id,quote_number,road_load_type,currency,
       subtotal,tax_amount,total_amount,snapshot_json,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    orderId,organizationId,quote.id,quote.quote_number,quote.road_load_type,quote.currency,
    quote.subtotal,quote.tax_amount,quote.total_amount,
    JSON.stringify({
      quoteNumber: quote.quote_number,
      roadLoadType: quote.road_load_type,
      originCountry: quote.origin_country,
      originState: quote.origin_state,
      originCity: quote.origin_city,
      pickupAddress: quote.pickup_address,
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
      notes: quote.notes,
      charges: charges.results,
    }),
    createdAt,
  ).run();
}

export async function inheritAcceptedQuoteReceivables(
  organizationId: string,
  orderId: string,
  quotationId: string,
  actorUserId: string,
) {
  const quote = await env.DB.prepare(
    `SELECT q.id,q.quote_number,c.name AS customer_name,q.currency,q.total_amount
       FROM quotations q
       JOIN customers c ON c.id=q.customer_id
      WHERE q.id=? AND q.organization_id=? AND q.status='accepted'`,
  )
    .bind(quotationId, organizationId)
    .first<QuoteReceivable>();
  if (!quote) throw new Error("报价无效或尚未接受");

  const charges = await env.DB.prepare(
    `SELECT id,charge_code,description,quantity,unit_price,amount,exchange_rate
       FROM quotation_charges
      WHERE quotation_id=?
      ORDER BY sort_order,id`,
  )
    .bind(quotationId)
    .all<QuoteCharge>();
  const now = new Date().toISOString();
  const statements = charges.results.map((charge) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO business_expenses(
         id,organization_id,order_id,direction,stage,charge_code,charge_name,
         counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
         base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
       ) VALUES(
         ?,?,?,'receivable','estimated',?,?,?,?,?,?,?,?,?,?,?,?,?,'quotation_charge',?
       )`,
    ).bind(
      crypto.randomUUID(),
      organizationId,
      orderId,
      charge.charge_code,
      charge.description,
      quote.customer_name,
      quote.currency,
      charge.quantity,
      charge.unit_price,
      charge.amount,
      charge.exchange_rate,
      charge.amount * charge.exchange_rate,
      `继承已接受报价 ${quote.quote_number}`,
      actorUserId,
      now,
      now,
      charge.id,
    ),
  );

  if (!statements.length) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO business_expenses(
           id,organization_id,order_id,direction,stage,charge_code,charge_name,
           counterparty_name,currency,quantity,unit_price,amount,exchange_rate,
           base_amount,notes,created_by_user_id,created_at,updated_at,source_type,source_id
         ) VALUES(
           ?,?,?,'receivable','estimated','QUOTATION_TOTAL','报价应收',?,?,1,?,?,1,?,?,?,?,?,'quotation',?
         )`,
      ).bind(
        crypto.randomUUID(),
        organizationId,
        orderId,
        quote.customer_name,
        quote.currency,
        quote.total_amount,
        quote.total_amount,
        quote.total_amount,
        `继承已接受报价 ${quote.quote_number}`,
        actorUserId,
        now,
        now,
        quote.id,
      ),
    );
  }

  await env.DB.batch(statements);
  await syncCostsModuleStatus(organizationId, orderId, now);
  await syncOrderWorkflowSnapshot(organizationId, orderId);
}
