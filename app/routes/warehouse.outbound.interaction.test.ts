import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import * as outboundRoute from "./warehouse.outbound";

type OutboundRouteTestExports = {
  warehouseDispatchCompletionResult?: (input: {
    dispatchNumber: string;
    businessType: string;
    completionWarningText: string;
  }) => Record<string, unknown>;
  OutboundBarcodeInput?: (props: { busy: boolean }) => ReactElement;
};

const testExports = outboundRoute as typeof outboundRoute & OutboundRouteTestExports;

describe("warehouse outbound interaction safety", () => {
  it("returns FTL dispatch success without requesting an automatic native print dialog", () => {
    expect(testExports.warehouseDispatchCompletionResult).toBeTypeOf("function");

    const result = testExports.warehouseDispatchCompletionResult?.({
      dispatchNumber: "OUT-001",
      businessType: "ftl",
      completionWarningText: "",
    });

    expect(result).toEqual({
      success: "OUT-001 已完成整车装车出库交接，车辆与司机信息已同步管理端；后续由订单的报关及出境运输节点确认实际出境",
    });
    expect(result).not.toHaveProperty("printHandoverSignal");
  });

  it("locks the barcode input while the previous scan submission is revalidating", () => {
    expect(testExports.OutboundBarcodeInput).toBeTypeOf("function");

    const busyMarkup = renderToStaticMarkup(
      testExports.OutboundBarcodeInput?.({ busy: true }) as ReactElement,
    );
    const idleMarkup = renderToStaticMarkup(
      testExports.OutboundBarcodeInput?.({ busy: false }) as ReactElement,
    );

    expect(busyMarkup).toContain("disabled");
    expect(idleMarkup).not.toContain("disabled");
  });
});
