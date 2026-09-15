export async function refreshSettlementAffectedOrders(input: {
  orderIds: readonly (string | null | undefined)[];
  syncCostsModuleStatus: (orderId: string) => Promise<void>;
  syncOrderWorkflowSnapshot: (orderId: string) => Promise<void>;
  refreshOrderCompletionStatus: (orderIds: readonly string[]) => Promise<void>;
}) {
  const orderIds = [
    ...new Set(
      input.orderIds
        .map((orderId) => orderId?.trim() ?? "")
        .filter(Boolean),
    ),
  ];

  for (const orderId of orderIds) {
    await input.syncCostsModuleStatus(orderId);
    await input.syncOrderWorkflowSnapshot(orderId);
    await input.refreshOrderCompletionStatus([orderId]);
  }

  return orderIds;
}
