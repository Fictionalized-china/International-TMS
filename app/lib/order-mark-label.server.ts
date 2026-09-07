import { env } from "cloudflare:workers";
import { orderMarkLabelAvailable } from "./order-mark-label-policy";
export { orderMarkLabelAvailable } from "./order-mark-label-policy";

export type OrderMarkLabel = {
  id: string;
  order_number: string;
  customer_name: string;
  cargo_description: string;
  pieces: number;
  declared_quantity_unit: string;
  planned_inbound_package_count: number;
  planned_inbound_package_type: string;
  gross_weight_kg: number;
  volume_cbm: number;
  origin_country: string;
  origin_state: string | null;
  origin_city: string;
  destination_country: string;
  destination_state: string | null;
  destination_city: string;
  overseas_warehouse_name: string | null;
  status: string;
  label_generated_at: string;
  inbound_package_locked_at: string | null;
  marks: Array<{ id: string; code: string; sequence: number; revision: number }>;
};

export type OrderMark = OrderMarkLabel["marks"][number];

export async function loadActiveOrderMarksByOrder(
  organizationId: string,
  orderIds: string[],
) {
  const result = new Map<string, OrderMark[]>();
  if (!orderIds.length) return result;

  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT order_id,id,package_code code,package_sequence sequence,label_revision revision
       FROM order_cargo_packages
      WHERE organization_id=? AND order_id IN (${placeholders})
        AND is_active=1 AND status!='cancelled'
      ORDER BY order_id,package_sequence`,
  ).bind(organizationId, ...orderIds).all<OrderMark & { order_id: string }>();

  for (const row of rows.results) {
    const marks = result.get(row.order_id) ?? [];
    marks.push({ id: row.id, code: row.code, sequence: row.sequence, revision: row.revision });
    result.set(row.order_id, marks);
  }
  return result;
}

export async function loadOrderMarkLabel(input: {
  organizationId: string;
  orderId: string;
  customerId?: string;
}) {
  const customerScope = input.customerId ? " AND o.customer_id=?" : "";
  const values = input.customerId
    ? [input.orderId, input.organizationId, input.customerId]
    : [input.orderId, input.organizationId];
  const order = await env.DB.prepare(
    `SELECT o.id,o.order_number,c.name customer_name,o.cargo_description,o.pieces,o.declared_quantity_unit,
      o.planned_inbound_package_count,o.planned_inbound_package_type,
      o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,
      o.destination_country,o.destination_state,o.destination_city,
      w.name overseas_warehouse_name,o.status,
      CASE
        WHEN q.accepted_at IS NOT NULL THEN q.accepted_at
        WHEN o.quotation_id IS NULL AND o.status IN ('confirmed','in_execution','completed') THEN o.created_at
        ELSE NULL
      END label_generated_at,o.quote_withdrawn,o.inbound_package_locked_at
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
     LEFT JOIN quotations q ON q.id=o.quotation_id AND q.organization_id=o.organization_id
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?${customerScope}`,
  )
    .bind(...values)
    .first<Omit<OrderMarkLabel,"marks"> & { quote_withdrawn: number }>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  if (!orderMarkLabelAvailable({
    status: order.status,
    acceptedAt: order.label_generated_at,
    quoteWithdrawn: order.quote_withdrawn,
  })) {
    throw new Response("客户接受报价后才会自动生成入仓唛头标签", { status: 409 });
  }
  const marks=await env.DB.prepare(
    `SELECT id,package_code code,package_sequence sequence,label_revision revision
       FROM order_cargo_packages
      WHERE organization_id=? AND order_id=? AND is_active=1 AND status!='cancelled'
      ORDER BY package_sequence`,
  ).bind(input.organizationId,input.orderId).all<{id:string;code:string;sequence:number;revision:number}>();
  return { ...order,marks:marks.results };
}

export function orderMarkLabelDownload(order: OrderMarkLabel) {
  const svg = buildOrderMarkLabelSvg(order);
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFileName(order.order_number)}-mark-label.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export function buildOrderMarkLabelSvg(order: OrderMarkLabel) {
  const route = [order.origin_country, order.origin_state, order.origin_city]
    .filter(Boolean)
    .join(" ") + " → " + [order.destination_country, order.destination_state, order.destination_city]
      .filter(Boolean)
      .join(" ");
  const marks=order.marks.length?order.marks:[{id:order.id,code:`${order.order_number}-IN-001`,sequence:1,revision:1}];
  const pageHeight=760;
  const height=pageHeight*marks.length;
  const pages=marks.map((mark,pageIndex)=>{
    const barcode=code39Bars(mark.code.toUpperCase());
    const scale=880/barcode.width;
    const rows = [
      ["入仓唛头", mark.code],
      ["订单号", order.order_number],
      ["包装序号", `${mark.sequence}/${order.planned_inbound_package_count}（预计）`],
      ["客户", order.customer_name],
      ["货物", order.cargo_description],
      ["商品数量", `${order.pieces} ${order.declared_quantity_unit}`],
      ["预计包装", `${order.planned_inbound_package_count} 包 · ${order.planned_inbound_package_type}`],
      ["运输线路", route],
      ["境外目的仓", order.overseas_warehouse_name || "待确定"],
    ];
    let rowY=310;
    const rowSvg=rows.map(([label,value])=>{
      const lines=wrapText(value,44);
      const rowHeight=Math.max(46,24+lines.length*20);
      const valueSvg=lines.map((line,index)=>`<tspan x="250" dy="${index===0?0:20}">${escapeXml(line)}</tspan>`).join("");
      const current=`<line x1="55" y1="${rowY}" x2="945" y2="${rowY}" stroke="#b7b7b7"/>
        <text x="75" y="${rowY+29}" font-size="20" font-weight="700">${escapeXml(label)}</text>
        <text x="250" y="${rowY+29}" font-size="20" font-weight="600">${valueSvg}</text>`;
      rowY+=rowHeight;
      return current;
    }).join("");
    return `<g transform="translate(0 ${pageIndex*pageHeight})">
      <rect width="1000" height="${pageHeight}" fill="#fff"/>
      <rect x="20" y="20" width="960" height="720" rx="10" fill="none" stroke="#111" stroke-width="5"/>
      <text x="55" y="72" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="31" font-weight="800">OULING 国际物流</text>
      <text x="945" y="72" text-anchor="end" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="24" font-weight="700">入仓唛头标签</text>
      <line x1="55" y1="92" x2="945" y2="92" stroke="#111" stroke-width="3"/>
      <g transform="translate(60 112) scale(${scale} 1)" fill="#111">${barcode.rects}</g>
      <text x="500" y="274" text-anchor="middle" font-family="Consolas,monospace" font-size="30" font-weight="800" letter-spacing="1">${escapeXml(mark.code)}</text>
      <g font-family="Arial,'Microsoft YaHei',sans-serif" fill="#111">${rowSvg}</g>
    </g>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}">
  ${pages}
