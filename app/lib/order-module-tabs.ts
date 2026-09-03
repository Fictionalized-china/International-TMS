export type CustomsModuleTabSection = "files" | "declarations";
export type CostsModuleTabSection = "files" | "expenses";
export type OrderModuleTabSection = CustomsModuleTabSection | CostsModuleTabSection | null;

export type OrderModuleTabDescriptor = {
  key: string;
  label: string;
  moduleCode: string | null;
  section: OrderModuleTabSection;
};

export function orderWorkflowModuleTabs(
  stepKey: string,
  tabs: readonly OrderModuleTabDescriptor[],
): OrderModuleTabDescriptor[] {
  if (stepKey !== "outbound_transport") return [...tabs];

  const priority = (tab: OrderModuleTabDescriptor) => {
    if (tab.moduleCode === "customs" && tab.section === "declarations") return 0;
    if (tab.moduleCode === "tracking") return 1;
    if (tab.moduleCode === "customs" && tab.section === "files") return 2;
    return 3;
  };

  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((left, right) => priority(left.tab) - priority(right.tab) || left.index - right.index)
    .map(({ tab }) => tab);
}

export function orderModuleTabHref({
  orderId,
  stepKey,
  moduleCode,
  section,
}: {
  orderId: string;
  stepKey: string;
  moduleCode: string | null;
  section: string | null;
}) {
  const params = new URLSearchParams({ stage: stepKey });
  if (moduleCode) params.set("module", moduleCode);
  if (section) params.set("section", section);
  return `/admin/orders/${encodeURIComponent(orderId)}?${params.toString()}`;
}

export function resolveCustomsSection(value: string | null): CustomsModuleTabSection {
  return value === "declarations" ? "declarations" : "files";
}

export function resolveCostsSection(value: string | null): CostsModuleTabSection {
  return value === "expenses" ? "expenses" : "files";
}

export function orderModuleTabDescriptors({
  key,
  moduleCode,
  moduleName,
}: {
  key: string;
  moduleCode: string | null;
  moduleName: string | null;
}): OrderModuleTabDescriptor[] {
  if (moduleCode === "customs") {
    return [
      { key: `${key}:files`, label: "报关文件", moduleCode, section: "files" },
      { key: `${key}:declarations`, label: "报关单", moduleCode, section: "declarations" },
    ];
  }

  if (moduleCode === "costs") {
    return [
      { key: `${key}:files`, label: "文件", moduleCode, section: "files" },
      { key: `${key}:expenses`, label: "费用", moduleCode, section: "expenses" },
    ];
  }

  return [{
    key,
    label: moduleName || moduleCode || "业务分区",
    moduleCode,
    section: null,
  }];
}
