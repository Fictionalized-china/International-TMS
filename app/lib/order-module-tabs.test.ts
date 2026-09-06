import { describe, expect, it } from "vitest";
import { costsTabHasPendingAction, orderEntryPreference, orderModuleTabDescriptors, orderModuleTabHref, orderWorkflowModuleTabs, resolveCostsSection, resolveCustomsSection } from "./order-module-tabs";

describe("orderEntryPreference", () => {
  it("lands document handlers on customs files before declarations", () => {
    expect(orderEntryPreference("DOC")).toEqual({
      stepKey: "outbound_transport",
      moduleCode: "customs",
      section: "files",
    });
  });

  it("keeps the normal workflow landing target for other positions", () => {
    expect(orderEntryPreference("OPERATION")).toBeNull();
  });
});

describe("orderModuleTabHref", () => {
  it("builds an absolute section link so sibling tabs keep the order route", () => {
    expect(orderModuleTabHref({
      orderId: "order/1",
      stepKey: "reconciliation",
      moduleCode: "costs",
      section: "expenses",
    })).toBe("/admin/orders/order%2F1?stage=reconciliation&module=costs&section=expenses");
  });
});

describe("orderModuleTabDescriptors", () => {
  it("splits customs documents and declarations into sibling tabs", () => {
    expect(orderModuleTabDescriptors({
      key: "customs-row",
      moduleCode: "customs",
      moduleName: "报关作业",
    })).toEqual([
      { key: "customs-row:files", label: "报关文件", moduleCode: "customs", section: "files" },
      { key: "customs-row:declarations", label: "报关单", moduleCode: "customs", section: "declarations" },
    ]);
  });

  it("keeps other workflow modules as one tab", () => {
    expect(orderModuleTabDescriptors({
      key: "tracking-row",
      moduleCode: "tracking",
      moduleName: "运输执行与跟踪",
    })).toEqual([
      { key: "tracking-row", label: "运输执行与跟踪", moduleCode: "tracking", section: null },
    ]);
  });

  it("splits settlement documents and expenses into sibling tabs", () => {
    expect(orderModuleTabDescriptors({
      key: "costs-row",
      moduleCode: "costs",
      moduleName: "对账结算",
    })).toEqual([
      { key: "costs-row:files", label: "文件", moduleCode: "costs", section: "files" },
      { key: "costs-row:expenses", label: "费用", moduleCode: "costs", section: "expenses" },
    ]);
  });
});

describe("resolveCustomsSection", () => {
  it("defaults direct customs links to the files view", () => {
    expect(resolveCustomsSection(null)).toBe("files");
    expect(resolveCustomsSection("unknown")).toBe("files");
    expect(resolveCustomsSection("declarations")).toBe("declarations");
  });
});

describe("resolveCostsSection", () => {
  it("defaults direct settlement links to the files view", () => {
    expect(resolveCostsSection(null)).toBe("files");
    expect(resolveCostsSection("unknown")).toBe("files");
    expect(resolveCostsSection("expenses")).toBe("expenses");
  });
});

describe("costsTabHasPendingAction", () => {
  it("marks only the expenses tab when settlement sign-offs are pending", () => {
    expect(costsTabHasPendingAction("expenses", true)).toBe(true);
    expect(costsTabHasPendingAction("files", true)).toBe(false);
    expect(costsTabHasPendingAction("expenses", false)).toBe(false);
  });
});

describe("orderWorkflowModuleTabs", () => {
  const tabs = [
    { key: "tracking", label: "运输执行与跟踪", moduleCode: "tracking", section: null },
    { key: "customs:files", label: "报关文件", moduleCode: "customs", section: "files" as const },
    { key: "customs:declarations", label: "报关单", moduleCode: "customs", section: "declarations" as const },
  ];

  it("orders outbound transport tabs by the handling sequence", () => {
    expect(orderWorkflowModuleTabs("outbound_transport", tabs).map((tab) => tab.label)).toEqual([
      "报关文件",
      "报关单",
      "运输执行与跟踪",
    ]);
  });

  it("keeps the configured order for other workflow steps", () => {
    expect(orderWorkflowModuleTabs("reconciliation", tabs)).toEqual(tabs);
  });
});
