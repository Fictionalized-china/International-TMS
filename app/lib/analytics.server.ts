import { env } from "cloudflare:workers";
import type { SessionUser } from "./auth.server";
import { analyticsVisibility } from "./analytics-access";
import { redactFinancialReport } from "./analytics-redaction";
import { chunkD1Values, d1Placeholders } from "./d1-bindings";
import { analyticsMetricDefinitions, type AnalyticsCalculationMode, type AnalyticsDateSource } from "./financial-analytics";
import {
  buildFinancialAnalyticsReport,
  type FinancialAnalyticsException,
  type FinancialAnalyticsExpense,
  type FinancialAnalyticsOrder,
  type FinancialAnalyticsVehicle,
} from "./financial-analytics-report";
import { orderVisibilitySql } from "./order-access.server";

type AnalyticsOrderRow = {
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
  payment_terms_days: number;
  origin_city: string | null;
  destination_city: string | null;
  destination_country: string | null;
  exit_port: string | null;
  salesperson_id: string | null;
  salesperson_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  gross_weight_kg: number;
  volume_cbm: number;
  has_receipt: number;
  in_stock_packages: number;
};

type ExpenseRow = {
  id: string;
  order_id: string;
  direction: "receivable" | "payable";
  stage: string;
  charge_code: string;
  charge_name: string;
  counterparty_name: string | null;
  base_amount: number;
  created_at: string;
  settlement_confirmed_at: string | null;
  allocated_amount: number;
};

type VehicleRow = {
  order_id: string;
  batch_id: string;
  batch_number: string;
  vehicle_no: string | null;
  border_port: string | null;
  actual_departure_at: string | null;
};

type ConfigRow = {
  metric_code: string;
  calculation_mode: AnalyticsCalculationMode;
  assigned_position_id: string | null;
  assigned_position_name: string | null;
  assigned_position_code: string | null;
  start_date_source: AnalyticsDateSource;
  target_value: number | null;
  warning_value: number | null;
  danger_value: number | null;
  effective_from: string;
};

type ManualValueRow = {
  metric_code: string;
  dimension_key: string;
  dimension_label: string | null;
  numeric_value: number | null;
  text_value: string | null;
  source_note: string | null;
  updated_at: string;
};

type PortSettingRow = { port_name: string; is_visible: number; sort_order: number };
type ReferencePortRow = { code: string; name: string; sort_order: number };

export type AnalyticsFilters = {
  view: "overview" | "product" | "customer" | "port-cost" | "receivable" | "team-risk" | "config";
  period: "month" | "quarter" | "year" | "custom";
  from: string;
  to: string;
  customerId: string;
  ownerId: string;
  route: string;
  businessType: string;
  exitPort: string;
};

