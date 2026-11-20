import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adminLoading = readFileSync(new URL("./routes/admin.loading.tsx", import.meta.url), "utf8");
const planningService = readFileSync(new URL("./lib/loading-batch-planning.server.ts", import.meta.url), "utf8");
const warehouseConsolidation = readFileSync(new URL("./routes/warehouse.cargo-consolidation.tsx", import.meta.url), "utf8");
const positionPortal = readFileSync(new URL("./lib/position-portal.ts", import.meta.url), "utf8");

describe("loading responsibility contract", () => {
  it("lets only the operation supervisor create a loading plan", () => {
    expect(adminLoading).toContain('requireSessionUser(request, "transport.batch.plan")');
    expect(adminLoading).toContain('valueOf(form, "intent") !== "create_batch"');
    expect(planningService).toContain("拼车配载至少选择 2 票订单");
    expect(planningService).toContain("所选订单必须已指派同一操作主管");
  });

  it("creates the PZ before commercial vehicle search and limits warehouse execution", () => {
    expect(planningService).toContain("first.warehouse_id,null,input.current.userId");
    expect(planningService).toContain('null,null,null,"submitted"');
    expect(positionPortal).toContain("生成配载单");
    expect(positionPortal).toContain("办理整批配载单找车");
  });

  it("keeps the warehouse endpoint execution-only", () => {
    expect(warehouseConsolidation).toContain('["create","add","remove","cancel","resource","resubmit"].includes(intent)');
    expect(warehouseConsolidation).toContain("仓库端只执行收货、装车、扫描和出库");
    expect(warehouseConsolidation).toContain("仓库不再决定订单组合或运输资源");
  });

  it("revalidates frozen workflow readiness and concurrent occupancy on submit", () => {
    expect(planningService).toContain("loadLoadingConsolidationWorkflowAccesses");
    expect(planningService).toContain("loadingConsolidationCandidateBlockers");
    expect(planningService).toContain("transport_batch_package_claims");
    expect(planningService).toContain("INSERT INTO transport_batch_packages");
    expect(planningService).toContain("部分订单已不满足配载条件");
  });
});
