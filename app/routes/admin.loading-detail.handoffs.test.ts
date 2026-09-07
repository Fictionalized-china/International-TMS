import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import {
  BatchDrawerOrderDisclosure,
  BatchOrderArchiveButton,
} from "./admin.loading-detail";

describe("PZ inline handoffs", () => {
  it("opens the existing dossier drawer instead of linking to a child order page", () => {
    const markup = renderToStaticMarkup(createElement(BatchOrderArchiveButton, {
      orderId: "order-1",
      onOpen: () => undefined,
    }));

    expect(markup).toContain("在右侧查看完整归档");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("/admin/orders/order-1/modules/documents");
  });

  it("shows the selected order's complete authorized file list in the batch drawer", () => {
    const markup = renderToStaticMarkup(createElement(BatchDrawerOrderDisclosure, {
      order: {
        order_id: "order-1",
        order_number: "SO-001",
        business_type: "ltl",
        work_number: "WK-001",
        customer_name: "客户一",
        cargo_description: "测试货物",
        cargo_names: "测试货物",
        pieces: 1,
        gross_weight_kg: 10,
        volume_cbm: 1,
        declared_weight_kg: 10,
        declared_volume_cbm: 1,
        inbound_at: null,
        dispatched_packages: 1,
        in_stock_packages: 0,
        overseas_warehouse_id: "warehouse-1",
        overseas_warehouse_name: "境外目的仓",
        overseas_status: "waiting_arrival",
        overseas_arrival_at: null,
        document_assignee_user_id: "doc-1",
        customs_assignee_user_id: "doc-1",
      },
      cargoItems: [],
      packageLabels: [],
      orderDocuments: [{
        id: "document-1",
        order_id: "order-1",
        document_category: "commercial_invoice",
        file_name: "invoice-v2.pdf",
        content_type: "application/pdf",
        size_bytes: 1024,
        description: null,
        review_status: "approved",
        created_at: "2026-09-06T00:00:00.000Z",
      }, {
        id: "document-0",
        order_id: "order-1",
        document_category: "commercial_invoice",
        file_name: "invoice-v1.pdf",
        content_type: "application/pdf",
        size_bytes: 900,
        description: null,
        review_status: "rejected",
        created_at: "2026-09-05T00:00:00.000Z",
      }],
      initiallyOpen: true,
    }));

    expect(markup).toContain("本票完整文件归档");
    expect(markup).toContain("invoice-v2.pdf");
    expect(markup).toContain("invoice-v1.pdf");
    expect(markup).toContain("/admin/document-files/order/document-1?mode=view");
    expect(markup).toContain("/admin/document-files/order/document-0?mode=view");
    expect(markup).toContain("<details");
    expect(markup).toContain("open=\"\"");
  });
});
