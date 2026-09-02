export type OrderModuleTabSection = "files" | "declarations" | null;

export type OrderModuleTabDescriptor = {
  key: string;
  label: string;
  moduleCode: string | null;
  section: OrderModuleTabSection;
};

export function resolveCustomsSection(value: string | null): Exclude<OrderModuleTabSection, null> {
  return value === "declarations" ? "declarations" : "files";
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

  return [{
    key,
    label: moduleName || moduleCode || "业务分区",
    moduleCode,
    section: null,
  }];
}
