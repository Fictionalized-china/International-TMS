import { describe, expect, it } from "vitest";
import {
  orderDocumentStages,
  orderDocumentTypeCodes,
  requiredPreDepartureDocumentTypes,
} from "./order-documents";

describe("order document taxonomy", () => {
  it("defines four stages and thirteen dedicated document types", () => {
    expect(orderDocumentStages).toHaveLength(4);
    expect(orderDocumentTypeCodes.size).toBe(13);
  });

  it("requires customs documents at departure only for customs orders", () => {
    expect(requiredPreDepartureDocumentTypes(false)).not.toContain("customs_document");
    expect(requiredPreDepartureDocumentTypes(true)).toContain("customs_document");
  });
});
