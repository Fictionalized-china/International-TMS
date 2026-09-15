import { describe, expect, it } from "vitest";
import { orderMarkLabelAvailable } from "./order-mark-label-policy";

describe("order mark label", () => {
  it("becomes available as soon as the quote is accepted while the order is still draft", () => {
    expect(orderMarkLabelAvailable({
      status: "draft",
      acceptedAt: "2026-09-01T12:00:00.000Z",
    })).toBe(true);
    expect(orderMarkLabelAvailable({ status: "draft", acceptedAt: null })).toBe(false);
  });

  it("blocks withdrawn and cancelled labels from operational printing", () => {
    expect(orderMarkLabelAvailable({
      status: "draft",
      acceptedAt: "2026-09-01T12:00:00.000Z",
      quoteWithdrawn: 1,
    })).toBe(false);
    expect(orderMarkLabelAvailable({
      status: "cancelled",
      acceptedAt: "2026-09-01T12:00:00.000Z",
    })).toBe(false);
  });

});
