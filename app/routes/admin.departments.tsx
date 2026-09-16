import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/admin.departments";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { ActionToast } from "../components/ActionToast";
import { OrganizationAccessTabs } from "../components/OrganizationAccessTabs";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { duplicateOrDatabaseError } from "../lib/db-errors.server";
import {
  buildDepartmentTree,
  departmentParentPath,
  type DepartmentTreeRow,
  type DepartmentTreeSource,
} from "../lib/department-tree";

type DepartmentRow = DepartmentTreeSource;

export async function loader({ request }:Route.LoaderArgs) {
  const current = await requireSessionUser(request,"department.view");
  const departments = await env.DB.prepare(`SELECT d.id,d.parent_id,d.code,d.name,d.status,d.sort_order,COUNT(m.id) AS member_count FROM departments d LEFT JOIN memberships m ON m.department_id=d.id AND m.organization_id=d.organization_id WHERE d.organization_id=? GROUP BY d.id ORDER BY d.sort_order,d.name`).bind(current.organizationId).all<DepartmentRow>();
  return { current, departments:departments.results };
}

export async function action({ request }:Route.ActionArgs) {
  const current = await requireSessionUser(request,"department.manage"), form = await request.formData(), intent=valueOf(form,"intent"), now=new Date().toISOString();
  if (intent==="toggle") {
    const id=valueOf(form,"departmentId"),next=valueOf(form,"status");
    if(!["active","disabled"].includes(next))return{formError:"部门目标状态无效"};
    const department=await env.DB.prepare("SELECT status FROM departments WHERE id=? AND organization_id=?").bind(id,current.organizationId).first<{status:string}>();
    if(!department)return{formError:"部门不存在"};
    if(department.status===next)return{formError:next==="active"?"部门已启用":"部门已停用"};
    const result=await env.DB.prepare("UPDATE departments SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status=?").bind(next,now,id,current.organizationId,department.status).run();
    if(!Number(result.meta?.changes||0))return{formError:"部门状态已被其他人修改，请刷新后查看"};
    await writeAudit({request,action:`department.${next}`,resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId});
    return{success:"部门状态已更新"};
  }
  const code=valueOf(form,"code").toUpperCase(),name=valueOf(form,"name"),parentId=valueOf(form,"parentId")||null,sortOrder=Number(valueOf(form,"sortOrder")||0);
  if(!/^[A-Z0-9-]{2,24}$/.test(code)||name.length<2||name.length>80||!Number.isSafeInteger(sortOrder))return{formError:"请填写有效的部门代码、名称和排序"};
  if(parentId){const parent=await env.DB.prepare("SELECT id FROM departments WHERE id=? AND organization_id=? AND status='active'").bind(parentId,current.organizationId).first();if(!parent)return{formError:"上级部门无效或已停用"};}
  if(intent==="update"){
    const id=valueOf(form,"departmentId");
    const existing=await env.DB.prepare("SELECT id,status FROM departments WHERE id=? AND organization_id=?").bind(id,current.organizationId).first<{id:string;status:string}>();
    if(!existing)return{formError:"部门不存在"};
    const status=existing.status;
    if(parentId){
      const cycle=await env.DB.prepare(`WITH RECURSIVE subtree(id) AS (SELECT id FROM departments WHERE id=? AND organization_id=? UNION ALL SELECT d.id FROM departments d JOIN subtree s ON d.parent_id=s.id WHERE d.organization_id=?) SELECT id FROM subtree WHERE id=? LIMIT 1`).bind(id,current.organizationId,current.organizationId,parentId).first();
      if(cycle)return{formError:"上级部门不能选择当前部门或其下级部门"};
    }
    try{await env.DB.prepare("UPDATE departments SET parent_id=?,code=?,name=?,status=?,sort_order=?,updated_at=? WHERE id=? AND organization_id=?").bind(parentId,code,name,status,sortOrder,now,id,current.organizationId).run();}catch(error){return{formError:duplicateOrDatabaseError(error,"部门代码不能重复")};}
    await writeAudit({request,action:"department.update",resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{code,name,parentId,status,sortOrder}});
    return{success:`部门 ${name} 已更新`};
  }
  const id=crypto.randomUUID();
  try{await env.DB.prepare("INSERT INTO departments(id,organization_id,parent_id,code,name,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)").bind(id,current.organizationId,parentId,code,name,sortOrder,now,now).run();}catch(error){return{formError:duplicateOrDatabaseError(error,"部门代码不能重复")};}
  await writeAudit({request,action:"department.create",resourceType:"department",resourceId:id,organizationId:current.organizationId,actorUserId:current.userId,metadata:{code,name,parentId}});
  return{success:`部门 ${name} 已创建`};
}

