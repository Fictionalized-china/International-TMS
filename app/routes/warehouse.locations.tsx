import { env } from "cloudflare:workers";
import { Form, useNavigation } from "react-router";
import { useEffect, useState, type ReactElement } from "react";
import type { Route } from "./+types/warehouse.locations";
import { Modal } from "../components/Modal";
import { ConfirmAction } from "../components/ConfirmAction";
import { ActionToast } from "../components/ActionToast";
import { requireSessionUser } from "../lib/auth.server";
import { writeAudit } from "../lib/audit.server";
import { valueOf } from "../lib/validation";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { chunkD1Rows, chunkD1Values, d1Placeholders } from "../lib/d1-bindings";

type Warehouse={id:string;code:string;name:string;country_code:string|null;city:string|null;address:string|null;status:string;zone_count:number;location_count:number};
type Zone={id:string;warehouse_id:string;code:string;name:string;zone_type:string;status:string;location_count:number};
type Location={id:string;warehouse_id:string;zone_id:string;code:string;name:string;barcode:string|null;capacity_cbm:number|null;status:string};

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const warehouseContext=await loadWarehouseContext(request,user),warehouse=warehouseContext.selected;
  const [warehouses,zones,locations]=await Promise.all([
    env.DB.prepare(`SELECT w.id,w.code,w.name,w.country_code,w.city,w.address,w.status,COUNT(DISTINCT z.id) zone_count,COUNT(DISTINCT l.id) location_count FROM warehouses w LEFT JOIN warehouse_zones z ON z.warehouse_id=w.id LEFT JOIN warehouse_locations l ON l.warehouse_id=w.id WHERE w.organization_id=? AND w.id=? GROUP BY w.id ORDER BY w.code`).bind(user.organizationId,warehouse.id).all<Warehouse>(),
    env.DB.prepare(`SELECT z.id,z.warehouse_id,z.code,z.name,z.zone_type,z.status,COUNT(l.id) location_count FROM warehouse_zones z LEFT JOIN warehouse_locations l ON l.zone_id=z.id WHERE z.organization_id=? AND z.warehouse_id=? GROUP BY z.id ORDER BY z.code`).bind(user.organizationId,warehouse.id).all<Zone>(),
    env.DB.prepare("SELECT id,warehouse_id,zone_id,code,name,barcode,capacity_cbm,status FROM warehouse_locations WHERE organization_id=? AND warehouse_id=? ORDER BY zone_id,code").bind(user.organizationId,warehouse.id).all<Location>()
  ]);
  return{user,warehouse,warehouses:warehouses.results,zones:zones.results,locations:locations.results};
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.manage","warehouse"),form=await request.formData(),intent=valueOf(form,"intent"),entity=valueOf(form,"entity"),now=new Date().toISOString();
  if(intent==="toggle"){
    const id=valueOf(form,"id"),status=valueOf(form,"status"),table=entity==="zone"?"warehouse_zones":entity==="location"?"warehouse_locations":"";
    if(entity==="warehouse")return{formError:"请在管理后台的仓库管理中停用仓库，避免中断当前现场会话"};
    if(!table)return{formError:"无效的配置类型"};
    if(!["active","disabled"].includes(status))return{formError:"配置目标状态无效"};
    const row=await env.DB.prepare(`SELECT status FROM ${table} WHERE id=? AND organization_id=?`).bind(id,user.organizationId).first<{status:string}>();
    if(!row)return{formError:"配置不存在"};
    if(row.status===status)return{formError:status==="active"?"配置已启用":"配置已停用"};
    const result=await env.DB.prepare(`UPDATE ${table} SET status=?,updated_at=? WHERE id=? AND organization_id=? AND status=?`).bind(status,now,id,user.organizationId,row.status).run();
    if(!Number(result.meta?.changes||0))return{formError:"配置状态已被其他人修改，请刷新后查看"};
    await writeAudit({request,action:`warehouse.${entity}.${status}`,resourceType:entity,resourceId:id,organizationId:user.organizationId,actorUserId:user.userId});
    return{success:"状态已更新"};
  }
  if(entity==="location_batch"){
    const zoneId=valueOf(form,"zoneId"),prefix=valueOf(form,"prefix").toUpperCase().replace(/-+$/,""),namePrefix=valueOf(form,"namePrefix")||"库位",start=Number(valueOf(form,"start")||1),count=Number(valueOf(form,"count")||0),padding=Number(valueOf(form,"padding")||2),capacity=Number(valueOf(form,"capacity")||0);
    if(!/^[A-Z0-9-]{1,16}$/.test(prefix)||namePrefix.length>40||!Number.isSafeInteger(start)||start<0||start>99999||!Number.isSafeInteger(count)||count<1||count>200||!Number.isSafeInteger(padding)||padding<1||padding>5||capacity<0)return{formError:"请填写有效的批量生成参数，每次最多生成 200 个库位"};
    const zone=await env.DB.prepare(`SELECT z.id,z.code zone_code,z.warehouse_id,w.code warehouse_code FROM warehouse_zones z JOIN warehouses w ON w.id=z.warehouse_id WHERE z.id=? AND z.organization_id=? AND z.status='active' AND w.status='active'`).bind(zoneId,user.organizationId).first<{id:string;zone_code:string;warehouse_id:string;warehouse_code:string}>();
    if(!zone)return{formError:"请选择有效的启用库区"};
    const generated=Array.from({length:count},(_,index)=>{const sequence=String(start+index).padStart(padding,"0"),code=`${prefix}-${sequence}`;return{code,name:`${namePrefix}${sequence}`,barcode:`LOC-${zone.warehouse_code}-${zone.zone_code}-${code}`};});
    if(generated.some(item=>item.code.length>24))return{formError:"生成后的库位代码超过 24 位，请缩短前缀或补零位数"};
    const existingCodes:string[]=[];
    for(const codeChunk of chunkD1Values(generated.map(item=>item.code),1)){
      const existing=await env.DB.prepare(`SELECT code FROM warehouse_locations WHERE warehouse_id=? AND code IN (${d1Placeholders(codeChunk.length)})`).bind(zone.warehouse_id,...codeChunk).all<{code:string}>();
      existingCodes.push(...existing.results.map(item=>item.code));
    }
    if(existingCodes.length)return{formError:`以下库位代码已存在：${existingCodes.slice(0,8).join("、")}${existingCodes.length>8?"…":""}`};
    const insertStatements:D1PreparedStatement[]=[];
    for(const itemChunk of chunkD1Rows(generated,10)){
      const valuesSql=itemChunk.map(()=>"(?,?,?,?,?,?,?,?,'active',?,?)").join(",");
      const bindings=itemChunk.flatMap(item=>[crypto.randomUUID(),user.organizationId,zone.warehouse_id,zone.id,item.code,item.name,item.barcode,capacity>0?capacity:null,now,now]);
      insertStatements.push(env.DB.prepare(`INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,barcode,capacity_cbm,status,created_at,updated_at) VALUES ${valuesSql}`).bind(...bindings));
    }
    await env.DB.batch(insertStatements);
    await writeAudit({request,action:"warehouse.location.batch_create",resourceType:"warehouse_location",organizationId:user.organizationId,actorUserId:user.userId,metadata:{zoneId,prefix,start,count,padding,capacity}});
    return{success:`已批量生成 ${count} 个库位（${generated[0].code} 至 ${generated[generated.length-1]?.code}）`};
  }
  const code=valueOf(form,"code").toUpperCase(),name=valueOf(form,"name");
  if(!/^[A-Z0-9-]{2,24}$/.test(code)||name.length<1||name.length>80)return{formError:"请填写有效的名称和代码（代码仅限字母、数字和横线）"};
  try{
    if(entity==="warehouse"){
      const country=valueOf(form,"country").toUpperCase(),city=valueOf(form,"city"),address=valueOf(form,"address");
      await env.DB.prepare("INSERT INTO warehouses(id,organization_id,code,name,country_code,city,address,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?)").bind(crypto.randomUUID(),user.organizationId,code,name,country||null,city||null,address||null,now,now).run();
    }else if(entity==="zone"){
      const warehouseId=valueOf(form,"warehouseId"),zoneType=valueOf(form,"zoneType");
      const parent=await env.DB.prepare("SELECT id FROM warehouses WHERE id=? AND organization_id=? AND status='active'").bind(warehouseId,user.organizationId).first();
      if(!parent)return{formError:"请选择有效的启用仓库"};
      await env.DB.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,zone_type,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)").bind(crypto.randomUUID(),user.organizationId,warehouseId,code,name,zoneType,now,now).run();
    }else if(entity==="location"){
      const zoneId=valueOf(form,"zoneId"),barcode=valueOf(form,"barcode"),capacity=Number(valueOf(form,"capacity")||0);
      const zone=await env.DB.prepare("SELECT id,warehouse_id FROM warehouse_zones WHERE id=? AND organization_id=? AND status='active'").bind(zoneId,user.organizationId).first<{id:string;warehouse_id:string}>();
      if(!zone)return{formError:"请选择有效的启用库区"};
      await env.DB.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,barcode,capacity_cbm,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'active',?,?)").bind(crypto.randomUUID(),user.organizationId,zone.warehouse_id,zoneId,code,name,barcode||null,capacity>0?capacity:null,now,now).run();
    }else return{formError:"无效的配置类型"};
  }catch{return{formError:"代码或条码不能重复，请检查后重试"};}
  await writeAudit({request,action:`warehouse.${entity}.create`,resourceType:entity,organizationId:user.organizationId,actorUserId:user.userId,metadata:{code,name}});
  return{success:`${name} 已创建`};
}

