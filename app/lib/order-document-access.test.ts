import { describe, expect, it } from "vitest";
import {
  canReviewOrderModuleDocument,
  canUploadOrderModuleDocument,
  isSettlementDocumentStageOpen,
  orderDocumentWorkflowMutationAccess,
  settlementDocumentStageAccess,
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
    "keeps the legacy settlement document fallback during %s",
    (currentStepKey) => {
      expect(isSettlementDocumentStageOpen(currentStepKey, "in_execution")).toBe(
        true,
      );
    },
  );

  it("opens a settlement document at its locked custom field placement", () => {
    const workflow = {
      locked: true,
      currentStepKey: "custom_document_gate",
      steps: [
        { stepKey: "pickup", stepName: "客户提货", sortOrder: 10 },
        {
          stepKey: "custom_document_gate",
          stepName: "自定义结算单据",
          sortOrder: 20,
        },
      ],
      modulePlacements: [
        { moduleCode: "costs", stepKey: "custom_document_gate" },
      ],
      fields: [
        {
          moduleCode: "costs",
          fieldKey: "document_billing_statement",
          stepKey: "custom_document_gate",
          isActive: true,
          isRequired: false,
        },
      ],
    } as const;

    expect(
      isSettlementDocumentStageOpen({
        orderStatus: "in_execution",
        fieldKey: "document_billing_statement",
        workflow,
      }),
    ).toBe(true);
    expect(
      isSettlementDocumentStageOpen({
        orderStatus: "in_execution",
        fieldKey: "document_payment_receipt",
        workflow,
      }),
    ).toBe(false);
    expect(
      isSettlementDocumentStageOpen({
        orderStatus: "completed",
        fieldKey: "document_billing_statement",
        workflow,
      }),
    ).toBe(false);
  });

  it("keeps a hidden locked document field invisible after completion", () => {
    const workflow = {
      locked: true,
      currentStepKey: "custom_document_gate",
      steps: [
        {
          stepKey: "custom_document_gate",
          stepName: "自定义结算单据",
          sortOrder: 20,
        },
      ],
      modulePlacements: [
        { moduleCode: "costs", stepKey: "custom_document_gate" },
      ],
      fields: [
        {
          moduleCode: "costs",
          fieldKey: "document_billing_statement",
          stepKey: "custom_document_gate",
          isActive: false,
          isRequired: false,
        },
      ],
    } as const;

    expect(
      settlementDocumentStageAccess({
        orderStatus: "completed",
        fieldKey: "document_billing_statement",
        workflow,
      }),
    ).toMatchObject({ allowed: false, visible: false });
  });

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

  const lockedDocumentWorkflow = (
    fieldKey: string,
    mode: "required" | "optional" | "hidden",
  ) => ({
    locked: true,
    currentStepKey: "outbound_transport",
    steps: [
      { stepKey: "order_creation", stepName: "委托资料补充", sortOrder: 10 },
      { stepKey: "outbound_transport", stepName: "报关放行", sortOrder: 20 },
    ],
    modulePlacements: [
      { moduleCode: "consignment", stepKey: "order_creation" },
      { moduleCode: "customs", stepKey: "outbound_transport" },
    ],
    fields: [{
      moduleCode: fieldKey === "document_consignment_letter" ? "consignment" : "customs",
      fieldKey,
      stepKey: fieldKey === "document_consignment_letter" ? "order_creation" : "outbound_transport",
      isActive: mode !== "hidden",
      isRequired: mode === "required",
    }],
  } as const);

  it.each([
    ["required", true],
    ["optional", true],
    ["hidden", false],
  ] as const)(
    "enforces the frozen %s mode for an order document mutation",
    (mode, allowed) => {
      expect(orderDocumentWorkflowMutationAccess({
        documentCategory: "commercial_invoice",
        workflow: lockedDocumentWorkflow("document_commercial_invoice", mode),
      })).toMatchObject({
        allowed,
        visible: allowed,
        required: mode === "required",
        mode,
        fieldKey: "document_commercial_invoice",
        moduleCode: "customs",
      });
    },
  );

  it("fails closed when a forged document category is absent from the frozen instance", () => {
    expect(orderDocumentWorkflowMutationAccess({
      documentCategory: "packing_list",
      workflow: lockedDocumentWorkflow("document_commercial_invoice", "required"),
    })).toMatchObject({
      allowed: false,
      visible: false,
      mode: "hidden",
      fieldKey: "document_packing_list",
    });
  });

  it("fails closed when the order has no frozen workflow instance", () => {
    expect(orderDocumentWorkflowMutationAccess({
      documentCategory: "consignment_letter",
      workflow: {
        locked: false,
        currentStepKey: null,
        steps: [],
        modulePlacements: [],
        fields: [],
      },
    })).toMatchObject({
      allowed: false,
      visible: false,
      configured: false,
      mode: "hidden",
    });
  });

  it("fails closed for a document type without a workflow field placement", () => {
    expect(orderDocumentWorkflowMutationAccess({
      documentCategory: "waybill",
      workflow: lockedDocumentWorkflow("document_commercial_invoice", "required"),
    })).toMatchObject({
      allowed: false,
      visible: false,
      configured: false,
      mode: "hidden",
      fieldKey: null,
      moduleCode: null,
    });
  });

  it("does not open a visible file field before its frozen workflow node", () => {
    const workflow = lockedDocumentWorkflow("document_commercial_invoice", "required");
    expect(orderDocumentWorkflowMutationAccess({
      documentCategory: "commercial_invoice",
      workflow: { ...workflow, currentStepKey: "order_creation" },
    })).toMatchObject({
      allowed: false,
      visible: true,
      required: true,
      mode: "required",
    });
  });
});
