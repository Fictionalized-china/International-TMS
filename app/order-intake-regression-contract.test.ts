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

  it("loads an order by any active inbound mark and counts the first scan", () => {
    expect(warehouseAcceptanceRoute).toContain("FROM order_cargo_packages scanned_mark");
    expect(warehouseAcceptanceRoute).toContain("UPPER(scanned_mark.package_code)=UPPER(?)");
    expect(warehouseAcceptanceRoute).toContain("initialScannedMarkCode = referencedMark.package_code.toUpperCase()");
    expect(warehouseAcceptanceRoute).toContain("loaderData.initialScannedMarkCode ? [loaderData.initialScannedMarkCode] : []");
    expect(warehouseAcceptanceRoute).toContain('inputLabel="扫描入仓唛头 / 订单号"');
    expect(warehouseAcceptanceRoute).toContain("handleMarkInputChange");
    expect(warehouseAcceptanceRoute).toContain("系统识别完整唛头后自动登记，无需点击按钮");
    expect(warehouseAcceptanceRoute).not.toContain(">加入本批</button>");
    expect(warehouseAcceptanceRoute).toContain("本单不支持分批入库");
    expect(warehouseAcceptanceRoute).toContain("showPartial={false}");
  });
});
