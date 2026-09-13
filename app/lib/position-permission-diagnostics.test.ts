import { describe, expect, it } from "vitest";
import { diagnosePositionPermission } from "./position-permission-diagnostics";

describe("diagnosePositionPermission", () => {
  it("接受与岗位角色完全一致的账号", () => {
    expect(diagnosePositionPermission({
      positionCode: "SALES",
      expectedRoleCode: "pos_sales",
      actualRoleCodes: ["pos_sales"],
      legacyOverrideCount: 0,
    })).toEqual({
      status: "consistent",
      issues: [],
      unexpectedRoleCodes: [],
    });
  });

  it("报告缺失、额外角色和旧账号覆盖", () => {
    const result = diagnosePositionPermission({
      positionCode: "DOC",
      expectedRoleCode: "pos_doc",
      actualRoleCodes: ["legacy_doc", "custom"],
      legacyOverrideCount: 2,
    });
    expect(result.status).toBe("conflict");
    expect(result.issues).toContain("缺少岗位角色 pos_doc");
    expect(result.issues).toContain("存在非岗位角色 custom、legacy_doc");
    expect(result.issues).toContain("存在 2 条已停用的账号级权限覆盖");
  });

  it("报告未绑定岗位的账号", () => {
    const result = diagnosePositionPermission({
      positionCode: null,
      expectedRoleCode: null,
      actualRoleCodes: [],
      legacyOverrideCount: 0,
    });
    expect(result.status).toBe("conflict");
    expect(result.issues).toEqual(["未绑定有效岗位"]);
  });
});
