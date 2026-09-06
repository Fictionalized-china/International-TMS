import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.exceptions";
import { Modal } from "../components/Modal";
import { QueryPagination } from "../components/QueryPagination";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { synchronizeOrderExceptionStatuses } from "../lib/order-exception-status.server";
import { paginateList, readListPage } from "../lib/list-pagination";
import { loadOrderModuleActionScope } from "../lib/order-modules.server";

type ExceptionRow={id:string;exception_number:string;package_id:string;barcode:string;shipment_number:string;order_number:string;customer_name:string;customer_identity_code:string;location_name:string;exception_type:string;severity:string;status:string;description:string;resolution:string|null;reported_at:string;resolved_at:string|null;reporter_name:string|null;assignee_name:string|null};
type Attachment={id:string;exception_id:string;file_name:string;content_type:string;size_bytes:number};
type UserOption={id:string;display_name:string};
type ReceiptDifferenceRow={order_id:string;order_number:string;customer_name:string;receipt_numbers:string;difference_count:number;max_difference_percent:number;updated_at:string};

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse"),warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,url=new URL(request.url),status=url.searchParams.get("status")??"active",requestedPage=readListPage(url.searchParams);
  const [exceptions,attachments,users,differenceRows]=await Promise.all([
    env.DB.prepare(`SELECT e.id,e.exception_number,e.package_id,p.barcode,s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,l.name location_name,e.exception_type,e.severity,e.status,e.description,e.resolution,e.reported_at,e.resolved_at,ur.display_name reporter_name,ua.display_name assignee_name FROM warehouse_exceptions e JOIN warehouse_packages p ON p.id=e.package_id JOIN shipments s ON s.id=e.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_locations l ON l.id=p.location_id LEFT JOIN users ur ON ur.id=e.reported_by_user_id LEFT JOIN users ua ON ua.id=e.assigned_to_user_id WHERE e.organization_id=? AND p.warehouse_id=? AND (?='all' OR (?='active' AND e.status IN ('open','processing')) OR e.status=?) ORDER BY CASE e.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,e.updated_at DESC`).bind(user.organizationId,warehouse.id,status,status,status).all<ExceptionRow>(),
    env.DB.prepare(`SELECT a.id,a.exception_id,a.file_name,a.content_type,a.size_bytes
      FROM warehouse_exception_attachments a
      WHERE a.organization_id=? AND a.exception_id IN (
        SELECT e.id FROM warehouse_exceptions e
        JOIN warehouse_packages p ON p.id=e.package_id
        WHERE e.organization_id=? AND p.warehouse_id=?
          AND (?='all' OR (?='active' AND e.status IN ('open','processing')) OR e.status=?)
        ORDER BY CASE e.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,e.updated_at DESC
      ) ORDER BY a.created_at`).bind(user.organizationId,user.organizationId,warehouse.id,status,status,status).all<Attachment>(),
    env.DB.prepare(`SELECT DISTINCT u.id,u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND u.status='active' ORDER BY u.display_name`).bind(user.organizationId).all<UserOption>(),
    env.DB.prepare(`SELECT d.order_id,o.order_number,c.name customer_name,
      GROUP_CONCAT(DISTINCT r.receipt_number) receipt_numbers,
      COUNT(*) difference_count,MAX(d.max_difference_percent) max_difference_percent,
      MAX(d.updated_at) updated_at
      FROM warehouse_receipt_differences d
      JOIN warehouse_receipts r ON r.id=d.receipt_id AND r.organization_id=d.organization_id
      JOIN transport_orders o ON o.id=d.order_id AND o.organization_id=d.organization_id
      JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
      WHERE d.organization_id=? AND r.warehouse_id=?
        AND (d.status='pending' OR d.fee_impact_confirmed=0)
      GROUP BY d.order_id,o.order_number,c.name
      ORDER BY MAX(d.updated_at) DESC`).bind(user.organizationId,warehouse.id).all<ReceiptDifferenceRow>()
  ]);
  const summary={open:exceptions.results.filter(x=>x.status==="open").length,processing:exceptions.results.filter(x=>x.status==="processing").length,critical:exceptions.results.filter(x=>x.severity==="critical"&&x.status!=="resolved").length};
  const pagination=paginateList(exceptions.results,requestedPage);
  const differenceModuleCode=warehouse.warehouse_role==="overseas_destination"?"overseas_warehouse":"warehouse";
  const differences=await Promise.all(differenceRows.results.map(async row=>{
    const scope=await loadOrderModuleActionScope(user.organizationId,row.order_id,differenceModuleCode);
    const canConfirm=Boolean(scope?.enabled&&user.positionCode&&scope.responsibilityPositionCodes.includes(user.positionCode));
    return{...row,can_confirm:canConfirm,access_reason:canConfirm?null:"当前订单冻结工作流未将仓库差异确认分配给本岗位"};
  }));
  return{user,warehouse,status,exceptions:pagination.items,attachments:attachments.results,users:users.results,differences,summary,pagination:{page:pagination.page,pageCount:pagination.pageCount,pageSize:pagination.pageSize,total:pagination.total}};
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse"),warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected,form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  await requireWarehouseAssignment(user,warehouse.id,"operator");
  if(intent==="confirm_receipt_difference"){
    const orderId=valueOf(form,"orderId");
    const differenceModuleCode=warehouse.warehouse_role==="overseas_destination"?"overseas_warehouse":"warehouse";
    const scope=await loadOrderModuleActionScope(user.organizationId,orderId,differenceModuleCode);
    if(!scope?.enabled)return{formError:"当前订单冻结工作流未启用仓库差异确认"};
    if(!user.positionCode||!scope.responsibilityPositionCodes.includes(user.positionCode))return{formError:"当前订单冻结工作流未将仓库差异确认分配给本岗位"};
    const pending=await env.DB.prepare(`SELECT COUNT(*) count FROM warehouse_receipt_differences d
      JOIN warehouse_receipts r ON r.id=d.receipt_id AND r.organization_id=d.organization_id
      WHERE d.organization_id=? AND d.order_id=? AND r.warehouse_id=?
        AND (d.status='pending' OR d.fee_impact_confirmed=0)`).bind(user.organizationId,orderId,warehouse.id).first<{count:number}>();
    if(!pending?.count)return{formError:"当前仓库没有该订单的待确认实收差异"};
    await env.DB.batch([
      env.DB.prepare(`UPDATE warehouse_receipt_differences SET status='confirmed',fee_impact_confirmed=1,
        confirmed_by_user_id=?,confirmed_at=?,updated_at=? WHERE organization_id=? AND order_id=?
        AND receipt_id IN (SELECT id FROM warehouse_receipts WHERE organization_id=? AND warehouse_id=?)
        AND (status='pending' OR fee_impact_confirmed=0)`).bind(user.userId,now,now,user.organizationId,orderId,user.organizationId,warehouse.id),
      env.DB.prepare(`UPDATE order_tasks SET status='completed',completed_at=?,updated_at=?
        WHERE organization_id=? AND order_id=? AND module_code='warehouse' AND task_type='warehouse_difference'
        AND status IN ('pending','in_progress') AND NOT EXISTS(
          SELECT 1 FROM warehouse_receipt_differences remaining
          WHERE remaining.organization_id=? AND remaining.order_id=?
            AND (remaining.status='pending' OR remaining.fee_impact_confirmed=0)
        )`).bind(now,now,user.organizationId,orderId,user.organizationId,orderId),
    ]);
    await writeAudit({request,action:"warehouse.actual.difference.confirm",resourceType:"transport_order",resourceId:orderId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{warehouseId:warehouse.id,feeImpactConfirmed:true}});
    return{success:"仓库实收差异及费用影响已确认，结算阻断已解除"};
  }
  if(intent==="create"){
    const barcode=valueOf(form,"barcode").toUpperCase(),type=valueOf(form,"exceptionType"),severity=valueOf(form,"severity"),description=valueOf(form,"description"),assignedTo=valueOf(form,"assignedTo")||null;
    if(!["damage","shortage","overage","wrong_label","wrong_location","other"].includes(type)||!["low","medium","high","critical"].includes(severity)||description.length<4)return{formError:"请完整填写异常类型、等级和说明"};
    const pkg=await env.DB.prepare("SELECT p.id,p.shipment_id,p.location_id,p.status,s.order_id FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id WHERE p.organization_id=? AND p.warehouse_id=? AND p.barcode=?").bind(user.organizationId,warehouse.id,barcode).first<{id:string;shipment_id:string;location_id:string;status:string;order_id:string}>();
    if(!pkg)return{formError:`未找到货物标签 ${barcode}`};
    if(pkg.status==="dispatched")return{formError:"货物已经出库，请从运单异常流程处理"};
    const duplicate=await env.DB.prepare("SELECT id FROM warehouse_exceptions WHERE package_id=? AND organization_id=? AND status IN ('open','processing')").bind(pkg.id,user.organizationId).first();
    if(duplicate)return{formError:"该货物已有未结案异常"};
    if(assignedTo){const member=await env.DB.prepare("SELECT id FROM memberships WHERE organization_id=? AND user_id=?").bind(user.organizationId,assignedTo).first();if(!member)return{formError:"处理负责人无效"};}
    const photos=form.getAll("photos").filter((file):file is File=>file instanceof File&&file.size>0);
    if(photos.length>3)return{formError:"每个异常最多上传 3 张图片"};
    for(const photo of photos)if(!["image/jpeg","image/png","image/webp"].includes(photo.type)||photo.size>1_500_000)return{formError:"图片仅支持 JPG、PNG、WebP，单张不能超过 1.5 MB"};
    const id=crypto.randomUUID(),number=generateException(),statements=[
      env.DB.prepare("INSERT INTO warehouse_exceptions(id,organization_id,exception_number,package_id,shipment_id,exception_type,severity,status,previous_package_status,description,reported_by_user_id,assigned_to_user_id,reported_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?)").bind(id,user.organizationId,number,pkg.id,pkg.shipment_id,type,severity,pkg.status,description,user.userId,assignedTo,now,now,now),
      env.DB.prepare("UPDATE warehouse_packages SET status='exception',updated_at=? WHERE id=? AND organization_id=?").bind(now,pkg.id,user.organizationId),
      env.DB.prepare("INSERT INTO warehouse_package_movements(id,organization_id,package_id,operation_type,from_location_id,to_location_id,operator_user_id,notes,occurred_at,created_at) VALUES(?,?,?,'exception',?,?,?,?,?,?)").bind(crypto.randomUUID(),user.organizationId,pkg.id,pkg.location_id,pkg.location_id,user.userId,description,now,now)
    ];
    for(const photo of photos)statements.push(env.DB.prepare("INSERT INTO warehouse_exception_attachments(id,organization_id,exception_id,file_name,content_type,size_bytes,data_url,uploaded_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),user.organizationId,id,photo.name,photo.type,photo.size,await toDataUrl(photo),user.userId,now));
    await env.DB.batch(statements);
    await synchronizeOrderExceptionStatuses(user.organizationId,[pkg.order_id],now);
    await writeAudit({request,action:"warehouse.exception.create",resourceType:"warehouse_exception",resourceId:id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,barcode,type,severity,photos:photos.length}});
    return{success:`异常 ${number} 已登记，货物已冻结`};
  }
  const exceptionId=valueOf(form,"exceptionId"),exception=await env.DB.prepare("SELECT e.id,e.package_id,e.status,e.previous_package_status,e.exception_number,s.order_id FROM warehouse_exceptions e JOIN warehouse_packages p ON p.id=e.package_id JOIN shipments s ON s.id=e.shipment_id WHERE e.id=? AND e.organization_id=? AND p.warehouse_id=?").bind(exceptionId,user.organizationId,warehouse.id).first<{id:string;package_id:string;status:string;previous_package_status:string;exception_number:string;order_id:string}>();
  if(!exception)return{formError:"异常记录不存在"};
  if(intent==="processing"){
    if(exception.status!=="open")return{formError:"只有待处理异常可以开始处理"};
    const assignedTo=valueOf(form,"assignedTo")||user.userId;
    await env.DB.prepare("UPDATE warehouse_exceptions SET status='processing',assigned_to_user_id=?,updated_at=? WHERE id=?").bind(assignedTo,now,exception.id).run();
    return{success:`${exception.exception_number} 已进入处理中`};
  }
  if(intent==="resolve"){
    if(!["open","processing"].includes(exception.status))return{formError:"异常已经结案"};
    const resolution=valueOf(form,"resolution");if(resolution.length<4)return{formError:"请填写异常处理结果"};
    await env.DB.batch([
      env.DB.prepare("UPDATE warehouse_exceptions SET status='resolved',resolution=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?").bind(resolution,user.userId,now,now,exception.id),
      env.DB.prepare("UPDATE warehouse_packages SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status='exception'").bind(exception.previous_package_status,now,exception.package_id,user.organizationId)
    ]);
    await synchronizeOrderExceptionStatuses(user.organizationId,[exception.order_id],now);
    await writeAudit({request,action:"warehouse.exception.resolve",resourceType:"warehouse_exception",resourceId:exception.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{resolution}});
    return{success:`${exception.exception_number} 已结案，货物已解除冻结`};
  }
  return{formError:"无效的异常操作"};
}

