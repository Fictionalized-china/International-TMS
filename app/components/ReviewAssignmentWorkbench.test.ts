import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewAssignmentWorkbench } from "./ReviewAssignmentWorkbench";

describe("same-page review and assignment", () => {
  it("shows approval and a locked assignment section before approval", () => {
    const html = renderToStaticMarkup(createElement(ReviewAssignmentWorkbench, {
      phase: "approval", children: createElement("form", { id: "approval-form" }),
    }));
    expect(html).toContain('id="approval-form"');
    expect(html).toContain("待审核通过后自动展开");
    expect(html).not.toContain('id="review-assignment-tasks"');
  });

  it("retains approval history while expanding assignment on the same page", () => {
    const html = renderToStaticMarkup(createElement(ReviewAssignmentWorkbench, {
      phase: "assignment",
      approvalRecord: { actor: "审核人", time: "2026/10/20", notes: "资料齐全" },
      children: createElement("form", { id: "assignment-form" }),
    }));
    expect(html).toContain("资料齐全");
    expect(html).toContain('id="review-assignment-tasks"');
    expect(html).toContain('id="assignment-form"');
    expect(html).not.toContain("任务分配暂未开放");
  });
});
