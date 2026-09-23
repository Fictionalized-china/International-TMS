import type { Route } from "./+types/admin.analytics-export";
import { requireSessionUser } from "../lib/auth.server";
import { loadAnalyticsSnapshot } from "../lib/analytics.server";

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "analytics.business.view");
  if (!current.permissions.includes("data.export")) throw new Response("没有汇总数据导出权限", { status: 403 });
  const snapshot = await loadAnalyticsSnapshot(request, current);
  const lines: string[][] = [
    ["指标", "数值"],
    ["订单总量", String(snapshot.metrics.total)],
    ["执行中", String(snapshot.metrics.executing)],
    ["已完成", String(snapshot.metrics.completed)],
    ["时效预警", String(snapshot.metrics.overdue)],
    ["业务异常", String(snapshot.metrics.exceptions)],
    ["仓库已实收", String(snapshot.metrics.warehouseReceived)],
  ];
  if (snapshot.finance.receivable !== null) lines.push(["应收金额", snapshot.finance.receivable.toFixed(2)]);
  if (snapshot.finance.payable !== null) lines.push(["应付及成本", snapshot.finance.payable.toFixed(2)]);
  if (snapshot.finance.profit !== null) lines.push(["毛利", snapshot.finance.profit.toFixed(2)]);
  lines.push([], ["客户", "订单数"], ...snapshot.breakdowns.customers.map(([label, value]) => [label, String(value)]));
  lines.push([], ["线路", "订单数"], ...snapshot.breakdowns.routes.map(([label, value]) => [label, String(value)]));
  lines.push([], ["负责人", "订单数"], ...snapshot.breakdowns.owners.map(([label, value]) => [label, String(value)]));
  const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tms-analytics-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

function csvCell(value: string) {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
