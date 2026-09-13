import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orderModuleRoute = readFileSync(
  new URL("./routes/admin.order-module.tsx", import.meta.url),
  "utf8",
);
const warehouseAcceptanceRoute = readFileSync(
  new URL("./routes/warehouse.acceptance.tsx", import.meta.url),
  "utf8",
);

describe("order intake regression contract", () => {
  it("offers approval and return while routing returns to the bound salesperson", () => {
    expect(orderModuleRoute).toContain('<option value="reject">打回</option>');
    expect(orderModuleRoute).toContain('actionCode === "reject"\n      ? order.salesperson_user_id');
    expect(orderModuleRoute).toContain("退回后恢复资料编辑，由原业务员补充并重新提交审批");
    expect(orderModuleRoute).toContain("请填写至少 2 个字符的打回原因");
  });

  it("formats per-package weights to two decimal places", () => {
    expect(orderModuleRoute).toContain("item.gross_weight_per_package_kg.toFixed(2)");
    expect(orderModuleRoute).toContain("item.net_weight_per_package_kg.toFixed(2)");
  });

  it("does not present the package-row fallback as a warehouse piece count", () => {
    expect(orderModuleRoute).toContain("NULLIF(SUM(r.total_pieces),0)");
    expect(orderModuleRoute).toContain('<td>未统计</td>');
    expect(orderModuleRoute).toContain("仓库未清点的商品件数显示为“未统计”");
  });

  it("identifies any active inbound mark from the unified warehouse scanner", () => {
    expect(warehouseAcceptanceRoute).toContain("FROM order_cargo_packages scanned_mark");
    expect(warehouseAcceptanceRoute).toContain("UPPER(scanned_mark.package_code)=UPPER(?)");
    expect(warehouseAcceptanceRoute).toContain('scanFetcher.submit({intent:"scan_mark"');
    expect(warehouseAcceptanceRoute).toContain('code,requestKey:crypto.randomUUID()');
    expect(warehouseAcceptanceRoute).toContain("仓库统一扫描栏");
    expect(warehouseAcceptanceRoute).toContain("同一个扫描栏服务当前仓库全部订单");
    expect(warehouseAcceptanceRoute).toContain("扫描成功，已归入");
    expect(warehouseAcceptanceRoute).not.toContain(">加入本批</button>");
    expect(warehouseAcceptanceRoute).toContain("入仓包装数按唛头扫描累计");
    expect(warehouseAcceptanceRoute).toContain("showPartial={false}");
  });
});