export async function loadAnalyticsSnapshot(request: Request, current: SessionUser) {
  const access = analyticsVisibility(current.permissions);
  if (!access.canView) throw new Response("没有权限查看汇总分析", { status: 403 });
  const url = new URL(request.url);
  const filters = analyticsFilters(url);
  const visibility = orderVisibilitySql(current, "o");
  const result = await env.DB.prepare(
    `SELECT o.id,o.order_number,o.status,o.business_type,o.is_overdue,o.exception_status,
            o.order_date,o.created_at,o.customer_id,c.name customer_name,c.payment_terms_days,
            o.origin_city,o.destination_city,o.destination_country,o.exit_port,
            o.salesperson_user_id salesperson_id,salesperson.display_name salesperson_name,
            o.current_assignee_user_id owner_id,owner.display_name owner_name,
            o.gross_weight_kg,o.volume_cbm,
            CASE WHEN EXISTS(
              SELECT 1 FROM shipments s JOIN warehouse_receipts receipt ON receipt.shipment_id=s.id
              WHERE s.organization_id=o.organization_id AND s.order_id=o.id AND receipt.status='completed'
            ) THEN 1 ELSE 0 END has_receipt,
            COALESCE((SELECT COUNT(*) FROM order_cargo_packages package
              WHERE package.organization_id=o.organization_id AND package.order_id=o.id AND package.status='received'),0) in_stock_packages
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       LEFT JOIN users salesperson ON salesperson.id=o.salesperson_user_id
       LEFT JOIN users owner ON owner.id=o.current_assignee_user_id
      WHERE o.organization_id=? AND ${visibility.sql} AND o.status!='cancelled'
      ORDER BY COALESCE(o.order_date,o.created_at) DESC
      LIMIT 5000`,
  ).bind(current.organizationId, ...visibility.values).all<AnalyticsOrderRow>();

  const allRows = result.results;
  const allOrderIds = allRows.map((row) => row.id);
  const [expenseRows, vehicleRows, exceptionRows, configurationRows, manualValues, portSettingRows, referencePorts, positions] = await Promise.all([
    loadExpenses(current.organizationId, allOrderIds),
    loadVehicles(current.organizationId, allOrderIds),
    loadExceptions(current.organizationId, allOrderIds),
    loadMetricConfigurations(current.organizationId),
    loadManualValues(current.organizationId, filters.from, filters.to),
    loadPortSettings(current.organizationId),
    env.DB.prepare("SELECT code,name,sort_order FROM reference_data WHERE organization_id=? AND category='border_port' AND status='active' ORDER BY sort_order,code")
      .bind(current.organizationId).all<ReferencePortRow>(),
    env.DB.prepare(`SELECT id,code,name,department_code FROM positions WHERE organization_id=? AND status='active' ORDER BY sort_order,name`)
      .bind(current.organizationId).all<{ id: string; code: string; name: string; department_code: string | null }>(),
  ]);

  const vehiclePortsByOrder = new Map<string, string>();
  for (const vehicle of vehicleRows) {
    if (vehicle.border_port && !vehiclePortsByOrder.has(vehicle.order_id)) vehiclePortsByOrder.set(vehicle.order_id, vehicle.border_port);
  }
  const effectivePort = (row: AnalyticsOrderRow) => row.exit_port || vehiclePortsByOrder.get(row.id) || "";
  const routeQuery = filters.route.toLocaleLowerCase("zh-CN");
  const rows = allRows.filter((row) => {
    const orderDate = (row.order_date || row.created_at).slice(0, 10);
    if (orderDate < filters.from || orderDate > filters.to) return false;
    if (filters.customerId && row.customer_id !== filters.customerId) return false;
    if (filters.ownerId && row.owner_id !== filters.ownerId && row.salesperson_id !== filters.ownerId) return false;
    if (filters.businessType && row.business_type !== filters.businessType) return false;
    if (filters.exitPort && effectivePort(row) !== filters.exitPort) return false;
    if (routeQuery && !`${row.origin_city || ""} ${row.destination_city || ""} ${row.destination_country || ""}`.toLocaleLowerCase("zh-CN").includes(routeQuery)) return false;
    return true;
  });
  const scopedOrderIds = new Set(rows.map((row) => row.id));
  const orderTerms = new Map(allRows.map((row) => [row.id, Number(row.payment_terms_days || 0)]));
  const scopedExpenses = expenseRows.filter((expense) => scopedOrderIds.has(expense.order_id));
  const report = buildFinancialAnalyticsReport({
    orders: rows.map(toReportOrder),
    expenses: scopedExpenses.map((expense) => toReportExpense(expense, orderTerms.get(expense.order_id) ?? 0)),
    vehicles: vehicleRows.filter((vehicle) => scopedOrderIds.has(vehicle.order_id)).map(toReportVehicle),
    exceptions: exceptionRows.filter((item) => !item.orderId || scopedOrderIds.has(item.orderId)),
  });
  const previousRange = previousCalendarMonth(filters.from);
  const previousRows = allRows.filter((row) => {
    const orderDate = (row.order_date || row.created_at).slice(0, 10);
    return orderDate >= previousRange.from && orderDate <= previousRange.to;
  });
  const previousOrderIds = new Set(previousRows.map((row) => row.id));
  const previousReport = buildFinancialAnalyticsReport({
    orders: previousRows.map(toReportOrder),
    expenses: expenseRows.filter((expense) => previousOrderIds.has(expense.order_id)).map((expense) => toReportExpense(expense, orderTerms.get(expense.order_id) ?? 0)),
    vehicles: vehicleRows.filter((vehicle) => previousOrderIds.has(vehicle.order_id)).map(toReportVehicle),
    exceptions: exceptionRows.filter((item) => !item.orderId || previousOrderIds.has(item.orderId)),
  });
  applyPreviousMonthComparisons(report, previousReport);
  const configuration = resolveConfiguration(configurationRows);
  const manual = new Map(manualValues.map((row) => [`${row.metric_code}\u0000${row.dimension_key}`, row]));
  const configurationWithValues = configuration.map((item) => {
    const manualValue = item.calculationMode === "manual" ? manual.get(`${item.code}\u0000`) ?? null : null;
    return { ...item, manualValue: manualValue?.numeric_value ?? null, manualSourceNote: manualValue?.source_note ?? null, pendingManualValue: item.calculationMode === "manual" && manualValue?.numeric_value == null };
  });
  applyManualHeadlineValues(report, configuration, manual);
  const portNames = new Map(referencePorts.results.map((row) => [row.code, row.name]));
  const masterPortOrder = new Map(referencePorts.results.map((row) => [row.code, Number(row.sort_order || 100)]));
  const knownPorts = [...new Set([...referencePorts.results.map((row) => row.code), ...allRows.map((row) => row.exit_port).filter(Boolean), ...vehicleRows.map((row) => row.border_port).filter(Boolean)])] as string[];
  const portSettings = knownPorts.map((portName, index) => ({
    portName,
    displayName: portNames.get(portName) || portName,
    isVisible: portSettingRows.find((row) => row.port_name === portName)?.is_visible !== 0,
    sortOrder: portSettingRows.find((row) => row.port_name === portName)?.sort_order ?? masterPortOrder.get(portName) ?? (index + 1) * 10,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName, "zh-CN"));
  applyPortVisibility(report, new Set(portSettings.filter((row) => row.isVisible).map((row) => row.portName)));
  applyPortLabels(report, portNames);
  const visibleReport = redactFinancialReport(report, access);

  const countBy = (key: (row: AnalyticsOrderRow) => string) => Object.entries(rows.reduce<Record<string, number>>((counts, row) => {
    const label = key(row) || "未设置";
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1]);

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
      receivable: access.canViewReceivable ? visibleReport.overview.revenue : null,
      payable: access.canViewPayable ? visibleReport.overview.directCost : null,
      profit: access.canViewProfit ? visibleReport.overview.grossProfit : null,
      margin: access.canViewProfit ? visibleReport.overview.grossMargin : null,
    },
    report: visibleReport,
    configuration: access.canConfigure || access.canFillManual
      ? configurationWithValues.filter((item) => metricVisible(item.sensitivity, access))
      : [],
    metricStates: configurationWithValues.filter((item) => metricVisible(item.sensitivity, access)).map((item) => ({
      code: item.code,
      calculationMode: item.calculationMode,
      pendingManualValue: item.pendingManualValue,
      manualValue: item.manualValue,
      sourceLabel: item.calculationMode === "automatic" ? "系统自动计算" : `岗位填报${item.assignedPositionName ? ` · ${item.assignedPositionName}` : ""}`,
    })),
    breakdowns: {
      customers: countBy((row) => row.customer_name).slice(0, 10),
      routes: countBy((row) => `${row.origin_city || "起运地待补"} → ${row.destination_city || "目的地待补"}`).slice(0, 10),
      owners: countBy((row) => row.owner_name || row.salesperson_name || "负责人待指派").slice(0, 10),
    },
    options: {
      customers: [...new Map(allRows.map((row) => [row.customer_id, row.customer_name])).entries()].map(([id, name]) => ({ id, name })),
      owners: [...new Map(allRows.filter((row) => row.owner_id || row.salesperson_id).map((row) => [row.owner_id || row.salesperson_id!, row.owner_name || row.salesperson_name || "未命名负责人"])).entries()].map(([id, name]) => ({ id, name })),
      ports: portSettings.filter((row) => row.isVisible).map((row) => ({ code: row.portName, name: row.displayName })),
      positions: positions.results,
    },
    portSettings: access.canConfigure ? portSettings : [],
    generatedAt: new Date().toISOString(),
  };
}

