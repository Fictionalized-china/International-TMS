export type WorkflowFieldRefreshChange = {
  moduleCode: string;
  stepKey: string;
};

export type WorkflowFieldOrderRefreshResult = {
  matchedOrders: number;
  refreshedOrders: number;
};

export async function refreshOrdersForWorkflowFieldChanges(input: {
  changes: readonly WorkflowFieldRefreshChange[];
  listAffectedOrderIds: (targetStepKeys: readonly string[]) => Promise<readonly string[]>;
  syncCostsModuleStatus: (orderId: string) => Promise<void>;
  syncOrderWorkflowSnapshot: (orderId: string) => Promise<void>;
}): Promise<WorkflowFieldOrderRefreshResult> {
  const targetStepKeys = [...new Set(
    input.changes
      .filter(
        (change) =>
          change.moduleCode === "costs" && change.stepKey === "reconciliation",
      )
      .map((change) => change.stepKey),
  )];
  if (!targetStepKeys.length) {
    return { matchedOrders: 0, refreshedOrders: 0 };
  }

  const orderIds = [...new Set(
    (await input.listAffectedOrderIds(targetStepKeys)).filter(Boolean),
  )];
  const refreshConcurrency = 4;
  for (let index = 0; index < orderIds.length; index += refreshConcurrency) {
    await Promise.all(
      orderIds.slice(index, index + refreshConcurrency).map(async (orderId) => {
        await input.syncCostsModuleStatus(orderId);
        await input.syncOrderWorkflowSnapshot(orderId);
      }),
    );
  }
  return { matchedOrders: orderIds.length, refreshedOrders: orderIds.length };
}
