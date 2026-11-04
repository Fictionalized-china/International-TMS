import type { SessionUser } from "./auth.server";
import { isBossBusinessActor } from "./permission-blocks";
import { loadFinancialClosure, financialClosurePredicate } from "./financial-closure.server";
import { changedRowGuard, predicateGuard, guardedBatch } from "./mutation-guard.server";

/** Explicit, audited recovery; never invoked by a GET or on financially closed orders. */
export async function reopenPrematureSettlement(db: D1Database, actor: SessionUser, orderId: string, confirmed: boolean, now = new Date().toISOString()) {
  if (!confirmed) throw new Error("请明确确认恢复财务待结算；原签核和资金记录不会删除");
  const order = await db.prepare(`SELECT o.id,o.status,o.completion_status,o.workflow_instance_id,o.current_step_code,o.current_step_name,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='review') finance_user_id,
    (SELECT assignee_user_id FROM order_module_instances WHERE organization_id=o.organization_id AND order_id=o.id AND module_code='costs') costs_user_id
    FROM transport_orders o WHERE o.organization_id=? AND o.id=?`).bind(actor.organizationId, orderId)
    .first<{ id: string; status: string; completion_status: string; workflow_instance_id: string | null; current_step_code: string | null; current_step_name: string | null; finance_user_id: string | null; costs_user_id: string | null }>();
  if (!order) throw new Error("订单不存在");
  if (!isBossBusinessActor(actor) && (actor.userId !== order.finance_user_id || !actor.permissions.includes("order.module.review.manage"))) throw new Error("仅本单财务负责人或系统管理人员可恢复财务办理");
  if (order.status === "in_execution" && await db.prepare("SELECT 1 FROM audit_logs WHERE organization_id=? AND resource_id=? AND action='settlement.archive.reopen'").bind(actor.organizationId, orderId).first()) return { success: "此前已恢复本单财务待结算，无需重复恢复" };
  if (order.status !== "completed" || order.completion_status !== "business_complete_unsettled") throw new Error("仅可恢复业务已归档但财务未结清的订单");
  const closure = await loadFinancialClosure(db, actor.organizationId, orderId);
  if (closure.complete) throw new Error("该单已财务结清，无需恢复");
  if (!order.workflow_instance_id) throw new Error("历史订单缺少冻结工作流，请由管理员核查后恢复");
  const instance = await db.prepare("SELECT id FROM workflow_instances WHERE id=? AND organization_id=? AND order_id=?").bind(order.workflow_instance_id, actor.organizationId, orderId).first();
  if (!instance) throw new Error("订单工作流绑定异常");
  const steps = (await db.prepare("SELECT id,step_key,step_name,sort_order,status,started_at,completed_at FROM workflow_instance_step_states WHERE instance_id=? ORDER BY sort_order").bind(order.workflow_instance_id)
    .all<{ id: string; step_key: string; step_name: string; sort_order: number; status: string; started_at: string | null; completed_at: string | null }>()).results;
  const modules = (await db.prepare("SELECT m.id,m.instance_step_state_id,m.module_code,m.status FROM workflow_instance_module_states m JOIN workflow_instance_step_states s ON s.id=m.instance_step_state_id WHERE s.instance_id=?").bind(order.workflow_instance_id)
    .all<{ id: string; instance_step_state_id: string; module_code: string; status: string }>()).results;
  const target = steps.filter(step => modules.some(module => module.instance_step_state_id === step.id && module.module_code === "costs")).at(-1);
  if (!target || !steps.some(step => step.sort_order > target.sort_order && modules.some(module => module.instance_step_state_id === step.id && module.module_code === "review"))) throw new Error("冻结工作流缺少独立的结算和最终复盘节点");
  const affectedSteps = steps.filter(step => step.sort_order >= target.sort_order);
  if (modules.some(module => affectedSteps.some(step => step.id === module.instance_step_state_id) && !["costs", "review"].includes(module.module_code))) throw new Error("结算后的自定义业务模块需要人工核查，不能自动回退");
  const reviewTasks = (await db.prepare(`SELECT t.* FROM workflow_instance_task_states t JOIN workflow_instance_module_states m ON m.id=t.instance_module_state_id
    JOIN workflow_instance_step_states s ON s.id=m.instance_step_state_id WHERE s.instance_id=? AND s.sort_order>=? AND m.module_code='review'`).bind(order.workflow_instance_id, target.sort_order).all<Record<string, unknown>>()).results;
  const reviewSnapshots = (await db.prepare("SELECT * FROM order_review_snapshots WHERE organization_id=? AND order_id=?").bind(actor.organizationId, orderId).all<Record<string, unknown>>()).results;
  const metadata = JSON.stringify({ previousOrder: order, previousSteps: affectedSteps, previousModules: modules.filter(module => affectedSteps.some(step => step.id === module.instance_step_state_id)), previousReviewTasks: reviewTasks, previousReviewSnapshots: reviewSnapshots, reason: "业务提前归档但对账和真实收付款核销尚未完成；仅恢复财务节点，保留运输、费用和签核事实" });
  await guardedBatch(db, [
    predicateGuard(db, `NOT (${financialClosurePredicate()})`, [actor.organizationId, orderId], now),
    db.prepare(`UPDATE transport_orders SET status='in_execution',completion_status='in_progress',settlement_completed_at=NULL,
      current_step_code='module:costs',current_step_name=?,current_assignee_user_id=?,workflow_updated_at=?,updated_at=?
      WHERE organization_id=? AND id=? AND workflow_instance_id=? AND status='completed' AND completion_status='business_complete_unsettled'`)
      .bind(`${target.step_name} · 待对账与收付款核销`, order.costs_user_id, now, now, actor.organizationId, orderId, order.workflow_instance_id),
    changedRowGuard(db, now),
    db.prepare("UPDATE workflow_instances SET status='active',current_step_key=?,completed_at=NULL,updated_at=? WHERE id=? AND organization_id=? AND order_id=?").bind(target.step_key, now, order.workflow_instance_id, actor.organizationId, orderId),
    db.prepare("UPDATE workflow_instance_step_states SET status=CASE WHEN id=? THEN 'active' ELSE 'pending' END,started_at=CASE WHEN id=? THEN started_at ELSE NULL END,completed_at=NULL,updated_at=? WHERE instance_id=? AND sort_order>=?").bind(target.id, target.id, now, order.workflow_instance_id, target.sort_order),
    ...modules.filter(module => affectedSteps.some(step => step.id === module.instance_step_state_id)).map(module => db.prepare("UPDATE workflow_instance_module_states SET status=?,updated_at=? WHERE id=?").bind(module.instance_step_state_id === target.id ? "active" : "pending", now, module.id)),
    ...reviewTasks.map(task => db.prepare("UPDATE workflow_instance_task_states SET status='pending',completed_at=NULL,completed_by_user_id=NULL,updated_at=? WHERE id=?").bind(now, String(task.id))),
    db.prepare("UPDATE order_module_instances SET status='in_progress',current_step_code=CASE WHEN module_code='costs' THEN 'parallel_review' ELSE 'reviewing' END,current_step_name=CASE WHEN module_code='costs' THEN '待对账与真实收付款核销' ELSE '待财务结清后最终复盘' END,progress_percent=CASE WHEN module_code='costs' THEN 80 ELSE 0 END,completed_at=NULL,blocking_reason=?,updated_at=? WHERE organization_id=? AND order_id=? AND module_code IN ('costs','review')").bind("财务闭环尚未完成，最终复盘归档暂未开放", now, actor.organizationId, orderId),
    db.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,'settlement.archive.reopen','transport_order',?,'success',?,?)").bind(crypto.randomUUID(), actor.organizationId, actor.userId, orderId, metadata, now),
    db.prepare(`INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at)
      SELECT ?,organization_id,order_id,id,'reopen_financial_settlement','恢复财务待结算','confirmed','reviewing','待财务结清后最终复盘',?,'保留原复盘、运输及签核记录；未代签或录入资金',? FROM order_module_instances WHERE organization_id=? AND order_id=? AND module_code='review'`).bind(crypto.randomUUID(), actor.userId, now, actor.organizationId, orderId),
  ], "订单或资金状态已变化，请刷新后重试恢复财务办理");
  return { success: "已恢复本单财务待结算；运输、费用、既有签核及原复盘记录均保留" };
}
