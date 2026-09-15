import { beforeEach, describe, expect, it, vi } from "vitest";

const routeHarness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "operation-1",
    permissions: ["order.view", "order.scope.assigned"],
    positionCode: "OPERATION",
    roleCodes: ["pos_operation"],
  };
  const state = {
    file: {
      file_name: "commercial-invoice.pdf",
      content_type: "application/pdf",
      data_url: "data:application/pdf;base64,QQ==",
      document_category: "commercial_invoice",
    },
    sql: "",
    bindings: [] as unknown[],
  };
  const DB = {
    prepare(sql: string) {
      state.sql = sql;
      return {
        bind(...bindings: unknown[]) {
          state.bindings = bindings;
          return {
            first: async () => state.file,
          };
        },
      };
    },
  };
  return {
    current,
    state,
    DB,
    requireSessionUser: vi.fn(async () => current),
    orderVisibilitySql: vi.fn(() => ({
      sql: "ORDER_VISIBLE = 1",
      values: ["order-scope"],
    })),
    batchVisibilitySql: vi.fn(() => ({
      sql: "BATCH_VISIBLE = 1",
      values: ["batch-scope"],
    })),
    storedDataUrlResponse: vi.fn(
      (input: { disposition: string }) =>
        new Response(input.disposition, { status: 200 }),
    ),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: routeHarness.DB } }));
vi.mock("../lib/auth.server", () => ({
  requireSessionUser: routeHarness.requireSessionUser,
}));
vi.mock("../lib/order-access.server", () => ({
  orderVisibilitySql: routeHarness.orderVisibilitySql,
  batchVisibilitySql: routeHarness.batchVisibilitySql,
}));
vi.mock("../lib/stored-file-response.server", () => ({
  storedDataUrlResponse: routeHarness.storedDataUrlResponse,
}));

import { loader } from "./admin.document-file";

describe("admin document file read authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeHarness.current.permissions = ["order.view", "order.scope.assigned"];
    routeHarness.state.file = {
      file_name: "commercial-invoice.pdf",
      content_type: "application/pdf",
      data_url: "data:application/pdf;base64,QQ==",
      document_category: "commercial_invoice",
    };
  });

  it.each([
    ["inline view", "?mode=view", "inline"],
    ["download", "", "attachment"],
  ])(
    "requires order.view for an ordinary scoped order file in %s mode",
    async (_, query, disposition) => {
      const request = new Request(
        `http://local.test/admin/document-files/order/file-1${query}`,
      );
      const response = await loader({
        request,
        params: { sourceType: "order", fileId: "file-1" },
        context: undefined,
      } as never);

      expect(response.status).toBe(200);
      expect(routeHarness.requireSessionUser).toHaveBeenCalledWith(
        request,
        "order.view",
      );
      expect(routeHarness.storedDataUrlResponse).toHaveBeenCalledWith(
        expect.objectContaining({ disposition }),
      );
      expect(routeHarness.orderVisibilitySql).toHaveBeenCalledWith(
        routeHarness.current,
        "o",
      );
      expect(routeHarness.state.sql).toContain("m.document_category");
    },
  );

  it.each([
    ["inline view", "?mode=view"],
    ["download", ""],
  ])(
    "blocks a scoped but financially unauthorized reader from a sensitive file in %s mode",
    async (_, query) => {
      routeHarness.state.file.document_category = "billing_statement";
      const request = new Request(
        `http://local.test/admin/document-files/order/file-1${query}`,
      );

      await expect(
        loader({
          request,
          params: { sourceType: "order", fileId: "file-1" },
          context: undefined,
        } as never),
      ).rejects.toMatchObject({ status: 403 });
      expect(routeHarness.storedDataUrlResponse).not.toHaveBeenCalled();
    },
  );

  it("uses batch visibility for an ordinary batch logistics document", async () => {
    routeHarness.state.file.file_name = "loading-manifest.pdf";
    routeHarness.state.file.document_category = "loading_manifest";
    const request = new Request(
      "http://local.test/admin/document-files/batch/file-2?mode=view",
    );

    const response = await loader({
      request,
      params: { sourceType: "batch", fileId: "file-2" },
      context: undefined,
    } as never);

    expect(response.status).toBe(200);
    expect(routeHarness.batchVisibilitySql).toHaveBeenCalledWith(
      routeHarness.current,
      "b",
    );
    expect(routeHarness.orderVisibilitySql).not.toHaveBeenCalled();
    expect(routeHarness.state.sql).toContain("d.document_category");
    expect(routeHarness.state.bindings).toEqual([
      "file-2",
      "org-1",
      "batch-scope",
    ]);
  });
});
