import { describe, expect, it } from "vitest";
import {
  normalizeWorkbenchSelection,
  validateWorkbenchBatch,
  type WorkbenchBatchCandidate,
} from "./workbench-batch";

const base: WorkbenchBatchCandidate = {
  row_id: "m1",
  order_id: "o1",
  order_number: "ITMS-001",
  customer_name: "测试客户",
  module_code: "customs",
  module_name: "报关",
  enabled: 1,
  module_status: "not_started",
  order_status: "approved",
  assignee_user_id: null,
  assignee_name: null,
};

describe("workbench batch validation", () => {
  it("deduplicates selected records and enforces the limit", () => {
    expect(normalizeWorkbenchSelection(["m1", "m1", " m2 "])).toEqual([
      "m1",
      "m2",
    ]);
    expect(() => normalizeWorkbenchSelection(["m1", "m2"], 1)).toThrow(
      "每次最多处理 1 条记录",
    );
  });

  it("allows an unassigned active module in its workspace", () => {
    const [result] = validateWorkbenchBatch(
      ["m1"],
      [base],
      "customs",
      "u1",
    );
    expect(result).toMatchObject({ eligible: true, reason: "可以领取" });
  });

  it("rejects cross-workspace, completed and assigned records separately", () => {
    const candidates = [
      { ...base, row_id: "wrong", module_code: "documents" },
      { ...base, row_id: "done", module_status: "completed" },
      {
        ...base,
        row_id: "owned",
        assignee_user_id: "u2",
        assignee_name: "张三",
      },
    ];
    const results = validateWorkbenchBatch(
      ["wrong", "done", "owned", "missing"],
      candidates,
      "customs",
      "u1",
    );
    expect(results.map((result) => result.reason)).toEqual([
      "记录不属于当前工作台",
      "模块已经完成或不适用",
      "已由张三负责",
      "记录不存在或已不属于当前组织",
    ]);
  });
});
