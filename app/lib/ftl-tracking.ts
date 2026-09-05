export type FtlBatchTrackingState = {
  batchStatus: "loading" | "departed" | "arrived";
  orderStatus: "loaded" | "departed" | "arrived";
  roadStatus: "loaded_waiting_exit" | "outbound_in_transit" | "overseas_arrived";
  recordsActualDeparture: boolean;
  recordsActualArrival: boolean;
};

/**
 * Reaching the border is not the same as crossing it. Keep the FTL batch at
 * the departure gate until the explicit `exported` milestone is recorded.
 */
export function ftlBatchTrackingState(
  milestoneCode: string,
): FtlBatchTrackingState {
  if (milestoneCode === "border_arrived") {
    return {
      batchStatus: "loading",
      orderStatus: "loaded",
      roadStatus: "loaded_waiting_exit",
      recordsActualDeparture: false,
      recordsActualArrival: false,
    };
  }
  if (milestoneCode === "station_arrived") {
    return {
      batchStatus: "arrived",
      orderStatus: "arrived",
      roadStatus: "overseas_arrived",
      recordsActualDeparture: true,
      recordsActualArrival: true,
    };
  }
  return {
    batchStatus: "departed",
    orderStatus: "departed",
    roadStatus: "outbound_in_transit",
    recordsActualDeparture: true,
    recordsActualArrival: false,
  };
}
