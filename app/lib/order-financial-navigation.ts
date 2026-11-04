export function orderFinancialHref(orderId: string, tab: string, actionUrl?: string, page?: number, stepKey = "reconciliation") {
  const query = new URL(actionUrl || "/", "http://local").searchParams;
  query.set("stage", query.get("stage") || stepKey);
  query.set("module", "costs"); query.set("section", "expenses"); query.set("financeTab", tab);
  query.delete("financePage");
  if (page) query.set("financePage", String(page));
  return `/admin/orders/${orderId}?${query.toString()}`;
}
