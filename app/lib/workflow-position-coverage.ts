export type PublishedWorkflowAssignment = {
  workflow_name: string;
  step_name: string;
  module_name: string;
};

export function workflowPositionCoverageBlocker(input: {
  positionName: string;
  otherActiveMembers: number;
  assignments: readonly PublishedWorkflowAssignment[];
}) {
  if (input.otherActiveMembers > 0 || input.assignments.length === 0) return null;
  const paths = input.assignments
    .slice(0, 3)
    .map((item) => `${item.workflow_name} / ${item.step_name} / ${item.module_name}`);
  const remaining = Math.max(0, input.assignments.length - paths.length);
  return `不能移除岗位“${input.positionName}”的最后一个有效账号；该岗位仍负责已发布工作流：${paths.join("；")}${remaining ? `；另有 ${remaining} 项` : ""}。请先补充同岗位账号，或发布已调整责任岗位的新工作流版本。`;
}
