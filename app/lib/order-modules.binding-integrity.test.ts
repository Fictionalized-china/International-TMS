import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const sql: string[] = [];
  const DB = {
    prepare(query: string) {
      sql.push(query);
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (query.includes("SELECT o.id,o.business_type,o.status")) {
            return {
              id: "order-1",
              business_type: "ftl",
              status: "in_execution",
              current_assignee_user_id: null,
              workflow_instance_id: "foreign-instance",
              matched_instance_id: null,
              workflow_id: null,
            };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch() {
      throw new Error("must fail before mutation");
    },
  };
  return { sql, DB };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));

import { ensureOrderModules } from "./order-modules.server";

describe("order module workflow binding integrity", () => {
  it("blocks synchronization before mutation when a pointer targets another order", async () => {
    harness.sql.length = 0;

    await expect(ensureOrderModules("organization-1", "order-1"))
      .rejects.toThrow("工作流实例绑定异常");

    const bindingQuery = harness.sql.find((query) =>
      query.includes("SELECT o.id,o.business_type,o.status"),
    );
    expect(bindingQuery).toContain("wi.organization_id=o.organization_id");
    expect(bindingQuery).toContain("wi.order_id=o.id");
    expect(bindingQuery).toContain("o.workflow_instance_id IS NULL");
  });
});