const zoneLabels:Record<string,string>={receiving:"收货区",storage:"存储区",sorting:"分拣区",staging:"集货区",exception:"异常区",dispatch:"出库区"};

export default function WarehouseLocations({loaderData,actionData}:Route.ComponentProps){
  const canManage=loaderData.user.permissions.includes("warehouse.manage"),busy=useNavigation().state!=="idle";
  return <><header className="page-header"><div><p className="eyebrow">WAREHOUSE MASTER DATA</p><h1>仓库与库位</h1><p>按仓库、库区、库位三级结构管理现场作业位置和扫描条码。</p></div>{canManage&&<div className="page-actions"><Modal title="新增仓库" triggerLabel="＋ 新增仓库" closeSignal={actionData?.success}><WarehouseForm busy={busy}/></Modal><Modal title="新增库区" triggerLabel="新增库区" triggerClassName="secondary" closeSignal={actionData?.success}><ZoneForm warehouses={loaderData.warehouses} busy={busy}/></Modal><Modal title="新增库位" triggerLabel="新增库位" triggerClassName="secondary" closeSignal={actionData?.success}><LocationForm zones={loaderData.zones} busy={busy}/></Modal><Modal title="批量生成库位" triggerLabel="批量生成库位" triggerClassName="secondary" closeSignal={actionData?.success} size="wide"><BatchLocationForm zones={loaderData.zones} busy={busy}/></Modal></div>}</header>
    <ActionToast data={actionData}/>
    <section className="stats"><article><span>仓库</span><strong>{loaderData.warehouses.length}</strong><small>独立作业场地</small></article><article><span>库区</span><strong>{loaderData.zones.length}</strong><small>按作业用途划分</small></article><article><span>库位</span><strong>{loaderData.locations.length}</strong><small>支持条码识别</small></article></section>
    <section className="warehouse-tree">{loaderData.warehouses.map(warehouse=><article className="panel" key={warehouse.id}><div className="panel-header"><div><h2>{warehouse.name} <code>{warehouse.code}</code></h2><p>{[warehouse.country_code,warehouse.city,warehouse.address].filter(Boolean).join(" · ")||"尚未设置地址"}</p></div><div className="page-actions"><span className={`status-pill ${warehouse.status!=="active"?"off":""}`}>{warehouse.status==="active"?"启用":"停用"}</span><small>仓库状态请在管理后台维护</small></div></div>
      <div className="location-groups">{loaderData.zones.filter(zone=>zone.warehouse_id===warehouse.id).map(zone=><section className="location-zone" key={zone.id}><header><div><strong>{zone.name}</strong><small>{zone.code} · {zoneLabels[zone.zone_type]??zone.zone_type}</small></div><div className="page-actions"><span>{zone.location_count} 个库位</span><span className={`status-pill ${zone.status!=="active"?"off":""}`}>{zone.status==="active"?"启用":"停用"}</span>{canManage&&<Toggle entity="zone" id={zone.id} active={zone.status==="active"} label={zone.name}/>}</div></header><div className="location-list">{loaderData.locations.filter(location=>location.zone_id===zone.id).map(location=><div className="location-card" key={location.id}><div><strong>{location.name}</strong><code>{location.code}</code></div><small>条码：{location.barcode||"使用库位代码"}{location.capacity_cbm?` · 容量 ${location.capacity_cbm} CBM`:""}</small><div className="page-actions"><span className={`status-pill ${location.status!=="active"?"off":""}`}>{location.status==="active"?"可用":"停用"}</span><div className="page-actions"><LocationLabelPrinter warehouse={warehouse.name} zone={zone.name} location={location}/>{canManage&&<Toggle entity="location" id={location.id} active={location.status==="active"} label={location.name}/>}</div></div></div>)}</div>{!zone.location_count&&<p className="empty-state">该库区还没有库位。</p>}</section>)}</div>{!warehouse.zone_count&&<p className="empty-state">该仓库还没有库区。</p>}</article>)}</section>
    {!loaderData.warehouses.length&&<p className="empty-state">暂无仓库，请先新增仓库。</p>}
  </>;
}

