import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { CSSProperties } from "react";
import type { Route } from "./+types/admin.departments";
import { Modal } from "../components/Modal";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";

type DepartmentRow = { id:string; parent_id:string|null; code:string; name:string; status:string; sort_order:number; member_count:number };
type TreeRow = DepartmentRow & { level:number; path:string };

export async function loader({ request }:Route.LoaderArgs) {
  const current = await requireSessionUser(request,"department.view");
  const departments = await env.DB.prepare(`SELECT d.id,d.parent_id,d.code,d.name,d.status,d.sort_order,COUNT(m.id) AS member_count FROM departments d LEFT JOIN memberships m ON m.department_id=d.id AND m.organization_id=d.organization_id WHERE d.organization_id=? GROUP BY d.id ORDER BY d.sort_order,d.name`).bind(current.organizationId).all<DepartmentRow>();
  return { current, departments:departments.results };
}

export async function action({ request }:Route.ActionArgs) {
  const current = await requireSessionUser(request,"department.manage"), form = await request.formData(), intent=valueOf(form,"intent"), now=new Date().toISOString();
  if (intent==="toggle") {
    const id=valueOf(form,"departmentId");
    const department=await env.DB.prepare("SELECT status FROM departments WHERE id=? AND organization_id=?").bind(id,current.organizationId).first<{status:string}>();
    if(!department)return{formError:"部门不存在"};
    const next=department.status==="active"?"disabled":"active";
    await env.DB.prepare("UPDATE departments SET status=?,updated_at=? WHERE id=? AND organization_id=?").bind(next,now,id,current.organizationId).run();
    await writeAudit({request,action:`department.${next}`,resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId});
    return{success:"部门状态已更新"};
  }
  const code=valueOf(form,"code").toUpperCase(),name=valueOf(form,"name"),parentId=valueOf(form,"parentId")||null,sortOrder=Number(valueOf(form,"sortOrder")||0);
  if(!/^[A-Z0-9-]{2,24}$/.test(code)||name.length<2||name.length>80||!Number.isSafeInteger(sortOrder))return{formError:"请填写有效的部门代码、名称和排序"};
  if(parentId){const parent=await env.DB.prepare("SELECT id FROM departments WHERE id=? AND organization_id=? AND status='active'").bind(parentId,current.organizationId).first();if(!parent)return{formError:"上级部门无效或已停用"};}
  if(intent==="update"){
    const id=valueOf(form,"departmentId"),status=valueOf(form,"status");
    const existing=await env.DB.prepare("SELECT id FROM departments WHERE id=? AND organization_id=?").bind(id,current.organizationId).first();
    if(!existing||!["active","disabled"].includes(status))return{formError:"部门不存在或状态无效"};
    if(parentId){
      const cycle=await env.DB.prepare(`WITH RECURSIVE subtree(id) AS (SELECT id FROM departments WHERE id=? AND organization_id=? UNION ALL SELECT d.id FROM departments d JOIN subtree s ON d.parent_id=s.id WHERE d.organization_id=?) SELECT id FROM subtree WHERE id=? LIMIT 1`).bind(id,current.organizationId,current.organizationId,parentId).first();
      if(cycle)return{formError:"上级部门不能选择当前部门或其下级部门"};
    }
    try{await env.DB.prepare("UPDATE departments SET parent_id=?,code=?,name=?,status=?,sort_order=?,updated_at=? WHERE id=? AND organization_id=?").bind(parentId,code,name,status,sortOrder,now,id,current.organizationId).run();}catch{return{formError:"部门代码不能重复"};}
    await writeAudit({request,action:"department.update",resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{code,name,parentId,status,sortOrder}});
    return{success:`部门 ${name} 已更新`};
  }
  const id=crypto.randomUUID();
  try{await env.DB.prepare("INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)").bind(id,current.organizationId,parentId,code,name,sortOrder,now,now).run();}catch{return{formError:"部门代码不能重复"};}
  await writeAudit({request,action:"department.create",resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{code,name,parentId}});
  return{success:`部门 ${name} 已创建`};
}