export async function generateScheduledAnalyticsSnapshots(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const periodStart = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const periodEnd = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
  const organizations = (await env.DB.prepare("SELECT id,name FROM organizations WHERE status='active' ORDER BY id").all<{ id: string; name: string }>()).results;
  let generated = 0;
  for (const organization of organizations) {
    const systemUser: SessionUser = {
      sessionId: "scheduled-analytics", userId: "scheduled-analytics", organizationId: organization.id, organizationName: organization.name,
      email: "scheduled@local", displayName: "定时报表任务", site: "admin", positionCode: "SYSTEM", roleCodes: ["owner"],
      permissions: ["analytics.business.view", "analytics.receivable.view", "analytics.payable.view", "analytics.profit.view", "analytics.config.manage", "analytics.manual.fill", "data.export", "order.view", "order.scope.all"],
      departmentId: null, departmentCode: null, dataScope: "company", warehouseIds: [], regionCountryCodes: [],
    };
    const request = new Request(`https://scheduled.local/admin/analytics?period=custom&from=${periodStart}&to=${periodEnd}`);
    const snapshot = await loadAnalyticsSnapshot(request, systemUser);
    const generatedAt = now.toISOString();
    await env.DB.prepare(`INSERT INTO analytics_report_snapshots(id,organization_id,period_start,period_end,generated_at,generation_mode,payload_json,created_at)
      VALUES(?,?,?,?,?,'scheduled',?,?)`).bind(
      crypto.randomUUID(), organization.id, periodStart, periodEnd, generatedAt,
      JSON.stringify({ filters: snapshot.filters, metrics: snapshot.metrics, finance: snapshot.finance, report: snapshot.report, generatedAt }), generatedAt,
    ).run();
    generated += 1;
  }
  return { generated, periodStart, periodEnd, generatedAt: now.toISOString() };
}