function Toggle({entity,id,active,label}:{entity:"zone"|"location";id:string;active:boolean;label:string}){return <Form method="post"><input type="hidden" name="intent" value="toggle"/><input type="hidden" name="entity" value={entity}/><input type="hidden" name="id" value={id}/><input type="hidden" name="status" value={active?"disabled":"active"}/>{active?<ConfirmAction title={entity==="zone"?"停用库区":"停用库位"} description={`停用后“${label}”不能再用于新的仓储作业；既有库存和扫描审计保留。`} triggerLabel="停用" confirmLabel="确认停用"/>:<button className="text-button">启用</button>}</Form>}
function WarehouseForm({busy}:{busy:boolean}){return <Form method="post" className="stack"><input type="hidden" name="entity" value="warehouse"/><label className="field"><span>仓库名称</span><input name="name" required/></label><label className="field"><span>仓库代码</span><input name="code" placeholder="URC-01" required/></label><div className="form-grid compact"><label className="field"><span>国家代码</span><input name="country" placeholder="CN"/></label><label className="field"><span>城市</span><input name="city"/></label></div><label className="field"><span>详细地址</span><input name="address"/></label><button className="primary" disabled={busy}>创建仓库</button></Form>}
function ZoneForm({warehouses,busy}:{warehouses:Warehouse[];busy:boolean}){return <Form method="post" className="stack"><input type="hidden" name="entity" value="zone"/><label className="field"><span>所属仓库</span><select name="warehouseId" required>{warehouses.filter(x=>x.status==="active").map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label className="field"><span>库区名称</span><input name="name" required/></label><label className="field"><span>库区代码</span><input name="code" placeholder="SORT-A" required/></label><label className="field"><span>库区类型</span><select name="zoneType">{Object.entries(zoneLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className="primary" disabled={busy}>创建库区</button></Form>}
function LocationForm({zones,busy}:{zones:Zone[];busy:boolean}){return <Form method="post" className="stack"><input type="hidden" name="entity" value="location"/><label className="field"><span>所属库区</span><select name="zoneId" required>{zones.filter(x=>x.status==="active").map(x=><option key={x.id} value={x.id}>{x.name}（{x.code}）</option>)}</select></label><label className="field"><span>库位名称</span><input name="name" required/></label><label className="field"><span>库位代码</span><input name="code" placeholder="A-01-01" required/></label><label className="field"><span>扫描条码</span><input name="barcode" placeholder="不填可后续生成"/></label><label className="field"><span>容量 CBM</span><input name="capacity" type="number" min="0" step="0.001"/></label><button className="primary" disabled={busy}>创建库位</button></Form>}
function BatchLocationForm({zones,busy}:{zones:Zone[];busy:boolean}){return <Form method="post" className="stack"><input type="hidden" name="entity" value="location_batch"/><label className="field"><span>所属库区</span><select name="zoneId" required>{zones.filter(x=>x.status==="active").map(x=><option key={x.id} value={x.id}>{x.name}（{x.code}）</option>)}</select></label><div className="form-grid compact"><label className="field"><span>代码前缀</span><input name="prefix" defaultValue="A" placeholder="例如 A-01" required/><small>系统将生成 A-01、A-02……</small></label><label className="field"><span>名称前缀</span><input name="namePrefix" defaultValue="库位" placeholder="例如 A区库位"/></label><label className="field"><span>起始序号</span><input name="start" type="number" min="0" max="99999" step="1" defaultValue="1" required/></label><label className="field"><span>生成数量</span><input name="count" type="number" min="1" max="200" step="1" defaultValue="20" required/><small>每次最多 200 个</small></label><label className="field"><span>序号位数</span><select name="padding" defaultValue="2"><option value="1">1 位（1）</option><option value="2">2 位（01）</option><option value="3">3 位（001）</option><option value="4">4 位（0001）</option><option value="5">5 位（00001）</option></select></label><label className="field"><span>统一容量 CBM</span><input name="capacity" type="number" min="0" step="0.001" placeholder="可不填"/></label></div><div className="batch-preview"><strong>生成规则示例</strong><span>前缀 A，起始 1，数量 20，序号 2 位 → A-01 至 A-20</span><small>扫描条码将自动包含仓库、库区和库位代码。</small></div><button className="primary" disabled={busy}>确认批量生成</button></Form>}
function LocationLabelPrinter({warehouse,zone,location}:{warehouse:string;zone:string;location:Location}){const[printing,setPrinting]=useState(false),barcode=(location.barcode||location.code).toUpperCase().replace(/[^A-Z0-9-]/g,"-");useEffect(()=>{if(!printing)return;const done=()=>setPrinting(false);window.addEventListener("afterprint",done,{once:true});const timer=window.setTimeout(()=>window.print(),50);return()=>{window.clearTimeout(timer);window.removeEventListener("afterprint",done)}},[printing]);return <><button type="button" className="text-button" onClick={()=>setPrinting(true)}>打印</button>{printing&&<div className="location-print-layer"><article className="location-label"><header><strong>OULING 欧凌国际物流</strong><span>库位标签</span></header><h1>{location.code}</h1><h2>{location.name}</h2><LocationBarcode value={barcode}/><b>{barcode}</b><dl><div><dt>仓库</dt><dd>{warehouse}</dd></div><div><dt>库区</dt><dd>{zone}</dd></div>{location.capacity_cbm&&<div><dt>容量</dt><dd>{location.capacity_cbm} CBM</dd></div>}</dl></article></div>}</>}
function LocationBarcode({value}:{value:string}){const patterns:Record<string,string>={"0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn","A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn","F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn","K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn","P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn","U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn","Z":"nwwnwnnnn","-":"nwnnnnwnw","*":"nwnnwnwnn"};let x=0;const bars:ReactElement[]=[];for(const char of `*${value}*`){for(const[index,width]of[...(patterns[char]??patterns["-"])].entries()){const size=width==="w"?3:1;if(index%2===0)bars.push(<rect key={`${x}-${index}`} x={x} y="0" width={size} height="48"/>);x+=size}x+=1}return <svg className="location-barcode" viewBox={`0 0 ${x} 48`} preserveAspectRatio="none">{bars}</svg>}
export function meta(){return[{title:"仓库与库位 | International TMS"}]}
