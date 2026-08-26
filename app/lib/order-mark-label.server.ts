import { env } from "cloudflare:workers";

export type OrderMarkLabel = {
  id: string;
  order_number: string;
  customer_name: string;
  cargo_description: string;
  pieces: number;
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
};

const approvedOrderStatuses = new Set(["confirmed", "in_execution", "completed"]);

export function orderMarkLabelAvailable(status: string) {
  return approvedOrderStatuses.has(status);
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
    `SELECT o.id,o.order_number,c.name customer_name,o.cargo_description,o.pieces,
      o.gross_weight_kg,o.volume_cbm,o.origin_country,o.origin_state,o.origin_city,
      o.destination_country,o.destination_state,o.destination_city,
      w.name overseas_warehouse_name,o.status
     FROM transport_orders o
     JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
     LEFT JOIN warehouses w ON w.id=o.overseas_warehouse_id AND w.organization_id=o.organization_id
     WHERE o.id=? AND o.organization_id=?${customerScope}`,
  )
    .bind(...values)
    .first<OrderMarkLabel>();
  if (!order) throw new Response("订单不存在", { status: 404 });
  if (!orderMarkLabelAvailable(order.status)) {
    throw new Response("订单审核通过后才会生成入仓唛头标签", { status: 409 });
  }
  return order;
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

function buildOrderMarkLabelSvg(order: OrderMarkLabel) {
  const barcode = code39Bars(order.order_number.toUpperCase());
  const scale = 880 / barcode.width;
  const route = [order.origin_country, order.origin_state, order.origin_city]
    .filter(Boolean)
    .join(" ") + " → " + [order.destination_country, order.destination_state, order.destination_city]
      .filter(Boolean)
      .join(" ");
  const rows = [
    ["订单号", order.order_number],
    ["客户", order.customer_name],
    ["货物", order.cargo_description],
    ["计划数据", `${order.pieces} 件 · ${order.gross_weight_kg} KG · ${order.volume_cbm} CBM`],
    ["运输线路", route],
    ["境外目的仓", order.overseas_warehouse_name || "待确定"],
  ];
  let rowY = 320;
  const rowSvg = rows.map(([label, value]) => {
    const lines = wrapText(value, 44);
    const height = Math.max(58, 30 + lines.length * 24);
    const valueSvg = lines.map((line, index) =>
      `<tspan x="250" dy="${index === 0 ? 0 : 24}">${escapeXml(line)}</tspan>`,
    ).join("");
    const current = `<line x1="55" y1="${rowY}" x2="945" y2="${rowY}" stroke="#b7b7b7"/>
      <text x="75" y="${rowY + 35}" font-size="22" font-weight="700">${escapeXml(label)}</text>
      <text x="250" y="${rowY + 35}" font-size="22" font-weight="600">${valueSvg}</text>`;
    rowY += height;
    return current;
  }).join("");
  const height = Math.max(720, rowY + 55);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}">
  <rect width="1000" height="${height}" fill="#fff"/>
  <rect x="20" y="20" width="960" height="${height - 40}" rx="10" fill="none" stroke="#111" stroke-width="5"/>
  <text x="55" y="72" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="31" font-weight="800">OULING 国际物流</text>
  <text x="945" y="72" text-anchor="end" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="24" font-weight="700">入仓唛头标签</text>
  <line x1="55" y1="92" x2="945" y2="92" stroke="#111" stroke-width="3"/>
  <g transform="translate(60 118) scale(${scale} 1)" fill="#111">${barcode.rects}</g>
  <text x="500" y="285" text-anchor="middle" font-family="Consolas,monospace" font-size="34" font-weight="800" letter-spacing="2">${escapeXml(order.order_number)}</text>
  <g font-family="Arial,'Microsoft YaHei',sans-serif" fill="#111">${rowSvg}</g>
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
