export const BATCH_OPERATION_MODULE_CODES = ["tracking", "exceptions"] as const;
export const BATCH_DOCUMENT_MODULE_CODES = ["documents", "customs"] as const;

export function batchRequiresSupervisorApproval(batchNumber: string) {
  return batchNumber.startsWith("PZ-");
}

export function canOrdinaryReassignBatchResponsibility(input: {
  batchNumber: string;
  approvalStatus: string;
  roadStatus: string;
  actualDepartureAt: string | null;
}) {
  return (
    batchRequiresSupervisorApproval(input.batchNumber) &&
    input.approvalStatus === "approved" &&
    !input.actualDepartureAt &&
    !["outbound_in_transit", "overseas_arrived", "waiting_pickup", "pickup_completed"].includes(input.roadStatus)
  );
}

export function batchSharedResponsibilityIsActive(roadStatus: string) {
  return !["overseas_arrived", "waiting_pickup", "pickup_completed"].includes(roadStatus);
}
