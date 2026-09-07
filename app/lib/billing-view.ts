import { readListPage } from "./list-pagination";

export const BILLING_PAGE_SIZE = 10;

export const billingTabs = [
  "tasks",
  "pending",
  "reconciliations",
  "cash",
  "invoices",
  "history",
] as const;

export type BillingTab = (typeof billingTabs)[number];
export type BillingHistoryType = "cash" | "invoices" | "legacy";

export type BillingView = {
  tab: BillingTab;
  page: number;
  query: string;
  direction: string;
  currency: string;
  status: string;
  historyType: BillingHistoryType;
};

const directions = new Set(["receivable", "payable", "receipt", "payment"]);
const statuses = new Set([
  "draft",
  "confirmed",
  "unsettled",
  "settled",
  "unallocated",
  "partially_allocated",
  "allocated",
]);
const historyTypes = new Set<BillingHistoryType>(["cash", "invoices", "legacy"]);

export function readBillingView(searchParams: URLSearchParams, defaultTab: BillingTab = "tasks"): BillingView {
  const requestedTab = searchParams.get("tab");
  const tab = billingTabs.includes(requestedTab as BillingTab)
    ? requestedTab as BillingTab
    : defaultTab;
  const requestedDirection = searchParams.get("direction") || "";
  const requestedStatus = searchParams.get("status") || "";
  const requestedHistoryType = searchParams.get("historyType") || "";

  return {
    tab,
    page: readListPage(searchParams),
    query: (searchParams.get("q") || "").trim(),
    direction: directions.has(requestedDirection)
      ? requestedDirection
      : tab === "pending" ? "receivable" : "",
    currency: (searchParams.get("currency") || "").trim().toUpperCase(),
    status: statuses.has(requestedStatus) ? requestedStatus : "",
    historyType: historyTypes.has(requestedHistoryType as BillingHistoryType)
      ? requestedHistoryType as BillingHistoryType
      : "cash",
  };
}

export function settlementExpenseGroupKey(item: {
  direction: string;
  counterparty_name: string;
  currency: string;
}) {
  return `${item.direction}\u0000${item.counterparty_name}\u0000${item.currency}`;
}
