import { describe, expect, it } from "vitest";
import { warehouseOutboundRemediations } from "./warehouse-outbound-remediation";

const base = {
  orderId: "order-1",
  transportBatchId: null,
  retryHref: "/warehouse/outbound?view=create&batchId=batch-1",
};

describe("warehouseOutboundRemediations", () => {
  it("routes a domestic transport blocker to the domestic transport module", () => {
    const [target] = warehouseOutboundRemediations({
      ...base,
      reasons: ["国内运输安排缺少必填信息：国内车牌号"],
    });
    expect(target.key).toBe("domestic-transport");
    expect(target.href).toContain("/modules/transport");
  });

  it("routes an unplanned LTL order to consolidation and preserves return path", () => {
    const [target] = warehouseOutboundRemediations({
      ...base,
      reasons: ["零担订单尚未生成配载批次"],
    });
    expect(target.key).toBe("create-loading-batch");
    expect(target.href).toContain("/warehouse/consolidation?");
    expect(target.href).toContain("returnTo=");
  });

  it("opens the existing loading batch when a batch-level field is missing", () => {
    const [target] = warehouseOutboundRemediations({
      ...base,
      transportBatchId: "batch-pz-1",
      reasons: ["配载批次尚未确定计划出境发车时间"],
    });
    expect(target.href).toBe("/admin/loading/batch-pz-1");
  });

  it("deduplicates multiple missing route fields into one repair portal", () => {
    const targets = warehouseOutboundRemediations({
      ...base,
      reasons: ["订单尚未确定出境口岸", "订单尚未确定境外目的仓"],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].key).toBe("order-route");
  });
});