const typeLabels:Record<string,string>={damage:"破损",shortage:"短少",overage:"多货",wrong_label:"错标",wrong_location:"错位",other:"其他"};
const severityLabels:Record<string,string>={low:"低",medium:"中",high:"高",critical:"紧急"};
const statusLabels:Record<string,string>={open:"待处理",processing:"处理中",resolved:"已结案",cancelled:"已取消"};
export default function WarehouseExceptions({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",canOperate=loaderData.user.permissions.includes("warehouse.operate"),{open,processing,critical}=loaderData.summary;
  return <><header className="page-header"><div><p className="eyebrow">EXCEPTION & EVIDENCE</p><h1>异常与凭证</h1><p>登记破损、短少、多货、错标和错位，上传现场照片并跟踪处理结案。</p></div>{canOperate&&<Modal title="登记仓库异常" triggerLabel="＋ 登记异常" closeSignal={actionData?.success} size="wide"><Form method="post" encType="multipart/form-data" className="stack"><input type="hidden" name="intent" value="create"/><label className="field scan-field"><span>货物标签条码</span><input name="barcode" placeholder="扫描货物标签" autoComplete="off" required/></label><div className="form-grid compact"><label className="field"><span>异常类型</span><select name="exceptionType"><option value="damage">破损</option><option value="shortage">短少</option><option value="overage">多货</option><option value="wrong_label">错标</option><option value="wrong_location">错位</option><option value="other">其他</option></select></label><label className="field"><span>严重等级</span><select name="severity"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></label><label className="field"><span>处理负责人</span><select name="assignedTo"><option value="">暂不分配</option>{loaderData.users.map(x=><option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label><label className="field"><span>现场图片（最多3张）</span><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple/></label></div><label className="field"><span>异常说明</span><textarea name="description" rows={4} required/></label><button className="primary" disabled={busy}>登记并冻结货物</button></Form></Modal>}</header>
    {(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
    <section className="panel warehouse-difference-confirmation-table"><div className="panel-header"><div><h2>待确认实收差异及费用影响</h2><p>仅显示当前绑定仓库产生的差异；确认后解除订单结算与复盘门禁。</p></div><span className={`status-pill ${loaderData.differences.length?"off":"success"}`}>{loaderData.differences.length?`${loaderData.differences.length} 票待确认`:"当前无待确认"}</span></div><div className="table-wrap"><table><thead><tr><th>订单 / 客户</th><th>收货单</th><th>差异</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{loaderData.differences.map(item=><tr key={item.order_id}><td><strong>{item.order_number}</strong><small>{item.customer_name}</small></td><td>{item.receipt_numbers||"—"}</td><td><strong>{item.difference_count} 条</strong><small>最大差异 {Number(item.max_difference_percent).toFixed(1)}%</small></td><td>{new Date(item.updated_at).toLocaleString("zh-CN")}</td><td>{canOperate&&item.can_confirm?<Form method="post"><input type="hidden" name="intent" value="confirm_receipt_difference"/><input type="hidden" name="orderId" value={item.order_id}/><button className="primary" disabled={busy}>确认差异及费用影响</button></Form>:<span className="muted">{item.access_reason||"只读"}</span>}</td></tr>)}{!loaderData.differences.length&&<tr><td colSpan={5} className="empty-state">当前仓库没有待确认的实收差异。</td></tr>}</tbody></table></div></section>
    <section className="panel warehouse-summary-table"><div className="table-wrap"><table><thead><tr><th>待处理</th><th>处理中</th><th>紧急异常</th></tr></thead><tbody><tr><td><strong>{open}</strong><small>等待现场认领</small></td><td><strong>{processing}</strong><small>已有负责人</small></td><td><strong>{critical}</strong><small>需要优先处理</small></td></tr></tbody></table></div></section>
    <nav className="tabs exception-tabs"><a className={loaderData.status==="active"?"active":""} href={`?warehouseId=${loaderData.warehouse.id}&status=active`}>未结案</a><a className={loaderData.status==="resolved"?"active":""} href={`?warehouseId=${loaderData.warehouse.id}&status=resolved`}>已结案</a><a className={loaderData.status==="all"?"active":""} href={`?warehouseId=${loaderData.warehouse.id}&status=all`}>全部</a></nav>
    <section className="panel warehouse-exception-table"><div className="table-wrap"><table><thead><tr><th>异常单</th><th>类型 / 等级</th><th>订单 / 运单</th><th>标签 / 库位</th><th>异常说明</th><th>现场凭证</th><th>登记 / 负责人</th><th>状态 / 结果</th><th>操作</th></tr></thead><tbody>{loaderData.exceptions.map(item=>{const photos=loaderData.attachments.filter(x=>x.exception_id===item.id);return <tr className={`severity-${item.severity}`} key={item.id}><td><strong>{item.exception_number}</strong><small>{item.customer_name}</small></td><td>{typeLabels[item.exception_type]}<small><span className={`severity-badge ${item.severity}`}>{severityLabels[item.severity]}</span></small></td><td><strong>{item.order_number}</strong><small>{item.shipment_number}</small></td><td><code>{item.barcode}</code><small>{item.location_name}</small></td><td>{item.description}</td><td>{photos.length?photos.map(photo=><a className="exception-evidence-link" key={photo.id} href={`/warehouse/document-files/exception/${photo.id}?warehouseId=${encodeURIComponent(loaderData.warehouse.id)}&mode=view`} target="_blank" rel="noreferrer">{photo.file_name}</a>):"—"}</td><td>{item.reporter_name||"系统"}<small>{new Date(item.reported_at).toLocaleString("zh-CN")} · {item.assignee_name||"未分配"}</small></td><td><span className={`status-pill ${item.status==="resolved"?"success":"off"}`}>{statusLabels[item.status]}</span>{item.resolution&&<small>{item.resolution}</small>}</td><td>{canOperate&&["open","processing"].includes(item.status)?<div className="row-actions">{item.status==="open"&&<Form method="post"><input type="hidden" name="intent" value="processing"/><input type="hidden" name="exceptionId" value={item.id}/><button className="text-button" disabled={busy}>开始处理</button></Form>}<Modal title={`结案 ${item.exception_number}`} triggerLabel="处理结案" triggerClassName="text-button" closeSignal={actionData?.success}><Form method="post" className="stack"><input type="hidden" name="intent" value="resolve"/><input type="hidden" name="exceptionId" value={item.id}/><label className="field"><span>处理结果</span><textarea name="resolution" rows={5} placeholder="说明检查结果、责任认定和处理措施" required/></label><button className="primary" disabled={busy}>确认结案并解除冻结</button></Form></Modal></div>:"—"}</td></tr>})}{!loaderData.exceptions.length&&<tr><td colSpan={9} className="empty-state">当前筛选条件下没有异常记录。</td></tr>}</tbody></table></div></section>
    <QueryPagination {...loaderData.pagination} unit="条"/>
  </>;
}
async function toDataUrl(file:File){const bytes=new Uint8Array(await file.arrayBuffer());let binary="";const size=0x8000;for(let i=0;i<bytes.length;i+=size)binary+=String.fromCharCode(...bytes.subarray(i,i+size));return `data:${file.type};base64,${btoa(binary)}`}
function generateException(){return `EX-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
export function meta(){return[{title:"仓库异常与凭证 | International TMS"}]}
