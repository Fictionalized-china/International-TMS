import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { analyticsVisibility } from "./analytics-access";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import { orderVisibilitySql } from "./order-access.server";

export type AnalyticsOrderRow = {
  id: string;
  order_number: string;
  status: string;
  business_type: string;
  is_overdue: number;
  exception_status: string;
  order_date: string | null;
  created_at: string;
  customer_id: string;
  customer_name: string;
  origin_city: string | null;
  destination_city: string | null;
  owner_id: string | null;
  owner_name: string | null;
  has_receipt: number;
  in_stock_packages: number;
};

type FinanceGroup = { direction: "receivable" | "payable"; total: number };

export type AnalyticsFilters = {
  from: string;
  to: string;
  customerId: string;
  ownerId: string;
  route: string;
};

export async function loadAnalyticsSnapshot(request: Request, current: SessionUser) {
  const access = analyticsVisibility(current.permissions);
  if (!access.canView) throw new Response("没有权限查看汇总分析", { status: 403 });
  const url = new URL(request.url);
  const filters: AnalyticsFilters = {
    from: (url.searchParams.get("from") ?? "").trim(),
    to: (url.searchParams.get("to") ?? "").trim(),
    customerId: (url.searchParams.get("customerId") ?? "").trim(),
    ownerId: (url.searchParams.get("ownerId") ?? "").trim(),
    route: (url.searchParams.get("route") ?? "").trim(),
  };
  const visibility = orderVisibilitySql(current, "o");
  const conditions = ["o.organization_id=?", visibility.sql, "o.status!='cancelled'"];
  const bindings: unknown[] = [current.organizationId, ...visibility.values];
  if (filters.from) {
    conditions.push("COALESCE(o.order_date,o.created_at)>=?");
    bindings.push(filters.from);
  }
  if (filters.to) {
    conditions.push("COALESCE(o.order_date,o.created_at)<?");
    bindings.push(`${filters.to}T23:59:59.999Z`);
  }
  const result = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.status,o.business_type,o.is_overdue,o.exception_status,
            o.order_date,o.created_at,o.customer_id,c.name customer_name,
            o.origin_city,o.destination_city,o.current_assignee_user_id owner_id,
            owner.display_name owner_name,
            CASE WHEN EXISTS(
              SELECT 1 FROM shipments s JOIN warehouse_receipts receipt ON receipt.shipment_id=s.id
              WHERE s.organization_id=o.organization_id AND s.order_id=o.id AND receipt.status='completed'
            ) THEN 1 ELSE 0 END has_receipt,
            COALESCE((SELECT COUNT(*) FROM order_cargo_packages package
              WHERE package.organization_id=o.organization_id AND package.order_id=o.id AND package.status='received'),0) in_stock_packages
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN users owner ON owner.id=o.current_assignee_user_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY COALESCE(o.order_date,o.created_at) DESC
      LIMIT 2000`,
  ).bind(...bindings).all<AnalyticsOrderRow>();

  const routeQuery = filters.route.toLocaleLowerCase("zh-CN");
  const rows = result.results.filter((row) => {
    if (filters.customerId && row.customer_id !== filters.customerId) return false;
    if (filters.ownerId && row.owner_id !== filters.ownerId) return false;
    if (routeQuery && !`${row.origin_city || ""} ${row.destination_city || ""}`.toLocaleLowerCase("zh-CN").includes(routeQuery)) return false;
    return true;
  });
  const orderIds = rows.map((row) => row.id);
  const financeTotals = { receivable: 0, payable: 0 };
  if (orderIds.length && (access.canViewReceivable || access.canViewPayable || access.canViewProfit)) {
    for (const chunk of chunkD1Values(orderIds, 2)) {
      const finance = await env.DB.prepare(
        `SELECT direction,COALESCE(SUM(base_amount),0) total
           FROM business_expenses
          WHERE organization_id=? AND order_id IN (${d1Placeholders(chunk.length)})
            AND stage!='cancelled' AND direction IN ('receivable','payable')
          GROUP BY direction`,
      ).bind(current.organizationId, ...chunk).all<FinanceGroup>();
      for (const group of finance.results) financeTotals[group.direction] += Number(group.total || 0);
    }
  }

  const countBy = (key: (row: AnalyticsOrderRow) => string) => Object.entries(rows.reduce<Record<string, number>>((counts, row) => {
    const label = key(row) || "未设置";
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1]);
  const customers = countBy((row) => row.customer_name).slice(0, 10);
  const routes = countBy((row) => `${row.origin_city || "起运地待补"} → ${row.destination_city || "目的地待补"}`).slice(0, 10);
  const owners = countBy((row) => row.owner_name || "负责人待指派").slice(0, 10);
  const profit = financeTotals.receivable - financeTotals.payable;
  return {
    access,
    filters,
    rows,
    metrics: {
      total: rows.length,
      executing: rows.filter((row) => row.status === "in_execution").length,
      completed: rows.filter((row) => row.status === "completed").length,
      overdue: rows.filter((row) => Boolean(row.is_overdue)).length,
      exceptions: rows.filter((row) => ["warning", "exception"].includes(row.exception_status)).length,
      warehouseReceived: rows.filter((row) => Boolean(row.has_receipt)).length,
      inStockPackages: rows.reduce((sum, row) => sum + Number(row.in_stock_packages || 0), 0),
    },
    finance: {
      receivable: access.canViewReceivable ? financeTotals.receivable : null,
      payable: access.canViewPayable ? financeTotals.payable : null,
      profit: access.canViewProfit ? profit : null,
      margin: access.canViewProfit && financeTotals.receivable > 0 ? profit / financeTotals.receivable : null,
    },
    breakdowns: { customers, routes, owners },
    options: {
      customers: [...new Map(result.results.map((row) => [row.customer_id, row.customer_name])).entries()].map(([id, name]) => ({ id, name })),
      owners: [...new Map(result.results.filter((row) => row.owner_id).map((row) => [row.owner_id!, row.owner_name || "未命名负责人"])).entries()].map(([id, name]) => ({ id, name })),
    },
  };
}
