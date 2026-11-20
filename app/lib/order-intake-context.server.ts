import {env} from "cloudflare:workers";
import type {SessionUser} from "./auth.server";
import {loadBusinessProcessPolicy} from "./business-process-policy.server";
import {policyPositions} from "./business-process-policy";
import {orderVisibilitySql} from "./order-access";
import {isBossBusinessActor} from "./permission-blocks";
import {loadActivePositionAccessProfile} from "./position-access-profile.server";

export type SupplementOrder=Record<string,unknown>&{id:string;order_number:string;status:string;updated_at:string;intake_operations_json:string|null;quote_commercial_user_id:string|null;quote_commercial_name_snapshot:string|null;is_responsible:number};

/** Read authority and responsibility from the current membership, never a stale form/session role. */
export async function loadOrderIntakeContext(current:SessionUser,orderId:string) {
  const profile=await loadActivePositionAccessProfile(env.DB,current.organizationId,current.userId);
  if(!profile)throw new Error("账号岗位或权限已停用，请重新登录");
  const actor={...current,...profile,roleCodes:[profile.roleCode]};
  if(!actor.permissions.includes("order.view"))throw new Error("当前账号没有订单查看权限");
  const scope=orderVisibilitySql(actor,"o");
  const order=await env.DB.prepare(`SELECT o.*,
    CASE WHEN o.salesperson_user_id=? OR o.created_by_user_id=? OR o.operation_supervisor_user_id=? OR o.current_assignee_user_id=?
      OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=o.organization_id AND m.order_id=o.id AND m.assignee_user_id=? AND m.enabled=1)
    THEN 1 ELSE 0 END is_responsible
    FROM transport_orders o WHERE o.id=? AND o.organization_id=? AND ${scope.sql}`)
    .bind(current.userId,current.userId,current.userId,current.userId,current.userId,orderId,current.organizationId,...scope.values).first<SupplementOrder>();
  if(!order)throw new Error("订单不存在或不在当前账号授权范围");
  const policy=await loadBusinessProcessPolicy(current.organizationId);
  const boss=isBossBusinessActor(actor);
  const canEdit=!["completed","cancelled"].includes(order.status)&&(boss||(
    Boolean(order.is_responsible)&&policyPositions(policy,"order.supplement_positions").includes(profile.positionCode)&&
    (actor.permissions.includes("order.intake.manage")||actor.permissions.includes("order.manage"))));
  return{order,actor,profile,policy,boss,canEdit};
}