</svg>`;
}

function code39Bars(value: string) {
  const patterns: Record<string, string> = {
    "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
    "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
    A:"wnnnnwnnw",B:"nnwnnwnnw",C:"wnwnnwnnn",D:"nnnnwwnnw",E:"wnnnwwnnn",F:"nnwnwwnnn",
    G:"nnnnnwwnw",H:"wnnnnwwnn",I:"nnwnnwwnn",J:"nnnnwwwnn",K:"wnnnnnnww",L:"nnwnnnnww",
    M:"wnwnnnnwn",N:"nnnnwnnww",O:"wnnnwnnwn",P:"nnwnwnnwn",Q:"nnnnnnwww",R:"wnnnnnwwn",
    S:"nnwnnnwwn",T:"nnnnwnwwn",U:"wwnnnnnnw",V:"nwwnnnnnw",W:"wwwnnnnnn",X:"nwnnwnnnw",
    Y:"wwnnwnnnn",Z:"nwwnwnnnn","-":"nwnnnnwnw","*":"nwnnwnwnn",
  };
  let x = 0;
  const rects: string[] = [];
  for (const char of `*${value}*`) {
    for (const [index, width] of [...(patterns[char] ?? patterns["-"])].entries()) {
      const size = width === "w" ? 3 : 1;
      if (index % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${size}" height="125"/>`);
      x += size;
    }
    x += 1;
  }
  return { width: x, rects: rects.join("") };
}

function wrapText(value: string, maxChars: number) {
  const text = String(value || "—").trim() || "—";
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    lines.push(text.slice(index, index + maxChars));
  }
  return lines;
}

function escapeXml(value: string) {
  return String(value).replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[char] || char);
}

function safeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}
