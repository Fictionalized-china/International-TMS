import type { OrderModuleCode } from "./order-modules";

export type OrderDocumentStageCode =
  | "pre_departure"
  | "in_transit"
  | "post_delivery"
  | "post_settlement";

export type OrderDocumentType = {
  code: string;
  name: string;
  hint: string;
  requiredForDeparture?: boolean;
};

export type OrderDocumentStage = {
  code: OrderDocumentStageCode;
  name: string;
  hint: string;
  documents: readonly OrderDocumentType[];
};

export const orderDocumentStages: readonly OrderDocumentStage[] = [
  {
    code: "pre_departure",
    name: "发运前",
    hint: "完成业务委托、贸易与报关资料准备；发车门槛会检查必需文件。",
    documents: [
      { code: "consignment_letter", name: "委托书", hint: "客户运输委托或托运委托书", requiredForDeparture: true },
      { code: "contract", name: "合同", hint: "运输、代理或客户业务合同", requiredForDeparture: true },
      { code: "commercial_invoice", name: "发票", hint: "商业发票或形式发票", requiredForDeparture: true },
      { code: "packing_list", name: "装箱单", hint: "货物件数、重量和包装明细", requiredForDeparture: true },
      { code: "customs_document", name: "报关资料", hint: "申报、报检或清关所需资料" },
    ],
  },
  {
    code: "in_transit",
    name: "运输中",
    hint: "随运输、换装和口岸流转持续补充。",
    documents: [
      { code: "waybill", name: "运单", hint: "公路运单或国际运输运单" },
      { code: "transshipment_order", name: "换装单", hint: "中转、换装或交接凭证" },
      { code: "border_document", name: "口岸文件", hint: "口岸交接、过境或查验文件" },
    ],
  },
  {
    code: "post_delivery",
    name: "签收后",
    hint: "用于证明末端交付和客户签收结果。",
    documents: [
      { code: "pod", name: "POD", hint: "Proof of Delivery 交付证明" },
      { code: "delivery_receipt", name: "签收单", hint: "收货人签字或盖章的签收文件" },
      { code: "return_receipt", name: "回单", hint: "业务回单或客户回执" },
    ],
  },
  {
    code: "post_settlement",
    name: "结算后",
    hint: "归档应收结算和收款证明。",
    documents: [
      { code: "billing_statement", name: "账单", hint: "客户应收账单或对账单" },
      { code: "payment_receipt", name: "收款凭证", hint: "银行回单或其他收款凭证" },
    ],
  },
] as const;

export const orderDocumentTypes = orderDocumentStages.flatMap(
  (stage) => stage.documents,
);

export type OrderDocumentPlacement = {
  documentCode: string;
  moduleCode: OrderModuleCode;
  fieldKey: string;
  requiredByDefault: boolean;
};

// A document is uploaded where the business actually produces or receives it.
// The documents module only aggregates, reviews and archives these records.
export const orderDocumentPlacements: readonly OrderDocumentPlacement[] = [
  {
    documentCode: "consignment_letter",
    moduleCode: "consignment",
    fieldKey: "document_consignment_letter",
    requiredByDefault: true,
  },
  {
    documentCode: "contract",
    moduleCode: "consignment",
    fieldKey: "document_contract",
    requiredByDefault: true,
  },
  {
    documentCode: "waybill",
    moduleCode: "transport",
    fieldKey: "document_waybill",
    requiredByDefault: false,
  },
  {
    documentCode: "commercial_invoice",
    moduleCode: "customs",
    fieldKey: "document_commercial_invoice",
    requiredByDefault: true,
  },
  {
    documentCode: "packing_list",
    moduleCode: "customs",
    fieldKey: "document_packing_list",
    requiredByDefault: true,
  },
  {
    documentCode: "customs_document",
    moduleCode: "customs",
    fieldKey: "document_customs_document",
    requiredByDefault: false,
  },
  {
    documentCode: "border_document",
    moduleCode: "customs",
    fieldKey: "document_border_document",
    requiredByDefault: false,
  },
  {
    documentCode: "transshipment_order",
    moduleCode: "tracking",
    fieldKey: "document_transshipment_order",
    requiredByDefault: false,
  },
  {
    documentCode: "pod",
    moduleCode: "overseas_warehouse",
    fieldKey: "document_pod",
    requiredByDefault: false,
  },
  {
    documentCode: "delivery_receipt",
    moduleCode: "overseas_warehouse",
    fieldKey: "document_delivery_receipt",
    requiredByDefault: true,
  },
  {
    documentCode: "return_receipt",
    moduleCode: "overseas_warehouse",
    fieldKey: "document_return_receipt",
    requiredByDefault: false,
  },
  {
    documentCode: "billing_statement",
    moduleCode: "costs",
    fieldKey: "document_billing_statement",
    requiredByDefault: false,
  },
  {
    documentCode: "payment_receipt",
    moduleCode: "costs",
    fieldKey: "document_payment_receipt",
    requiredByDefault: false,
  },
] as const;

export function orderDocumentPlacement(documentCode: string) {
  return orderDocumentPlacements.find(
    (placement) => placement.documentCode === documentCode,
  );
}

export function orderDocumentsForModule(moduleCode: OrderModuleCode) {
  return orderDocumentPlacements
    .filter((placement) => placement.moduleCode === moduleCode)
    .map((placement) => ({
      ...placement,
      document: orderDocumentTypes.find(
        (document) => document.code === placement.documentCode,
      )!,
    }));
}

export const orderDocumentTypeCodes = new Set(
  orderDocumentTypes.map((document) => document.code),
);

export const maxInlineOrderDocumentBytes = 1_200_000;

export function orderDocumentTypeLabel(code: string | null) {
  return (
    orderDocumentTypes.find((document) => document.code === code)?.name ??
    ({
      consignment: "委托资料（旧分类）",
      customs: "报关/清关（旧分类）",
      transport: "运输单证（旧分类）",
      invoice: "发票/费用（旧分类）",
      other: "其他",
    } as Record<string, string>)[code || "other"] ??
    "其他"
  );
}

export function requiredPreDepartureDocumentTypes(customsEnabled: boolean) {
  const required = orderDocumentStages[0].documents
    .filter((document) => document.requiredForDeparture)
    .map((document) => document.code);
  return customsEnabled ? [...required, "customs_document"] : required;
}
