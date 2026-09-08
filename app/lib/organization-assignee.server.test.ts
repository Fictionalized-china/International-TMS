import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const queries: Array<{ sql: string; bindings: unknown[] }> = [];
  let validUserIds = new Set(["user-a3"]);
  let grantedCodes = ["order.module.transport.manage"];
  let memberQueryError: Error | null = null;
  const memberRows = [{
    id: "user-a3",
    display_name: "Operator A3",
    department_id: "department-operation",
    department_code: "OPERATION",
    department_name: "操作部",
    position_id: "position-operation",
    position_code: "OPERATION",
    position_name: "操作岗",
    permission_codes: "order.module.transport.manage",
  }];

  return {
    queries,
    setValidUserIds(userIds: string[]) {
      validUserIds = new Set(userIds);
    },
    setGrantedCodes(codes: string[]) {
      grantedCodes = codes;
    },
    setMemberQueryError(error: Error | null) {
      memberQueryError = error;
    },
    DB: {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
        queries.push(query);
        return {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return {
              async first() {
                if (sql.includes("SELECT m.id membership_id")) {
                  return validUserIds.has(String(bindings[1])) ? { membership_id: "membership-a3" } : null;
                }
                return validUserIds.has(String(bindings[1])) ? { ok: 1 } : null;
              },
              async all<T>() {
                if (sql.includes("GROUP_CONCAT(DISTINCT effective_permission.code)")) {
                  if (memberQueryError) throw memberQueryError;
                  return { results: memberRows as T[] };
                }
                if (sql.includes("GROUP_CONCAT(DISTINCT legacy_permission.code)")) {
                  return { results: memberRows as T[] };
                }
                if (sql.includes("SELECT DISTINCT effective.code")) {
                  return { results: grantedCodes.map((code) => ({ code })) as T[] };
                }
                return {
                  results: [...validUserIds].map((id) => ({ id })) as T[],
                };
              },
            };
          },
        };
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
    database.setGrantedCodes(["order.module.transport.manage"]);
    database.setMemberQueryError(null);
  });

  it("accepts only an active personal account attached to a matching department and position", async () => {
    await expect(isActiveOrganizationAssignee("org-a", "user-a3")).resolves.toBe(true);
    await expect(isActiveOrganizationAssignee("org-a", "user-missing")).resolves.toBe(false);

    expect(database.queries[0].sql).toContain("JOIN departments");
    expect(database.queries[0].sql).toContain("JOIN positions");
    expect(database.queries[0].sql).toContain("p.department_code=d.code");
    expect(database.queries[0].bindings).toEqual(["org-a", "user-a3"]);
  });

  it("returns only concrete assignable account ids and rejects invalid submissions", async () => {
    await expect(listActiveOrganizationAssigneeIds("org-a")).resolves.toEqual(
      new Set(["user-a3"]),
    );
    await expect(requireActiveOrganizationAssignee("org-a", "user-a3")).resolves.toBeUndefined();
    await expect(
      requireActiveOrganizationAssignee("org-a", "user-missing"),
    ).rejects.toThrow("请选择部门、岗位下的有效个人账户");
  });

  it("can restrict an assignee to one or more position codes", async () => {
    await expect(
      isActiveOrganizationAssigneeForPositions("org-a", "user-a3", ["OPERATION"]),
    ).resolves.toBe(true);
    expect(database.queries.at(-1)?.sql).toContain("p.code IN (?)");
    expect(database.queries.at(-1)?.bindings).toEqual(["org-a", "user-a3", "OPERATION"]);
  });

  it("validates a frozen-node assignee from position inheritance", async () => {
    await expect(isActiveOrganizationAssigneeForWorkflowNodes({
      organizationId: "org-a",
      userId: "user-a3",
      responsibilityPositionCode: "OPERATION",
      nodes: [{ stepKey: "domestic_execution", moduleCode: "transport" }],
    })).resolves.toBe(true);
    expect(database.queries.at(-1)?.sql).toContain("membership_workflow_access_overrides");
  });

  it("applies personal deny-aware effective permissions after the position check", async () => {
    await expect(isActiveOrganizationAssigneeForPositions(
      "org-a",
      "user-a3",
      ["OPERATION"],
      [["order.module.transport.manage"], ["order.module.exceptions.manage"]],
    )).resolves.toBe(false);

    database.setGrantedCodes([
      "order.module.transport.manage",
      "order.module.exceptions.manage",
    ]);
    await expect(isActiveOrganizationAssigneeForPositions(
      "org-a",
      "user-a3",
      ["OPERATION"],
      [["order.module.transport.manage"], ["order.module.exceptions.manage"]],
    )).resolves.toBe(true);
    expect(database.queries.at(-1)?.sql).toContain("denied.effect='deny'");
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

  it("仅在个人权限覆盖表缺失时回落旧角色权限候选查询", async () => {
    database.setMemberQueryError(
      new Error("D1_ERROR: no such table: membership_permission_overrides"),
    );

    await expect(listActiveOrganizationAssignees("org-a")).resolves.toEqual([
      expect.objectContaining({ id: "user-a3", position_code: "OPERATION" }),
    ]);
    const memberQueries = database.queries.filter((query) =>
      query.sql.includes("GROUP_CONCAT(DISTINCT"),
    );
    expect(memberQueries).toHaveLength(2);
    expect(memberQueries[0].sql).toContain("membership_permission_overrides");
    expect(memberQueries[1].sql).not.toContain("membership_permission_overrides");
  });

  it("候选查询的非缺表异常不降级且继续抛出", async () => {
    database.setMemberQueryError(new Error("D1_ERROR: database unavailable"));

    await expect(listActiveOrganizationAssignees("org-a"))
      .rejects.toThrow("database unavailable");
    expect(database.queries.filter((query) =>
      query.sql.includes("GROUP_CONCAT(DISTINCT"),
    )).toHaveLength(1);
  });
});
