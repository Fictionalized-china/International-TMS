import {
  chargeableWeightKg,
  classifyCost,
  comparisonLabel,
  creditStatus,
  isExcludedFromGrossProfit,
  safeRatio,
  type CostCategory,
} from "./financial-analytics";

export type FinancialAnalyticsOrder = {
  id: string;
  orderNumber: string;
  businessType: string;
  customerId: string;
  customerName: string;
  destinationCountry: string;
  exitPort: string;
  salespersonId: string;
  salespersonName: string;
  grossWeightKg: number;
  volumeCbm: number;
};

export type FinancialAnalyticsExpense = {
  id: string;
  orderId: string;
  direction: "receivable" | "payable";
  stage: string;
  chargeCode: string;
  chargeName: string;
  counterpartyName: string;
  baseAmount: number;
  allocatedAmount: number;
  settlementConfirmedAt: string | null;
  dueDate: string | null;
};

export type FinancialAnalyticsVehicle = {
  orderId: string;
  batchId: string;
  batchNumber: string;
  vehicleNo: string;
  borderPort: string;
  departedAt: string | null;
};

export type FinancialAnalyticsException = {
  orderId: string | null;
  portName: string;
  type: string;
  description: string;
};

const confirmedStages = new Set(["reconciled", "invoiced", "settled"]);

function businessTypeLabel(value: string) {
  if (value === "ftl") return "整车";
  if (value === "ltl") return "拼车";
  return value || "未设置";
}

function sum<T>(rows: readonly T[], get: (row: T) => number) {
  return rows.reduce((total, row) => total + Number(get(row) || 0), 0);
}

function round(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  return rows.reduce<Map<string, T[]>>((groups, row) => {
    const value = key(row) || "未设置";
    groups.set(value, [...(groups.get(value) ?? []), row]);
    return groups;
  }, new Map());
}

function metricsForOrders(orderIds: Set<string>, expenses: readonly FinancialAnalyticsExpense[]) {
  const rows = expenses.filter((expense) => orderIds.has(expense.orderId) && confirmedStages.has(expense.stage));
  const operating = rows.filter((expense) => !isExcludedFromGrossProfit(expense.chargeCode, expense.chargeName));
  const revenue = sum(operating.filter((expense) => expense.direction === "receivable"), (expense) => expense.baseAmount);
  const cost = sum(operating.filter((expense) => expense.direction === "payable"), (expense) => expense.baseAmount);
  return { revenue, cost, profit: revenue - cost };
}

