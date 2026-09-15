import { beforeEach, describe, expect, it } from "vitest";
import { loadOrderDocumentWorkflowMutationAccess } from "./order-document-access.server";

function database(input: {
  status?: string;
  currentStepKey?: string;
  fieldActive?: number;
}) {
  const status = input.status ?? "in_execution";
  const currentStepKey = input.currentStepKey ?? "outbound_transport";
  const fieldActive = input.fieldActive ?? 1;
  return {
    prepare(query: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (query.includes("SELECT status FROM transport_orders")) {
            return { status };
          }
          if (query.includes("SELECT o.workflow_instance_id,wi.id matched_instance_id,wi.current_step_key")) {
            return {
              workflow_instance_id: "instance-1",
              matched_instance_id: "instance-1",
              current_step_key: currentStepKey,
            };
          }
          return null;
        },
        async all() {
          if (query.includes("FROM workflow_instance_step_states")) {
            return { results: [
              { step_key: "order_creation", step_name: "Order", sort_order: 10 },
              { step_key: "outbound_transport", step_name: "Outbound", sort_order: 20 },
            ] };
          }
          if (query.includes("FROM workflow_instance_module_states")) {
            return { results: [{ module_code: "customs", step_key: "outbound_transport" }] };
          }
          if (query.includes("FROM workflow_instance_fields")) {
            return { results: [{
              module_code: "customs",
              field_key: "document_commercial_invoice",
              step_key: "outbound_transport",
              is_active: fieldActive,
              is_required: 1,
            }] };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe("order document frozen mutation loader", () => {
  beforeEach(() => undefined);

  it("rejects a warehouse upload for a hidden frozen field", async () => {
    const access = await loadOrderDocumentWorkflowMutationAccess(
      database({ fieldActive: 0 }),
      "org-1",
      "order-1",
      "commercial_invoice",
    );
    expect(access).toMatchObject({
      allowed: false,
      visible: false,
      mode: "hidden",
      fieldKey: "document_commercial_invoice",
    });
  });

  it("rejects a visible field before its configured frozen node", async () => {
    const access = await loadOrderDocumentWorkflowMutationAccess(
      database({ currentStepKey: "order_creation" }),
      "org-1",
      "order-1",
      "commercial_invoice",
    );
    expect(access).toMatchObject({
      allowed: false,
      visible: true,
      mode: "required",
    });
  });

  it.each(["completed", "cancelled"])(
    "keeps a configured field read-only after the order is %s",
    async (status) => {
      const access = await loadOrderDocumentWorkflowMutationAccess(
        database({ status }),
        "org-1",
        "order-1",
        "commercial_invoice",
      );
      expect(access).toMatchObject({
        allowed: false,
        visible: true,
        mode: "required",
      });
      expect(access.reason).toContain("仅供查看");
    },
  );

  it("allows an active field after reaching its frozen node", async () => {
    const access = await loadOrderDocumentWorkflowMutationAccess(
      database({}),
      "org-1",
      "order-1",
      "commercial_invoice",
    );
    expect(access).toMatchObject({ allowed: true, visible: true });
  });
});
