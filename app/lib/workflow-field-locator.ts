export type WorkflowFieldLocatorItem = {
  id: string;
  label: string;
  fieldKey: string;
  moduleLabel: string;
  stepId: string;
  stepName: string;
  modeLabel: string;
};

export type WorkflowFieldIdentity = {
  stepKey: string;
  moduleCode: string;
  fieldKey: string;
};

export function workflowFieldConfigurationHref(input: {
  workflowId: string;
  stepKey: string;
  moduleCode: string;
  fieldKey: string;
}) {
  const search = new URLSearchParams({
    workflowId: input.workflowId,
    stepKey: input.stepKey,
    moduleCode: input.moduleCode,
    fieldKey: input.fieldKey,
  });
  return `/admin/workflow?${search.toString()}`;
}

export function workflowFieldIdentityMatches(
  field: WorkflowFieldIdentity,
  requested: Partial<WorkflowFieldIdentity>,
) {
  return Boolean(
    requested.fieldKey && requested.moduleCode && requested.stepKey &&
    field.fieldKey === requested.fieldKey &&
    field.moduleCode === requested.moduleCode &&
    field.stepKey === requested.stepKey,
  );
}

export function filterWorkflowFieldLocatorItems(
  items: WorkflowFieldLocatorItem[],
  query: string,
  limit = 12,
) {
  const terms = query.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return items.filter((item) => {
    const searchable = [
      item.label,
      item.fieldKey,
      item.moduleLabel,
      item.stepName,
      item.modeLabel,
    ].join(" ").toLocaleLowerCase("zh-CN");
    return terms.every((term) => searchable.includes(term));
  }).slice(0, limit);
}