export default function Departments({loaderData,actionData}:Route.ComponentProps){
  const rows=buildDepartmentTree(loaderData.departments),canManage=loaderData.current.permissions.includes("department.manage"),busy=useNavigation().state!=="idle";
  const rootCount=rows.filter(row=>row.level===0&&!row.orphaned).length,childCount=rows.filter(row=>row.level>0).length,memberCount=rows.reduce((sum,row)=>sum+Number(row.member_count||0),0);
  return <><header className="page-header"><div><p className="eyebrow">ORGANIZATION TREE</p><h1>部门管理</h1><p>按树形结构维护总部、区域、业务部门和下级团队。</p></div>{canManage&&<Modal title="新增部门" triggerLabel="新增部门" closeSignal={actionData?.success}><Form method="post" className="stack department-config-form"><input type="hidden" name="intent" value="create"/><label className="field"><span>部门名称</span><input name="name" placeholder="例如：国际业务部" required/></label><label className="field"><span>部门代码</span><input name="code" placeholder="例如：INTL-SALES" required/></label><label className="field"><span>上级部门</span><select name="parentId"><option value="">无（一级部门）</option>{rows.filter(row=>row.status==="active").map(row=><option key={row.id} value={row.id}>{`${"　".repeat(row.level)}${row.name}`}</option>)}</select></label><label className="field"><span>排序</span><input name="sortOrder" type="number" step="1" defaultValue="10"/></label><button className="primary" disabled={busy}>创建部门</button></Form></Modal>}</header>
    <OrganizationAccessTabs permissions={loaderData.current.permissions}/>
    <ActionToast data={actionData}/>
    <section className="panel department-tree-panel"><div className="panel-header department-tree-panel-header"><div><h2>组织部门树</h2><p>优先展示拥有下级的组织根节点；仅调整阅读层级，不改变部门归属和数据权限。</p></div><div className="department-tree-summary" aria-label="组织概览"><span><b>{rootCount}</b> 个一级部门</span><span><b>{childCount}</b> 个下级部门</span><span><b>{memberCount}</b> 名在岗成员</span></div></div><div className="department-tree-scroll"><div className={`department-tree${canManage?"":" read-only"}`} role="treegrid" aria-label="组织部门树"><div className="department-tree-head" role="row"><span role="columnheader">部门层级</span><span role="columnheader">部门代码</span><span role="columnheader">成员</span><span role="columnheader">状态</span>{canManage&&<span role="columnheader">操作</span>}</div>{rows.map(row=><article className={`department-row${row.level===0?" is-root":""}${row.orphaned?" is-orphan":""}`} key={row.id} role="row" aria-level={row.level+1}><div className="department-branch" style={{paddingInlineStart:`${16+Math.min(row.level,8)*28}px`}} role="gridcell"><span className="department-node" aria-hidden="true"/><div><strong>{row.name}</strong><small>{departmentParentPath(row)}</small></div></div><code role="gridcell">{row.code}</code><span className="department-member-count" role="gridcell"><b>{row.member_count}</b><small>名成员</small></span><span role="gridcell"><span className={`status-pill ${row.status!=="active"?"off":""}`}>{row.status==="active"?"启用":"停用"}</span></span>{canManage&&<div className="department-actions" role="gridcell"><Modal title={`编辑 ${row.name}`} triggerLabel="编辑" triggerClassName="text-button" closeSignal={actionData?.success}><DepartmentEditForm department={row} rows={rows} busy={busy}/></Modal><Form method="post"><input type="hidden" name="intent" value="toggle"/><input type="hidden" name="departmentId" value={row.id}/><input type="hidden" name="status" value={row.status==="active"?"disabled":"active"}/>{row.status==="active"?<ConfirmAction title="停用部门" description={`停用后“${row.name}”不能再作为新增人员和下级部门的有效归属；现有成员与历史审计保留。`} triggerLabel="停用" confirmLabel="确认停用" pending={busy}/>:<button className="text-button" disabled={busy}>启用</button>}</Form></div>}</article>)}</div></div>{!rows.length&&<p className="empty-state">暂无部门，请点击右上角新增。</p>}</section>
  </>;
}

function DepartmentEditForm({department,rows,busy}:{department:DepartmentTreeRow;rows:DepartmentTreeRow[];busy:boolean}){
  const parents=allowedParents(rows,department.id).filter(row=>row.status==="active");
  return <Form method="post" className="stack department-config-form"><input type="hidden" name="intent" value="update"/><input type="hidden" name="departmentId" value={department.id}/><label className="field"><span>部门名称</span><input name="name" defaultValue={department.name} required/></label><label className="field"><span>部门代码</span><input name="code" defaultValue={department.code} required/></label><label className="field"><span>上级部门</span><select name="parentId" defaultValue={department.parent_id??""}><option value="">无（一级部门）</option>{parents.map(row=><option key={row.id} value={row.id}>{`${"　".repeat(row.level)}${row.name}`}</option>)}</select></label><label className="field"><span>排序</span><input name="sortOrder" type="number" step="1" defaultValue={department.sort_order}/></label><button className="primary" disabled={busy}>保存部门</button></Form>;
}

function allowedParents(rows:DepartmentTreeRow[],departmentId:string){
  const blocked=new Set([departmentId]);
  let changed=true;
  while(changed){changed=false;for(const row of rows)if(row.parent_id&&blocked.has(row.parent_id)&&!blocked.has(row.id)){blocked.add(row.id);changed=true;}}
  return rows.filter(row=>!blocked.has(row.id));
}
export function meta(){return[{title:"部门管理 | International TMS"}];}
