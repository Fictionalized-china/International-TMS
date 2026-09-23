import { describe, expect, it, vi } from "vitest";
import { insertShipmentEventIfMissing } from "./shipment-event-write.server";

describe("shipment event write", () => {
  it("uses an idempotent event key and keeps customer visibility explicit", () => {
    const bind = vi.fn();
    const prepare = vi.fn(() => ({ bind }));
    insertShipmentEventIfMissing({ prepare } as unknown as D1Database, {
      id: "event-1",
      shipmentId: "shipment-1",
      status: "in_transit",
      location: "霍尔果斯",
      description: "到达出境口岸",
      eventAt: "2026-09-23T08:00:00.000Z",
      visibleToCustomer: 0,
      actorUserId: "user-1",
      createdAt: "2026-09-23T08:01:00.000Z",
    });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE NOT EXISTS"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("visible_to_customer"));
    expect(bind).toHaveBeenCalledWith(
      "event-1",
      "shipment-1",
      "in_transit",
      "霍尔果斯",
      "到达出境口岸",
      "2026-09-23T08:00:00.000Z",
      0,
      "user-1",
      "2026-09-23T08:01:00.000Z",
      "shipment-1",
      "in_transit",
      "到达出境口岸",
      "2026-09-23T08:00:00.000Z",
    );
  });
});
