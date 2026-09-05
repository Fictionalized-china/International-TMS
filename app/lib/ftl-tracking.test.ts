import { describe, expect, it } from "vitest";
import { ftlBatchTrackingState } from "./ftl-tracking";

describe("FTL batch tracking state", () => {
  it("does not mark an FTL batch departed merely because it reached the border", () => {
    expect(ftlBatchTrackingState("border_arrived")).toEqual({
      batchStatus: "loading",
      orderStatus: "loaded",
      roadStatus: "loaded_waiting_exit",
      recordsActualDeparture: false,
      recordsActualArrival: false,
    });
  });

  it("records actual departure only from the explicit exported milestone", () => {
    expect(ftlBatchTrackingState("exported")).toMatchObject({
      batchStatus: "departed",
      orderStatus: "departed",
      roadStatus: "outbound_in_transit",
      recordsActualDeparture: true,
      recordsActualArrival: false,
    });
  });

  it("keeps the arrival transition explicit", () => {
    expect(ftlBatchTrackingState("station_arrived")).toMatchObject({
      batchStatus: "arrived",
      orderStatus: "arrived",
      roadStatus: "overseas_arrived",
      recordsActualArrival: true,
    });
  });
});
