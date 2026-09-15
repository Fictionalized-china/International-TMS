import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const queries: Array<{ sql: string; bindings: unknown[] }> = [];
  let validUserIds = new Set(["user-a3"]);
  let permissionCodes = "order.module.transport.manage";
  let positionCode = "OPERATION";

  const member = () => ({
    id: "user-a3",
    display_name: "Operator A3",
    membership_id: "membership-a3",
    department_id: "department-operation",
    department_code: "OPERATION",
    department_name: "操作部",
    position_id: "position-operation",
    position_code: positionCode,
    position_name: "操作岗",
    permission_codes: permissionCodes,
    permission_override_entries: null,
  });

  return {
    queries,
    setValidUserIds(userIds: string[]) {
      validUserIds = new Set(userIds);
    },
    setPermissionCodes(codes: string[]) {
      permissionCodes = codes.join(",");
    },
    setPositionCode(code: string) {
      positionCode = code;
    },
    DB: {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return statement;
          },
          async first() {
            return validUserIds.has(String(query.bindings[1])) ? { ok: 1 } : null;
          },
          async all<T>() {
            if (sql.includes("GROUP_CONCAT(DISTINCT CASE")) {
              return { results: [member()] as T[] };
            }
            return {
              results: [...validUserIds].map((id) => ({ id })) as T[],
            };
          },
        };
        return statement;
      },
    },
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));

import {
  satisfiesOrganizationAssigneePermissionRequirements,
} from "./organization-assignee";
import {
  isActiveOrganizationAssignee,
  isActiveOrganizationAssigneeForPositions,
  isActiveOrganizationAssigneeForWorkflowNodes,
  listActiveOrganizationAssignees,
  listActiveOrganizationAssigneeIds,
  requireActiveOrganizationAssignee,
} from "./organization-assignee.server";

describe("organization assignee server guard", () => {
  beforeEach(() => {
    database.queries.length = 0;
    database.setValidUserIds(["user-a3"]);
    database.setPermissionCodes(["order.module.transport.manage"]);
    database.setPositionCode("OPERATION");
  });

  it("accepts only an active account attached to a matching department and position", async () => {
    await expect(isActiveOrganizationAssignee("org-a", "user-a3")).resolves.toBe(true);
    await expect(isActiveOrganizationAssignee("org-a", "user-missing")).resolves.toBe(false);
    expect(database.queries[0].sql).toContain("JOIN departments");
    expect(database.queries[0].sql).toContain("JOIN positions");
    expect(database.queries[0].sql).toContain("p.department_code=d.code");
  });

  it("returns only concrete assignable accounts and rejects invalid submissions", async () => {
    await expect(listActiveOrganizationAssigneeIds("org-a")).resolves.toEqual(
      new Set(["user-a3"]),
    );
    await expect(requireActiveOrganizationAssignee("org-a", "user-a3")).resolves.toBeUndefined();
    await expect(requireActiveOrganizationAssignee("org-a", "user-missing")).rejects.toThrow();
  });

  it("restricts assignment by the account current position", async () => {
    await expect(
      isActiveOrganizationAssigneeForPositions("org-a", "user-a3", ["OPERATION"]),
    ).resolves.toBe(true);
    await expect(
      isActiveOrganizationAssigneeForPositions("org-a", "user-a3", ["DOC"]),
    ).resolves.toBe(false);
  });

  it("validates a frozen-node assignee from position inheritance", async () => {
    await expect(isActiveOrganizationAssigneeForWorkflowNodes({
      organizationId: "org-a",
      userId: "user-a3",
      responsibilityPositionCode: "OPERATION",
      nodes: [{ stepKey: "domestic_execution", moduleCode: "transport" }],
    })).resolves.toBe(true);
  });

  it("uses only the position permission profile for runtime requirements", async () => {
    await expect(isActiveOrganizationAssigneeForPositions(
      "org-a",
      "user-a3",
      ["OPERATION"],
      [["order.module.transport.manage"], ["order.module.exceptions.manage"]],
    )).resolves.toBe(false);

    database.setPermissionCodes([
      "order.module.transport.manage",
      "order.module.exceptions.manage",
    ]);
    await expect(isActiveOrganizationAssigneeForPositions(
      "org-a",
      "user-a3",
      ["OPERATION"],
      [["order.module.transport.manage"], ["order.module.exceptions.manage"]],
    )).resolves.toBe(true);
    expect(database.queries.at(-1)?.sql).not.toContain("membership_permission_overrides");
    expect(database.queries.at(-1)?.sql).not.toContain("membership_roles");
  });

  it("derives exactly one active permission role from position code", async () => {
    await expect(listActiveOrganizationAssignees("org-a")).resolves.toEqual([
      expect.objectContaining({
        id: "user-a3",
        position_code: "OPERATION",
        permission_codes: "order.module.transport.manage",
      }),
    ]);
    const sql = database.queries.at(-1)?.sql ?? "";
    expect(sql).toContain("CASE p.code");
    expect(sql).toContain("r.status='active'");
    expect(sql).not.toContain("membership_permission_overrides");
    expect(sql).not.toContain("membership_roles");
  });

  it("grants protected positions the complete runtime marker", async () => {
    database.setPositionCode("BOSS");
    await expect(listActiveOrganizationAssignees("org-a")).resolves.toEqual([
      expect.objectContaining({ permission_codes: "*" }),
    ]);
  });

  it("requires one granted permission from every runtime alternative group", () => {
    const requirements = [
      ["order.module.review.manage"],
      ["billing.expense.approve", "billing.manage"],
    ];
    expect(satisfiesOrganizationAssigneePermissionRequirements(
      ["order.module.review.manage", "billing.expense.approve"], requirements,
    )).toBe(true);
    expect(satisfiesOrganizationAssigneePermissionRequirements(
      ["order.module.review.manage"], requirements,
    )).toBe(false);
    expect(satisfiesOrganizationAssigneePermissionRequirements(["*"], requirements)).toBe(true);
  });
});
