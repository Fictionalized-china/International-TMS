import { describe, expect, it } from "vitest";
import { loadFreshSettlementWorkbenchActor } from "./settlement-workbench-access.server";

type RowSet = {
  inherited?: string[];
  roles?: string[];
  overrides?: Array<{ code: string; effect: "allow" | "deny" }>;
  allPermissions?: string[];
  valid?: boolean;
  positionCode?: string;
};

function database(rows: RowSet = {}) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      calls.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async first() {
          if (rows.valid === false) return null;
          return {
            membership_id: "membership-1",
            position_code: rows.positionCode ?? "FINANCE_ACCOUNTING",
            role_codes: (rows.roles ?? ["pos_finance"]).join(","),
            inherited_codes: (rows.inherited ?? []).join(","),
            override_json: JSON.stringify(rows.overrides ?? []),
          };
        },
        async all() {
          if (sql.includes("active_role.code AS code")) {
            return { results: (rows.roles ?? ["pos_finance"]).map((code) => ({ code })) };
          }
          if (sql.includes("role_permission.permission_code AS code")) {
            return { results: (rows.inherited ?? []).map((code) => ({ code })) };
          }
          if (sql.includes("membership_permission_overrides")) {
            return { results: rows.overrides ?? [] };
          }
          if (sql.includes("FROM permissions permission")) {
            return { results: (rows.allPermissions ?? []).map((code) => ({ code })) };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

const identity = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "finance-1",
};

describe("fresh settlement actor", () => {
  it("reloads active session, membership, position, roles and account overrides", async () => {
    const { db, calls } = database({
      inherited: ["billing.view", "billing.sensitive.view", "billing.manage"],
      overrides: [{ code: "billing.manage", effect: "deny" }],
    });

    const actor = await loadFreshSettlementWorkbenchActor(
      db,
      identity,
      "2026-09-06T00:00:00.000Z",
    );

    expect(actor).toEqual({
      organizationId: "org-1",
      userId: "finance-1",
      positionCode: "FINANCE_ACCOUNTING",
      roleCodes: ["pos_finance"],
      permissions: ["billing.sensitive.view", "billing.view"],
    });
    expect(calls[0].sql).toContain("session.expires_at>?");
    expect(calls[0].sql).toContain("session.site='admin'");
    expect(calls[0].sql).toContain("user.status='active'");
    expect(calls[0].sql).toContain("organization.status='active'");
    expect(calls[0].sql).toContain("membership.status='active'");
    expect(calls[0].sql).toContain("position.status='active'");
    expect(calls[0].sql).toContain("active_role.status='active'");
    expect(calls.every((call) => call.bindings.includes("session-1"))).toBe(true);
  });

  it("fails closed without querying permissions when the live identity is invalid", async () => {
    const { db, calls } = database({ valid: false });

    await expect(loadFreshSettlementWorkbenchActor(db, identity)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps protected owner permissions tied to a currently active protected role", async () => {
    const { db } = database({
      positionCode: "BOSS",
      roles: ["owner"],
      inherited: ["billing.view"],
      overrides: [{ code: "billing.manage", effect: "deny" }],
      allPermissions: ["billing.view", "billing.manage", "billing.scope.all"],
    });

    const actor = await loadFreshSettlementWorkbenchActor(db, identity);
    expect(actor?.permissions).toEqual(["billing.manage", "billing.scope.all", "billing.view"]);
  });
});
