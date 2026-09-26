import { env } from "cloudflare:workers";
import type { CSSProperties, ReactNode } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/admin.analytics";
import { ActionToast } from "../components/ActionToast";
import { AppIcon } from "../components/AppIcon";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser } from "../lib/auth.server";
import { analyticsVisibility } from "../lib/analytics-access";
import { analyticsMetricDefinitions, metricDefinition, type AnalyticsCalculationMode, type AnalyticsDateSource } from "../lib/financial-analytics";
import { loadAnalyticsSnapshot } from "../lib/analytics.server";
import { valueOf } from "../lib/validation";

const dateSources: Array<[AnalyticsDateSource, string]> = [
  ["order_created", "订单创建日"], ["actual_departure", "实际发车日"], ["actual_arrival", "实际到达日"],
  ["customer_signed", "客户签收日"], ["settlement_confirmed", "结算确认日"], ["bill_created", "账单生成日"],
  ["agreed_due", "约定付款日"], ["cash_occurred", "收付款发生日"], ["manual", "手工选择"],
];

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "analytics.business.view");
  return { current, ...(await loadAnalyticsSnapshot(request, current)) };
}

export async function action({ request }: Route.ActionArgs) {
  const current = await requireSessionUser(request, "analytics.business.view");
  const access = analyticsVisibility(current.permissions);
  const form = await request.formData();
  const intent = valueOf(form, "intent");
  const now = new Date().toISOString();
  if (intent === "save_port_visibility") {
    if (!access.canConfigure) throw new Response("没有口岸展示配置权限", { status: 403 });
    const ports = form.getAll("visiblePort").map(String).filter(Boolean);
    const knownPorts = form.getAll("knownPort").map(String).filter(Boolean);
    const visible = new Set(ports);
    for (const [index, portName] of knownPorts.entries()) {
      await env.DB.prepare(`INSERT INTO analytics_port_settings(organization_id,port_name,is_visible,sort_order,updated_by_user_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(organization_id,port_name) DO UPDATE SET is_visible=excluded.is_visible,sort_order=excluded.sort_order,
        updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`)
        .bind(current.organizationId, portName, visible.has(portName) ? 1 : 0, (index + 1) * 10, current.userId, now, now).run();
    }
    await writeAudit({ request, action: "analytics.port_visibility.update", resourceType: "analytics_port_setting", organizationId: current.organizationId, actorUserId: current.userId, metadata: { knownPorts, visiblePorts: ports } });
    return { success: "口岸展示范围已保存" };
  }
  const metricCode = valueOf(form, "metricCode");
  const definition = metricDefinition(metricCode);
  if (!definition) return { formError: "分析指标不存在" };

  if (intent === "save_config") {
    if (!access.canConfigure) throw new Response("没有财务分析口径配置权限", { status: 403 });
    const mode = valueOf(form, "calculationMode") as AnalyticsCalculationMode;
    const dateSource = valueOf(form, "startDateSource") as AnalyticsDateSource;
    const positionId = valueOf(form, "assignedPositionId") || null;
    const effectiveFrom = valueOf(form, "effectiveFrom");
    if (!(["automatic", "manual"] as string[]).includes(mode)) return { formError: "计算方式无效" };
    if (!dateSources.some(([code]) => code === dateSource)) return { formError: "起算日期来源无效" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { formError: "请选择生效日期" };
    if (mode === "manual" && !positionId) return { formError: "人工填写必须指定岗位" };
    if (positionId) {
      const position = await env.DB.prepare("SELECT id FROM positions WHERE id=? AND organization_id=? AND status='active'").bind(positionId, current.organizationId).first();
      if (!position) return { formError: "指定岗位无效或已停用" };
    }
    const previous = await env.DB.prepare("SELECT calculation_mode,assigned_position_id,start_date_source,target_value,warning_value,danger_value,effective_from FROM analytics_metric_configs WHERE organization_id=? AND metric_code=?")
      .bind(current.organizationId, metricCode).first();
    const numberOrNull = (name: string) => {
      const raw = valueOf(form, name);
      if (!raw) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const next = {
      calculationMode: mode, assignedPositionId: mode === "manual" ? positionId : null, startDateSource: dateSource,
      targetValue: numberOrNull("targetValue"), warningValue: numberOrNull("warningValue"), dangerValue: numberOrNull("dangerValue"), effectiveFrom,
    };
    await env.DB.prepare(`INSERT INTO analytics_metric_configs
      (id,organization_id,metric_code,calculation_mode,assigned_position_id,start_date_source,target_value,warning_value,danger_value,effective_from,updated_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(organization_id,metric_code) DO UPDATE SET calculation_mode=excluded.calculation_mode,assigned_position_id=excluded.assigned_position_id,
        start_date_source=excluded.start_date_source,target_value=excluded.target_value,warning_value=excluded.warning_value,danger_value=excluded.danger_value,
        effective_from=excluded.effective_from,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`)
      .bind(crypto.randomUUID(), current.organizationId, metricCode, mode, next.assignedPositionId, dateSource, next.targetValue, next.warningValue, next.dangerValue, effectiveFrom, current.userId, now, now).run();
    await writeAudit({ request, action: "analytics.metric_config.update", resourceType: "analytics_metric_config", resourceId: metricCode, organizationId: current.organizationId, actorUserId: current.userId, metadata: { before: previous, after: next } });
    return { success: `${definition.label} 的统计口径已保存，自 ${effectiveFrom} 起生效` };
  }

  if (intent === "save_manual_value") {
    if (!access.canFillManual && !access.canConfigure) throw new Response("没有人工指标填写权限", { status: 403 });
    const config = await env.DB.prepare(`SELECT config.calculation_mode,position.code position_code FROM analytics_metric_configs config
      LEFT JOIN positions position ON position.id=config.assigned_position_id WHERE config.organization_id=? AND config.metric_code=?`)
      .bind(current.organizationId, metricCode).first<{ calculation_mode: string; position_code: string | null }>();
    if (!config || config.calculation_mode !== "manual") return { formError: "该指标当前不是人工填写模式" };
    if (!access.canConfigure && (!config.position_code || config.position_code !== current.positionCode)) return { formError: "该指标未分配给当前岗位" };
    const periodStart = valueOf(form, "periodStart");
    const periodEnd = valueOf(form, "periodEnd");
    const rawValue = valueOf(form, "numericValue");
    const numericValue = Number(rawValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodStart > periodEnd) return { formError: "统计期间无效" };
    if (!rawValue || !Number.isFinite(numericValue)) return { formError: "请填写有效数值" };
    const dimensionKey = valueOf(form, "dimensionKey");
    const dimensionLabel = valueOf(form, "dimensionLabel") || null;
    const sourceNote = valueOf(form, "sourceNote") || null;
    const previous = await env.DB.prepare("SELECT numeric_value,source_note,updated_at FROM analytics_manual_metric_values WHERE organization_id=? AND metric_code=? AND period_start=? AND period_end=? AND dimension_key=?")
      .bind(current.organizationId, metricCode, periodStart, periodEnd, dimensionKey).first();
    await env.DB.prepare(`INSERT INTO analytics_manual_metric_values
      (id,organization_id,metric_code,period_start,period_end,dimension_key,dimension_label,numeric_value,source_note,status,entered_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'confirmed',?,?,?)
      ON CONFLICT(organization_id,metric_code,period_start,period_end,dimension_key) DO UPDATE SET dimension_label=excluded.dimension_label,
        numeric_value=excluded.numeric_value,source_note=excluded.source_note,status='confirmed',entered_by_user_id=excluded.entered_by_user_id,updated_at=excluded.updated_at`)
      .bind(crypto.randomUUID(), current.organizationId, metricCode, periodStart, periodEnd, dimensionKey, dimensionLabel, numericValue, sourceNote, current.userId, now, now).run();
    await writeAudit({ request, action: "analytics.manual_value.confirm", resourceType: "analytics_manual_metric_value", resourceId: metricCode, organizationId: current.organizationId, actorUserId: current.userId, metadata: { periodStart, periodEnd, dimensionKey, before: previous, after: { numericValue, sourceNote } } });
    return { success: `${definition.label} 已确认，分析报表将采用该人工值` };
  }
  return { formError: "未知操作" };
}

export default function Analytics({ loaderData, actionData }: Route.ComponentProps) {
  const { report, access } = loaderData;
  const revenueMetric = displayedMetric(loaderData.metricStates, "revenue", report.overview.revenue, money);
  const costMetric = displayedMetric(loaderData.metricStates, "direct_cost", report.overview.directCost, money);
  const profitMetric = displayedMetric(loaderData.metricStates, "gross_profit", report.overview.grossProfit, money);
  const receivableMetric = displayedMetric(loaderData.metricStates, "receivable_balance", report.receivables.total, money);
  const dsoMetric = displayedMetric(loaderData.metricStates, "dso", report.receivables.dso, (value) => `${value} 天`);
  const collectionMetric = displayedMetric(loaderData.metricStates, "collection_rate", report.receivables.collectionRate ?? 0, (value) => percent(value));
  const reserveMetric = displayedMetric(loaderData.metricStates, "bad_debt_reserve", report.receivables.badDebtReserve, money);
  const filterParams = new URLSearchParams(Object.entries(loaderData.filters).filter(([, value]) => value));
  const view = loaderData.filters.view;
  const viewHref = (nextView: string) => { const params = new URLSearchParams(filterParams); params.set("view", nextView); return `/admin/analytics?${params}`; };
  const cards = [
    { label: "订单总量", value: loaderData.metrics.total, hint: "当前筛选范围", icon: "clipboard" as const, href: "/admin/orders" },
    { label: "执行中", value: loaderData.metrics.executing, hint: "正在办理或运输", icon: "truck" as const, href: "/admin/orders?status=in_execution" },
    { label: "时效预警", value: loaderData.metrics.overdue, hint: "订单已标记超时", icon: "bell" as const, href: "/admin/orders" },
    { label: "业务异常", value: loaderData.metrics.exceptions, hint: "警告或异常状态", icon: "shield" as const, href: "/admin/orders?exception=yes" },
  ];
  return <div className="analytics-center finance-analytics">
    <ActionToast data={actionData}/>
    <header className="page-header analytics-header">
      <div><p className="eyebrow">FINANCIAL & BUSINESS ANALYTICS</p><h1>经营与财务汇总分析</h1><p>按已授权口径汇总订单、运踪、仓库和结算数据；正式金额取结算确认值，未确认金额单列为预计。</p></div>
      <div className="page-actions">{access.canExport && <a className="secondary" href={`/admin/analytics/export?${filterParams}`}>导出 Excel 数据</a>}<button className="secondary" type="button" onClick={() => window.print()}>导出 / 打印 PDF</button><Link className="primary" to="/admin/orders">穿透订单明细</Link></div>
    </header>

    <section className="panel analytics-filter-panel">
      <Form method="get" className="analytics-filter-bar finance-filter-bar"><input type="hidden" name="view" value={view}/>
        <label><span>统计周期</span><select name="period" defaultValue={loaderData.filters.period}><option value="month">本月</option><option value="quarter">本季度</option><option value="year">本年</option><option value="custom">自定义</option></select></label>
        <label><span>开始日期</span><input type="date" name="from" defaultValue={loaderData.filters.from}/></label>
        <label><span>结束日期</span><input type="date" name="to" defaultValue={loaderData.filters.to}/></label>
        <label><span>客户</span><select name="customerId" defaultValue={loaderData.filters.customerId}><option value="">全部客户</option>{loaderData.options.customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>业务类型</span><select name="businessType" defaultValue={loaderData.filters.businessType}><option value="">全部</option><option value="ftl">整车</option><option value="ltl">拼车</option></select></label>
        <div className="analytics-filter-actions"><button className="primary">应用筛选</button><Link className="secondary" to={`/admin/analytics?view=${view}`}>重置</Link></div>
        <details className="analytics-advanced-filters"><summary>更多筛选{(loaderData.filters.ownerId || loaderData.filters.route || loaderData.filters.exitPort) ? "（已启用）" : ""}</summary><div>
          <label><span>负责人</span><select name="ownerId" defaultValue={loaderData.filters.ownerId}><option value="">全部负责人</option>{loaderData.options.owners.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label><span>线路</span><input name="route" defaultValue={loaderData.filters.route} placeholder="起运地 / 目的地"/></label>
          <label><span>口岸</span><select name="exitPort" defaultValue={loaderData.filters.exitPort}><option value="">全部口岸</option>{loaderData.options.ports.map((port) => <option key={port.code} value={port.code}>{port.name}{port.name === port.code ? "" : ` · ${port.code}`}</option>)}</select></label>
        </div></details>
      </Form>
      <p className="analytics-generated">统计期间：{loaderData.filters.from} 至 {loaderData.filters.to} · 生成时间：{dateTime(loaderData.generatedAt)} · 抛重比 1:300</p>
    </section>

    <nav className="analytics-section-nav analytics-view-tabs" aria-label="分析板块导航">
      {([ ["overview", "经营全景"], ["product", "产品与发车"], ["customer", "客户"], ["port-cost", "口岸与成本"], ["receivable", "应收与供应商"], ["team-risk", "团队与预警"] ] as const).map(([code, label]) => <Link key={code} className={view === code ? "active" : ""} aria-current={view === code ? "page" : undefined} to={viewHref(code)}>{label}</Link>)}
      {(access.canConfigure || access.canFillManual) && <Link className={view === "config" ? "active" : ""} aria-current={view === "config" ? "page" : undefined} to={viewHref("config")}>{access.canConfigure ? "口径配置" : "指标填报"}</Link>}
    </nav>

    {view === "overview" && <section className="analytics-kpi-grid compact" aria-label="业务汇总指标">
      {cards.map((card) => <Link key={card.label} to={card.href}><span><AppIcon name={card.icon}/></span><div><small>{card.label}</small><strong>{card.value}</strong><em>{card.hint}</em></div></Link>)}
    </section>}

    {view === "overview" && <ReportSection id="analytics-section-1" eyebrow="01 / OVERVIEW" title="公司整体财务全景" description="过关税费、货款赔偿、货损和罚款不计入运营毛利，单列为异常财务影响。">
      <div className="finance-kpi-grid">
        {access.canViewReceivable && (
          <FinanceMetric label="确认收入" value={revenueMetric.value} note={`${revenueMetric.source} · 预计口径 ${money(report.overview.estimatedRevenue)}`}/>
        )}
        {access.canViewPayable && (
          <FinanceMetric label="直接结算成本" value={costMetric.value} note={`${costMetric.source} · 预计口径 ${money(report.overview.estimatedCost)}`}/>
        )}
        {access.canViewProfit && <FinanceMetric label="运营毛利" value={profitMetric.value} note={`${profitMetric.source} · 毛利率 ${profitMetric.pending ? "待填写" : percent(report.overview.grossMargin)}`} tone={!profitMetric.pending && report.overview.grossProfit < 0 ? "danger" : "good"}/>}
        {(access.canViewPayable || access.canViewProfit) && <FinanceMetric label="异常财务影响" value={money(report.overview.abnormalExpense - report.overview.abnormalIncome)} note="税费、赔偿、货损、罚款等" tone="warning"/>}
      </div>
    </ReportSection>}

    {view === "product" && <ReportSection id="analytics-section-2" eyebrow="02 / PRODUCT & VEHICLE" title="产品线利润与汽运发车分析" description="一张订单计一票；整车和拼车分别统计，发车数据可按业务线、国家和口岸查看。">
      <DataTable headers={["产品线", "票数", "票数占比", "销售额", "销售占比", "毛利", "毛利占比", "毛利率"]} empty="当前期间暂无产品线数据">
        {report.productLines.map((row) => <tr key={row.label}><td>{row.label}</td><td>{row.ticketCount}</td><td>{percent(row.ticketShare)}</td><MoneyCell allowed={access.canViewReceivable} value={row.sales}/><td>{access.canViewReceivable ? percent(row.salesShare) : "无权限"}</td><MoneyCell allowed={access.canViewProfit} value={row.grossProfit}/><td>{access.canViewProfit ? percent(row.grossProfitShare) : "无权限"}</td><td>{access.canViewProfit ? percent(row.grossMargin) : "无权限"}</td></tr>)}
      </DataTable>
      <DataTable headers={["统计维度", "业务线 / 口岸", "目的国", "票数", "发车数"]} empty="当前期间暂无发车数据">
        {report.vehicleAnalysis.map((row, index) => <tr key={`${row.dimension}-${row.businessType}-${index}`}><td>{row.dimension}</td><td>{row.businessType}</td><td>{row.destinationCountry}</td><td>{row.ticketCount}</td><td>{row.departureCount}</td></tr>)}
      </DataTable>
      <details className="analytics-details"><summary>一票多车订单明细（{report.multiVehicleOrders.length} 条）</summary><DataTable headers={["订单号", "业务线", "销售", "目的地 / 口岸", "车辆总数", "车号"]} empty="当前期间无一票多车记录">{report.multiVehicleOrders.map((row, index) => <tr key={`${row.orderId}-${row.vehicleNo}-${index}`}><td><Link to={`/admin/orders/${row.orderId}`}>{row.orderNumber}</Link></td><td>{row.businessType}</td><td>{row.salesperson}</td><td>{row.destination}</td><td>{row.totalVehicles}</td><td>{row.vehicleNo}</td></tr>)}</DataTable></details>
    </ReportSection>}

    {view === "customer" && <ReportSection id="analytics-section-3" eyebrow="03 / CUSTOMER" title="客户贡献与应收账龄" description="贡献占比由订单结算数据自动计算；Top 10 之外合并为其他客户。">
      {access.canViewReceivable ? <div className="customer-contribution-layout"><ContributionPie rows={report.customerContribution}/><DataTable headers={["客户", "销售额", "销售占比", "毛利", "毛利占比", "毛利率", "上月比较"]} empty="暂无客户贡献数据">{report.customerContribution.map((row) => <tr key={row.customerId}><td><Link to={`/admin/orders?keyword=${encodeURIComponent(row.customerName)}`}>{row.customerName}</Link></td><td>{money(row.sales)}</td><td>{percent(row.salesShare)}</td><td>{access.canViewProfit ? money(row.grossProfit) : "无权限"}</td><td>{access.canViewProfit ? percent(row.grossProfitShare) : "无权限"}</td><td>{access.canViewProfit ? percent(row.grossMargin) : "无权限"}</td><td>{row.comparison}</td></tr>)}</DataTable></div> : <PermissionNotice/>}
      {access.canViewReceivable && <DataTable headers={["客户", "应收余额", "余额占比", "最长账龄", "逾期金额", "逾期占比", "信用状态"]} empty="暂无客户应收余额">{report.customerReceivables.map((row) => <tr key={row.customerId}><td>{row.customerName}</td><td>{money(row.balance)}</td><td>{percent(row.share)}</td><td>{row.agingDays} 天</td><td>{money(row.overdueAmount)}</td><td>{percent(row.overdueRatio)}</td><td><Status value={row.creditStatus}/></td></tr>)}</DataTable>}
    </ReportSection>}

    {view === "port-cost" && <ReportSection id="analytics-section-4" eyebrow="04 / PORT & COST" title="口岸贡献与成本结构" description="口岸可由配置人员勾选展示；成本按结算费用归类，拼车公共费用按实重与体积重×300孰高的计费重比例分摊。">
      {access.canViewProfit ? <DataTable headers={["口岸", "目的国", "销售收入", "直接成本", "毛利", "毛利率", "票数", "成本占比"]} empty="暂无口岸贡献数据">{report.portContribution.map((row, index) => <tr key={`${row.portName}-${row.destinationCountry}-${index}`}><td>{row.portName}</td><td>{row.destinationCountry}</td><td>{money(row.revenue)}</td><td>{money(row.cost)}</td><td>{money(row.grossProfit)}</td><td>{percent(row.grossMargin)}</td><td>{row.ticketCount}</td><td>{percent(row.directCostShare)}</td></tr>)}</DataTable> : <PermissionNotice/>}
      {access.canViewPayable && <><DataTable headers={["成本类别", "金额", "占运营成本", "占销售收入", "上月比较"]} empty="暂无成本数据">{report.costStructure.map((row) => <tr key={row.category}><td>{row.category}</td><td>{money(row.amount)}</td><td>{percent(row.costShare)}</td><td>{percent(row.revenueShare)}</td><td>{row.comparison}</td></tr>)}</DataTable>
      <DataTable headers={["业务线", "成本类别", "金额", "业务线内占比", "公司成本占比"]} empty="暂无业务线成本数据">{report.businessCostDistribution.map((row, index) => <tr key={`${row.businessType}-${row.category}-${index}`}><td>{row.businessType}</td><td>{row.category}</td><td>{money(row.amount)}</td><td>{percent(row.businessShare)}</td><td>{percent(row.companyShare)}</td></tr>)}</DataTable>
      <DataTable headers={["口岸", "总成本", "境外运费", "正常运费", "压车费", "生活费", "国内运费", "仓储费", "转关费", "税费保险", "其他"]} empty="暂无口岸成本数据">{report.portCostStructure.map((row) => <tr key={row.portName}><td>{row.portName}</td><td>{money(row.totalCost)}</td><td>{money(row.overseasFreight)}</td><td>{money(row.normalFreight)}</td><td>{money(row.detention)}</td><td>{money(row.living)}</td><td>{money(row.domesticFreight)}</td><td>{money(row.portStorage)}</td><td>{money(row.transitCustoms)}</td><td>{money(row.taxInsurance)}</td><td>{money(row.other)}</td></tr>)}</DataTable>
      <DataTable headers={["口岸", "货损票数", "赔偿金额", "货损率", "主要类型", "绿通票数", "罚款金额"]} empty="暂无货损、绿通或罚款数据">{report.cargoDamage.map((row) => <tr key={row.portName}><td>{row.portName}</td><td>{row.ticketCount}</td><td>{money(row.damageAmount)}</td><td>{percent(row.damageRate)}</td><td>{row.primaryType}</td><td>{row.greenLaneCount}</td><td>{money(row.penaltyAmount)}</td></tr>)}</DataTable></>}
    </ReportSection>}

    {view === "receivable" && <ReportSection id="analytics-section-5" eyebrow="05 / RECEIVABLE & PAYABLE" title="应收回款、坏账与供应商付款" description="客户账期由客户资料带入，逾期 15/30/60 天分级；超过约定账期 60 天列入坏账风险，可导出明细。">
      {access.canViewReceivable ? <div className="finance-kpi-grid receivable-kpis"><FinanceMetric label="应收账款总额" value={receivableMetric.value} note={receivableMetric.source}/><FinanceMetric label="逾期应收" value={money(report.receivables.overdue)} tone="warning"/><FinanceMetric label="DSO" value={dsoMetric.value} note={dsoMetric.source}/><FinanceMetric label="回款率" value={collectionMetric.value} note={collectionMetric.source}/><FinanceMetric label="坏账准备" value={reserveMetric.value} note={`${reserveMetric.source} · 准备金率 ${reserveMetric.pending ? "待填写" : percent(report.receivables.badDebtReserveRate)}`}/></div> : <PermissionNotice/>}
      {access.canViewReceivable && <DataTable headers={["正常 / 30天内", "31-60天", "61-90天", "90天以上", "加权账龄"]} empty="暂无应收账龄数据"><tr><td>{money(report.receivables.normal)}</td><td>{money(report.receivables.days31to60)}</td><td>{money(report.receivables.days61to90)}</td><td>{money(report.receivables.daysOver90)}</td><td>{report.receivables.weightedAgingDays} 天</td></tr></DataTable>}
      {access.canViewPayable && <DataTable headers={["供应商", "类型", "账期", "应付余额", "采购金额", "较上月价格波动"]} empty="暂无供应商应付数据">{report.supplierPayments.map((row) => <tr key={row.supplierName}><td>{row.supplierName}</td><td>{row.type}</td><td>{row.paymentTermsDays === null ? "待配置" : `${row.paymentTermsDays} 天`}</td><td>{money(row.payableBalance)}</td><td>{money(row.purchaseAmount)}</td><td>{row.priceChange}</td></tr>)}</DataTable>}
    </ReportSection>}

    {view === "team-risk" && <ReportSection id="analytics-section-6" eyebrow="06 / TEAM & RISK" title="团队产出与负毛利预警" description="团队人效按销售及产品线统计；负毛利票占比超过 5% 自动预警。">
      {access.canViewProfit ? <><DataTable headers={["销售", "产品线", "票数", "收入", "成本", "毛利", "收入占比", "毛利占比", "毛利率"]} empty="暂无团队产出数据">{report.teamOutput.map((row, index) => <tr key={`${row.salesperson}-${row.productLine}-${index}`}><td>{row.salesperson}</td><td>{row.productLine}</td><td>{row.ticketCount}</td><td>{money(row.revenue)}</td><td>{money(row.cost)}</td><td>{money(row.grossProfit)}</td><td>{percent(row.revenueShare)}</td><td>{percent(row.grossProfitShare)}</td><td>{percent(row.grossMargin)}</td></tr>)}</DataTable>
      <DataTable headers={["业务线", "总票数", "负毛利票数", "负毛利占比", "销售额", "毛利率", "状态"]} empty="暂无负毛利分析数据">{report.negativeProfit.map((row) => <tr key={row.businessType}><td>{row.businessType}</td><td>{row.ticketCount}</td><td>{row.negativeTicketCount}</td><td>{percent(row.negativeTicketRatio)}</td><td>{money(row.sales)}</td><td>{percent(row.grossMargin)}</td><td><Status value={row.alert}/></td></tr>)}</DataTable></> : <PermissionNotice/>}
    </ReportSection>}

    {view === "config" && (access.canConfigure || access.canFillManual) && <MetricConfiguration loaderData={loaderData}/>}
  </div>;
}

function MetricConfiguration({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
  const busy = useNavigation().state !== "idle";
  const groups = [...new Set(analyticsMetricDefinitions.map((metric) => metric.section))];
  return <section className="panel analytics-report-section analytics-config" id="analytics-config">
    <div className="panel-header"><div><p className="eyebrow">CONFIGURATION</p><h2>财务计算规则配置</h2><p>每项指标独立设置自动计算或指定岗位填写；修改只对生效日之后的数据生效，历史快照不自动改写。</p></div></div>
    {loaderData.access.canConfigure && <details className="analytics-config-group" open><summary>口岸展示范围</summary><Form method="post" className="analytics-port-config"><input type="hidden" name="intent" value="save_port_visibility"/><p>系统中已登记的口岸全部列出；勾选后才进入分析筛选和口岸报表。</p><div>{loaderData.portSettings.map((port) => <label key={port.portName}><input type="hidden" name="knownPort" value={port.portName}/><input type="checkbox" name="visiblePort" value={port.portName} defaultChecked={port.isVisible}/><span>{port.displayName}{port.displayName === port.portName ? "" : ` · ${port.portName}`}</span></label>)}</div>{loaderData.portSettings.length ? <button className="secondary" disabled={busy}>保存口岸范围</button> : <p className="empty-state">口岸基础资料与业务数据中尚未登记口岸。</p>}</Form></details>}
    {groups.map((section) => <details key={section} className="analytics-config-group"><summary>{section}</summary><div className="analytics-config-list">
      {loaderData.configuration.filter((item) => item.section === section).map((item) => {
        const canFillThis = item.calculationMode === "manual" && (loaderData.access.canConfigure || (loaderData.access.canFillManual && item.assignedPositionCode === loaderData.current.positionCode));
        return <article key={item.code} className="analytics-config-card"><div className="analytics-config-card-title"><div><strong>{item.label}</strong><small>{item.calculationMode === "automatic" ? "系统自动计算" : `由 ${item.assignedPositionName || "待指定岗位"} 填写`}</small></div><span className="status-pill">{item.unit === "ratio" ? "比例" : item.unit === "days" ? "天数" : item.unit === "count" ? "数量" : "金额"}</span></div>
          {loaderData.access.canConfigure && <Form method="post" className="analytics-config-form"><input type="hidden" name="intent" value="save_config"/><input type="hidden" name="metricCode" value={item.code}/><label><span>计算方式</span><select name="calculationMode" defaultValue={item.calculationMode}><option value="automatic">系统自动计算</option><option value="manual">指定岗位填写</option></select></label><label><span>填写岗位</span><select name="assignedPositionId" defaultValue={item.assignedPositionId || ""}><option value="">自动计算 / 不指定</option>{loaderData.options.positions.map((position) => <option key={position.id} value={position.id}>{position.name}（{position.code}）</option>)}</select></label><label><span>起算日</span><select name="startDateSource" defaultValue={item.startDateSource}>{dateSources.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><label><span>生效日</span><input type="date" name="effectiveFrom" defaultValue={item.effectiveFrom || loaderData.filters.from} required/></label><label><span>目标值</span><input type="number" step="0.01" name="targetValue" defaultValue={item.targetValue ?? ""}/></label><label><span>预警值</span><input type="number" step="0.01" name="warningValue" defaultValue={item.warningValue ?? ""}/></label><label><span>危险值</span><input type="number" step="0.01" name="dangerValue" defaultValue={item.dangerValue ?? ""}/></label><button className="secondary" disabled={busy}>保存口径</button></Form>}
          {canFillThis && <Form method="post" className="analytics-manual-form"><input type="hidden" name="intent" value="save_manual_value"/><input type="hidden" name="metricCode" value={item.code}/><input type="hidden" name="periodStart" value={loaderData.filters.from}/><input type="hidden" name="periodEnd" value={loaderData.filters.to}/><input type="hidden" name="dimensionKey" value=""/><label><span>本期确认值</span><input name="numericValue" type="number" step="0.01" defaultValue={item.manualValue ?? ""} placeholder="待填写" required/></label><label><span>数据来源 / 说明</span><input name="sourceNote" defaultValue={item.manualSourceNote ?? ""} placeholder="例如：财务复核表 2026-09"/></label><button className="primary" disabled={busy}>确认金额</button></Form>}
        </article>;
      })}
    </div></details>)}
  </section>;
}

function ReportSection({ id, eyebrow, title, description, children }: { id: string; eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <section className="panel analytics-report-section" id={id}><div className="panel-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}
function DataTable({ headers, children, empty }: { headers: string[]; children: ReactNode; empty: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <div className="analytics-table-wrap"><table className="data-table analytics-data-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{hasRows ? children : <tr><td colSpan={headers.length} className="empty-state">{empty}</td></tr>}</tbody></table></div>;
}
function FinanceMetric({ label, value, note, tone = "" }: { label: string; value: string; note?: string; tone?: string }) { return <div className={`finance-metric ${tone}`}><small>{label}</small><strong>{value}</strong><span>{note || "当前筛选期间"}</span></div>; }
function MoneyCell({ allowed, value }: { allowed: boolean; value: number }) { return <td>{allowed ? money(value) : "无权限"}</td>; }
function PermissionNotice() { return <p className="analytics-permission-note">当前岗位未获该类财务数据查看权限，页面不会下发相关明细。</p>; }
function Status({ value }: { value: string }) { const danger = /坏账|严重|负毛利|>/.test(value); const warning = /预警/.test(value); return <span className={`status-pill ${danger ? "danger" : warning ? "warning" : ""}`}>{value}</span>; }

function ContributionPie({ rows }: { rows: Array<{ customerId: string; customerName: string; sales: number }> }) {
  const top = rows.slice(0, 10);
  const other = rows.slice(10).reduce((sum, row) => sum + row.sales, 0);
  const values = [...top.map((row) => ({ label: row.customerName, value: row.sales })), ...(other > 0 ? [{ label: "其他客户", value: other }] : [])];
  const total = values.reduce((sum, row) => sum + row.value, 0);
  const colors = ["#0f766e", "#2563eb", "#ea580c", "#7c3aed", "#0891b2", "#65a30d", "#dc2626", "#4f46e5", "#ca8a04", "#db2777", "#64748b"];
  let cursor = 0;
  const stops = values.map((row, index) => { const start = cursor; cursor += total > 0 ? row.value / total * 100 : 0; return `${colors[index % colors.length]} ${start}% ${cursor}%`; });
  return <div className="contribution-pie-card"><div className="contribution-pie" style={{ "--pie": total > 0 ? `conic-gradient(${stops.join(",")})` : "#e2e8f0" } as CSSProperties} role="img" aria-label="客户销售贡献饼图"><span><b>{values.length}</b>个客户组</span></div><ol>{values.map((row, index) => <li key={row.label}><i style={{ backgroundColor: colors[index % colors.length] }}/><span>{row.label}</span><b>{total > 0 ? percent(row.value / total) : "—"}</b></li>)}</ol></div>;
}
function money(value: number) { return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0)); }
function percent(value: number | null) { return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`; }
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function displayedMetric(states: Array<{ code: string; pendingManualValue: boolean; sourceLabel: string }>, code: string, automaticValue: number, format: (value: number) => string) {
  const state = states.find((item) => item.code === code);
  return { value: state?.pendingManualValue ? "待填写" : format(automaticValue), pending: Boolean(state?.pendingManualValue), source: state?.sourceLabel || "系统自动计算" };
}
export function meta() { return [{ title: "经营与财务汇总分析 | International TMS" }]; }
