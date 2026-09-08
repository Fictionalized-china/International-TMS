import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const state = {
    module: null as null | {
      enabled: number;
      assignee_user_id: string | null;
      workflow_instance_id: string | null;
      matched_instance_id: string | null;
    },
    workflowModule: null as null | {
      id: string;
      step_key: string;
      responsibility_position_code: string | null;
    },
    tasks: [] as Array<{
      assignee_user_id: string | null;
      responsibility_position_code: string | null;
    }>,
    queries: [] as string[],
  };
  const DB = {
    prepare(sql: string) {
      state.queries.push(sql);
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM order_module_instances m"))
                return state.module;
              if (sql.includes("FROM workflow_instances wi"))
                return state.workflowModule;
              return null;
            },
            async all() {
              if (sql.includes("FROM workflow_instance_task_states"))
                return { results: state.tasks };
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { DB, state };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));

import { loadOrderModuleActionScope } from "./order-modules.server";

describe("order module action scope", () => {
  beforeEach(() => {
    database.state.queries = [];
    database.state.module = {
      enabled: 1,
      assignee_user_id: null,
      workflow_instance_id: "workflow-instance-1",
      matched_instance_id: "workflow-instance-1",
    };
    database.state.workflowModule = {
      id: "review-module-state",
      step_key: "completion_review",
      responsibility_position_code: "FINANCE_ACCOUNTING",
    };
    database.state.tasks = [];
  });

  it("takes enablement, ownership and responsibility from the frozen instance", async () => {
    database.state.module = {
      enabled: 0,
      assignee_user_id: "finance-user",
      workflow_instance_id: "workflow-instance-1",
      matched_instance_id: "workflow-instance-1",
    };
    database.state.tasks = [
      {
        assignee_user_id: "finance-user",
        responsibility_position_code: "FINANCE_ACCOUNTING",
      },
    ];

    await expect(loadOrderModuleActionScope(
      "organization-1",
      "order-1",
      "review",
    )).resolves.toEqual({
      moduleCode: "review",
      stepKey: "completion_review",
      enabled: true,
      assigneeUserId: "finance-user",
      taskAssigneeUserIds: ["finance-user"],
      responsibilityPositionCodes: ["FINANCE_ACCOUNTING"],
    });
    expect(database.state.queries.find((sql) =>
      sql.includes("JOIN workflow_instance_module_states ms"),
    )).toContain("LEFT JOIN workflow_instance_step_states current_ss");
  });

  it("does not let a mutable module flag enable a module absent from the frozen instance", async () => {
    database.state.workflowModule = null;

    await expect(loadOrderModuleActionScope(
      "organization-1",
      "order-1",
      "review",
    )).resolves.toMatchObject({ enabled: false });
  });

  it("keeps the stored module flag only as a legacy fallback without an instance", async () => {
    database.state.module = {
      enabled: 1,
      assignee_user_id: null,
      workflow_instance_id: null,
      matched_instance_id: null,
    };
    database.state.workflowModule = null;

    await expect(loadOrderModuleActionScope(
      "organization-1",
      "order-1",
      "exceptions",
    )).resolves.toMatchObject({ enabled: true });
  });

  it("fails closed instead of resolving another order's frozen instance", async () => {
    database.state.module = {
      enabled: 1,
      assignee_user_id: "foreign-owner",
      workflow_instance_id: "foreign-instance",
      matched_instance_id: null,
    };

    await expect(loadOrderModuleActionScope(
      "organization-1",
      "order-1",
      "review",
    )).resolves.toEqual({
      moduleCode: "review",
      stepKey: null,
      enabled: false,
      assigneeUserId: null,
      taskAssigneeUserIds: [],
      responsibilityPositionCodes: [],
    });
    expect(database.state.queries.join("\n")).toContain("wi.order_id=o.id");
  });
});
