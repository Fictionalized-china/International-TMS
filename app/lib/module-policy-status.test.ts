import { describe, expect, it } from "vitest";
import {
  documentRequirementBlockerPrefix,
  reconcileDocumentsModuleState,
  reconcileWorkflowFieldBlocker,
} from "./module-policy-status";

describe("workflow field blocker reconciliation", () => {
  it("clears only a system-owned missing-field blocker after required becomes optional", () => {
    expect(reconcileWorkflowFieldBlocker({
      status: "blocked",
      blockingReason: "请先补齐必填字段：委托书",
      startedAt: "2026-09-01T10:00:00.000Z",
      missingLabels: [],
    })).toEqual({ status: "in_progress", blockingReason: null, changed: true });
  });

  it("preserves a manual or warehouse exception while field policy changes", () => {
    expect(reconcileWorkflowFieldBlocker({
      status: "blocked",
      blockingReason: "仓库验收发现外包装破损",
      startedAt: null,
      missingLabels: ["委托书"],
    })).toEqual({
      status: "blocked",
      blockingReason: "仓库验收发现外包装破损",
      changed: false,
    });
  });

  it("creates a deterministic blocker when optional becomes required and data is missing", () => {
    expect(reconcileWorkflowFieldBlocker({
      status: "not_started",
      blockingReason: null,
      startedAt: null,
      missingLabels: ["委托书", "客户代号"],
    })).toEqual({
      status: "blocked",
      blockingReason: "请先补齐必填字段：委托书、客户代号",
      changed: true,
    });
  });

  it("does not reopen a completed historical module fact", () => {
    expect(reconcileWorkflowFieldBlocker({
      status: "completed",
      blockingReason: null,
      startedAt: "2026-09-01T10:00:00.000Z",
      missingLabels: ["委托书"],
    })).toEqual({ status: "completed", blockingReason: null, changed: false });
  });

  it("uses a supplement blocker without rolling back the historical step", () => {
    expect(reconcileWorkflowFieldBlocker({
      status: "in_progress",
      blockingReason: null,
      startedAt: "2026-09-01T10:00:00.000Z",
      missingLabels: ["委托书"],
      blockerPrefix: "待补录必填字段：",
    })).toMatchObject({
      status: "blocked",
      blockingReason: "待补录必填字段：委托书",
    });
  });
});

describe("documents aggregate reconciliation", () => {
  it("marks required documents ready even when an optional upload is pending review", () => {
    expect(reconcileDocumentsModuleState({
      status: "in_progress",
      blockingReason: `${documentRequirementBlockerPrefix}商业发票`,
      requiredLabels: ["委托书"],
      incompleteLabels: [],
      optionalPendingLabels: ["报关单 / 预录报关单"],
    })).toMatchObject({
      status: "completed",
      blockingReason: null,
      complete: true,
      stepName: "必填资料齐全，选填文件待审",
    });
  });

  it("clears a legacy workflow-field blocker after required document approval", () => {
    expect(reconcileDocumentsModuleState({
      status: "blocked",
      blockingReason: "请先补齐必填字段：委托书",
      requiredLabels: ["委托书"],
      incompleteLabels: [],
      optionalPendingLabels: [],
    })).toMatchObject({
      status: "completed",
      blockingReason: null,
      complete: true,
    });
  });

  it("blocks only on incomplete required documents", () => {
    expect(reconcileDocumentsModuleState({
      status: "in_progress",
      blockingReason: null,
      requiredLabels: ["委托书", "商业发票"],
      incompleteLabels: ["商业发票"],
      optionalPendingLabels: ["合同"],
    })).toMatchObject({
      status: "blocked",
      blockingReason: `${documentRequirementBlockerPrefix}商业发票`,
      complete: false,
    });
  });

  it("does not overwrite an exception blocker owned by another subsystem", () => {
    expect(reconcileDocumentsModuleState({
      status: "blocked",
      blockingReason: "仓库异常：货物短少",
      requiredLabels: ["委托书"],
      incompleteLabels: [],
      optionalPendingLabels: [],
    })).toEqual({
      status: "blocked",
      blockingReason: "仓库异常：货物短少",
      stepCode: null,
      stepName: null,
      progress: null,
      complete: false,
      changed: false,
    });
  });
});