export function buildFinancialAnalyticsReport(input: {
  orders: readonly FinancialAnalyticsOrder[];
  expenses: readonly FinancialAnalyticsExpense[];
  vehicles: readonly FinancialAnalyticsVehicle[];
  exceptions?: readonly FinancialAnalyticsException[];
  today?: Date;
}) {
  const { orders, expenses, vehicles } = input;
  const exceptions = input.exceptions ?? [];
  const today = input.today ?? new Date();
  const orderMap = new Map(orders.map((order) => [order.id, order]));
  const allOrderIds = new Set(orders.map((order) => order.id));
  const confirmedExpenses = expenses.filter((expense) => confirmedStages.has(expense.stage));
  const operatingExpenses = confirmedExpenses.filter((expense) => !isExcludedFromGrossProfit(expense.chargeCode, expense.chargeName));
  const excludedExpenses = confirmedExpenses.filter((expense) => isExcludedFromGrossProfit(expense.chargeCode, expense.chargeName));
  const overviewMetrics = metricsForOrders(allOrderIds, expenses);
  const estimatedRevenue = sum(expenses.filter((expense) => expense.direction === "receivable" && !isExcludedFromGrossProfit(expense.chargeCode, expense.chargeName)), (expense) => expense.baseAmount);
  const estimatedCost = sum(expenses.filter((expense) => expense.direction === "payable" && !isExcludedFromGrossProfit(expense.chargeCode, expense.chargeName)), (expense) => expense.baseAmount);
  const abnormalExpense = sum(excludedExpenses.filter((expense) => expense.direction === "payable"), (expense) => expense.baseAmount);
  const abnormalIncome = sum(excludedExpenses.filter((expense) => expense.direction === "receivable"), (expense) => expense.baseAmount);

  const productLines = [...groupBy(orders, (order) => businessTypeLabel(order.businessType))].map(([label, lineOrders]) => {
    const metrics = metricsForOrders(new Set(lineOrders.map((order) => order.id)), expenses);
    return {
      label,
      ticketCount: lineOrders.length,
      ticketShare: safeRatio(lineOrders.length, orders.length),
      sales: metrics.revenue,
      salesShare: safeRatio(metrics.revenue, overviewMetrics.revenue),
      grossProfit: metrics.profit,
      grossProfitShare: safeRatio(metrics.profit, overviewMetrics.profit),
      grossMargin: safeRatio(metrics.profit, metrics.revenue),
    };
  }).sort((a, b) => b.sales - a.sales);

  const vehicleByOrder = groupBy(vehicles, (vehicle) => vehicle.orderId);
  const vehicleAnalysis = [...groupBy(orders, (order) => `${businessTypeLabel(order.businessType)}\u0000${order.destinationCountry || "未设置"}`)].map(([key, scopedOrders]) => {
    const [businessType, destinationCountry] = key.split("\u0000");
    const vehicleKeys = new Set(scopedOrders.flatMap((order) => (vehicleByOrder.get(order.id) ?? []).map((vehicle) => vehicle.vehicleNo || vehicle.batchId)));
    const batches = new Set(scopedOrders.flatMap((order) => (vehicleByOrder.get(order.id) ?? []).map((vehicle) => vehicle.batchId)));
    return { dimension: "按业务线", businessType, destinationCountry, ticketCount: scopedOrders.length, departureCount: vehicleKeys.size || batches.size };
  });

  const portVehicleAnalysis = [...groupBy(orders, (order) => order.exitPort || (vehicleByOrder.get(order.id)?.[0]?.borderPort ?? "未设置"))].map(([portName, scopedOrders]) => {
    const vehicleKeys = new Set(scopedOrders.flatMap((order) => (vehicleByOrder.get(order.id) ?? []).map((vehicle) => vehicle.vehicleNo || vehicle.batchId)));
    return { dimension: "按口岸", businessType: portName, destinationCountry: "小计", ticketCount: scopedOrders.length, departureCount: vehicleKeys.size };
  });

  const multiVehicleOrders = orders.flatMap((order) => {
    const scopedVehicles = [...new Map((vehicleByOrder.get(order.id) ?? []).map((vehicle) => [vehicle.vehicleNo || vehicle.batchNumber, vehicle])).values()];
    if (scopedVehicles.length <= 1) return [];
    return scopedVehicles.map((vehicle) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      businessType: businessTypeLabel(order.businessType),
      salesperson: order.salespersonName || "未指定",
      destination: `${order.destinationCountry || "未设置"} / ${order.exitPort || vehicle.borderPort || "口岸未设置"}`,
      totalVehicles: scopedVehicles.length,
      vehicleNo: vehicle.vehicleNo || "车号待补",
    }));
  });

  const customerContribution = [...groupBy(orders, (order) => order.customerId)].map(([, customerOrders]) => {
    const first = customerOrders[0];
    const metrics = metricsForOrders(new Set(customerOrders.map((order) => order.id)), expenses);
    return {
      customerId: first.customerId,
      customerName: first.customerName,
      sales: metrics.revenue,
      salesShare: safeRatio(metrics.revenue, overviewMetrics.revenue),
      grossProfit: metrics.profit,
      grossProfitShare: safeRatio(metrics.profit, overviewMetrics.profit),
      grossMargin: safeRatio(metrics.profit, metrics.revenue),
      comparison: comparisonLabel(metrics.revenue, 0, false),
    };
  }).sort((a, b) => b.sales - a.sales);

  const outstandingReceivables = confirmedExpenses.filter((expense) => expense.direction === "receivable")
    .map((expense) => ({ ...expense, outstanding: Math.max(0, expense.baseAmount - expense.allocatedAmount) }))
    .filter((expense) => expense.outstanding > 0);
  const receivablesByCustomer = [...groupBy(outstandingReceivables, (expense) => orderMap.get(expense.orderId)?.customerId ?? "unknown")].map(([, customerExpenses]) => {
    const customer = orderMap.get(customerExpenses[0].orderId);
    const total = sum(customerExpenses, (expense) => expense.outstanding);
    const overdue = customerExpenses.filter((expense) => daysPastDue(expense.dueDate, today) > 0);
    const overdueAmount = sum(overdue, (expense) => expense.outstanding);
    const maxDays = Math.max(0, ...customerExpenses.map((expense) => daysPastDue(expense.dueDate, today)));
    return {
      customerId: customer?.customerId ?? "unknown",
      customerName: customer?.customerName ?? "客户待补",
      balance: total,
      share: 0,
      agingDays: maxDays,
      overdueAmount,
      overdueRatio: safeRatio(overdueAmount, total),
      creditStatus: creditStatus(maxDays),
    };
  }).sort((a, b) => b.balance - a.balance);
  const totalReceivableBalance = sum(receivablesByCustomer, (row) => row.balance);
  receivablesByCustomer.forEach((row) => { row.share = safeRatio(row.balance, totalReceivableBalance) ?? 0; });

  const portContribution = [...groupBy(orders, (order) => order.exitPort || (vehicleByOrder.get(order.id)?.[0]?.borderPort ?? "未设置"))].flatMap(([portName, portOrders]) => {
    return [...groupBy(portOrders, (order) => order.destinationCountry || "未设置")].map(([destinationCountry, destinationOrders]) => {
      const metrics = metricsForOrders(new Set(destinationOrders.map((order) => order.id)), expenses);
      return {
        portName,
        destinationCountry,
        revenue: metrics.revenue,
        cost: metrics.cost,
        grossProfit: metrics.profit,
        grossMargin: safeRatio(metrics.profit, metrics.revenue),
        ticketCount: destinationOrders.length,
        directCostShare: safeRatio(metrics.cost, overviewMetrics.cost),
      };
    });
  }).sort((a, b) => b.revenue - a.revenue);

  const costStructure = [...groupBy(operatingExpenses.filter((expense) => expense.direction === "payable"), (expense) => classifyCost(expense.chargeCode, expense.chargeName))].map(([category, rows]) => {
    const amount = sum(rows, (expense) => expense.baseAmount);
    return {
      category: category as CostCategory,
      amount,
      costShare: safeRatio(amount, overviewMetrics.cost),
      revenueShare: safeRatio(amount, overviewMetrics.revenue),
      comparison: comparisonLabel(amount, 0, false),
    };
  }).sort((a, b) => b.amount - a.amount);

  const businessCostDistribution = productLines.flatMap((line) => {
    const ids = new Set(orders.filter((order) => businessTypeLabel(order.businessType) === line.label).map((order) => order.id));
    const rows = operatingExpenses.filter((expense) => expense.direction === "payable" && ids.has(expense.orderId));
    const total = sum(rows, (expense) => expense.baseAmount);
    return [...groupBy(rows, (expense) => classifyCost(expense.chargeCode, expense.chargeName))].map(([category, categoryRows]) => {
      const amount = sum(categoryRows, (expense) => expense.baseAmount);
      return { businessType: line.label, category, amount, businessShare: safeRatio(amount, total), companyShare: safeRatio(amount, overviewMetrics.cost) };
    });
  });

  const portCostStructure = [...groupBy(operatingExpenses.filter((expense) => expense.direction === "payable"), (expense) => {
    const order = orderMap.get(expense.orderId);
    return order?.exitPort || (order ? vehicleByOrder.get(order.id)?.[0]?.borderPort : "") || "未设置";
  })].map(([portName, rows]) => {
    const byCategory = groupBy(rows, (expense) => classifyCost(expense.chargeCode, expense.chargeName));
    const amount = (category: CostCategory) => sum(byCategory.get(category) ?? [], (expense) => expense.baseAmount);
    const overseasFreight = amount("境外运费");
    const detention = sum(rows.filter((expense) => /压车/.test(`${expense.chargeCode} ${expense.chargeName}`)), (expense) => expense.baseAmount);
    const living = sum(rows.filter((expense) => /生活/.test(`${expense.chargeCode} ${expense.chargeName}`)), (expense) => expense.baseAmount);
    return {
      portName,
      totalCost: sum(rows, (expense) => expense.baseAmount),
      overseasFreight,
      normalFreight: Math.max(0, overseasFreight - detention - living),
      detention,
      living,
      domesticFreight: amount("国内运费"),
      portStorage: amount("仓储费"),
      transitCustoms: amount("转关费"),
      taxInsurance: sum(excludedExpenses.filter((expense) => {
        const order = orderMap.get(expense.orderId);
        const port = order?.exitPort || (order ? vehicleByOrder.get(order.id)?.[0]?.borderPort : "") || "未设置";
        return port === portName && classifyCost(expense.chargeCode, expense.chargeName) === "税费与保险";
      }), (expense) => expense.baseAmount),
      other: amount("其他费用") + amount("国内代理费") + amount("口岸服务费"),
      overseasShare: safeRatio(overseasFreight, sum(rows, (expense) => expense.baseAmount)),
      detentionLivingShare: safeRatio(detention + living, overseasFreight),
    };
  });

  const damageByPort = [...groupBy(excludedExpenses.filter((expense) => classifyCost(expense.chargeCode, expense.chargeName) === "赔偿及罚款"), (expense) => {
    const order = orderMap.get(expense.orderId);
    return order?.exitPort || (order ? vehicleByOrder.get(order.id)?.[0]?.borderPort : "") || "未设置";
  })].map(([portName, rows]) => {
    const relatedOrders = new Set(rows.map((expense) => expense.orderId));
    const portRevenue = sum(portContribution.filter((row) => row.portName === portName), (row) => row.revenue);
    const damageAmount = sum(rows, (expense) => expense.baseAmount);
    const relatedExceptions = exceptions.filter((item) => item.portName === portName && ["damage", "cargo_damage", "shortage", "cargo_shortage"].includes(item.type));
    return {
      portName,
      ticketCount: relatedOrders.size,
      damageAmount,
      damageRate: safeRatio(damageAmount, portRevenue),
      primaryType: relatedExceptions[0]?.description || rows[0]?.chargeName || "货损赔偿",
      greenLaneCount: 0,
      penaltyAmount: sum(rows.filter((expense) => /罚款/.test(`${expense.chargeCode} ${expense.chargeName}`)), (expense) => expense.baseAmount),
    };
  });

  const totalReceived = sum(confirmedExpenses.filter((expense) => expense.direction === "receivable"), (expense) => Math.min(expense.baseAmount, expense.allocatedAmount));
  const overdueBuckets = { normal: 0, days31to60: 0, days61to90: 0, daysOver90: 0 };
  for (const expense of outstandingReceivables) {
    const days = daysPastDue(expense.dueDate, today);
    if (days <= 30) overdueBuckets.normal += expense.outstanding;
    else if (days <= 60) overdueBuckets.days31to60 += expense.outstanding;
    else if (days <= 90) overdueBuckets.days61to90 += expense.outstanding;
    else overdueBuckets.daysOver90 += expense.outstanding;
  }
  const overdueTotal = overdueBuckets.days31to60 + overdueBuckets.days61to90 + overdueBuckets.daysOver90;
  const weightedDays = totalReceivableBalance > 0
    ? sum(outstandingReceivables, (expense) => expense.outstanding * daysPastDue(expense.dueDate, today)) / totalReceivableBalance
    : 0;
  const dso = overviewMetrics.revenue > 0 ? totalReceivableBalance / overviewMetrics.revenue * 30 : 0;

  const supplierPayments = [...groupBy(confirmedExpenses.filter((expense) => expense.direction === "payable"), (expense) => expense.counterpartyName || "供应商待补")].map(([supplierName, rows]) => {
    const payable = sum(rows, (expense) => Math.max(0, expense.baseAmount - expense.allocatedAmount));
    const purchases = sum(rows, (expense) => expense.baseAmount);
    return { supplierName, type: "供应商", paymentTermsDays: null as number | null, payableBalance: payable, purchaseAmount: purchases, priceChange: comparisonLabel(purchases, 0, false) };
  }).sort((a, b) => b.payableBalance - a.payableBalance);

  const teamOutput = [...groupBy(orders, (order) => order.salespersonId || "unassigned")].flatMap(([, personOrders]) => {
    const person = personOrders[0];
    const total = metricsForOrders(new Set(personOrders.map((order) => order.id)), expenses);
    const lines = [...groupBy(personOrders, (order) => businessTypeLabel(order.businessType))].map(([productLine, scoped]) => {
      const metrics = metricsForOrders(new Set(scoped.map((order) => order.id)), expenses);
      return { salesperson: person.salespersonName || "未指定", productLine, ticketCount: scoped.length, revenue: metrics.revenue, cost: metrics.cost, grossProfit: metrics.profit, revenueShare: null as number | null, grossProfitShare: null as number | null, grossMargin: safeRatio(metrics.profit, metrics.revenue) };
    });
    return [{ salesperson: person.salespersonName || "未指定", productLine: "总计", ticketCount: personOrders.length, revenue: total.revenue, cost: total.cost, grossProfit: total.profit, revenueShare: safeRatio(total.revenue, overviewMetrics.revenue), grossProfitShare: safeRatio(total.profit, overviewMetrics.profit), grossMargin: safeRatio(total.profit, total.revenue) }, ...lines];
  }).sort((a, b) => b.revenue - a.revenue);

  const negativeProfit = productLines.map((line) => {
    const scopedOrders = orders.filter((order) => businessTypeLabel(order.businessType) === line.label);
    const negative = scopedOrders.filter((order) => metricsForOrders(new Set([order.id]), expenses).profit < 0);
    return { businessType: line.label, ticketCount: scopedOrders.length, negativeTicketCount: negative.length, negativeTicketRatio: safeRatio(negative.length, scopedOrders.length), sales: line.sales, grossMargin: line.grossMargin, alert: negative.length / Math.max(1, scopedOrders.length) > 0.05 ? "负毛利票占比>5%" : "正常" };
  });

  return {
    overview: {
      revenue: overviewMetrics.revenue,
      directCost: overviewMetrics.cost,
      grossProfit: overviewMetrics.profit,
      grossMargin: safeRatio(overviewMetrics.profit, overviewMetrics.revenue),
      estimatedRevenue,
      estimatedCost,
      estimatedProfit: estimatedRevenue - estimatedCost,
      abnormalExpense,
      abnormalIncome,
    },
    productLines,
    vehicleAnalysis: [...vehicleAnalysis, ...portVehicleAnalysis],
    multiVehicleOrders,
    customerContribution,
    customerReceivables: receivablesByCustomer,
    portContribution,
    costStructure,
    businessCostDistribution,
    portCostStructure,
    cargoDamage: damageByPort,
    receivables: {
      total: totalReceivableBalance,
      normal: overdueBuckets.normal,
      overdue: overdueTotal,
      days31to60: overdueBuckets.days31to60,
      days61to90: overdueBuckets.days61to90,
      daysOver90: overdueBuckets.daysOver90,
      weightedAgingDays: round(weightedDays, 1),
      dso: round(dso, 1),
      collectionRate: safeRatio(totalReceived, totalReceived + totalReceivableBalance),
      badDebtReserve: 0,
      badDebtReserveRate: 0,
    },
    supplierPayments,
    teamOutput,
    negativeProfit,
    chargeableWeights: orders.map((order) => ({ orderId: order.id, chargeableWeightKg: chargeableWeightKg(order.grossWeightKg, order.volumeCbm) })),
  };
}

function daysPastDue(dueDate: string | null, today: Date) {
  if (!dueDate) return 0;
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(due.getTime())) return 0;
  const current = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.floor((current - due.getTime()) / 86_400_000));
}
