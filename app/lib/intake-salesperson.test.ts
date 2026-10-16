import { describe, expect, it } from "vitest";
import { preferredIntakeSalespersonId } from "./intake-salesperson";

describe("preferred intake salesperson", () => {
  const users = [
    { id: "boss", position_code: null },
    { id: "sales-1", position_code: "SALES" },
  ];

  it("keeps a real salesperson as the default when the boss creates an order", () => {
    expect(preferredIntakeSalespersonId({
      currentUserId: "boss",
      currentPositionCode: "BOSS",
      users,
    })).toBe("sales-1");
  });

  it("keeps ordinary users bound to themselves and falls back if no salesperson exists", () => {
    expect(preferredIntakeSalespersonId({
      currentUserId: "sales-1",
      currentPositionCode: "SALES",
      users,
    })).toBe("sales-1");
    expect(preferredIntakeSalespersonId({
      currentUserId: "boss",
      currentPositionCode: "BOSS",
      users: [{ id: "boss" }],
    })).toBe("boss");
  });
});
