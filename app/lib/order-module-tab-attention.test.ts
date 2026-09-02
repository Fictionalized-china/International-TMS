import { describe, expect, it } from "vitest";
import { orderModuleTabAttention } from "./order-module-tab-attention";

describe("orderModuleTabAttention", () => {
  it("does not mark tracking fields that are gated by upstream customs work", () => {
    expect(orderModuleTabAttention("tracking", true)).toBeNull();
  });

  it("turns missing customs work into an explicit action prompt", () => {
    expect(orderModuleTabAttention("customs", true)).toBe("action");
  });

  it("keeps the required marker behavior for other modules", () => {
    expect(orderModuleTabAttention("documents", true)).toBe("required");
    expect(orderModuleTabAttention("customs", false)).toBeNull();
  });
});
