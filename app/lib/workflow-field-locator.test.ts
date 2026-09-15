import { describe, expect, it } from "vitest";
import {
  filterWorkflowFieldLocatorItems,
  workflowFieldConfigurationHref,
  workflowFieldIdentityMatches,
  type WorkflowFieldLocatorItem,
} from "./workflow-field-locator";

const fields: WorkflowFieldLocatorItem[] = [
  {
    id: "field-1",
    label: "二次核验结论",
    fieldKey: "e2e_secondary_review_result",
    moduleLabel: "委托信息",
    stepId: "step-2",
    stepName: "资料二次核验",
    modeLabel: "必填",
  },
  {
    id: "field-2",
    label: "客户单号",
    fieldKey: "customer_reference",
    moduleLabel: "委托信息",
    stepId: "step-1",
    stepName: "委托资料补充",
    modeLabel: "隐藏",
  },
];

describe("workflow field locator", () => {
  it("finds a field by label, code or source node", () => {
    expect(filterWorkflowFieldLocatorItems(fields, "二次核验").map((item) => item.id)).toEqual(["field-1"]);
    expect(filterWorkflowFieldLocatorItems(fields, "customer_reference").map((item) => item.id)).toEqual(["field-2"]);
    expect(filterWorkflowFieldLocatorItems(fields, "资料二次核验 必填").map((item) => item.id)).toEqual(["field-1"]);
  });

  it("builds an exact workflow and field configuration link", () => {
    expect(workflowFieldConfigurationHref({
      workflowId: "workflow 1",
      stepKey: "custom_step",
      moduleCode: "consignment",
      fieldKey: "field/2",
    })).toBe(
      "/admin/workflow?workflowId=workflow+1&stepKey=custom_step&moduleCode=consignment&fieldKey=field%2F2",
    );
  });

  it("matches a snapshot field to its template field by stable business identity", () => {
    expect(workflowFieldIdentityMatches(
      { stepKey: "custom_step", moduleCode: "consignment", fieldKey: "secondary_review" },
      { stepKey: "custom_step", moduleCode: "consignment", fieldKey: "secondary_review" },
    )).toBe(true);
    expect(workflowFieldIdentityMatches(
      { stepKey: "order_creation", moduleCode: "consignment", fieldKey: "secondary_review" },
      { stepKey: "custom_step", moduleCode: "consignment", fieldKey: "secondary_review" },
    )).toBe(false);
  });
});
