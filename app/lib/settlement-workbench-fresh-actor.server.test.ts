import { describe, expect, it } from "vitest";
import { loadFreshSettlementWorkbenchActor } from "./settlement-workbench-access.server";

type RowSet = {
  permissions?: string[];
  allPermissions?: string[];
  sessionValid?: boolean;
  profileValid?: boolean;
  positionCode?: string;
  roleCode?: string;
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
          if (sql.includes("FROM sessions session")) {
            return rows.sessionValid === false ? null : { ok: 1 };
          }
          if (sql.includes("FROM memberships membership")) {
            if (rows.profileValid === false) return null;
            return {
              membership_id: "membership-1",
              department_id: "department-1",
              department_code: "ACC",
              position_id: "position-1",
              position_code: rows.positionCode ?? "FINANCE_ACCOUNTING",
              position_name: "财务会计岗",
              role_code: rows.roleCode ?? "pos_finance",
              permission_codes: (rows.permissions ?? []).join(","),
            };
          }
          return null;
        },
        async all() {
          if (sql.includes("SELECT code FROM permissions")) {
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
  it("reloads the active session and exact current-position permission profile", async () => {
    const { db, calls } = database({
      permissions: ["billing.view", "billing.sensitive.view", "billing.manage"],
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
      permissions: ["billing.manage", "billing.sensitive.view", "billing.view"],
    });
    expect(calls[0].sql).toContain("session.expires_at>?");
    expect(calls[0].sql).toContain("session.site='admin'");
    expect(calls[1].sql).toContain("CASE position.code");
    expect(calls[1].sql).not.toContain("membership_roles");
    expect(calls[1].sql).not.toContain("membership_permission_overrides");
  });

  it("fails closed before loading a profile when the live session is invalid", async () => {
    const { db, calls } = database({ sessionValid: false });
    await expect(loadFreshSettlementWorkbenchActor(db, identity)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("fails closed when no active current-position profile exists", async () => {
    const { db } = database({ profileValid: false });
    await expect(loadFreshSettlementWorkbenchActor(db, identity)).resolves.toBeNull();
  });

  it("gives protected positions all registered permissions without account overrides", async () => {
    const { db } = database({
      positionCode: "BOSS",
      roleCode: "boss",
      permissions: ["billing.view"],
      allPermissions: ["billing.view", "billing.manage", "billing.scope.all"],
    });
    const actor = await loadFreshSettlementWorkbenchActor(db, identity);
    expect(actor?.permissions).toEqual([
      "billing.view",
      "billing.manage",
      "billing.scope.all",
    ]);
  });
});
