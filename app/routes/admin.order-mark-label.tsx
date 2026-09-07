import { env } from "cloudflare:workers";
import type { Route } from "./+types/admin.order-mark-label";
import { OrderMarkLabelPage } from "../components/OrderMarkLabelPage";
import { requireSessionUser } from "../lib/auth.server";
import { loadOrderMarkLabel } from "../lib/order-mark-label.server";
import { requireOrderAccess } from "../lib/order-access.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "order.view");
  await requireOrderAccess(current, params.orderId);
  const order = await loadOrderMarkLabel({ organizationId: current.organizationId, orderId: params.orderId });
  const canReviseInboundPackages=Boolean(!order.inbound_package_locked_at&&(
    current.permissions.includes("order.manage")||
    (current.positionCode==="SALES"&&current.permissions.includes("quote.manage")&&await isOrderSalesperson(current.organizationId,params.orderId,current.userId))
  ));
  return { order,canReviseInboundPackages };
}

export async function action({request,params}:Route.ActionArgs){
  const current=await requireSessionUser(request,"order.view");
  await requireOrderAccess(current,params.orderId);
  const form=await request.formData(),plannedPackageCount=Number(valueOf(form,"plannedPackageCount"));
  if(!Number.isSafeInteger(plannedPackageCount)||plannedPackageCount<1||plannedPackageCount>500)return{formError:"预计入仓包装数必须是 1–500 的整数"};
  const order=await env.DB.prepare(`SELECT id,order_number,status,salesperson_user_id,inbound_package_locked_at,inbound_mark_revision,gross_weight_kg,volume_cbm FROM transport_orders WHERE organization_id=? AND id=?`).bind(current.organizationId,params.orderId).first<{id:string;order_number:string;status:string;salesperson_user_id:string|null;inbound_package_locked_at:string|null;inbound_mark_revision:number;gross_weight_kg:number;volume_cbm:number}>();
  if(!order)return{formError:"订单不存在"};
  const authorized=current.permissions.includes("order.manage")||(current.positionCode==="SALES"&&current.permissions.includes("quote.manage")&&order.salesperson_user_id===current.userId);
  if(!authorized)return{formError:"仅本单业务员或订单管理员可在首次扫码前修订包装数"};
  if(order.inbound_package_locked_at)return{formError:"国内仓已开始扫码，包装数和入仓唛头已锁定"};
  if(["completed","cancelled"].includes(order.status))return{formError:"订单已结束，不能修订入仓包装数"};
  const cargo=await env.DB.prepare("SELECT id FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY line_no,created_at LIMIT 1").bind(current.organizationId,order.id).first<{id:string}>();
  if(!cargo)return{formError:"订单尚无货物明细，不能生成入仓唛头"};
  const now=new Date().toISOString(),revision=Number(order.inbound_mark_revision||1)+1;
  const statements:D1PreparedStatement[]=[
    env.DB.prepare("UPDATE transport_orders SET planned_inbound_package_count=?,inbound_mark_revision=?,updated_at=? WHERE organization_id=? AND id=? AND inbound_package_locked_at IS NULL").bind(plannedPackageCount,revision,now,current.organizationId,order.id),
    env.DB.prepare("UPDATE order_cargo_items SET package_count=?,gross_weight_per_package_kg=?,net_weight_per_package_kg=?,volume_per_package_cbm=?,updated_at=? WHERE organization_id=? AND id=?").bind(plannedPackageCount,Number(order.gross_weight_kg||0)/plannedPackageCount,Number(order.gross_weight_kg||0)/plannedPackageCount,Number(order.volume_cbm||0)/plannedPackageCount,now,current.organizationId,cargo.id),
    env.DB.prepare("UPDATE order_cargo_packages SET is_active=0,status='cancelled' WHERE organization_id=? AND order_id=? AND received_at IS NULL").bind(current.organizationId,order.id),
  ];
  for(let sequence=1;sequence<=plannedPackageCount;sequence++)statements.push(env.DB.prepare(`INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at,label_revision,is_active,is_supplemental) VALUES(?,?,?,?,?,?,?, ?,1,0)`).bind(crypto.randomUUID(),current.organizationId,order.id,cargo.id,`${order.order_number}-IN-${String(sequence).padStart(3,"0")}`,sequence,now,revision));
  statements.push(env.DB.prepare(`INSERT INTO order_workflow_history(id,organization_id,order_id,action_code,action_name,from_status,to_status,to_step_code,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),current.organizationId,order.id,"inbound_mark_revised","首次扫码前修订入仓包装数",order.status,order.status,"order_creation",current.userId,`第 ${revision} 版：${plannedPackageCount} 包`,now));
  await env.DB.batch(statements);
  await writeAudit({request,action:"order.inbound_marks.revise",resourceType:"transport_order",resourceId:order.id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{plannedPackageCount,revision}});
  return{success:`已生成第 ${revision} 版入仓唛头，共 ${plannedPackageCount} 张；旧版已失效`};
}

async function isOrderSalesperson(organizationId:string,orderId:string,userId:string){
  const row=await env.DB.prepare("SELECT 1 ok FROM transport_orders WHERE organization_id=? AND id=? AND salesperson_user_id=?").bind(organizationId,orderId,userId).first<{ok:number}>();
  return Boolean(row?.ok);
}

export default function AdminOrderMarkLabel({ loaderData,actionData }: Route.ComponentProps) {
  return <OrderMarkLabelPage order={loaderData.order} returnTo={`/admin/orders/${loaderData.order.id}`} downloadTo={`/admin/orders/${loaderData.order.id}/mark-label/download`} canReviseInboundPackages={loaderData.canReviseInboundPackages} revisionMessage={actionData} />;
}

export function meta() {
  return [{ title: "入仓唛头标签 | International TMS" }];
}
