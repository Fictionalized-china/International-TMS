import { describe, expect, it } from "vitest";

import { visibleApprovalCustomFields } from "./order-approval-custom-fields";

describe("visibleApprovalCustomFields", () => {
  it("shows active custom fields in the compact consignment approval view", () => {
    const fields = [
      { fieldKey: "built_in", isActive: true, isBuiltIn: true },
      { fieldKey: "custom_required", isActive: true, isBuiltIn: false },
      { fieldKey: "custom_hidden", isActive: false, isBuiltIn: false },
    ];

    expect(visibleApprovalCustomFields(fields).map((field) => field.fieldKey))
      .toEqual(["custom_required"]);
  });
});
