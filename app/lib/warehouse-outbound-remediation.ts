export type WarehouseOutboundRemediation = {
  key: string;
  title: string;
  hint: string;
  href: string;
};

type RemediationInput = {
  orderId: string;
  transportBatchId?: string | null;
  reasons: readonly string[];
  retryHref: string;
};

function remediationForReason(
  input: Omit<RemediationInput, "reasons">,
  reason: string,
): WarehouseOutboundRemediation {
  if (
    reason.includes("国内运输安排") ||
    reason.includes("整车订单尚未完成车辆运输安排")
  ) {
    return {
      key: "domestic-transport",
      title: "补齐国内运输安排",
      hint: "进入该订单的国内运输页，补齐工作流实际要求的承运商、车辆、司机或计划时间。",
      href: `/admin/orders/${input.orderId}/modules/transport#module-business-data`,
    };
  }
  if (
    reason.includes("配载") ||
    reason.includes("装载") ||
    reason.includes("当前配载计划")
  ) {
    return input.transportBatchId
      ? {
          key: "loading-batch",
          title: "打开当前 PZ 配载单",
          hint: "在配载单内补齐批次承运商、车辆、司机、口岸和计划时间。",
          href: `/admin/loading/${input.transportBatchId}`,
        }
      : {
          key: "create-loading-batch",
          title: "进入货物配载",
          hint: "为拼车订单创建或加入 PZ 配载单，完成整批装车安排。",
          href: `/warehouse/consolidation?orderId=${encodeURIComponent(input.orderId)}&returnTo=${encodeURIComponent(input.retryHref)}`,
        };
  }
  if (reason.includes("仓库尚未登记") || reason.includes("尚未货齐")) {
    return {
      key: "warehouse-acceptance",
      title: "进入验收收货",
      hint: "补录实际收货数量、重量、体积和货齐结果。",
      href: `/warehouse/acceptance?orderId=${encodeURIComponent(input.orderId)}&returnTo=${encodeURIComponent(input.retryHref)}`,
    };
  }
  if (
    reason.includes("出境口岸") ||
    reason.includes("境外目的仓") ||
    reason.includes("整车还是拼车")
  ) {
    return {
      key: "order-route",
      title: "补齐订单运输方案",
      hint: "进入订单资料页补齐订单类型、出境口岸或境外目的仓。",
      href: `/admin/orders/${input.orderId}/operations`,
    };
  }
  if (reason.includes("阻断") || reason.includes("异常")) {
    return {
      key: "order-exception",
      title: "查看并解除订单异常",
      hint: "进入订单中心查看当前阻断模块和异常处理入口。",
      href: `/admin/orders/${input.orderId}`,
    };
  }
  return {
    key: "order-center",
    title: "打开订单处理中心",
    hint: "查看该订单当前节点、缺失资料和可办理入口。",
    href: `/admin/orders/${input.orderId}`,
  };
}

export function warehouseOutboundRemediations(
  input: RemediationInput,
): WarehouseOutboundRemediation[] {
  const unique = new Map<string, WarehouseOutboundRemediation>();
  for (const reason of input.reasons) {
    const remediation = remediationForReason(input, reason);
    if (!unique.has(remediation.key)) unique.set(remediation.key, remediation);
  }
  return [...unique.values()];
}
