export type WorkbenchCode =
  | "tasks"
  | "customs"
  | "documents"
  | "tracking"
  | "costs";

export type WorkbenchBatchCandidate = {
  row_id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  module_code: string;
  module_name: string;
  enabled: number;
  module_status: string;
  order_status: string;
  assignee_user_id: string | null;
  assignee_name: string | null;
};

export type WorkbenchBatchCheck = {
  rowId: string;
  orderId: string | null;
  orderNumber: string;
  customerName: string;
  moduleCode: string | null;
  moduleName: string;
  eligible: boolean;
  reason: string;
};

const directWorkspaceModules: Record<
  Exclude<WorkbenchCode, "tasks">,
  string
> = {
  customs: "customs",
  documents: "documents",
  tracking: "tracking",
  costs: "costs",
};

export function workspaceAcceptsModule(
  workspace: WorkbenchCode,
  moduleCode: string,
) {
  return workspace === "tasks"
    ? moduleCode !== "assignment"
    : directWorkspaceModules[workspace] === moduleCode;
}

export function normalizeWorkbenchSelection(ids: string[], maximum = 50) {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length > maximum)
    throw new Error(`每次最多处理 ${maximum} 条记录`);
  return normalized;
}

export function validateWorkbenchBatch(
  selectedIds: string[],
  candidates: WorkbenchBatchCandidate[],
  workspace: WorkbenchCode,
  currentUserId: string,
): WorkbenchBatchCheck[] {
  const byId = new Map(candidates.map((candidate) => [candidate.row_id, candidate]));
  return selectedIds.map((rowId) => {
    const row = byId.get(rowId);
    if (!row)
      return failed(rowId, "记录不存在或已不属于当前组织");
    const base = {
      rowId,
      orderId: row.order_id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      moduleCode: row.module_code,
      moduleName: row.module_name,
    };
    if (!workspaceAcceptsModule(workspace, row.module_code))
      return { ...base, eligible: false, reason: "记录不属于当前工作台" };
    if (row.enabled !== 1)
      return { ...base, eligible: false, reason: "模块未启用" };
    if (["completed", "cancelled"].includes(row.order_status))
      return { ...base, eligible: false, reason: "订单已经完成或取消" };
    if (["completed", "not_applicable"].includes(row.module_status))
      return { ...base, eligible: false, reason: "模块已经完成或不适用" };
    if (["blocked", "exception"].includes(row.module_status))
      return { ...base, eligible: false, reason: "模块处于阻塞或异常状态" };
    if (row.assignee_user_id === currentUserId)
      return { ...base, eligible: false, reason: "已经由你负责" };
    if (row.assignee_user_id)
      return {
        ...base,
        eligible: false,
        reason: `已由${row.assignee_name || "其他员工"}负责`,
      };
    return { ...base, eligible: true, reason: "可以领取" };
  });
}

function failed(rowId: string, reason: string): WorkbenchBatchCheck {
  return {
    rowId,
    orderId: null,
    orderNumber: "未知记录",
    customerName: "—",
    moduleCode: null,
    moduleName: "—",
    eligible: false,
    reason,
  };
}