export default function Departments({loaderData,actionData}:Route.ComponentProps){
  const rows=buildTree(loaderData.departments),canManage=loaderData.current.permissions.includes("department.manage"),busy=useNavigation().state!=="idle";
  return <><header className="page-header"><div><p className="eyebrow">ORGANIZATION TREE</p><h1>部门管理</h1><p>按树形结构维护总部、区域、业务部门和下级团队。</p></div>{canManage&&<Modal title="新增部门" triggerLabel="新增部门" closeSignal={actionData?.success}><Form method="post" className="stack department-config-form"><input type="hidden" name="intent" value="create"/><label className="field"><span>部门名称</span><input name="name" placeholder="例如：国际业务部" required/></label><label className="field"><span>部门代码</span><input name="code" placeholder="例如：INTL-SALES" required/></label><label className="field"><span>上级部门</span><select name="parentId"><option value="">无（一级部门）</option>{rows.filter(row=>row.status==="active").map(row=><option key={row.id} value={row.id}>{`${"　".repeat(row.level)}${row.name}`}</option>)}</select></label><label className="field"><span>排序</span><input name="sortOrder" type="number" step="1" defaultValue="10"/></label><button className="primary" disabled={busy}>创建部门</button></Form></Modal>}</header>
    {(actionData?.success||actionData?.formError)&&<div className={`alert ${actionData.formError?"error":"success"}`}>{actionData.formError??actionData.success}</div>}
    <section className="panel"><div className="panel-header"><div><h2>组织部门树</h2><p>支持不限层级的父子部门结构。</p></div><span className="status-pill">{rows.length} 个部门</span></div><div className="department-tree">{rows.map(row=><article className={`department-row level-${Math.min(row.level,5)}`} key={row.id}><div className="department-branch" style={{"--department-level":row.level} as CSSProperties}><span className="department-node">{row.level===0?"◆":"└"}</span><div><strong>{row.name}</strong><small>{row.path}</small></div></div><code>{row.code}</code><span>{row.member_count} 名成员</span><span className={`status-pill ${row.status!=="active"?"off":""}`}>{row.status==="active"?"启用":"停用"}</span>{canManage&&<div className="department-actions"><Modal title={`编辑 ${row.name}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={actionData?.success}><DepartmentEditForm department={row} rows={rows} busy={busy}/></Modal><Form method="post"><input type="hidden" name="intent" value="toggle"/><input type="hidden" name="departmentId" value={row.id}/><button className="text-button" disabled={busy}>{row.status==="active"?"停用":"启用"}</button></Form></div>}</article>)}</div>{!rows.length&&<p className="empty-state">暂无部门，请点击右上角新增。</p>}</section>
  </>;
}

function DepartmentEditForm({department,rows,busy}:{department:TreeRow;rows:TreeRow[];busy:boolean}){
  const parents=allowedParents(rows,department.id).filter(row=>row.status==="active");
  return <Form method="post" className="stack department-config-form"><input type="hidden" name="intent" value="update"/><input type="hidden" name="departmentId" value={department.id}/><label className="field"><span>部门名称</span><input name="name" defaultValue={department.name} required/></label><label className="field"><span>部门代码</span><input name="code" defaultValue={department.code} required/></label><label className="field"><span>上级部门</span><select name="parentId" defaultValue={department.parent_id??""}><option value="">无（一级部门）</option>{parents.map(row=><option key={row.id} value={row.id}>{`${"　".repeat(row.level)}${row.name}`}</option>)}</select></label><label className="field"><span>排序</span><input name="sortOrder" type="number" step="1" defaultValue={department.sort_order}/></label><label className="field"><span>状态</span><select name="status" defaultValue={department.status}><option value="active">启用</option><option value="disabled">停用</option></select></label><button className="primary" disabled={busy}>保存部门</button></Form>;
}

function allowedParents(rows:TreeRow[],departmentId:string){
  const blocked=new Set([departmentId]);
  let changed=true;
  while(changed){changed=false;for(const row of rows)if(row.parent_id&&blocked.has(row.parent_id)&&!blocked.has(row.id)){blocked.add(row.id);changed=true;}}
  return rows.filter(row=>!blocked.has(row.id));
}

function buildTree(departments:DepartmentRow[]):TreeRow[]{
  const children=new Map<string|null,DepartmentRow[]>();
  for(const department of departments){const group=children.get(department.parent_id)??[];group.push(department);children.set(department.parent_id,group);}
  const result:TreeRow[]=[],visited=new Set<string>();
  const visit=(parentId:string|null,level:number,parentPath:string)=>{for(const department of children.get(parentId)??[]){if(visited.has(department.id))continue;visited.add(department.id);const path=parentPath?`${parentPath} / ${department.name}`:department.name;result.push({...department,level,path});visit(department.id,level+1,path);}};
  visit(null,0,"");
  for(const department of departments)if(!visited.has(department.id))result.push({...department,level:0,path:`未关联 / ${department.name}`});
  return result;
}
export function meta(){return[{title:"部门管理 | International TMS"}];}
