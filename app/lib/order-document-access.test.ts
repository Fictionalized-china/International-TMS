import { describe, expect, it } from "vitest";
import {
  canReviewOrderModuleDocument,
  canUploadOrderModuleDocument,
  isSettlementDocumentStageOpen,
} from "./order-document-access";

describe("order document access", () => {
  const owners = {
    customerServiceAssigneeUserId: "customer-service-owner",
    financeAssigneeUserId: "finance-owner",
  };

  it("allows the assigned customer service and finance owners to upload settlement documents", () => {
    expect(
      canUploadOrderModuleDocument(
        { userId: "customer-service-owner", positionCode: "CS" },
        "costs",
        false,
        owners,
      ),
    ).toBe(true);
    expect(
      canUploadOrderModuleDocument(
        { userId: "finance-owner", positionCode: "FINANCE_ACCOUNTING" },
        "costs",
        false,
        owners,
      ),
    ).toBe(true);
  });

  it.each([
    ["another customer service", "another-cs", "CS"],
    ["another finance user", "another-finance", "FINANCE_ACCOUNTING"],
    ["a document clerk", "document-clerk", "DOC"],
  ])("rejects %s when uploading settlement documents", (_, userId, positionCode) => {
    expect(
      canUploadOrderModuleDocument(
        { userId, positionCode },
        "costs",
        true,
        owners,
      ),
    ).toBe(false);
  });

  it("only allows the assigned finance owner to review settlement documents", () => {
    expect(
      canReviewOrderModuleDocument(
        { userId: "finance-owner", positionCode: "FINANCE_ACCOUNTING" },
        "costs",
        false,
        owners,
      ),
    ).toBe(true);
    expect(
      canReviewOrderModuleDocument(
        { userId: "another-finance", positionCode: "FINANCE_ACCOUNTING" },
        "costs",
        true,
        owners,
      ),
    ).toBe(false);
    expect(
      canReviewOrderModuleDocument(
        { userId: "customer-service-owner", positionCode: "CS" },
        "costs",
        true,
        owners,
      ),
    ).toBe(false);
  });

  it("fails closed when a settlement owner is not assigned", () => {
    expect(
      canUploadOrderModuleDocument(
        { userId: "customer-service-owner", positionCode: "CS" },
        "costs",
        true,
      ),
    ).toBe(false);
    expect(
      canReviewOrderModuleDocument(
        { userId: "finance-owner", positionCode: "FINANCE_ACCOUNTING" },
        "costs",
        true,
      ),
    ).toBe(false);
  });

  it.each(["reconciliation", "completion_review"])(
    "opens settlement document maintenance during %s",
    (currentStepKey) => {
      expect(isSettlementDocumentStageOpen(currentStepKey, "in_execution")).toBe(
        true,
      );
    },
  );

  it.each([
    ["domestic_transport", "in_execution"],
    ["reconciliation", "completed"],
    ["completion_review", "cancelled"],
  ])(
    "keeps settlement document maintenance closed at %s / %s",
    (currentStepKey, orderStatus) => {
      expect(
        isSettlementDocumentStageOpen(currentStepKey, orderStatus),
      ).toBe(false);
    },
  );

  it("keeps existing module rules outside reconciliation", () => {
    expect(
      canUploadOrderModuleDocument({ positionCode: "DOC" }, "customs", true),
    ).toBe(true);
    expect(
      canReviewOrderModuleDocument({ positionCode: "DOC" }, "customs", false),
    ).toBe(false);
  });

  it("keeps boss and developer as system-level fallbacks", () => {
    expect(
      canReviewOrderModuleDocument(
        { userId: "boss", positionCode: "BOSS" },
        "costs",
        false,
      ),
    ).toBe(true);
    expect(
      canUploadOrderModuleDocument(
        { userId: "developer", positionCode: "DEVELOPER" },
        "costs",
        false,
      ),
    ).toBe(true);
  });
});
