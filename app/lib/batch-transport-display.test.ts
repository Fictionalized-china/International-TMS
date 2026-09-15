import { describe, expect, it } from "vitest";
import { batchTransportDisplay } from "./batch-transport-display";

describe("batchTransportDisplay", () => {
  it("formats PZ carrier, vehicle and driver facts without duplicating storage", () => {
    expect(batchTransportDisplay({
      carrier_name: "主数据承运商",
      overseas_carrier_name: "PZ 实际承运商",
      overseas_vehicle_plate: "粤B12345",
      overseas_vehicle_type: "厢式车",
      overseas_driver_name: "张师傅",
      overseas_driver_phone: "13800000000",
    })).toEqual({
      carrier: "PZ 实际承运商 · 主数据承运商",
      vehicle: "粤B12345 · 厢式车",
      driver: "张师傅 · 13800000000",
    });
  });

  it("uses readable pending states for incomplete optional resources", () => {
    expect(batchTransportDisplay({})).toEqual({
      carrier: "承运商待补",
      vehicle: "车辆待补",
      driver: "司机待补",
    });
  });

  it("does not repeat the same carrier fact from the batch and master data join", () => {
    expect(batchTransportDisplay({
      overseas_carrier_name: "欧陵国际物流",
      carrier_name: "欧陵国际物流",
    }).carrier).toBe("欧陵国际物流");
  });
});
