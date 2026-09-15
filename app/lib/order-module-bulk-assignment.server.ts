import { env } from "cloudflare:workers";
import {
  frozenWorkflowTaskAssignmentStatements,
  resolveOrderModuleAssignmentTarget,
  type ResolvedOrderModuleAssignmentTarget,
} from "./order-assignment-manifest.server";
import { orderModuleDefinition } from "./order-modules";
import { requireActiveOrganizationAssignee } from "./organization-assignee.server";
import { syncOrderWorkflowSnapshot } from "./order-modules.server";

export type BulkOrderModuleAssignment = {
  moduleCode: string;
  assigneeUserId: string;
  responsibilityPositionCode?: string | null;
};

type BulkAssignmentModuleRow = {
  id: string;
  module_code: string;
  module_name: string;
  enabled: number;
  status: string;
  current_step_code: string | null;
  current_step_name: string | null;
};

type ValidatedBulkAssignment = {
  assignment: BulkOrderModuleAssignment;
  module: BulkAssignmentModuleRow;
  target: ResolvedOrderModuleAssignmentTarget | null;
  taskTitle: string;
};

/**
 * Validates the complete request before preparing any mutation, then commits
 * every assignment in one D1 batch. This prevents a later invalid module,
 * frozen responsibility, position, or personal permission from leaving an
 * earlier module assigned.
 */
export async function assignOrderModulesBulk(input: {
  organizationId: string;
  orderId: string;
  actorUserId: string;
  assignments: readonly BulkOrderModuleAssignment[];
  dueAt?: string | null;
  notes?: string | null;
}) {
  if (!input.assignments.length) throw new Error("当前没有可分配的模块");
  const moduleCodes = input.assignments.map((assignment) => assignment.moduleCode);
  if (new Set(moduleCodes).size !== moduleCodes.length) {
    throw new Error("批量分配不能包含重复模块");
  }
  const placeholders = moduleCodes.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id,module_code,module_name,enabled,status,current_step_code,current_step_name
       FROM order_module_instances
      WHERE organization_id=? AND order_id=? AND module_code IN (${placeholders})`,
  ).bind(input.organizationId, input.orderId, ...moduleCodes).all<BulkAssignmentModuleRow>();
  const rowByCode = new Map(rows.results.map((row) => [row.module_code, row]));
  const validated: ValidatedBulkAssignment[] = [];

  for (const assignment of input.assignments) {
    if (!assignment.assigneeUserId) throw new Error("请选择有效个人账户");
    const module = rowByCode.get(assignment.moduleCode);
    if (!module) throw new Error(`模块不存在：${assignment.moduleCode}`);
    if (module.enabled !== 1) throw new Error(`${module.module_name}未启用，不能分配`);
    if (["completed", "not_applicable"].includes(module.status)) {
      throw new Error(`${module.module_name}已完成或无需办理，不能分配`);
    }
    const definition = orderModuleDefinition(assignment.moduleCode);
    if (!definition) throw new Error(`模块不存在：${assignment.moduleCode}`);
    const target = await resolveOrderModuleAssignmentTarget({
      organizationId: input.organizationId,
      orderId: input.orderId,
      moduleCode: assignment.moduleCode,
      assigneeUserId: assignment.assigneeUserId,
      responsibilityPositionCode: assignment.responsibilityPositionCode,
    });
    if (!target) {
      await requireActiveOrganizationAssignee(
        input.organizationId,
        assignment.assigneeUserId,
      );
    }
    const legacyTaskTitle = `${definition.name}处理任务`;
    validated.push({
      assignment,
      module,
      target,
      taskTitle: target
        ? `${legacyTaskTitle}（${target.positionCode}）`
        : legacyTaskTitle,
    });
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const plan of validated) {
    const { assignment, module, target, taskTitle } = plan;
    const legacyTaskTitle = `${orderModuleDefinition(assignment.moduleCode)!.name}处理任务`;
    if (!target || target.primaryOwner) {
      statements.push(env.DB.prepare(
        "UPDATE order_module_instances SET assignee_user_id=?,blocking_reason=NULL,updated_at=? WHERE id=?",
      ).bind(assignment.assigneeUserId, now, module.id));
    }
    if (target) {
      statements.push(...frozenWorkflowTaskAssignmentStatements({
        organizationId: input.organizationId,
        orderId: input.orderId,
        assigneeUserId: assignment.assigneeUserId,
        now,
        target,
      }));
    }
    statements.push(
      target
        ? env.DB.prepare(
            "UPDATE order_tasks SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND task_type='module_owner' AND status IN ('pending','in_progress') AND title IN (?,?)",
          ).bind(now, input.organizationId, input.orderId, assignment.moduleCode, legacyTaskTitle, taskTitle)
        : env.DB.prepare(
            "UPDATE order_tasks SET status='cancelled',updated_at=? WHERE organization_id=? AND order_id=? AND module_code=? AND task_type='module_owner' AND status IN ('pending','in_progress')",
          ).bind(now, input.organizationId, input.orderId, assignment.moduleCode),
      env.DB.prepare(
        "INSERT INTO order_tasks(id,organization_id,order_id,module_code,task_type,title,status,assignee_user_id,assigned_by_user_id,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(), input.organizationId, input.orderId,
        assignment.moduleCode, "module_owner", taskTitle,
        assignment.assigneeUserId, input.actorUserId, input.dueAt || null, now, now,
      ),
      env.DB.prepare(
        "INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(), input.organizationId, input.orderId, module.id,
        "assign", target ? `分配${target.positionCode}负责人` : "分配负责人",
        module.current_step_code,
        module.current_step_code || orderModuleDefinition(assignment.moduleCode)!.steps[0].code,
        module.current_step_name || orderModuleDefinition(assignment.moduleCode)!.steps[0].name,
        input.actorUserId, input.notes || null, now,
      ),
    );
  }
  await env.DB.batch(statements);
  await syncOrderWorkflowSnapshot(input.organizationId, input.orderId);
  return { assignedCount: validated.length };
}
