import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.exceptions";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import { writeAudit } from "../lib/audit.server";

type ExceptionRow={id:string;exception_number:string;package_id:string;barcode:string;shipment_number:string;order_number:string;customer_name:string;customer_identity_code:string;location_name:string;exception_type:string;severity:string;status:string;description:string;resolution:string|null;reported_at:string;resolved_at:string|null;reporter_name:string|null;assignee_name:string|null};
type Attachment={id:string;exception_id:string;file_name:string;content_type:string;size_bytes:number;data_url:string};
type UserOption={id:string;display_name:string};

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse"),url=new URL(request.url),status=url.searchParams.get("status")??"active";
  const [exceptions,attachments,users]=await Promise.all([
    env.DB.prepare(`SELECT e.id,e.exception_number,e.package_id,p.barcode,s.shipment_number,o.order_number,c.name customer_name,c.identity_code customer_identity_code,l.name location_name,e.exception_type,e.severity,e.status,e.description,e.resolution,e.reported_at,e.resolved_at,ur.display_name reporter_name,ua.display_name assignee_name FROM warehouse_exceptions e JOIN warehouse_packages p ON p.id=e.package_id JOIN shipments s ON s.id=e.shipment_id JOIN transport_orders o ON o.id=s.order_id JOIN customers c ON c.id=s.customer_id JOIN warehouse_locations l ON l.id=p.location_id LEFT JOIN users ur ON ur.id=e.reported_by_user_id LEFT JOIN users ua ON ua.id=e.assigned_to_user_id WHERE e.organization_id=? AND (?='all' OR (?='active' AND e.status IN ('open','processing')) OR e.status=?) ORDER BY CASE e.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,e.updated_at DESC LIMIT 100`).bind(user.organizationId,status,status,status).all<ExceptionRow>(),
    env.DB.prepare(`SELECT a.id,a.exception_id,a.file_name,a.content_type,a.size_bytes,a.data_url FROM warehouse_exception_attachments a JOIN warehouse_exceptions e ON e.id=a.exception_id WHERE a.organization_id=? ORDER BY a.created_at`).bind(user.organizationId).all<Attachment>(),
    env.DB.prepare(`SELECT DISTINCT u.id,u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND u.status='active' ORDER BY u.display_name`).bind(user.organizationId).all<UserOption>()
  ]);
  return{user,status,exceptions:exceptions.results,attachments:attachments.results,users:users.results};
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse"),form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(intent==="create"){
    const barcode=valueOf(form,"barcode").toUpperCase(),type=valueOf(form,"exceptionType"),severity=valueOf(form,"severity"),description=valueOf(form,"description"),assignedTo=valueOf(form,"assignedTo")||null;
    if(!["damage","shortage","overage","wrong_label","wrong_location","other"].includes(type)||!["low","medium","high","critical"].includes(severity)||description.length<4)return{formError:"请完整填写异常类型、等级和说明"};
    const pkg=await env.DB.prepare("SELECT id,shipment_id,location_id,status FROM warehouse_packages WHERE organization_id=? AND barcode=?").bind(user.organizationId,barcode).first<{id:string;shipment_id:string;location_id:string;status:string}>();
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
    await writeAudit({request,action:"warehouse.exception.create",resourceType:"warehouse_exception",resourceId:id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{number,barcode,type,severity,photos:photos.length}});
    return{success:`异常 ${number} 已登记，货物已冻结`};
  }
  const exceptionId=valueOf(form,"exceptionId"),exception=await env.DB.prepare("SELECT id,package_id,status,previous_package_status,exception_number FROM warehouse_exceptions WHERE id=? AND organization_id=?").bind(exceptionId,user.organizationId).first<{id:string;package_id:string;status:string;previous_package_status:string;exception_number:string}>();
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
    await writeAudit({request,action:"warehouse.exception.resolve",resourceType:"warehouse_exception",resourceId:exception.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{resolution}});
    return{success:`${exception.exception_number} 已结案，货物已解除冻结`};
  }
  return{formError:"无效的异常操作"};
}

