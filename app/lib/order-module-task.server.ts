import type { SessionUser } from "./auth.server";
import { orderVisibilitySql } from "./order-access";
import { canManageOrderModule, moduleManagePermission } from "./position-portal";
import { canCompleteWorkflowTask } from "./workflow-task-access";
import { loadActivePositionAccessProfile, activePositionProfilePredicate } from "./position-access-profile.server";
import { changedRowGuard, predicateGuard, guardedBatch } from "./mutation-guard.server";
import { prepareOrderIntakeAdvance, intakeGateCommitStatements } from "./order-intake-gate.server";

/** Completes a module reminder, not a frozen business task or the module itself. */
export async function completeOrderModuleTask(db: D1Database, current: SessionUser, orderId: string, moduleCode: string, taskId: string) {
  const profile = await loadActivePositionAccessProfile(db, current.organizationId, current.userId);
  if (!profile || !profile.permissions.includes("order.view")) throw new Error("账号或订单查看权限已停用");
  const actor = { ...current, ...profile, roleCodes: [profile.roleCode] };
  if (!canManageOrderModule(actor, moduleCode)) throw new Error("当前岗位不能办理该模块待办");
  const visibility = orderVisibilitySql(actor, "o");
  const scopeSql = `FROM order_tasks t
    JOIN transport_orders o ON o.id=t.order_id AND o.organization_id=t.organization_id
    JOIN order_module_instances omi ON omi.organization_id=t.organization_id AND omi.order_id=t.order_id AND omi.module_code=t.module_code AND omi.enabled=1
    LEFT JOIN workflow_instances wi ON wi.id=o.workflow_instance_id AND wi.organization_id=o.organization_id AND wi.order_id=o.id
    LEFT JOIN workflow_instance_step_states ss ON ss.instance_id=wi.id AND ss.step_key=wi.current_step_key AND ss.status='active'
    LEFT JOIN workflow_instance_module_states ms ON ms.instance_step_state_id=ss.id AND ms.module_code=t.module_code
    WHERE t.id=? AND t.organization_id=? AND t.order_id=? AND t.module_code=?
      AND t.status IN ('pending','in_progress') AND o.status NOT IN ('completed','cancelled')
      AND ((o.workflow_instance_id IS NULL AND o.current_step_code=?) OR (wi.status='active' AND ss.id IS NOT NULL AND ms.id IS NOT NULL))
      AND ${visibility.sql}`;
  const scopeValues = [taskId, current.organizationId, orderId, moduleCode, `module:${moduleCode}`, ...visibility.values];
  const task = await db.prepare(`SELECT t.status,t.updated_at,t.assignee_user_id task_assignee,
      omi.id module_id,omi.assignee_user_id module_assignee,o.status order_status,o.current_step_code,
      wi.id instance_id,wi.workflow_id,wi.current_step_key,ss.id step_id,ms.id state_id,ms.responsibility_position_code
    ${scopeSql}`).bind(...scopeValues).first<{
      status: string; updated_at: string; task_assignee: string | null; module_id: string;
      module_assignee: string | null; order_status: string; current_step_code: string | null;
      instance_id: string | null; workflow_id: string | null; current_step_key: string | null;
      step_id: string | null; state_id: string | null; responsibility_position_code: string | null;
    }>();
  if (!task) throw new Error("该待办不在当前可办理模块，或已经完成");
  if (!canCompleteWorkflowTask({ actorUserId: current.userId, actorPositionCodes: [profile.positionCode], actorRoleCodes: [profile.roleCode], taskAssigneeUserId: task.task_assignee, moduleAssigneeUserId: task.module_assignee, responsibilityPositionCode: task.responsibility_position_code }))
    throw new Error("当前账号不是该待办的负责人");
  const intake = await prepareOrderIntakeAdvance(current.organizationId, orderId, db);
  const now = new Date().toISOString();
  const authority = activePositionProfilePredicate({ organizationId: current.organizationId, userId: current.userId, profile, requiredPermissions: ["order.view", moduleManagePermission(moduleCode)] });
  const columns = { "t.status": task.status, "t.updated_at": task.updated_at, "t.assignee_user_id": task.task_assignee, "omi.id": task.module_id, "omi.assignee_user_id": task.module_assignee, "o.status": task.order_status, "o.current_step_code": task.current_step_code, "wi.id": task.instance_id, "wi.workflow_id": task.workflow_id, "wi.current_step_key": task.current_step_key, "ss.id": task.step_id, "ms.id": task.state_id, "ms.responsibility_position_code": task.responsibility_position_code };
  const same = Object.keys(columns).map(key => `(HEX(${key})=HEX(?) OR (${key} IS NULL AND ? IS NULL))`).join(" AND ");
  await guardedBatch(db, [
    predicateGuard(db, authority.sql, authority.values, now),
    ...intakeGateCommitStatements(intake, now, db),
    predicateGuard(db, `EXISTS(SELECT 1 ${scopeSql} AND ${same})`, [...scopeValues, ...Object.values(columns).flatMap(value => [value, value])], now),
    db.prepare("UPDATE order_tasks SET status='completed',completed_at=?,updated_at=? WHERE organization_id=? AND id=? AND status=? AND updated_at=?").bind(now, now, current.organizationId, taskId, task.status, task.updated_at),
    changedRowGuard(db, now),
    db.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'order.task.complete','order_task',?,'success',?,?)").bind(crypto.randomUUID(), current.organizationId, current.userId, taskId, JSON.stringify({ orderId, moduleCode }), now),
  ], "待办、负责人、节点或权限已变化，本次未提交，请刷新重试");
}
