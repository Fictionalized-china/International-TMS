import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const queries: Array<{ sql: string; bindings: unknown[] }> = [];
  let validUserIds = new Set(["user-a3"]);

  return {
    queries,
    setValidUserIds(userIds: string[]) {
      validUserIds = new Set(userIds);
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
                return validUserIds.has(String(bindings[1])) ? { ok: 1 } : null;
              },
              async all<T>() {
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
  isActiveOrganizationAssignee,
  isActiveOrganizationAssigneeForPositions,
  listActiveOrganizationAssigneeIds,
  requireActiveOrganizationAssignee,
} from "./organization-assignee.server";

describe("organization assignee server guard", () => {
  beforeEach(() => {
    database.queries.length = 0;
    database.setValidUserIds(["user-a3"]);
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
});
