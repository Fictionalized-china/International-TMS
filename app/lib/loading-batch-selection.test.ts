import { describe, expect, it } from "vitest";

import { canCreateLoadingBatch, isSingleOrderPartialBatch } from "./loading-batch-selection";

describe("loading batch selection", () => {
  it("keeps ordinary consolidation at two or more orders", () => {
    expect(canCreateLoadingBatch([
      { package_count: 1, allocated_package_count: 0 },
      { package_count: 1, allocated_package_count: 0 },
    ], [1, 1])).toBe(true);
    expect(canCreateLoadingBatch([
      { package_count: 1, allocated_package_count: 0 },
    ], [1])).toBe(false);
  });

  it("allows a one-order batch only when it is a partial or continuation transport", () => {
    expect(isSingleOrderPartialBatch({ package_count: 3, allocated_package_count: 0 }, 2)).toBe(true);
    expect(isSingleOrderPartialBatch({ package_count: 1, allocated_package_count: 2 }, 1)).toBe(true);
    expect(isSingleOrderPartialBatch({ package_count: 3, allocated_package_count: 0 }, 3)).toBe(false);
  });
});
