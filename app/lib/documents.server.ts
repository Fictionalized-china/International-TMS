import { env } from "cloudflare:workers";

export type DocumentType = "inquiry" | "quote" | "order" | "shipment" | "invoice";

const prefixes: Record<DocumentType, string> = { inquiry: "INQ", quote: "QT", order: "SO", shipment: "SHP", invoice: "INV" };

export async function nextDocumentNumber(organizationId: string, type: DocumentType): Promise<string> {
  await env.DB.prepare("INSERT OR IGNORE INTO document_sequences (organization_id, document_type, next_value) VALUES (?, ?, 1)").bind(organizationId, type).run();
  const row = await env.DB.prepare("UPDATE document_sequences SET next_value = next_value + 1 WHERE organization_id = ? AND document_type = ? RETURNING next_value - 1 AS value").bind(organizationId, type).first<{ value: number }>();
  if (!row) throw new Error(`Unable to allocate ${type} number`);
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefixes[type]}${date}${String(row.value).padStart(5, "0")}`;
}