function applyPortVisibility(report: ReturnType<typeof buildFinancialAnalyticsReport>, visiblePorts: Set<string>) {
  report.portContribution = report.portContribution.filter((row) => visiblePorts.has(row.portName));
  report.portCostStructure = report.portCostStructure.filter((row) => visiblePorts.has(row.portName));
  report.cargoDamage = report.cargoDamage.filter((row) => visiblePorts.has(row.portName));
  report.vehicleAnalysis = report.vehicleAnalysis.filter((row) => row.dimension !== "按口岸" || visiblePorts.has(row.businessType));
}

function applyPortLabels(report: ReturnType<typeof buildFinancialAnalyticsReport>, portNames: Map<string, string>) {
  const label = (code: string) => portNames.get(code) || code || "未设置";
  for (const row of report.portContribution) row.portName = label(row.portName);
  for (const row of report.portCostStructure) row.portName = label(row.portName);
  for (const row of report.cargoDamage) row.portName = label(row.portName);
  for (const row of report.vehicleAnalysis) if (row.dimension === "按口岸") row.businessType = label(row.businessType);
}

function previousCalendarMonth(anchorDate: string) {
  const anchor = new Date(`${anchorDate.slice(0, 7)}-01T00:00:00.000Z`);
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function applyPreviousMonthComparisons(
  current: ReturnType<typeof buildFinancialAnalyticsReport>,
  previous: ReturnType<typeof buildFinancialAnalyticsReport>,
) {
  const compare = (value: number, oldValue: number | undefined) => {
    if (oldValue === undefined) return "暂无可比数据";
    if (oldValue === 0 && value > 0) return "新增";
    if (oldValue === 0) return "—";
    const change = (value - oldValue) / Math.abs(oldValue);
    return `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  };
  const customers = new Map(previous.customerContribution.map((row) => [row.customerId, row.sales]));
  for (const row of current.customerContribution) row.comparison = compare(row.sales, customers.get(row.customerId));
  const costs = new Map(previous.costStructure.map((row) => [row.category, row.amount]));
  for (const row of current.costStructure) row.comparison = compare(row.amount, costs.get(row.category));
  const suppliers = new Map(previous.supplierPayments.map((row) => [row.supplierName, row.purchaseAmount]));
  for (const row of current.supplierPayments) row.priceChange = compare(row.purchaseAmount, suppliers.get(row.supplierName));
}

function analyticsFilters(url: URL): AnalyticsFilters {
  const requestedView = url.searchParams.get("view");
  const view = (["overview", "product", "customer", "port-cost", "receivable", "team-risk", "config"].includes(requestedView || "") ? requestedView : "overview") as AnalyticsFilters["view"];
  const requestedPeriod = url.searchParams.get("period");
  const period = (["month", "quarter", "year", "custom"].includes(requestedPeriod || "") ? requestedPeriod : "month") as AnalyticsFilters["period"];
  const now = new Date();
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  let from = (url.searchParams.get("from") ?? "").trim();
  let to = (url.searchParams.get("to") ?? "").trim();
  if (period !== "custom" || !from || !to) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    if (period === "year") from = `${year}-01-01`;
    else if (period === "quarter") from = `${year}-${String(Math.floor(month / 3) * 3 + 1).padStart(2, "0")}-01`;
    else from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    to = current;
  }
  if (from > to) [from, to] = [to, from];
  return {
    view,
    period,
    from,
    to,
    customerId: (url.searchParams.get("customerId") ?? "").trim(),
    ownerId: (url.searchParams.get("ownerId") ?? "").trim(),
    route: (url.searchParams.get("route") ?? "").trim(),
    businessType: (url.searchParams.get("businessType") ?? "").trim(),
    exitPort: (url.searchParams.get("exitPort") ?? "").trim(),
  };
}

async function loadExpenses(organizationId: string, orderIds: string[]) {
  const rows: ExpenseRow[] = [];
  for (const chunk of chunkD1Values(orderIds, 2)) {
    const result = await env.DB.prepare(
      `SELECT e.id,e.order_id,e.direction,e.stage,e.charge_code,e.charge_name,e.counterparty_name,
              e.base_amount,e.created_at,
              (SELECT MAX(r.confirmed_at) FROM settlement_reconciliation_lines line
                JOIN settlement_reconciliations r ON r.id=line.reconciliation_id AND r.organization_id=line.organization_id
               WHERE line.organization_id=e.organization_id AND line.expense_id=e.id AND r.status='confirmed') settlement_confirmed_at,
              COALESCE((SELECT SUM(allocation.amount) FROM settlement_cash_allocations allocation
                JOIN settlement_cash_transactions transaction_record
                  ON transaction_record.id=allocation.cash_transaction_id AND transaction_record.status!='void'
               WHERE allocation.organization_id=e.organization_id AND allocation.expense_id=e.id),0) allocated_amount
         FROM business_expenses e
        WHERE e.organization_id=? AND e.order_id IN (${d1Placeholders(chunk.length)})
          AND e.stage!='cancelled'`,
    ).bind(organizationId, ...chunk).all<ExpenseRow>();
    rows.push(...result.results);
  }
  return rows;
}

async function loadVehicles(organizationId: string, orderIds: string[]) {
  const rows: VehicleRow[] = [];
  for (const chunk of chunkD1Values(orderIds, 2)) {
    const result = await env.DB.prepare(
      `SELECT batch_order.order_id,batch.id batch_id,batch.batch_number,vehicle.vehicle_no,
              batch.border_port,batch.actual_departure_at
         FROM transport_batch_orders batch_order
         JOIN transport_batches batch ON batch.id=batch_order.batch_id AND batch.organization_id=batch_order.organization_id
         LEFT JOIN transport_batch_vehicles vehicle ON vehicle.batch_id=batch.id AND vehicle.status!='cancelled'
        WHERE batch_order.organization_id=? AND batch_order.order_id IN (${d1Placeholders(chunk.length)})
          AND batch_order.status!='removed' AND batch.status!='cancelled'`,
    ).bind(organizationId, ...chunk).all<VehicleRow>();
    rows.push(...result.results);
  }
  return rows;
}

async function loadExceptions(organizationId: string, orderIds: string[]) {
  const rows: FinancialAnalyticsException[] = [];
  for (const chunk of chunkD1Values(orderIds, 2)) {
    const result = await env.DB.prepare(
      `SELECT exception_record.order_id,COALESCE(order_record.exit_port,batch.border_port,'未设置') port_name,
              exception_record.exception_type type,exception_record.description
         FROM transport_batch_exceptions exception_record
         JOIN transport_batches batch ON batch.id=exception_record.batch_id
         LEFT JOIN transport_orders order_record ON order_record.id=exception_record.order_id
        WHERE exception_record.organization_id=? AND exception_record.order_id IN (${d1Placeholders(chunk.length)})
          AND exception_record.status!='cancelled'`,
    ).bind(organizationId, ...chunk).all<{ order_id: string | null; port_name: string; type: string; description: string }>();
    rows.push(...result.results.map((row) => ({ orderId: row.order_id, portName: row.port_name, type: row.type, description: row.description })));
  }
  return rows;
}

async function loadMetricConfigurations(organizationId: string) {
  return (await env.DB.prepare(
    `SELECT config.metric_code,config.calculation_mode,config.assigned_position_id,
            position.name assigned_position_name,position.code assigned_position_code,config.start_date_source,
            config.target_value,config.warning_value,config.danger_value,config.effective_from
       FROM analytics_metric_configs config
       LEFT JOIN positions position ON position.id=config.assigned_position_id
      WHERE config.organization_id=?`,
  ).bind(organizationId).all<ConfigRow>()).results;
}

async function loadManualValues(organizationId: string, from: string, to: string) {
  return (await env.DB.prepare(
    `SELECT metric_code,dimension_key,dimension_label,numeric_value,text_value,source_note,updated_at
       FROM analytics_manual_metric_values
      WHERE organization_id=? AND period_start=? AND period_end=? AND status='confirmed'`,
  ).bind(organizationId, from, to).all<ManualValueRow>()).results;
}

async function loadPortSettings(organizationId: string) {
  return (await env.DB.prepare(
    "SELECT port_name,is_visible,sort_order FROM analytics_port_settings WHERE organization_id=? ORDER BY sort_order,port_name",
  ).bind(organizationId).all<PortSettingRow>()).results;
}

function resolveConfiguration(rows: ConfigRow[]) {
  const configured = new Map(rows.map((row) => [row.metric_code, row]));
  return analyticsMetricDefinitions.map((definition) => ({
    ...definition,
    calculationMode: configured.get(definition.code)?.calculation_mode ?? "automatic" as AnalyticsCalculationMode,
    assignedPositionId: configured.get(definition.code)?.assigned_position_id ?? null,
    assignedPositionName: configured.get(definition.code)?.assigned_position_name ?? null,
    assignedPositionCode: configured.get(definition.code)?.assigned_position_code ?? null,
    startDateSource: configured.get(definition.code)?.start_date_source ?? definition.defaultDateSource,
    targetValue: configured.get(definition.code)?.target_value ?? null,
    warningValue: configured.get(definition.code)?.warning_value ?? null,
    dangerValue: configured.get(definition.code)?.danger_value ?? null,
    effectiveFrom: configured.get(definition.code)?.effective_from ?? null,
  }));
}

function metricVisible(sensitivity: string, access: ReturnType<typeof analyticsVisibility>) {
  if (sensitivity === "receivable") return access.canViewReceivable;
  if (sensitivity === "payable") return access.canViewPayable;
  if (sensitivity === "profit") return access.canViewProfit;
  return access.canView;
}

function applyManualHeadlineValues(
  report: ReturnType<typeof buildFinancialAnalyticsReport>,
  configuration: ReturnType<typeof resolveConfiguration>,
  manualValues: Map<string, ManualValueRow>,
) {
  const manual = (code: string) => configuration.find((item) => item.code === code)?.calculationMode === "manual"
    ? manualValues.get(`${code}\u0000`)?.numeric_value ?? null
    : null;
  report.overview.revenue = manual("revenue") ?? report.overview.revenue;
  report.overview.directCost = manual("direct_cost") ?? report.overview.directCost;
  report.overview.grossProfit = manual("gross_profit") ?? (report.overview.revenue - report.overview.directCost);
  report.overview.grossMargin = report.overview.revenue > 0 ? report.overview.grossProfit / report.overview.revenue : null;
  report.receivables.dso = manual("dso") ?? report.receivables.dso;
  report.receivables.collectionRate = manual("collection_rate") ?? report.receivables.collectionRate;
  report.receivables.badDebtReserve = manual("bad_debt_reserve") ?? report.receivables.badDebtReserve;
  report.receivables.badDebtReserveRate = report.receivables.total > 0 ? report.receivables.badDebtReserve / report.receivables.total : 0;
  const greenLaneManual = configuration.find((item) => item.code === "cargo_damage")?.calculationMode === "manual";
  if (greenLaneManual) {
    for (const row of report.cargoDamage) row.greenLaneCount = manualValues.get(`cargo_damage\u0000${row.portName}`)?.numeric_value ?? row.greenLaneCount;
  }
}

function toReportOrder(row: AnalyticsOrderRow): FinancialAnalyticsOrder {
  return {
    id: row.id,
    orderNumber: row.order_number,
    businessType: row.business_type,
    customerId: row.customer_id,
    customerName: row.customer_name,
    destinationCountry: row.destination_country || "未设置",
    exitPort: row.exit_port || "",
    salespersonId: row.salesperson_id || "",
    salespersonName: row.salesperson_name || "未指定",
    grossWeightKg: Number(row.gross_weight_kg || 0),
    volumeCbm: Number(row.volume_cbm || 0),
  };
}

function toReportExpense(row: ExpenseRow, termsDays: number): FinancialAnalyticsExpense {
  const base = row.settlement_confirmed_at || row.created_at;
  const due = new Date(base);
  due.setUTCDate(due.getUTCDate() + Math.max(0, termsDays));
  return {
    id: row.id,
    orderId: row.order_id,
    direction: row.direction,
    stage: row.stage,
    chargeCode: row.charge_code,
    chargeName: row.charge_name,
    counterpartyName: row.counterparty_name || "未设置",
    baseAmount: Number(row.base_amount || 0),
    allocatedAmount: Number(row.allocated_amount || 0),
    settlementConfirmedAt: row.settlement_confirmed_at,
    dueDate: due.toISOString().slice(0, 10),
  };
}

function toReportVehicle(row: VehicleRow): FinancialAnalyticsVehicle {
  return {
    orderId: row.order_id,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    vehicleNo: row.vehicle_no || "",
    borderPort: row.border_port || "",
    departedAt: row.actual_departure_at,
  };
}
