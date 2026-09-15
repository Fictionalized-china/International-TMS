import { describe, expect, it } from "vitest";
import { canTransition, nextStates } from "./workflow";

describe("transport workflows", () => {
  it("allows valid sequential shipment progress", () => {
    expect(canTransition("shipment", "booked", "picked_up")).toBe(true);
    expect(canTransition("shipment", "picked_up", "in_transit")).toBe(true);
    expect(canTransition("shipment", "in_transit", "delivered")).toBe(true);
  });

  it("blocks reopening terminal documents", () => {
    expect(nextStates("quote", "accepted")).toEqual([]);
    expect(canTransition("order", "completed", "draft")).toBe(false);
    expect(canTransition("invoice", "paid", "issued")).toBe(false);
  });
});
