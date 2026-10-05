import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
vi.mock("../components/Modal", () => ({ Modal: ({ triggerLabel }: { triggerLabel: string }) => createElement("button", null, triggerLabel) }));
import Quotations from "./admin.quotations";

function render(direct: boolean, permissions: string[]) {
  const props = {
    loaderData: {
      current: { permissions, userId: "sales-1", positionCode: "SALES", roleCodes: [] },
      filters: { keyword: "", lifecycle: "", entryMode: direct ? "direct" : "" },
      quoteStats: { pending: 0, accepted: 0, orders: 0 },
      quotes: [], pagination: { page: 1, pageCount: 1, total: 0, pageSize: 10 },
    }, params: {}, matches: [],
  } as unknown as ComponentProps<typeof Quotations>;
  const router = createMemoryRouter([{ path: "/admin/quotations", element: createElement(Quotations, props) }], {
    initialEntries: [`/admin/quotations${direct ? "?entryMode=direct" : ""}`],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("intake and quotation workspace separation", () => {
  it("renders intake in the order-center context, not alongside the quotation ledger", () => {
    const markup = render(true, ["menu.admin.orders.view", "order.view", "order.intake.manage", "quote.view", "quote.manage"]);
    expect(markup).toContain("ORDER INTAKE / 订单中心");
    expect(markup).toContain("确认的业务建立订单");
    expect(markup).not.toContain("待客户确认");
    expect(markup).not.toContain("创建报价");
    expect(markup).not.toContain("报价记录");
    expect(markup).toContain('<button>直接录单</button>');
  });

  it("keeps the quote tool but removes its duplicate direct-intake entry", () => {
    const markup = render(false, ["menu.admin.quotations.view", "quote.view", "quote.manage", "order.intake.manage"]);
    expect(markup).toContain('<button>创建报价</button>');
    expect(markup).toContain("报价记录");
    expect(markup).not.toContain('<button>直接录单</button>');
    expect(markup).not.toContain("entryMode=direct");
  });

  it("cannot render a writable intake trigger after its permission is removed", () => {
    expect(render(true, ["menu.admin.orders.view", "order.view"])).not.toContain('<button>直接录单</button>');
  });
});
