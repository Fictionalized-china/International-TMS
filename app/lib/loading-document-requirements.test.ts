import { describe, expect, it } from "vitest";
import {
  currentStageLoadingDocumentRequirements,
  loadingDocumentFieldPolicy,
  resolveLoadingDocumentRequirements,
  summarizeLoadingDocumentRequirements,
  warehouseLoadingDocumentMutationPolicy,
} from "./loading-document-requirements";

describe("loading document requirements", () => {
  it("does not count an optional missing consignment letter as incomplete", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "order-1",
      customsEnabled: false,
      fieldsByModule: {
        consignment: [
          {
            fieldKey: "document_consignment_letter",
            isActive: true,
            isRequired: false,
          },
        ],
      },
    });

    expect(
      summarizeLoadingDocumentRequirements(requirements.documents, []),
    ).toMatchObject({
      activeCount: 1,
      requiredCount: 0,
      incompleteCodes: [],
      complete: true,
    });
  });

  it("blocks on a required missing consignment letter", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "order-2",
      customsEnabled: false,
      fieldsByModule: {
        consignment: [
          {
            fieldKey: "document_consignment_letter",
            isActive: true,
            isRequired: true,
          },
        ],
      },
    });

    expect(
      summarizeLoadingDocumentRequirements(requirements.documents, []),
    ).toMatchObject({
      requiredCount: 1,
      missingUploadCodes: ["consignment_letter"],
      incompleteCodes: ["consignment_letter"],
      complete: false,
    });
  });

  it("does not activate customs documents for an order without the customs module", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "order-3",
      customsEnabled: false,
      fieldsByModule: {},
    });

    expect(
      requirements.documents.filter((document) => document.isActive).map(
        (document) => document.code,
      ),
    ).toEqual(["consignment_letter"]);
  });

  it("uses required, optional and hidden workflow modes per order", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "order-4",
      customsEnabled: true,
      fieldsByModule: {
        consignment: [
          {
            fieldKey: "document_consignment_letter",
            isActive: false,
            isRequired: false,
          },
        ],
        customs: [
          {
            fieldKey: "document_commercial_invoice",
            isActive: true,
            isRequired: false,
          },
          {
            fieldKey: "document_packing_list",
            isActive: true,
            isRequired: true,
          },
          {
            fieldKey: "document_customs_document",
            isActive: false,
            isRequired: false,
          },
          {
            fieldKey: "document_customs_declaration_file",
            isActive: true,
            isRequired: false,
          },
        ],
      },
    });
    const summary = summarizeLoadingDocumentRequirements(
      requirements.documents,
      [
        {
          document_category: "commercial_invoice",
          review_status: "approved",
        },
        { document_category: "packing_list", review_status: "pending" },
      ],
    );

    expect(summary).toMatchObject({
      activeCount: 3,
      requiredCount: 1,
      uploadedRequiredCount: 1,
      approvedRequiredCount: 0,
      incompleteCodes: ["packing_list"],
      complete: false,
    });

    expect(loadingDocumentFieldPolicy(
      requirements.documents,
      "commercial_invoice",
    )).toMatchObject({ visible: true, required: false, configured: true });
    expect(loadingDocumentFieldPolicy(
      requirements.documents,
      "packing_list",
    )).toMatchObject({ visible: true, required: true, configured: true });
    expect(loadingDocumentFieldPolicy(
      requirements.documents,
      "customs_document",
    )).toMatchObject({ visible: false, required: false, configured: true });
    expect(loadingDocumentFieldPolicy(
      requirements.documents,
      "not_configured",
    )).toMatchObject({ visible: false, required: false, configured: false });
  });

  it("evaluates mixed orders independently inside one consolidation batch", () => {
    const optionalOrder = resolveLoadingDocumentRequirements({
      orderId: "ltl-1",
      customsEnabled: false,
      fieldsByModule: {
        consignment: [
          {
            fieldKey: "document_consignment_letter",
            isActive: true,
            isRequired: false,
          },
        ],
      },
    });
    const requiredOrders = ["ltl-2", "ltl-3"].map((orderId) =>
      resolveLoadingDocumentRequirements({
        orderId,
        customsEnabled: false,
        fieldsByModule: {
          consignment: [
            {
              fieldKey: "document_consignment_letter",
              isActive: true,
              isRequired: true,
            },
          ],
        },
      }),
    );
    const summaries = [optionalOrder, ...requiredOrders].map((group) =>
      summarizeLoadingDocumentRequirements(
        group.documents,
        group.orderId === "ltl-1"
          ? []
          : [
              {
                document_category: "consignment_letter",
                review_status: "approved",
              },
            ],
      ),
    );

    expect(summaries.flatMap((summary) => summary.incompleteCodes)).toEqual([]);
    expect(summaries.reduce((sum, summary) => sum + summary.requiredCount, 0)).toBe(2);
  });

  it("keeps warehouse task creation blocked until uploaded files are confirmed", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "warehouse-remediation",
      customsEnabled: false,
      fieldsByModule: {
        consignment: [
          {
            fieldKey: "document_consignment_letter",
            isActive: true,
            isRequired: true,
          },
        ],
      },
    });

    expect(
      summarizeLoadingDocumentRequirements(requirements.documents, []),
    ).toMatchObject({
      missingUploadCodes: ["consignment_letter"],
      incompleteCodes: ["consignment_letter"],
      complete: false,
    });
    expect(
      summarizeLoadingDocumentRequirements(requirements.documents, [
        {
          document_category: "consignment_letter",
          review_status: "pending",
        },
      ]),
    ).toMatchObject({
      missingUploadCodes: [],
      incompleteCodes: ["consignment_letter"],
      complete: false,
    });
    expect(
      summarizeLoadingDocumentRequirements(requirements.documents, [
        {
          document_category: "consignment_letter",
          review_status: "approved",
        },
      ]),
    ).toMatchObject({
      missingUploadCodes: [],
      incompleteCodes: [],
      complete: true,
    });
  });

  it("does not let future customs files block the earlier loading stage", () => {
    const requirements = resolveLoadingDocumentRequirements({
      orderId: "stage-aware-order",
      customsEnabled: true,
      fieldsByModule: {
        consignment: [{
          fieldKey: "document_consignment_letter",
          isActive: true,
          isRequired: true,
          stageAvailable: true,
        }],
        customs: [
          {
            fieldKey: "document_commercial_invoice",
            isActive: true,
            isRequired: true,
            stageAvailable: false,
          },
          {
            fieldKey: "document_packing_list",
            isActive: true,
            isRequired: true,
            stageAvailable: false,
          },
          {
            fieldKey: "document_customs_document",
            isActive: true,
            isRequired: true,
            stageAvailable: false,
          },
          {
            fieldKey: "document_customs_declaration_file",
            isActive: true,
            isRequired: false,
            stageAvailable: false,
          },
        ],
      },
    });

    const dueNow = currentStageLoadingDocumentRequirements(requirements.documents);
    expect(dueNow.map((document) => document.code)).toEqual([
      "consignment_letter",
    ]);
    expect(summarizeLoadingDocumentRequirements(dueNow, [{
      document_category: "consignment_letter",
      review_status: "approved",
    }])).toMatchObject({
      requiredCount: 1,
      incompleteCodes: [],
      complete: true,
    });
  });

  it("keeps the warehouse loading-document surface read-only", () => {
    expect(warehouseLoadingDocumentMutationPolicy).toMatchObject({
      allowed: false,
    });
  });
});
