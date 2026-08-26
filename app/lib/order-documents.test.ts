import { describe, expect, it } from "vitest";
import {
  orderDocumentStages,
  orderDocumentPlacement,
  orderDocumentTypeCodes,
  requiredPreDepartureDocumentTypes,
} from "./order-documents";

describe("order document taxonomy", () => {
  it("defines four stages and thirteen dedicated document types", () => {
    expect(orderDocumentStages).toHaveLength(4);
    expect(orderDocumentTypeCodes.size).toBe(13);
    // 合同不再作为订单工作流文件（2026-08-18 需求：合同归客户资料管理）
    expect(orderDocumentTypeCodes.has("contract")).toBe(false);
  });

  it("requires customs documents at departure only for customs orders", () => {
    expect(requiredPreDepartureDocumentTypes(false)).not.toContain("customs_document");
    expect(requiredPreDepartureDocumentTypes(true)).toContain("customs_document");
  });

  it("keeps delivery receipt as optional archive evidence", () => {
    expect(orderDocumentPlacement("delivery_receipt")?.requiredByDefault).toBe(false);
  });
});