const typeLabels:Record<string,string>={damage:"破损",shortage:"短少",overage:"多货",wrong_label:"错标",wrong_location:"错位",other:"其他"};
const severityLabels:Record<string,string>={low:"低",medium:"中",high:"高",critical:"紧急"};
const statusLabels:Record<string,string>={open:"待处理",processing:"处理中",resolved:"已结案",cancelled:"已取消"};
export default function WarehouseExceptions({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",canOperate=loaderData.user.permissions.includes("warehouse.operate"),open=loaderData.exceptions.filter(x=>x.status==="open").length,processing=loaderData.exceptions.filter(x=>x.status==="processing").length,critical=loaderData.exceptions.filter(x=>x.severity==="critical"&&x.status!=="resolved").length;
  return <><header className="page-header"><div><p className="eyebrow">EXCEPTION & EVIDENCE</p><h1>异常与凭证</h1><p>登记破损、短少、多货、错标和错位，上传现场照片并跟踪处理结案。</p></div>{canOperate&&<Modal title="登记仓库异常" triggerLabel="＋ 登记异常" closeSignal={actionData?.success} size="wide"><Form method="post" encType="multipart/form-data" className="stack"><input type="hidden" name="intent" value="create"/><label className="field scan-field"><span>货物标签条码</span><input name="barcode" placeholder="扫描货物标签" autoComplete="off" required/></label><div className="form-grid compact"><label className="field"><span>异常类型</span><select name="exceptionType"><option value="damage">破损</option><option value="shortage">短少</option><option value="overage">多货</option><option value="wrong_label">错标</option><option value="wrong_location">错位</option><option value="other">其他</option></select></label><label className="field"><span>严重等级</span><select name="severity"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></label><label className="field"><span>处理负责人</span><select name="assignedTo"><option value="">暂不分配</option>{loaderData.users.map(x=><option key={x.id} value={x.id}>{x.display_name}</option>)}</select></label><label className="field"><span>现场图片（最多3张）</span><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple/></label></div><label className="field"><span>异常说明</span><textarea name="description" rows={4} required/></label><button className="primary" disabled={busy}>登记并冻结货物</button></Form></Modal>}</header>
    {(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
    <section className="stats"><article><span>待处理</span><strong>{open}</strong><small>等待现场认领</small></article><article><span>处理中</span><strong>{processing}</strong><small>已有负责人</small></article><article><span>紧急异常</span><strong>{critical}</strong><small>需要优先处理</small></article></section>
    <nav className="tabs exception-tabs"><a className={loaderData.status==="active"?"active":""} href="?status=active">未结案</a><a className={loaderData.status==="resolved"?"active":""} href="?status=resolved">已结案</a><a className={loaderData.status==="all"?"active":""} href="?status=all">全部</a></nav>
    <div className="exception-list">{loaderData.exceptions.map(item=><article className={`panel exception-card severity-${item.severity}`} key={item.id}><div className="panel-header"><div><div className="exception-title"><h2>{item.exception_number}</h2><span>{typeLabels[item.exception_type]}</span><span className={`severity-badge ${item.severity}`}>{severityLabels[item.severity]}</span></div><p>[{item.customer_identity_code}] {item.order_number} · {item.shipment_number} · {item.barcode} · {item.customer_name} · {item.location_name}</p></div><span className={`status-pill ${item.status==="resolved"?"":"off"}`}>{statusLabels[item.status]}</span></div><p className="exception-description">{item.description}</p><div className="evidence-grid">{loaderData.attachments.filter(x=>x.exception_id===item.id).map(photo=><a key={photo.id} href={photo.data_url} target="_blank" rel="noreferrer"><img src={photo.data_url} alt={photo.file_name}/><small>{photo.file_name}</small></a>)}</div><div className="exception-meta"><span>登记：{item.reporter_name||"系统"} · {new Date(item.reported_at).toLocaleString("zh-CN")}</span><span>负责人：{item.assignee_name||"未分配"}</span></div>{item.resolution&&<div className="resolution"><strong>处理结果</strong><p>{item.resolution}</p></div>}{canOperate&&["open","processing"].includes(item.status)&&<div className="page-actions exception-actions">{item.status==="open"&&<Form method="post"><input type="hidden" name="intent" value="processing"/><input type="hidden" name="exceptionId" value={item.id}/><button className="secondary" disabled={busy}>开始处理</button></Form>}<Modal title={`结案 ${item.exception_number}`} triggerLabel="处理结案" closeSignal={actionData?.success}><Form method="post" className="stack"><input type="hidden" name="intent" value="resolve"/><input type="hidden" name="exceptionId" value={item.id}/><label className="field"><span>处理结果</span><textarea name="resolution" rows={5} placeholder="说明检查结果、责任认定和处理措施" required/></label><button className="primary" disabled={busy}>确认结案并解除冻结</button></Form></Modal></div>}</article>)}</div>{!loaderData.exceptions.length&&<p className="empty-state">当前筛选条件下没有异常记录。</p>}
  </>;
}
async function toDataUrl(file:File){const bytes=new Uint8Array(await file.arrayBuffer());let binary="";const size=0x8000;for(let i=0;i<bytes.length;i+=size)binary+=String.fromCharCode(...bytes.subarray(i,i+size));return `data:${file.type};base64,${btoa(binary)}`}
function generateException(){return `EX-${new Date().toISOString().slice(2,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,5).toUpperCase()}`}
export function meta(){return[{title:"仓库异常与凭证 | International TMS"}]}
