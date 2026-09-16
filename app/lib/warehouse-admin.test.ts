import { describe, expect, it } from "vitest";

import {
  validateWarehousePasswordReset,
  warehousePasswordResetRequested,
} from "./warehouse-admin";

describe("warehouse password reset validation", () => {
  it("keeps warehouse-only edits independent from password resets", () => {
    const input = { accountId: "", password: "", confirmPassword: "" };
    expect(warehousePasswordResetRequested(input)).toBe(false);
    expect(validateWarehousePasswordReset(input)).toBeNull();
  });

  it("requires a warehouse-bound account and matching strong passwords", () => {
    expect(validateWarehousePasswordReset({
      accountId: "",
      password: "StrongPassword2026",
      confirmPassword: "StrongPassword2026",
    })).toBe("请选择需要修改密码的仓库账号");
    expect(validateWarehousePasswordReset({
      accountId: "user-1",
      password: "weak",
      confirmPassword: "weak",
    })).toBe("密码至少需要 12 位");
    expect(validateWarehousePasswordReset({
      accountId: "user-1",
      password: "StrongPassword2026",
      confirmPassword: "StrongPassword2027",
    })).toBe("两次输入的新密码不一致");
    expect(validateWarehousePasswordReset({
      accountId: "user-1",
      password: "StrongPassword2026",
      confirmPassword: "StrongPassword2026",
    })).toBeNull();
  });
});
