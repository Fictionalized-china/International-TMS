import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  DB: {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM transport_orders o")) {
                return {
                  id: "order-1",
                  order_number: "SO-1",
                  status: "confirmed",
                  current_step_code: "task_assignment",
                  current_assignee_user_id: "supervisor-1",
                  salesperson_user_id: "sales-1",
                  shipper_name: "shipper",
                  shipper_contact: null,
                  shipper_phone: null,
                  consignee_name: "consignee",
                  origin_city: "深圳",
                  origin_address: "深圳",
                  destination_city: "塔什干",
                  destination_address: "塔什干",
                  cargo_description: "cargo",
                  transport_mode: "road",
                  requested_pickup_date: null,
                  exit_port: "PORT-1",
                  overseas_warehouse_id: "warehouse-1",
                  border_port_valid: 1,
                  overseas_warehouse_valid: 1,
                };
              }
              if (sql.includes("FROM order_workflow_transitions")) {
                return {
                  action_code: "dispatch",
                  action_name: "确认派单",
                  from_status: "confirmed",
                  to_status: "in_execution",
                  target_step_code: "domestic_transport",
                  target_step_name: "国内运输",
                  requires_assignee: 1,
                  sort_order: 30,
                };
              }
              if (sql.includes("FROM memberships m")) return { code: "OPERATION_SUPERVISOR" };
              if (sql.includes("module_code='assignment'")) {
                return {
                  assignee_user_id: "next-user",
                  status: "pending",
                  enabled: 1,
                  is_required: 1,
                };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database,
}));

const assignees = vi.hoisted(() => ({
  active: vi.fn(async () => true),
  activeForPositions: vi.fn(async () => true),
}));
const dispatchPolicy = vi.hoisted(() => ({
  load: vi.fn(async () => ({
    source: "workflow_instance" as "workflow_instance" | "legacy",
    workflowInstanceId: "workflow-instance-1" as string | null,
    groupKey: "position:DOC" as string | null,
    positionCode: "DOC",
  })),
}));

vi.mock("cloudflare:workers", () => ({ env: { DB: database.DB } }));
vi.mock("./order-modules.server", () => ({
  ensureOrderModules: vi.fn(async () => undefined),
  syncOrderWorkflowSnapshot: vi.fn(async () => undefined),
}));
vi.mock("./workflow-fields.server", () => ({
  missingRequiredWorkflowStepFields: vi.fn(async () => []),
}));
vi.mock("./order-workflow", () => ({
  assignmentModuleBlocksDispatch: vi.fn(() => true),
  canRunOrderWorkflowAction: vi.fn(() => true),
  shouldRefreshOrderModulesBeforeWorkflowGate: vi.fn(() => false),
}));
vi.mock("./organization-assignee.server", () => ({
  isActiveOrganizationAssignee: assignees.active,
  isActiveOrganizationAssigneeForPositions: assignees.activeForPositions,
}));
vi.mock("./order-assignment-manifest.server", () => ({
  loadOrderDispatchResponsibilityPolicy: dispatchPolicy.load,
}));

import { validateOrderWorkflowAction } from "./order-workflow.server";

const input = {
  organizationId: "organization-1",
  orderId: "order-1",
  actionCode: "dispatch",
  actorUserId: "supervisor-1",
  assigneeUserId: "next-user",
  allowPendingAssignment: true,
};

describe("order workflow dispatch responsibility", () => {
  beforeEach(() => {
    assignees.active.mockClear();
    assignees.activeForPositions.mockReset();
    assignees.activeForPositions.mockResolvedValue(true);
    dispatchPolicy.load.mockReset();
    dispatchPolicy.load.mockResolvedValue({
      source: "workflow_instance",
      workflowInstanceId: "workflow-instance-1",
      groupKey: "position:DOC",
      positionCode: "DOC",
    });
  });

  it("validates dispatch against the first required position from the frozen instance", async () => {
    await expect(validateOrderWorkflowAction(input)).resolves.toMatchObject({ ok: true });

    expect(dispatchPolicy.load).toHaveBeenCalledWith("organization-1", "order-1");
    expect(assignees.activeForPositions).toHaveBeenCalledWith(
      "organization-1",
      "next-user",
      ["DOC"],
    );
  });

  it("reports the frozen position in the gate when the selected user is invalid", async () => {
    assignees.activeForPositions.mockResolvedValueOnce(false);

    await expect(validateOrderWorkflowAction(input)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("锁定工作流首个必办岗位（DOC）"),
    });
  });

  it("uses OPERATION only for an order explicitly identified as legacy", async () => {
    dispatchPolicy.load.mockResolvedValueOnce({
      source: "legacy",
      workflowInstanceId: null,
      groupKey: null,
      positionCode: "OPERATION",
    });

    await expect(validateOrderWorkflowAction(input)).resolves.toMatchObject({ ok: true });
    expect(assignees.activeForPositions).toHaveBeenCalledWith(
      "organization-1",
      "next-user",
      ["OPERATION"],
    );
  });
});
