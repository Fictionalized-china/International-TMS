import { describe, expect, it } from "vitest";
import {
  appendOrderQueueContext,
  orderDetailQueueHref,
  orderQueueContextFromList,
  readOrderQueueNavigation,
} from "./order-queue-navigation";

describe("order queue navigation", () => {
  it("keeps only the visible ten unique order ids", () => {
    const context = orderQueueContextFromList({
      returnTo: "/admin/orders?view=orders&status=confirmed&page=2",
      orderIds: ["a", "b", "a", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
    });
    expect(context.orderIds).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(orderDetailQueueHref("b", context)).toContain("returnTo=%2Fadmin%2Forders%3Fview%3Dorders%26status%3Dconfirmed%26page%3D2");
  });

  it("resolves previous and next without trusting an external return url", () => {
    const navigation = readOrderQueueNavigation(new URLSearchParams({
      returnTo: "https://example.com/escape",
      orderQueue: "a,b,c",
    }), "b");
    expect(navigation.returnTo).toBe("/admin/orders?view=orders");
    expect(navigation.previousOrderId).toBe("a");
    expect(navigation.nextOrderId).toBe("c");
  });

  it("preserves queue context through module tabs and anchors", () => {
    expect(appendOrderQueueContext(
      "/admin/orders/a?stage=reconciliation#module-business-data",
      { returnTo: "/admin/orders?view=orders", orderIds: ["a", "b"] },
    )).toBe("/admin/orders/a?stage=reconciliation&returnTo=%2Fadmin%2Forders%3Fview%3Dorders&orderQueue=a%2Cb#module-business-data");
  });
});
