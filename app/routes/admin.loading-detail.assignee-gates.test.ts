import { beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS } from "../lib/batch-responsibility";

const harness = vi.hoisted(() => {
  const current = {
    organizationId: "org-1",
    userId: "supervisor-1",
    permissions: ["order.view", "transport.batch.approve"],
    positionCode: "OPERATION_SUPERVISOR",
    roleCodes: ["pos_operation_supervisor"],
  };
  const DB = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes("FROM transport_batches b WHERE b.id=?")) {
            return {
              id: "batch-1",
              batch_number: "PZ-20260906-001",
              status: "loading",
              road_status: "loading",
              border_port: null,
              customs_location: null,
              route_notes: null,
              warehouse_id: "warehouse-1",
              overseas_carrier_name: null,
              overseas_vehicle_type: null,
              overseas_vehicle_count: 0,
              overseas_vehicle_plate: null,
              overseas_driver_name: null,
              overseas_driver_phone: null,
            };
          }
          if (sql.startsWith("SELECT batch_number,approval_status")) {
            return {
              batch_number: "PZ-20260906-001",
              approval_status: "submitted",
              operation_supervisor_user_id: "supervisor-1",
              operation_assignee_user_id: null,
              document_assignee_user_id: null,
              responsibility_revision: null,
              actual_departure_at: null,
              road_status: "loading",
            };
          }
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
  };
  return {
    current,
    DB,
    requireSessionUser: vi.fn(async () => current),
    validateAssignee: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({ env: { DB: harness.DB } }));
vi.mock("../lib/auth.server", () => ({ requireSessionUser: harness.requireSessionUser }));
vi.mock("../lib/organization-assignee.server", () => ({
  isActiveOrganizationAssigneeForPositions: harness.validateAssignee,
}));

import { action } from "./admin.loading-detail";

function request() {
  return new Request("http://local.test/admin/loading/batch-1", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      intent: "batch_approve",
      operationAssigneeUserId: "operation-candidate",
      documentAssigneeUserId: "document-candidate",
    }),
  });
}

function runApproval() {
  return action({
    request: request(),
    params: { batchId: "batch-1" },
    context: undefined,
  } as never);
}

describe("PZ responsibility assignee capability gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the operation capability requirements in the POST guard", async () => {
    harness.validateAssignee.mockResolvedValueOnce(false);
    await expect(runApproval()).resolves.toEqual({ formError: expect.any(String) });
    expect(harness.validateAssignee).toHaveBeenNthCalledWith(
      1,
      "org-1",
      "operation-candidate",
      ["OPERATION"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.operation,
    );
  });

  it("uses the document capability requirements in the POST guard", async () => {
    harness.validateAssignee
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(runApproval()).resolves.toEqual({ formError: expect.any(String) });
    expect(harness.validateAssignee).toHaveBeenNthCalledWith(
      2,
      "org-1",
      "document-candidate",
      ["DOC"],
      BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.document,
    );
  });
});
