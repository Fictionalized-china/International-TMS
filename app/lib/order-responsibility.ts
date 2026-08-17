import type { OrderModuleCode } from "./order-modules";

export type OrderResponsiblePosition = {
  code: string;
  name: string;
};

const modulePositions: Record<OrderModuleCode, OrderResponsiblePosition> = {
  consignment: { code: "SALES", name: "业务员" },
  cargo: { code: "SALES", name: "业务员" },
  assignment: { code: "OPERATION", name: "操作" },
  transport: { code: "OPERATION", name: "操作" },
  warehouse: { code: "CONTAINER", name: "箱管" },
  loading: { code: "CONTAINER", name: "箱管" },
  documents: { code: "DOC", name: "单证" },
  customs: { code: "DOC", name: "单证" },
  tracking: { code: "OVERSEAS", name: "海外人员" },
  overseas_warehouse: { code: "OVERSEAS", name: "海外人员" },
  costs: { code: "FINANCE", name: "财务" },
  exceptions: { code: "OPERATION", name: "操作" },
  review: { code: "FINANCE", name: "财务" },
};

export function orderResponsiblePosition(
  moduleCode: OrderModuleCode | null,
  orderStatus: string,
): OrderResponsiblePosition {
  if (orderStatus === "cancelled") {
    return { code: "NONE", name: "无需处理" };
  }
  if (orderStatus === "submitted" || orderStatus === "confirmed") {
    return { code: "OPERATION", name: "操作" };
  }
  if (moduleCode) return modulePositions[moduleCode];
  return { code: "OPERATION", name: "操作" };
}
