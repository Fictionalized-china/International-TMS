import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = vi.hoisted(() => ({ position: "WAREHOUSE" }));
const warehouse = { id: "warehouse-1", code: "WH-1", name: "国内仓", warehouse_role: "domestic_collection", country_code: "CN", city: "深圳" };
const slot = "inventory-session-tab-123";
const token = "inventory-session-token";
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = "https://tms.example.test";
const cookie = `itms_warehouse_session_${warehouse.id}_${slot}=${token}`;
const inventory = Array.from({ length: 21 }, (_, index) => ({
  id: `package-${index}`, barcode: `SO-1-IN-${index}`, package_number: `PKG-${index}`,
  shipment_number: "SHP-1", order_number: "SO-1", customer_name: "测试客户", customer_identity_code: "TEST",
  pieces: 1, weight_kg: 1, volume_cbm: 0, status: "in_stock", location_id: "location-1",
  location_name: "入库位", location_code: "LOC-1", zone_name: "收货区", warehouse_name: "国内仓",
  updated_at: "2026-11-05T09:00:00Z", pickup_appointment_at: null, pickup_appointment_period: null,
}));

vi.mock("cloudflare:workers", () => ({ env: { DB: {
  prepare(sql: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { bindings = values; return statement; },
      async first() {
        if (sql.includes("FROM sessions s") && bindings[0] === tokenHash) return {
          session_id: "session-1", site: "warehouse", user_id: "user-1", email: "warehouse@example.test",
          display_name: "仓库账号", organization_id: "org-1", organization_name: "测试组织",
        };
        return null;
      },
      async all() {
        if (sql.includes("SELECT warehouse.id,warehouse.country_code"))
          return { results: [{ id: warehouse.id, country_code: "CN" }] };
        if (sql.includes("SELECT warehouse_id,access_level FROM warehouse_user_access"))
          return { results: [{ warehouse_id: warehouse.id, access_level: "operator" }] };
        if (sql.includes("FROM warehouses w")) return { results: [warehouse] };
        if (sql.includes("FROM warehouse_packages p JOIN shipments")) return { results: inventory };
        return { results: [] };
      },
    };
    return statement;
  },
} } }));
vi.mock("../lib/position-access-profile.server", () => ({
  loadActivePositionAccessProfile: async () => ({
    membershipId: "membership-1", departmentId: "department-1", departmentCode: "OP",
    positionId: "position-1", positionCode: actor.position, positionName: actor.position,
    roleCode: actor.position === "BOSS" ? "boss" : "warehouse_operator",
    permissions: ["warehouse.view"], dataScope: actor.position === "BOSS" ? "company" : "warehouse",
  }),
}));

import WarehouseInventory, { loader } from "./warehouse.inventory";

function request(url: URL, extraHeaders: Record<string, string> = {}) {
  // No Referer: refreshing the results must authenticate from the URL alone.
  return new Request(url, { headers: { Cookie: cookie, ...extraHeaders } });
}

function load(url: URL, extraHeaders?: Record<string, string>) {
  return loader({ request: request(url, extraHeaders) } as Parameters<typeof loader>[0]);
}

function render(url: URL, data: Awaited<ReturnType<typeof loader>>) {
  const router = createMemoryRouter([{
    path: "/warehouse/inventory",
    element: createElement(WarehouseInventory, { loaderData: data } as never),
  }], { initialEntries: [url.pathname + url.search] });
  try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
  finally { router.dispose(); }
}

function attribute(markup: string, name: string) {
  return markup.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1].replaceAll("&amp;", "&") ?? "";
}

function searchUrl(markup: string) {
  const form = markup.match(/<form\b[^>]*class="inventory-filter"[^>]*>[\s\S]*?<\/form>/)?.[0];
  if (!form) throw new Error("Inventory search form was not rendered");
  const url = new URL(attribute(form, "action"), base);
  // Native GET form submission replaces the action query with successful controls.
  url.search = "";
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const name = attribute(input[0], "name");
    if (name) url.searchParams.set(name, attribute(input[0], "value"));
  }
  url.searchParams.set("q", "SO-1");
  url.searchParams.set("status", "all");
  url.searchParams.set("location", "location-1");
  return url;
}

beforeEach(() => { actor.position = "WAREHOUSE"; });

describe("warehouse inventory search session continuity", () => {
  it.each(["WAREHOUSE", "BOSS"])("preserves %s authentication across search, refresh, another search and pagination", async position => {
    actor.position = position;
    const initial = new URL(`/warehouse/inventory?warehouseId=${warehouse.id}&itmsTab=${slot}`, base);
    const searched = searchUrl(render(initial, await load(initial)));
    expect(searched.searchParams.get("warehouseId")).toBe(warehouse.id);
    expect(searched.searchParams.get("itmsTab")).toBe(slot);

    const refreshed = await load(searched);
    expect(refreshed.user.positionCode).toBe(position);
    expect(refreshed.warehouse.id).toBe(warehouse.id);
    expect(refreshed.q).toBe("SO-1");
    expect(refreshed.statusFilter).toBe("all");
    expect(refreshed.locationFilter).toBe("location-1");

    const searchedAgain = searchUrl(render(searched, refreshed));
    const repeated = await load(searchedAgain);
    const markup = render(searchedAgain, repeated);
    const nextPage = markup.match(/<a\b[^>]*aria-label="第 2 页"[^>]*>/)?.[0];
    expect(nextPage).toBeDefined();
    const paged = new URL(attribute(nextPage!, "href"), base);
    expect(paged.searchParams.get("warehouseId")).toBe(warehouse.id);
    expect(paged.searchParams.get("itmsTab")).toBe(slot);
    expect((await load(paged)).pagination.page).toBe(2);
  });

  it("persists a tab initially supplied by the request header for subsequent document requests", async () => {
    const initial = new URL(`/warehouse/inventory?warehouseId=${warehouse.id}`, base);
    const searched = searchUrl(render(initial, await load(initial, { "X-ITMS-Tab": slot })));
    expect(searched.searchParams.get("itmsTab")).toBe(slot);
    expect((await load(searched)).user.userId).toBe("user-1");
  });

  it("does not authenticate an unrelated warehouse using the current warehouse cookie", async () => {
    const other = new URL(`/warehouse/inventory?warehouseId=warehouse-other&itmsTab=${slot}`, base);
    await expect(load(other)).rejects.toMatchObject({ status: 302 });
  });
});
