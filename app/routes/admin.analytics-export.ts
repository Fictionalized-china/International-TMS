import type { Route } from "./+types/admin.analytics-export";
import { requireSessionUser } from "../lib/auth.server";
import { loadAnalyticsSnapshot } from "../lib/analytics.server";

type Cell = string | number | null;

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "analytics.business.view");
  if (!current.permissions.includes("data.export")) throw new Response("没有汇总数据导出权限", { status: 403 });
  const snapshot = await loadAnalyticsSnapshot(request, current);
  const { report, access } = snapshot;
  const sheets: Array<{ name: string; rows: Cell[][] }> = [];
  const summary: Cell[][] = [
    ["经营与财务汇总分析"], ["统计开始", snapshot.filters.from], ["统计结束", snapshot.filters.to], ["生成时间", snapshot.generatedAt],
    [], ["业务指标", "数值"], ["订单总量", snapshot.metrics.total], ["执行中", snapshot.metrics.executing], ["已完成", snapshot.metrics.completed],
    ["时效预警", snapshot.metrics.overdue], ["业务异常", snapshot.metrics.exceptions], ["仓库已实收", snapshot.metrics.warehouseReceived],
  ];
  if (access.canViewReceivable) summary.push(["确认收入", report.overview.revenue], ["预计收入", report.overview.estimatedRevenue], ["应收余额", report.receivables.total], ["DSO", report.receivables.dso], ["回款率", report.receivables.collectionRate]);
  if (access.canViewPayable) summary.push(["直接结算成本", report.overview.directCost], ["预计成本", report.overview.estimatedCost], ["异常财务影响", report.overview.abnormalExpense - report.overview.abnormalIncome]);
  if (access.canViewProfit) summary.push(["运营毛利", report.overview.grossProfit], ["运营毛利率", report.overview.grossMargin]);
  sheets.push({ name: "经营全景", rows: summary });
  sheets.push({ name: "产品线利润", rows: [["产品线", "票数", "票数占比", "销售额", "销售占比", "毛利", "毛利占比", "毛利率"], ...report.productLines.map((r) => [r.label, r.ticketCount, r.ticketShare, access.canViewReceivable ? r.sales : null, access.canViewReceivable ? r.salesShare : null, access.canViewProfit ? r.grossProfit : null, access.canViewProfit ? r.grossProfitShare : null, access.canViewProfit ? r.grossMargin : null])] });
  sheets.push({ name: "发车分析", rows: [["统计维度", "业务线或口岸", "目的国", "票数", "发车数"], ...report.vehicleAnalysis.map((r) => [r.dimension, r.businessType, r.destinationCountry, r.ticketCount, r.departureCount])] });
  sheets.push({ name: "一票多车", rows: [["订单号", "业务线", "销售", "目的地口岸", "车辆总数", "车号"], ...report.multiVehicleOrders.map((r) => [r.orderNumber, r.businessType, r.salesperson, r.destination, r.totalVehicles, r.vehicleNo])] });
  if (access.canViewReceivable) {
    sheets.push({ name: "客户贡献", rows: [["客户", "销售额", "销售占比", "毛利", "毛利占比", "毛利率", "上月比较"], ...report.customerContribution.map((r) => [r.customerName, r.sales, r.salesShare, access.canViewProfit ? r.grossProfit : null, access.canViewProfit ? r.grossProfitShare : null, access.canViewProfit ? r.grossMargin : null, r.comparison])] });
    sheets.push({ name: "客户应收账龄", rows: [["客户", "应收余额", "余额占比", "最长账龄天", "逾期金额", "逾期占比", "信用状态"], ...report.customerReceivables.map((r) => [r.customerName, r.balance, r.share, r.agingDays, r.overdueAmount, r.overdueRatio, r.creditStatus])] });
  }
  if (access.canViewProfit) sheets.push({ name: "口岸贡献", rows: [["口岸", "目的国", "收入", "成本", "毛利", "毛利率", "票数", "成本占比"], ...report.portContribution.map((r) => [r.portName, r.destinationCountry, r.revenue, r.cost, r.grossProfit, r.grossMargin, r.ticketCount, r.directCostShare])] });
  if (access.canViewPayable) {
    sheets.push({ name: "成本结构", rows: [["成本类别", "金额", "运营成本占比", "销售收入占比", "上月比较"], ...report.costStructure.map((r) => [r.category, r.amount, r.costShare, r.revenueShare, r.comparison])] });
    sheets.push({ name: "业务线成本", rows: [["业务线", "成本类别", "金额", "业务线内占比", "公司成本占比"], ...report.businessCostDistribution.map((r) => [r.businessType, r.category, r.amount, r.businessShare, r.companyShare])] });
    sheets.push({ name: "口岸成本", rows: [["口岸", "总成本", "境外运费", "正常运费", "压车费", "生活费", "国内运费", "仓储费", "转关费", "税费保险", "其他"], ...report.portCostStructure.map((r) => [r.portName, r.totalCost, r.overseasFreight, r.normalFreight, r.detention, r.living, r.domesticFreight, r.portStorage, r.transitCustoms, r.taxInsurance, r.other])] });
    sheets.push({ name: "货损绿通", rows: [["口岸", "货损票数", "赔偿金额", "货损率", "主要类型", "绿通票数", "罚款金额"], ...report.cargoDamage.map((r) => [r.portName, r.ticketCount, r.damageAmount, r.damageRate, r.primaryType, r.greenLaneCount, r.penaltyAmount])] });
    sheets.push({ name: "供应商付款", rows: [["供应商", "类型", "账期天", "应付余额", "采购金额", "上月价格波动"], ...report.supplierPayments.map((r) => [r.supplierName, r.type, r.paymentTermsDays, r.payableBalance, r.purchaseAmount, r.priceChange])] });
  }
  if (access.canViewProfit) {
    sheets.push({ name: "团队产出", rows: [["销售", "产品线", "票数", "收入", "成本", "毛利", "收入占比", "毛利占比", "毛利率"], ...report.teamOutput.map((r) => [r.salesperson, r.productLine, r.ticketCount, r.revenue, r.cost, r.grossProfit, r.revenueShare, r.grossProfitShare, r.grossMargin])] });
    sheets.push({ name: "负毛利预警", rows: [["业务线", "总票数", "负毛利票数", "负毛利占比", "销售额", "毛利率", "状态"], ...report.negativeProfit.map((r) => [r.businessType, r.ticketCount, r.negativeTicketCount, r.negativeTicketRatio, r.sales, r.grossMargin, r.alert])] });
  }
  const workbook = spreadsheetXml(sheets);
  return new Response(`\uFEFF${workbook}`, { headers: {
    "Content-Type": "application/vnd.ms-excel; charset=utf-8",
    "Content-Disposition": `attachment; filename="tms-financial-analytics-${snapshot.filters.from}-${snapshot.filters.to}.xls"`,
    "Cache-Control": "no-store",
  } });
}

function spreadsheetXml(sheets: Array<{ name: string; rows: Cell[][] }>) {
  const body = sheets.map((sheet) => `<Worksheet ss:Name="${xml(sheet.name.slice(0, 31))}"><Table>${sheet.rows.map((row, rowIndex) => `<Row>${row.map((cell) => cellXml(cell, rowIndex === 0)).join("")}</Row>`).join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane></WorksheetOptions></Worksheet>`).join("");
  return `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DCEAF3" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style></Styles>${body}</Workbook>`;
}
function cellXml(value: Cell, header: boolean) {
  const type = typeof value === "number" && Number.isFinite(value) ? "Number" : "String";
  const content = value === null || value === undefined ? "" : String(value);
  return `<Cell${header ? ' ss:StyleID="Header"' : ""}><Data ss:Type="${type}">${xml(content)}</Data></Cell>`;
}
function xml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
