import type { OrderModuleCode } from "./order-modules";

export type OrderResponsiblePosition = {
  code: string;
  name: string;
};

const modulePositions: Record<OrderModuleCode, OrderResponsiblePosition> = {
  consignment: { code: "SALES", name: "业务员" },
  cargo: { code: "SALES", name: "业务员" },
  assignment: { code: "OPERATION_SUPERVISOR", name: "操作主管" },
  transport: { code: "OPERATION", name: "操作岗（含运踪）" },
  warehouse: { code: "WAREHOUSE", name: "仓库岗" },
  loading: { code: "WAREHOUSE", name: "仓库岗" },
  documents: { code: "DOC", name: "单证岗" },
  customs: { code: "DOC", name: "单证岗" },
  tracking: { code: "OPERATION", name: "操作岗（含运踪）" },
  overseas_warehouse: { code: "OVERSEAS_WAREHOUSE", name: "境外仓库岗" },
  costs: { code: "CS", name: "客服岗" },
  exceptions: { code: "OPERATION", name: "操作岗（含运踪）" },
  review: { code: "FINANCE_ACCOUNTING", name: "财务会计岗" },
};

export function orderResponsiblePosition(
  moduleCode: OrderModuleCode | null,
  orderStatus: string,
): OrderResponsiblePosition {
  if (orderStatus === "cancelled") {
    return { code: "NONE", name: "无需处理" };
  }
  if (orderStatus === "submitted") {
    return { code: "BUSINESS_SUPERVISOR", name: "业务主管" };
  }
  if (orderStatus === "confirmed") {
    return { code: "OPERATION_SUPERVISOR", name: "操作主管" };
  }
  if (moduleCode) return modulePositions[moduleCode];
  return { code: "OPERATION", name: "操作岗（含运踪）" };
}
