import { describe, expect, it } from "vitest";
import {
  orderDocumentStages,
  orderDocumentPlacement,
  orderDocumentTypeCodes,
  requiredPreDepartureDocumentTypes,
} from "./order-documents";

describe("order document taxonomy", () => {
  it("defines four stages and fourteen dedicated document types", () => {
    expect(orderDocumentStages).toHaveLength(4);
    expect(orderDocumentTypeCodes.size).toBe(14);
    // 客户主档合同仍独立保存；工作流合同是可配置的订单级文件，可按字段策略释放。
    expect(orderDocumentTypeCodes.has("contract")).toBe(true);
  });

  it("requires customs documents at departure only for customs orders", () => {
    expect(requiredPreDepartureDocumentTypes(false)).not.toContain("customs_document");
    expect(requiredPreDepartureDocumentTypes(true)).toContain("customs_document");
  });

  it("keeps delivery receipt as optional archive evidence", () => {
    expect(orderDocumentPlacement("delivery_receipt")?.requiredByDefault).toBe(false);
  });
});
