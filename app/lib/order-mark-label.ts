import { markContactTypeLabels, type MarkContactSnapshot } from "./mark-contacts";

export type OrderMarkLabel = {
  id: string;
  order_number: string;
  contact_phone: string | null;
  mark_contacts: MarkContactSnapshot[];
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

export function orderMarkLabelFacts(order: Omit<Pick<
  OrderMarkLabel,
  "destination_country" | "destination_state" | "destination_city" |
  "overseas_warehouse_name" | "pieces" | "declared_quantity_unit" |
  "volume_cbm" | "gross_weight_kg" | "contact_phone" | "mark_contacts"
>, "mark_contacts"> & { mark_contacts?: MarkContactSnapshot[] | null }) {
  const destinationRegion = [order.destination_country, order.destination_state, order.destination_city]
    .filter(Boolean)
    .join(" ");
  const markContacts = order.mark_contacts ?? [];
  return {
    destination: [destinationRegion, order.overseas_warehouse_name].filter(Boolean).join(" · ") || "待确认",
    pieces: `${formatMeasure(order.pieces, 0)} ${order.declared_quantity_unit || "件"}`,
    volume: `${formatMeasure(order.volume_cbm, 4)} CBM`,
    weight: `${formatMeasure(order.gross_weight_kg, 3)} KG`,
    contacts: markContacts.map((contact)=>({
      ...contact,
      label:contact.title || markContactTypeLabels[contact.type],
    })),
    phone: markContacts.length
      ? markContacts.map((contact)=>`${contact.title || markContactTypeLabels[contact.type]}：${contact.name} ${contact.phone}`).join("\n")
      : "—",
  };
}

export function buildOrderMarkLabelSvg(order: OrderMarkLabel) {
  const facts = orderMarkLabelFacts(order);
  const marks = order.marks.length
    ? order.marks
    : [{ id: order.id, code: `${order.order_number}-IN-001`, sequence: 1, revision: 1 }];
  const pageHeight = 610;
  const height = pageHeight * marks.length;
  const pages = marks.map((mark, pageIndex) => {
    const barcode = code39Bars(mark.code.toUpperCase());
    const scale = 880 / barcode.width;
    const rows = [
      ["目的地", facts.destination],
      ["件数", facts.pieces],
      ["方数", facts.volume],
      ["重量", facts.weight],
      ["我方联系人", facts.phone],
    ];
    let rowY = 316;
    const rowSvg = rows.map(([label, value]) => {
      const lines = wrapText(value, 44);
      const rowHeight = Math.max(46, 24 + lines.length * 20);
      const valueSvg = lines
        .map((line, index) => `<tspan x="250" dy="${index === 0 ? 0 : 20}">${escapeXml(line)}</tspan>`)
        .join("");
      const current = `<line x1="55" y1="${rowY}" x2="945" y2="${rowY}" stroke="#b7b7b7"/>
        <text x="75" y="${rowY + 29}" font-size="20" font-weight="700">${escapeXml(label)}</text>
        <text x="250" y="${rowY + 29}" font-size="20" font-weight="600">${valueSvg}</text>`;
      rowY += rowHeight;
      return current;
    }).join("");
    return `<g transform="translate(0 ${pageIndex * pageHeight})">
      <rect width="1000" height="${pageHeight}" fill="#fff"/>
      <rect x="20" y="20" width="960" height="570" rx="10" fill="none" stroke="#111" stroke-width="5"/>
      <text x="55" y="72" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="31" font-weight="800">OULING 国际物流</text>
      <text x="945" y="72" text-anchor="end" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="24" font-weight="700">入仓唛头标签</text>
      <line x1="55" y1="92" x2="945" y2="92" stroke="#111" stroke-width="3"/>
      <g transform="translate(60 112) scale(${scale} 1)" fill="#111">${barcode.rects}</g>
      <text x="500" y="258" text-anchor="middle" font-family="Consolas,monospace" font-size="17" font-weight="700">扫描码：${escapeXml(mark.code)} · 包装 ${mark.sequence}/${order.planned_inbound_package_count}</text>
      <text x="500" y="296" text-anchor="middle" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="29" font-weight="800">唛头号　${escapeXml(order.order_number)}</text>
      <g font-family="Arial,'Microsoft YaHei',sans-serif" fill="#111">${rowSvg}</g>
      <text x="55" y="572" font-family="Arial,'Microsoft YaHei',sans-serif" font-size="14" fill="#444">条码为本包装唯一入仓扫描码；唛头号保持订单号。</text>
    </g>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}">
  ${pages}
</svg>`;
}

function formatMeasure(value: number, maximumFractionDigits: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return String(Number(number.toFixed(maximumFractionDigits)));
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
  for (const paragraph of text.split(/\r?\n/)) {
    for (let index = 0; index < paragraph.length; index += maxChars) {
      lines.push(paragraph.slice(index, index + maxChars));
    }
  }
  return lines.length?lines:["—"];
}

function escapeXml(value: string) {
  return String(value).replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[char] || char);
}
