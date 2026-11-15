import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.hr-reports-export";
import { requireSessionUser } from "../lib/auth.server";
import { hrReportPeriod } from "../lib/hr-reports";
import { hrPaidReportCsv, loadHrReport } from "../lib/hr-reports.server";
import { hrConsignmentCsv, loadHrConsignments } from "../lib/hr-consignments.server";
import { readHrConsignmentFilters } from "../lib/hr-consignments";
import { writeAudit } from "../lib/audit.server";

/** Resource route: a download is never rendered as the HR React page. */
export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "hr.report.view");
  if (!current.permissions.includes("data.export")) throw new Response("没有导出权限", { status: 403 });
  const url = new URL(request.url), defaults = hrReportPeriod(new Date(), url.searchParams.get("period") === "week" ? "week" : "month");
  let filters;
  try { filters = readHrConsignmentFilters(url.searchParams, defaults); }
  catch (error) { throw new Response(error instanceof Error ? error.message : "导出筛选无效", { status: 400 }); }
  let body: string, count: number;
  const paid = url.searchParams.get("view") === "paid";
  if (paid) {
    const rows = await loadHrReport(env.DB, current, filters.from || defaults.from, filters.to || defaults.to);
    body = hrPaidReportCsv(rows); count = rows.length;
  } else {
    const { rows } = await loadHrConsignments(env.DB, current, filters);
    body = hrConsignmentCsv(rows); count = rows.length;
  }
  await writeAudit({ request, action: "hr.report.export", resourceType: "hr_report", resourceId: paid ? "paid" : "consignments", organizationId: current.organizationId, actorUserId: current.userId, metadata: { view: paid ? "paid" : "consignments", filters, count, amountsVisible: current.permissions.includes("hr.report.amount.view") } });
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${paid ? "hr-paid-orders" : "hr-consignments"}.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
