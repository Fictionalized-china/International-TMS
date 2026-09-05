import { describe, expect, it } from "vitest";
import {
  loadingConsolidationCandidateBlockers,
  loadingConsolidationStageAccess,
} from "./loading-consolidation-stage-gate";

describe("loading consolidation frozen-stage gate", () => {
  it("keeps consolidation closed while a custom predecessor is current", () => {
    expect(loadingConsolidationStageAccess({
      currentStepKey: "custom_precheck",
      steps: [
        { stepKey: "custom_precheck", stepName: "装车前复核", sortOrder: 10 },
        { stepKey: "custom_loading", stepName: "自定义装车", sortOrder: 20 },
      ],
      loadingStepKeys: ["custom_loading"],
    })).toEqual({
      available: false,
      targetStepKey: "custom_loading",
      targetStepName: "自定义装车",
      reason: "当前处于“装车前复核”，进入“自定义装车”后开放货物配载",
    });
  });

  it("opens only when the dynamically placed loading step becomes current", () => {
    expect(loadingConsolidationStageAccess({
      currentStepKey: "custom_loading",
      steps: [
        { stepKey: "custom_precheck", stepName: "装车前复核", sortOrder: 10 },
        { stepKey: "custom_loading", stepName: "自定义装车", sortOrder: 20 },
      ],
      loadingStepKeys: ["custom_loading"],
    })).toEqual({
      available: true,
      targetStepKey: "custom_loading",
      targetStepName: "自定义装车",
      reason: null,
    });
  });

  it("fails closed when the frozen workflow hides the loading module", () => {
    expect(loadingConsolidationStageAccess({
      currentStepKey: "custom_precheck",
      steps: [
        { stepKey: "custom_precheck", stepName: "装车前复核", sortOrder: 10 },
      ],
      loadingStepKeys: [],
    })).toEqual({
      available: false,
      targetStepKey: null,
      targetStepName: null,
      reason: "当前冻结工作流未启用装车与出库模块，不能生成配载单",
    });
  });

  it("does not reopen consolidation after the loading placement has passed", () => {
    expect(loadingConsolidationStageAccess({
      currentStepKey: "customs",
      steps: [
        { stepKey: "custom_loading", stepName: "自定义装车", sortOrder: 20 },
        { stepKey: "customs", stepName: "报关", sortOrder: 30 },
      ],
      loadingStepKeys: ["custom_loading"],
    })).toEqual({
      available: false,
      targetStepKey: "custom_loading",
      targetStepName: "自定义装车",
      reason: "“自定义装车”办理节点已结束，不能重新生成配载单",
    });
  });

  it("returns the exact workflow blocker used by both the list and submit action", () => {
    const reason = "当前处于“装车前复核”，进入“自定义装车”后开放货物配载";
    expect(loadingConsolidationCandidateBlockers({
      business_type: "ltl",
      package_count: 1,
      cargo_ready: 1,
      has_exception: 0,
      active_dispatch: 0,
      active_batch_id: null,
      active_batch_number: null,
      overseas_warehouse_id: "overseas-1",
    }, {
      available: false,
      reason,
    })).toEqual([reason]);
    expect(loadingConsolidationCandidateBlockers({
      business_type: "ltl",
      package_count: 1,
      cargo_ready: 1,
      has_exception: 0,
      active_dispatch: 0,
      active_batch_id: null,
      active_batch_number: null,
      overseas_warehouse_id: "overseas-1",
    }, undefined)).toEqual([
      "无法确认订单当前冻结工作流是否允许配载，请刷新后重试",
    ]);
  });
});
