import { env } from "cloudflare:workers";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/warehouse.cargo-consolidation";
import { Modal } from "../components/Modal";
import { writeAudit } from "../lib/audit.server";
import { requireSessionUser } from "../lib/auth.server";
import { ensureOrderModules, syncOrderWorkflowSnapshot } from "../lib/order-modules.server";
import { requireWarehouseAssignment } from "../lib/warehouse-access.server";
import { loadWarehouseContext } from "../lib/warehouse-context.server";
import { valueOf } from "../lib/validation";

const DEFAULT_PAGE_SIZE=30;
const PAGE_SIZES=[30,50,100];

type StockRow={
  order_id:string;order_number:string;business_type:string;customer_name:string;
  cargo_names:string|null;overseas_warehouse_id:string|null;overseas_warehouse_name:string|null;
  destination_country:string;destination_state:string|null;destination_city:string;
  exit_port:string|null;customs_location:string|null;package_count:number;pieces:number;
  weight_kg:number;volume_cbm:number;location_names:string|null;cargo_ready:number;
  has_exception:number;active_dispatch:number;active_batch_id:string|null;active_batch_number:string|null;
};

type BatchRow={
  id:string;batch_number:string;batch_name:string;destination_location:string;
  border_port:string|null;customs_location:string|null;planned_loading_at:string|null;
  status:string;road_status:string;order_count:number;order_numbers:string;
  total_weight:number;total_volume:number;has_dispatch:number;has_started:number;created_at:string;
};

type BatchOrder={batch_id:string;order_id:string;order_number:string;customer_name:string;cargo_names:string|null;weight_kg:number;volume_cbm:number};
type Selection={orderId:string;orderNumber:string;customerName:string;packages:number;pieces:number;weight:number;volume:number};
type CandidateState=StockRow&{origin_country:string;origin_state:string|null;origin_city:string};
type TargetBatch={id:string;batch_number:string;warehouse_id:string;status:string;destination_location:string;border_port:string|null;customs_location:string|null};

const stockCtes=`WITH stock AS (
    SELECT s.order_id,COUNT(p.id) package_count,COALESCE(SUM(p.pieces),0) pieces,
      COALESCE(SUM(p.weight_kg),0) weight_kg,COALESCE(SUM(p.volume_cbm),0) volume_cbm,
      GROUP_CONCAT(DISTINCT wl.name) location_names
    FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id
    LEFT JOIN warehouse_locations wl ON wl.id=p.location_id
    WHERE p.organization_id=? AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')
    GROUP BY s.order_id
  ), ready AS (
    SELECT DISTINCT s.order_id FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id
    WHERE r.organization_id=? AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1
  ), exception_orders AS (
    SELECT DISTINCT s.order_id FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id
    WHERE e.organization_id=? AND e.status IN ('open','processing')
  ), dispatch_orders AS (
    SELECT DISTINCT s.order_id FROM warehouse_dispatches d
    JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id
    JOIN shipments s ON s.id=p.shipment_id
    WHERE d.organization_id=? AND p.warehouse_id=? AND d.status!='cancelled'
  ), active_batch AS (
    SELECT bo.order_id,b.id batch_id,b.batch_number,
      ROW_NUMBER() OVER(PARTITION BY bo.order_id ORDER BY b.updated_at DESC) row_no
    FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    WHERE bo.organization_id=? AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%'
  )`;
const stockFrom=` FROM stock st JOIN transport_orders o ON o.id=st.order_id
  JOIN customers c ON c.id=o.customer_id
  LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id AND ow.organization_id=o.organization_id
  LEFT JOIN active_batch ab ON ab.order_id=o.id AND ab.row_no=1
  LEFT JOIN ready rr ON rr.order_id=o.id LEFT JOIN exception_orders eo ON eo.order_id=o.id
  LEFT JOIN dispatch_orders dd ON dd.order_id=o.id WHERE 1=1`;

function stockBindings(organizationId:string,warehouseId:string){return[organizationId,warehouseId,organizationId,warehouseId,organizationId,organizationId,warehouseId,organizationId]}
function rowSelectSql(){return`SELECT o.id order_id,o.order_number,o.business_type,c.name customer_name,
    (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
    o.overseas_warehouse_id,ow.name overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city,
    o.exit_port,o.customs_location,st.package_count,st.pieces,st.weight_kg,st.volume_cbm,st.location_names,
    CASE WHEN rr.order_id IS NULL THEN 0 ELSE 1 END cargo_ready,
    CASE WHEN eo.order_id IS NULL THEN 0 ELSE 1 END has_exception,
    CASE WHEN dd.order_id IS NULL THEN 0 ELSE 1 END active_dispatch,
    ab.batch_id active_batch_id,ab.batch_number active_batch_number`}

export async function loader({request}:Route.LoaderArgs){
  const user=await requireSessionUser(request,"warehouse.view","warehouse");
  const context=await loadWarehouseContext(request,user),warehouse=context.selected;
  if(warehouse.warehouse_role==="overseas_destination")throw new Response("境外目的仓不办理货物配载",{status:403});
  const url=new URL(request.url),page=Math.max(1,Number(url.searchParams.get("page"))||1);
  const requestedSize=Number(url.searchParams.get("pageSize"))||DEFAULT_PAGE_SIZE;
  const pageSize=PAGE_SIZES.includes(requestedSize)?requestedSize:DEFAULT_PAGE_SIZE;
  const filters={warehouse:url.searchParams.get("destinationWarehouse")?.trim()??"",country:url.searchParams.get("country")?.trim()??"",state:url.searchParams.get("state")?.trim()??"",city:url.searchParams.get("city")?.trim()??"",borderPort:url.searchParams.get("borderPort")?.trim()??"",customs:url.searchParams.get("customs")?.trim()??"",customer:url.searchParams.get("customer")?.trim()??"",eligibility:url.searchParams.get("eligibility")?.trim()??"",keyword:url.searchParams.get("q")?.trim()??""};
  const clauses:string[]=[],bindings:string[]=[];
  const like=(column:string,value:string)=>{if(value){clauses.push(`${column} LIKE ?`);bindings.push(`%${value}%`)}};
  like("COALESCE(ow.name,'')",filters.warehouse);like("o.destination_country",filters.country);like("COALESCE(o.destination_state,'')",filters.state);like("o.destination_city",filters.city);like("COALESCE(o.exit_port,'')",filters.borderPort);like("COALESCE(o.customs_location,'')",filters.customs);like("c.name",filters.customer);
  if(filters.keyword){clauses.push("(o.order_number LIKE ? OR c.name LIKE ? OR COALESCE(o.cargo_description,'') LIKE ? OR EXISTS(SELECT 1 FROM order_cargo_items qi WHERE qi.order_id=o.id AND COALESCE(qi.cargo_name_cn,'') LIKE ?))");bindings.push(...Array(4).fill(`%${filters.keyword}%`))}
  if(filters.eligibility==="eligible")clauses.push("o.business_type='ltl' AND rr.order_id IS NOT NULL AND eo.order_id IS NULL AND dd.order_id IS NULL AND ab.batch_id IS NULL");
  if(filters.eligibility==="blocked")clauses.push("(o.business_type!='ltl' OR rr.order_id IS NULL OR eo.order_id IS NOT NULL OR dd.order_id IS NOT NULL OR ab.batch_id IS NOT NULL)");
  const filterSql=clauses.length?` AND ${clauses.join(" AND ")}`:"",baseBindings=stockBindings(user.organizationId,warehouse.id);
  const totalRow=await env.DB.prepare(`${stockCtes} SELECT COUNT(*) total ${stockFrom}${filterSql}`).bind(...baseBindings,...bindings).first<{total:number}>();
  const total=totalRow?.total??0,pages=Math.max(1,Math.ceil(total/pageSize)),safePage=Math.min(page,pages);
  const [rows,options,batches,batchOrders]=await Promise.all([
    env.DB.prepare(`${stockCtes} ${rowSelectSql()} ${stockFrom}${filterSql} ORDER BY CASE WHEN ab.batch_id IS NULL THEN 0 ELSE 1 END,o.updated_at DESC LIMIT ? OFFSET ?`).bind(...baseBindings,...bindings,pageSize,(safePage-1)*pageSize).all<StockRow>(),
    env.DB.prepare(`${stockCtes} SELECT DISTINCT COALESCE(ow.name,'') overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city,o.exit_port,o.customs_location,c.name customer_name ${stockFrom} ORDER BY overseas_warehouse_name,o.destination_country,o.destination_state,o.destination_city`).bind(...baseBindings).all<StockRow&{customer_name:string}>(),
    env.DB.prepare(`SELECT b.id,b.batch_number,b.batch_name,b.destination_location,b.border_port,b.customs_location,b.planned_loading_at,b.status,b.road_status,b.created_at,
      COUNT(DISTINCT bo.order_id) order_count,GROUP_CONCAT(DISTINCT o.order_number) order_numbers,
      COALESCE(SUM((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated'))),0) total_weight,
      COALESCE(SUM((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated'))),0) total_volume,
      EXISTS(SELECT 1 FROM warehouse_dispatches d WHERE d.transport_batch_id=b.id AND d.status!='cancelled') has_dispatch,
      EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id
        WHERE d.transport_batch_id=b.id AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending')) has_started
      FROM transport_batches b JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      GROUP BY b.id ORDER BY b.updated_at DESC LIMIT 30`).bind(user.organizationId,warehouse.id).all<BatchRow>(),
    env.DB.prepare(`SELECT bo.batch_id,o.id order_id,o.order_number,c.name customer_name,
      (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
      COALESCE((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated')),0) weight_kg,
      COALESCE((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id=o.id AND p.warehouse_id=b.warehouse_id AND p.status IN ('in_stock','allocated')),0) volume_cbm
      FROM transport_batches b JOIN transport_batch_orders bo ON bo.batch_id=b.id AND bo.status!='removed'
      JOIN transport_orders o ON o.id=bo.order_id JOIN customers c ON c.id=o.customer_id
      WHERE b.organization_id=? AND b.warehouse_id=? AND b.batch_number LIKE 'PZ-%' AND b.status!='cancelled'
      ORDER BY b.updated_at DESC,bo.sequence_no LIMIT 500`).bind(user.organizationId,warehouse.id).all<BatchOrder>(),
  ]);
  return{user,warehouse,rows:rows.results,options:options.results,batches:batches.results,batchOrders:batchOrders.results,filters,page:safePage,pageSize,pages,total};
}

export async function action({request}:Route.ActionArgs){
  const user=await requireSessionUser(request,"warehouse.operate","warehouse");
  const context=await loadWarehouseContext(request,user),warehouse=context.selected;
  await requireWarehouseAssignment(user,warehouse.id,"operator");
  const form=await request.formData(),intent=valueOf(form,"intent"),now=new Date().toISOString();
  if(intent==="create"||intent==="add"){
    const orderIds=[...new Set(form.getAll("orderId").map(String).filter(Boolean))];
    if(intent==="create"&&orderIds.length<2)return{formError:"拼车配载至少需要选择 2 张完整订单"};
    if(intent==="add"&&!orderIds.length)return{formError:"请先选择需要加入配载单的订单"};
    const states=await loadCandidateStates(user.organizationId,warehouse.id,orderIds);
    const blockers=states.flatMap((row)=>candidateBlockers(row).map(reason=>`${row.order_number}：${reason}`));
    if(states.length!==orderIds.length)blockers.push("部分所选订单已不在当前仓库或已经出库");
    if(blockers.length)return{formError:`暂不能配载：${[...new Set(blockers)].join("；")}`};
    const targetBatchId=intent==="add"?valueOf(form,"batchId"):"";
    let comparison=states;
    let targetBatch:TargetBatch|null=null;
    if(targetBatchId){
      targetBatch=await env.DB.prepare("SELECT id,batch_number,warehouse_id,status,destination_location,border_port,customs_location FROM transport_batches WHERE id=? AND organization_id=? AND batch_number LIKE 'PZ-%' AND status IN ('planning','loading')").bind(targetBatchId,user.organizationId).first<TargetBatch>();
      if(!targetBatch||targetBatch.warehouse_id!==warehouse.id)return{formError:"目标配载单不存在或不属于当前仓库"};
      if(await batchHasStarted(user.organizationId,targetBatch.id))return{formError:`${targetBatch.batch_number} 已开始装车，不能再增加订单`};
      const firstOrder=await env.DB.prepare("SELECT o.id order_id,o.order_number,o.business_type,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,o.exit_port,o.customs_location,o.overseas_warehouse_id,ow.name overseas_warehouse_name,'' customer_name,'' cargo_names,0 package_count,0 pieces,0 weight_kg,0 volume_cbm,'' location_names,1 cargo_ready,0 has_exception,0 active_dispatch,NULL active_batch_id,NULL active_batch_number FROM transport_batch_orders bo JOIN transport_orders o ON o.id=bo.order_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id WHERE bo.batch_id=? AND bo.status!='removed' ORDER BY bo.sequence_no LIMIT 1").bind(targetBatch.id).first<CandidateState>();
      if(firstOrder)comparison=[firstOrder,...states];
    }
    const compatibility=checkCompatibility(comparison);
    if(compatibility)return{formError:compatibility};
    if(targetBatch){
      const selectedPort=uniqueFilled(states.map(row=>row.exit_port));
      const selectedCustoms=uniqueFilled(states.map(row=>row.customs_location));
      if(targetBatch.border_port&&selectedPort&&targetBatch.border_port.trim()!==selectedPort)return{formError:`所选订单的出境口岸与 ${targetBatch.batch_number} 不一致`};
      if(targetBatch.customs_location&&selectedCustoms&&targetBatch.customs_location.trim()!==selectedCustoms)return{formError:`所选订单的清关地与 ${targetBatch.batch_number} 不一致`};
      const sequence=await env.DB.prepare("SELECT COALESCE(MAX(sequence_no),0) next FROM transport_batch_orders WHERE batch_id=? AND organization_id=?").bind(targetBatch.id,user.organizationId).first<{next:number}>();
      const statements=states.map((row,index)=>env.DB.prepare(`INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?) ON CONFLICT(batch_id,order_id) DO UPDATE SET sequence_no=excluded.sequence_no,status='planned',added_by_user_id=excluded.added_by_user_id,updated_at=excluded.updated_at`).bind(crypto.randomUUID(),user.organizationId,targetBatch!.id,row.order_id,(sequence?.next??0)+index+1,user.userId,now,now));
      await env.DB.batch(statements);
      await addOrdersToPendingDispatch(user.organizationId,warehouse.id,targetBatch.id,states.map(row=>row.order_id),now);
      await activateLoadingModules(user.organizationId,states.map(row=>row.order_id),targetBatch.batch_number,user.userId,now,"加入已有配载单");
      await writeAudit({request,action:"warehouse.consolidation.add",resourceType:"transport_batch",resourceId:targetBatch.id,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:targetBatch.batch_number,orderIds}});
      return{success:`已将 ${states.length} 票订单加入 ${targetBatch.batch_number}`,batchId:targetBatch.id};
    }
    const first=states[0],dateKey=now.slice(0,10).replaceAll("-","");
    const seq=await env.DB.prepare("SELECT COALESCE(MAX(CAST(substr(batch_number,13) AS INTEGER)),0)+1 next FROM transport_batches WHERE organization_id=? AND batch_number LIKE ?").bind(user.organizationId,`PZ-${dateKey}-%`).first<{next:number}>();
    const batchId=crypto.randomUUID(),batchNumber=`PZ-${dateKey}-${String(seq?.next??1).padStart(3,"0")}`;
    const inheritedPort=uniqueFilled(states.map(row=>row.exit_port)),enteredPort=valueOf(form,"borderPort").trim();
    const inheritedCustoms=uniqueFilled(states.map(row=>row.customs_location)),enteredCustoms=valueOf(form,"customsLocation").trim();
    if(enteredPort&&inheritedPort&&enteredPort!==inheritedPort)return{formError:"填写的出境口岸与订单已有口岸不一致"};
    if(enteredCustoms&&inheritedCustoms&&enteredCustoms!==inheritedCustoms)return{formError:"填写的清关地与订单已有清关地不一致"};
    const borderPort=enteredPort||inheritedPort||null;
    const customsLocation=enteredCustoms||inheritedCustoms||null;
    const destination=[first.overseas_warehouse_name,[first.destination_country,first.destination_state,first.destination_city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    const routeKey=[warehouse.id,first.overseas_warehouse_id,first.destination_country,first.destination_state,first.destination_city,borderPort,customsLocation].map(value=>(value??"").trim().toLowerCase()).join("|");
    const batchName=valueOf(form,"batchName").trim()||`${warehouse.name} → ${first.overseas_warehouse_name||first.destination_city}`;
    const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT INTO transport_batches(id,organization_id,order_id,batch_number,batch_name,origin_location,destination_location,planned_departure_at,planned_arrival_at,status,notes,route_key,warehouse_id,carrier_id,created_by_user_id,created_at,updated_at,border_port,customs_location,transit_location,route_notes,planned_loading_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(batchId,user.organizationId,first.order_id,batchNumber,batchName,warehouse.name,destination,null,null,"planning",valueOf(form,"notes").trim()||null,routeKey,warehouse.id,null,user.userId,now,now,borderPort,customsLocation,null,valueOf(form,"routeNotes").trim()||null,valueOf(form,"plannedLoadingAt")||null)];
    states.forEach((row,index)=>statements.push(env.DB.prepare("INSERT INTO transport_batch_orders(id,organization_id,batch_id,order_id,sequence_no,status,added_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?)").bind(crypto.randomUUID(),user.organizationId,batchId,row.order_id,index+1,user.userId,now,now)));
    try{await env.DB.batch(statements)}catch{return{formError:"配载单编号冲突或数据已被其他操作占用，请刷新后重试"}}
    await activateLoadingModules(user.organizationId,states.map(row=>row.order_id),batchNumber,user.userId,now,"仓库货物配载");
    await writeAudit({request,action:"warehouse.consolidation.create",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber,orderIds,totalWeight:states.reduce((sum,row)=>sum+row.weight_kg,0),totalVolume:states.reduce((sum,row)=>sum+row.volume_cbm,0)}});
    return{success:`配载单 ${batchNumber} 已生成，共 ${states.length} 票完整订单`,batchId};
  }
  if(intent==="remove"){
    const batchId=valueOf(form,"batchId"),orderId=valueOf(form,"orderId");
    const batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或不能修改"};
    const count=await env.DB.prepare("SELECT COUNT(*) total FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(batchId,user.organizationId).first<{total:number}>();
    if((count?.total??0)<=2)return{formError:"配载单至少保留 2 票订单；如需全部重配，请取消该配载单"};
    const membership=await env.DB.prepare("SELECT 1 ok FROM transport_batch_orders WHERE batch_id=? AND order_id=? AND organization_id=? AND status!='removed'").bind(batchId,orderId,user.organizationId).first();
    if(!membership)return{formError:"该订单不在当前配载单中"};
    await env.DB.prepare("UPDATE transport_batch_orders SET status='removed',updated_at=? WHERE batch_id=? AND order_id=? AND organization_id=?").bind(now,batchId,orderId,user.organizationId).run();
    await removeOrdersFromPendingDispatch(user.organizationId,warehouse.id,batchId,[orderId],now);
    await resetLoadingModules(user.organizationId,[orderId],user.userId,now,`从配载单 ${batch.batch_number} 移除`);
    await writeAudit({request,action:"warehouse.consolidation.remove",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number,orderId}});
    return{success:`订单已从 ${batch.batch_number} 移除`,batchId};
  }
  if(intent==="cancel"){
    const batchId=valueOf(form,"batchId"),batch=await editableBatch(user.organizationId,warehouse.id,batchId);
    if(!batch)return{formError:"配载单不存在、已开始装车或不能取消"};
    const orders=await env.DB.prepare("SELECT order_id FROM transport_batch_orders WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(batchId,user.organizationId).all<{order_id:string}>();
    await cancelPendingDispatch(user.organizationId,batchId,now);
    await env.DB.batch([env.DB.prepare("UPDATE transport_batches SET status='cancelled',updated_at=? WHERE id=? AND organization_id=?").bind(now,batchId,user.organizationId),env.DB.prepare("UPDATE transport_batch_orders SET status='removed',updated_at=? WHERE batch_id=? AND organization_id=? AND status!='removed'").bind(now,batchId,user.organizationId)]);
    await resetLoadingModules(user.organizationId,orders.results.map(row=>row.order_id),user.userId,now,`取消配载单 ${batch.batch_number}`);
    await writeAudit({request,action:"warehouse.consolidation.cancel",resourceType:"transport_batch",resourceId:batchId,organizationId:user.organizationId,actorUserId:user.userId,metadata:{batchNumber:batch.batch_number,orderIds:orders.results.map(row=>row.order_id)}});
    return{success:`配载单 ${batch.batch_number} 已取消，订单已释放`};
  }
  return{formError:"未知操作"};
}

export default function CargoConsolidation({loaderData,actionData}:Route.ComponentProps){
  const busy=useNavigation().state!=="idle",storageKey=`warehouse-consolidation:${loaderData.warehouse.id}`;
  const[selected,setSelected]=useState<Selection[]>([]);
  useEffect(()=>{try{setSelected(JSON.parse(localStorage.getItem(storageKey)||"[]"))}catch{setSelected([])}},[storageKey]);
  useEffect(()=>{localStorage.setItem(storageKey,JSON.stringify(selected))},[storageKey,selected]);
  useEffect(()=>{if(actionData?.success)setSelected([])},[actionData?.success]);
  const totals=useMemo(()=>selected.reduce((sum,row)=>({packages:sum.packages+row.packages,pieces:sum.pieces+row.pieces,weight:sum.weight+row.weight,volume:sum.volume+row.volume}),{packages:0,pieces:0,weight:0,volume:0}),[selected]);
  const selectedIds=new Set(selected.map(row=>row.orderId));
  const toggle=(row:StockRow,checked:boolean)=>setSelected(current=>checked?[...current.filter(item=>item.orderId!==row.order_id),toSelection(row)]:current.filter(item=>item.orderId!==row.order_id));
  const values=<K extends keyof (typeof loaderData.options)[number]>(key:K)=>[...new Set(loaderData.options.map(row=>row[key]).filter(Boolean) as string[])];
  const availableBatches=loaderData.batches.filter(batch=>!batch.has_started&&["planning","loading"].includes(batch.status));
  return<>
    <header className="warehouse-page-header ltl-loading-header"><div><p className="eyebrow">CARGO CONSOLIDATION</p><h1>货物配载</h1><p>按仓库实收数据选择完整拼车订单，生成正式 PZ 配载单。</p></div><div className="page-actions"><button type="button" className="secondary" disabled={!selected.length} onClick={()=>setSelected([])}>清空选择</button>{selected.length>0&&availableBatches.length>0&&<Modal title="加入已有配载单" triggerLabel="加入已有配载单" triggerClassName="secondary" closeSignal={actionData?.success}><Form method="post" className="stack"><input type="hidden" name="intent" value="add"/>{selected.map(row=><input key={row.orderId} type="hidden" name="orderId" value={row.orderId}/>)}<label className="field"><span>目标配载单 *</span><select name="batchId" required><option value="">请选择</option>{availableBatches.map(batch=><option key={batch.id} value={batch.id}>{batch.batch_number} · {batch.destination_location}</option>)}</select></label><p>系统会再次校验目的仓、地区、口岸和清关地是否兼容。</p><button className="primary" disabled={busy}>确认加入</button></Form></Modal>}<Modal title="生成配载单" triggerLabel={`生成配载（${selected.length} 票）`} size="wide" closeSignal={actionData?.success}><ConsolidationForm selected={selected} totals={totals} busy={busy}/></Modal></div></header>
    {actionData?.formError&&<div className="alert error">{actionData.formError}</div>}{actionData?.success&&<div className="alert success">{actionData.success}{actionData.batchId&&<> · <Link to={`/admin/loading/${actionData.batchId}`}>打开配载单</Link></>}</div>}
    <section className="panel ltl-filter-panel"><FilterForm loaderData={loaderData} values={values}/></section>
    <section className="panel"><div className="panel-header"><div><h2>当前仓库全部在库货物</h2><p>默认显示全部尚未出库货物；不可配载的订单保留显示并说明原因。</p></div><span className="status-pill">已选 {selected.length} / 在库 {loaderData.total} 票</span></div><div className="table-wrap ltl-loading-table"><table><thead><tr><th>选择</th><th>配载状态</th><th>订单 / 客户</th><th>货物</th><th>实收数据</th><th>境外目的仓 / 地区</th><th>口岸 / 清关地</th><th>库位</th></tr></thead><tbody>{loaderData.rows.map(row=>{const blockers=candidateBlockers(row),checked=selectedIds.has(row.order_id);return<tr key={row.order_id} className={checked?"selected-row":""}><td><input type="checkbox" checked={checked} disabled={blockers.length>0} onChange={event=>toggle(row,event.target.checked)} aria-label={`选择订单 ${row.order_number}`}/></td><td>{blockers.length?<><span className="status-pill off">不可配载</span><small className="danger-text">{blockers.join("；")}</small></>:<span className="status-pill success">可配载</span>}</td><td><strong>{row.order_number}</strong><small>{row.customer_name}</small></td><td><strong>{row.cargo_names||"未填写货名"}</strong></td><td>{row.package_count} 包装 · {row.pieces} 件<small>{row.weight_kg.toFixed(2)} KG · {row.volume_cbm.toFixed(3)} CBM</small></td><td>{row.overseas_warehouse_name||"目的仓未设置"}<small>{[row.destination_country,row.destination_state,row.destination_city].filter(Boolean).join(" ")}</small></td><td>{row.exit_port||"待补充"}<small>{row.customs_location||"待补充"}</small></td><td>{row.location_names||"—"}</td></tr>})}</tbody></table></div>{!loaderData.rows.length&&<p className="empty-state">当前仓库没有符合筛选条件的在库货物。</p>}<Pagination loaderData={loaderData}/></section>
    <section className="panel"><div className="panel-header"><div><h2>当前仓库配载单</h2><p>装车开始前可以增加、移除订单或取消配载；开始装车后由配载单统一推进。</p></div></div><div className="table-wrap"><table><thead><tr><th>配载单</th><th>订单</th><th>实收汇总</th><th>目的地 / 口岸</th><th>计划装车</th><th>状态</th><th>操作</th></tr></thead><tbody>{loaderData.batches.map(batch=><tr key={batch.id}><td><strong>{batch.batch_number}</strong><small>{batch.batch_name}</small></td><td><strong>{batch.order_count} 票</strong><small>{batch.order_numbers}</small></td><td>{batch.total_weight.toFixed(2)} KG<small>{batch.total_volume.toFixed(3)} CBM</small></td><td>{batch.destination_location}<small>{batch.border_port||"口岸待补"} · {batch.customs_location||"清关地待补"}</small></td><td>{batch.planned_loading_at?new Date(batch.planned_loading_at).toLocaleString("zh-CN"):"待定"}</td><td><span className="status-pill">{batch.has_started?"已开始装车":batch.has_dispatch?"装车任务已生成":batch.status==="planning"?"配载已生成":"待装车"}</span></td><td><div className="button-row"><Link className="text-button" to={`/admin/loading/${batch.id}`}>打开</Link>{!batch.has_started&&<Modal title={`调整 ${batch.batch_number}`} triggerLabel="调整" triggerClassName="text-button" closeSignal={actionData?.success}><BatchAdjustment batch={batch} orders={loaderData.batchOrders.filter(row=>row.batch_id===batch.id)} busy={busy}/></Modal>}</div></td></tr>)}</tbody></table></div>{!loaderData.batches.length&&<p className="empty-state">当前仓库尚未生成配载单。</p>}</section>
  </>;
}

function ConsolidationForm({selected,totals,busy}:{selected:Selection[];totals:{packages:number;pieces:number;weight:number;volume:number};busy:boolean}){return<Form method="post" className="stack ltl-task-form"><input type="hidden" name="intent" value="create"/>{selected.map(row=><input key={row.orderId} type="hidden" name="orderId" value={row.orderId}/>)}<div className="ltl-selection-summary"><div><span>完整订单</span><strong>{selected.length} 票</strong></div><div><span>包装 / 件数</span><strong>{totals.packages} 包装 · {totals.pieces} 件</strong></div><div><span>实收重量</span><strong>{totals.weight.toFixed(2)} KG</strong></div><div><span>实收体积</span><strong>{totals.volume.toFixed(3)} CBM</strong></div></div><div className="table-wrap compact-selection-table"><table><thead><tr><th>订单</th><th>客户</th><th>重量</th><th>体积</th></tr></thead><tbody>{selected.map(row=><tr key={row.orderId}><td>{row.orderNumber}</td><td>{row.customerName}</td><td>{row.weight.toFixed(2)} KG</td><td>{row.volume.toFixed(3)} CBM</td></tr>)}</tbody></table></div><div className="form-grid compact"><label className="field"><span>配载单名称</span><input name="batchName" placeholder="选填，系统可自动生成"/></label><label className="field"><span>计划装车时间</span><input name="plannedLoadingAt" type="datetime-local"/></label><label className="field"><span>出境口岸</span><input name="borderPort" placeholder="选填或继承订单"/></label><label className="field"><span>清关地</span><input name="customsLocation" placeholder="选填或继承订单"/></label><label className="field span-2"><span>运输线路</span><textarea name="routeNotes" rows={2} placeholder="选填，多行填写"/></label><label className="field span-2"><span>备注</span><textarea name="notes" rows={2}/></label></div><div className="alert info">配载容量由人工判断。生成后订单将被锁定，承运商、车辆和司机可在配载单中后补。</div><button className="primary" disabled={busy||selected.length<2}>确认生成 PZ 配载单</button></Form>}
function BatchAdjustment({batch,orders,busy}:{batch:BatchRow;orders:BatchOrder[];busy:boolean}){return<div className="stack"><div className="table-wrap"><table><thead><tr><th>订单</th><th>客户 / 货物</th><th>实收数据</th><th>操作</th></tr></thead><tbody>{orders.map(row=><tr key={row.order_id}><td>{row.order_number}</td><td>{row.customer_name}<small>{row.cargo_names||"—"}</small></td><td>{row.weight_kg.toFixed(2)} KG<small>{row.volume_cbm.toFixed(3)} CBM</small></td><td><Form method="post"><input type="hidden" name="intent" value="remove"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="orderId" value={row.order_id}/><button className="text-button danger" disabled={busy||orders.length<=2}>移除</button></Form></td></tr>)}</tbody></table></div><div className="alert info">需要增加订单时，请关闭弹窗，在上方在库货物列表勾选订单后点击“加入已有配载单”。</div><Form method="post"><input type="hidden" name="intent" value="cancel"/><input type="hidden" name="batchId" value={batch.id}/><button className="secondary danger" disabled={busy}>取消整张配载单并释放订单</button></Form></div>}
function FilterForm({loaderData,values}:{loaderData:Route.ComponentProps["loaderData"];values:<K extends keyof (typeof loaderData.options)[number]>(key:K)=>string[]}){return<Form method="get" className="ltl-loading-filters"><input type="hidden" name="warehouseId" value={loaderData.warehouse.id}/><Select label="目的仓" name="destinationWarehouse" current={loaderData.filters.warehouse} values={values("overseas_warehouse_name")}/><Select label="国家" name="country" current={loaderData.filters.country} values={values("destination_country")}/><Select label="省 / 州" name="state" current={loaderData.filters.state} values={values("destination_state")}/><Select label="城市" name="city" current={loaderData.filters.city} values={values("destination_city")}/><Select label="出境口岸" name="borderPort" current={loaderData.filters.borderPort} values={values("exit_port")}/><Select label="清关地" name="customs" current={loaderData.filters.customs} values={values("customs_location")}/><Select label="客户" name="customer" current={loaderData.filters.customer} values={values("customer_name")}/><label><span>是否可配载</span><select name="eligibility" defaultValue={loaderData.filters.eligibility}><option value="">全部</option><option value="eligible">仅可配载</option><option value="blocked">仅不可配载</option></select></label><label className="ltl-filter-search"><span>订单 / 货物</span><input name="q" defaultValue={loaderData.filters.keyword} placeholder="订单号或货物名称"/></label><label><span>每页</span><select name="pageSize" defaultValue={loaderData.pageSize}>{PAGE_SIZES.map(size=><option key={size} value={size}>{size} 条</option>)}</select></label><button className="secondary">筛选</button><Link className="text-button" to={`/warehouse/consolidation?warehouseId=${loaderData.warehouse.id}`}>重置</Link></Form>}
function Select({label,name,current,values}:{label:string;name:string;current:string;values:string[]}){return<label><span>{label}</span><select name={name} defaultValue={current}><option value="">全部</option>{values.map(value=><option key={value}>{value}</option>)}</select></label>}
function Pagination({loaderData}:{loaderData:{page:number;pages:number;pageSize:number;warehouse:{id:string};filters:Record<string,string>}}){if(loaderData.pages<=1)return null;const href=(page:number)=>{const params=new URLSearchParams({warehouseId:loaderData.warehouse.id,page:String(page),pageSize:String(loaderData.pageSize)}),names:Record<string,string>={warehouse:"destinationWarehouse",keyword:"q"};Object.entries(loaderData.filters).forEach(([key,value])=>{if(value)params.set(names[key]||key,value)});return`/warehouse/consolidation?${params}`};return<footer className="pagination"><span>第 {loaderData.page} / {loaderData.pages} 页</span><div>{loaderData.page>1&&<Link className="secondary" to={href(loaderData.page-1)}>上一页</Link>}{loaderData.page<loaderData.pages&&<Link className="secondary" to={href(loaderData.page+1)}>下一页</Link>}</div></footer>}

function toSelection(row:StockRow):Selection{return{orderId:row.order_id,orderNumber:row.order_number,customerName:row.customer_name,packages:row.package_count,pieces:row.pieces,weight:row.weight_kg,volume:row.volume_cbm}}
function candidateBlockers(row:StockRow){const reasons:string[]=[];if(row.business_type!=="ltl")reasons.push("整车订单");if(!row.package_count)reasons.push("当前仓无在库货物");if(!row.cargo_ready)reasons.push("未确认货齐");if(row.has_exception)reasons.push("存在未结异常");if(row.active_batch_id)reasons.push(`已加入 ${row.active_batch_number}`);if(row.active_dispatch)reasons.push("已生成装车任务");if(!row.overseas_warehouse_id)reasons.push("未设置境外目的仓");return reasons}
function uniqueFilled(values:(string|null)[]){const unique=[...new Set(values.map(value=>value?.trim()).filter(Boolean) as string[])];return unique.length===1?unique[0]:""}
function checkCompatibility(rows:CandidateState[]){if(!rows.length)return"没有可配载订单";const first=rows[0],same=(pick:(row:CandidateState)=>string|null)=>rows.every(row=>(pick(row)||"").trim()===(pick(first)||"").trim());if(!first.overseas_warehouse_id)return"所选订单必须设置境外目的仓";if(!same(row=>row.overseas_warehouse_id))return"所选订单的境外目的仓不一致";if(!same(row=>row.destination_country)||!same(row=>row.destination_state)||!same(row=>row.destination_city))return"所选订单的目的国家、省州或城市不一致";const ports=[...new Set(rows.map(row=>row.exit_port?.trim()).filter(Boolean))],customs=[...new Set(rows.map(row=>row.customs_location?.trim()).filter(Boolean))];if(ports.length>1)return"所选订单已填写的出境口岸不一致";if(customs.length>1)return"所选订单已填写的清关地不一致";return""}
async function loadCandidateStates(organizationId:string,warehouseId:string,orderIds:string[]){if(!orderIds.length)return[];const rows=await Promise.all(orderIds.map(orderId=>env.DB.prepare(`SELECT o.id order_id,o.order_number,o.business_type,o.origin_country,o.origin_state,o.origin_city,o.destination_country,o.destination_state,o.destination_city,o.exit_port,o.customs_location,o.overseas_warehouse_id,ow.name overseas_warehouse_name,c.name customer_name,
    (SELECT GROUP_CONCAT(NULLIF(TRIM(i.cargo_name_cn),''),'、') FROM order_cargo_items i WHERE i.organization_id=o.organization_id AND i.order_id=o.id) cargo_names,
    (SELECT COUNT(*) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')) package_count,
    COALESCE((SELECT SUM(p.pieces) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) pieces,
    COALESCE((SELECT SUM(p.weight_kg) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) weight_kg,
    COALESCE((SELECT SUM(p.volume_cbm) FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE p.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND p.status IN ('in_stock','allocated')),0) volume_cbm,'' location_names,
    EXISTS(SELECT 1 FROM warehouse_receipts r JOIN shipments s ON s.id=r.shipment_id WHERE r.organization_id=o.organization_id AND s.order_id=o.id AND r.warehouse_id=? AND r.status='completed' AND r.cargo_complete=1) cargo_ready,
    EXISTS(SELECT 1 FROM warehouse_exceptions e JOIN shipments s ON s.id=e.shipment_id WHERE e.organization_id=o.organization_id AND s.order_id=o.id AND e.status IN ('open','processing')) has_exception,
    EXISTS(SELECT 1 FROM warehouse_dispatches d JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id WHERE d.organization_id=o.organization_id AND s.order_id=o.id AND p.warehouse_id=? AND d.status!='cancelled') active_dispatch,
    (SELECT b.id FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' ORDER BY b.updated_at DESC LIMIT 1) active_batch_id,
    (SELECT b.batch_number FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id WHERE bo.organization_id=o.organization_id AND bo.order_id=o.id AND bo.status!='removed' AND b.status!='cancelled' AND b.batch_number LIKE 'PZ-%' ORDER BY b.updated_at DESC LIMIT 1) active_batch_number
    FROM transport_orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN warehouses ow ON ow.id=o.overseas_warehouse_id WHERE o.id=? AND o.organization_id=?`).bind(warehouseId,warehouseId,warehouseId,warehouseId,warehouseId,warehouseId,orderId,organizationId).first<CandidateState>()));return rows.filter((row):row is CandidateState=>Boolean(row))}
async function activateLoadingModules(organizationId:string,orderIds:string[],batchNumber:string,userId:string,now:string,actionName:string){for(const orderId of orderIds)await ensureOrderModules(organizationId,orderId);const placeholders=orderIds.map(()=>"?").join(","),modules=await env.DB.prepare(`SELECT id,order_id,current_step_code FROM order_module_instances WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id IN (${placeholders})`).bind(organizationId,...orderIds).all<{id:string;order_id:string;current_step_code:string|null}>();const statements=modules.results.flatMap(module=>[env.DB.prepare("UPDATE order_module_instances SET status='in_progress',current_step_code='planned',current_step_name='配载成单',progress_percent=75,started_at=COALESCE(started_at,?),completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,now,module.id),env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,module.order_id,module.id,"batch_create",actionName,module.current_step_code,"planned","配载成单",userId,`加入配载单 ${batchNumber}`,now)]);if(statements.length)await env.DB.batch(statements);await Promise.all(orderIds.map(orderId=>syncOrderWorkflowSnapshot(organizationId,orderId)))}
async function resetLoadingModules(organizationId:string,orderIds:string[],userId:string,now:string,notes:string){if(!orderIds.length)return;const placeholders=orderIds.map(()=>"?").join(","),modules=await env.DB.prepare(`SELECT id,order_id,current_step_code FROM order_module_instances WHERE organization_id=? AND module_code='loading' AND enabled=1 AND order_id IN (${placeholders})`).bind(organizationId,...orderIds).all<{id:string;order_id:string;current_step_code:string|null}>();const statements=modules.results.flatMap(module=>[env.DB.prepare("UPDATE order_module_instances SET status='ready',current_step_code='warehouse_ready',current_step_name='仓库已货齐，待配载',progress_percent=50,completed_at=NULL,blocking_reason=NULL,updated_at=? WHERE id=?").bind(now,module.id),env.DB.prepare("INSERT INTO order_module_history(id,organization_id,order_id,module_instance_id,action_code,action_name,from_step_code,to_step_code,to_step_name,actor_user_id,notes,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),organizationId,module.order_id,module.id,"batch_release","释放配载订单",module.current_step_code,"warehouse_ready","仓库已货齐，待配载",userId,notes,now)]);if(statements.length)await env.DB.batch(statements);await Promise.all(orderIds.map(orderId=>syncOrderWorkflowSnapshot(organizationId,orderId)))}
async function addOrdersToPendingDispatch(organizationId:string,warehouseId:string,batchId:string,orderIds:string[],now:string){
  if(!orderIds.length)return;
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  const placeholders=orderIds.map(()=>"?").join(",");
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO warehouse_dispatch_items(id,organization_id,dispatch_id,package_id,status)
      SELECT lower(hex(randomblob(16))),p.organization_id,?,p.id,'pending' FROM warehouse_packages p
      JOIN shipments s ON s.id=p.shipment_id AND s.organization_id=p.organization_id
      WHERE p.organization_id=? AND p.warehouse_id=? AND p.status IN ('in_stock','allocated') AND s.order_id IN (${placeholders})`).bind(dispatch.id,organizationId,warehouseId,...orderIds),
    env.DB.prepare(`UPDATE warehouse_packages SET status='allocated',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='in_stock'
      AND shipment_id IN (SELECT id FROM shipments WHERE organization_id=? AND order_id IN (${placeholders}))`).bind(now,organizationId,warehouseId,organizationId,...orderIds),
  ]);
}
async function removeOrdersFromPendingDispatch(organizationId:string,warehouseId:string,batchId:string,orderIds:string[],now:string){
  if(!orderIds.length)return;
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  const placeholders=orderIds.map(()=>"?").join(",");
  await env.DB.batch([
    env.DB.prepare(`UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND warehouse_id=? AND status='allocated' AND id IN (
      SELECT di.package_id FROM warehouse_dispatch_items di JOIN warehouse_packages p ON p.id=di.package_id JOIN shipments s ON s.id=p.shipment_id
      WHERE di.dispatch_id=? AND s.order_id IN (${placeholders}))`).bind(now,organizationId,warehouseId,dispatch.id,...orderIds),
    env.DB.prepare(`DELETE FROM warehouse_dispatch_items WHERE dispatch_id=? AND package_id IN (
      SELECT p.id FROM warehouse_packages p JOIN shipments s ON s.id=p.shipment_id WHERE s.order_id IN (${placeholders}))`).bind(dispatch.id,...orderIds),
  ]);
}
async function cancelPendingDispatch(organizationId:string,batchId:string,now:string){
  const dispatch=await env.DB.prepare("SELECT id FROM warehouse_dispatches WHERE organization_id=? AND transport_batch_id=? AND status='loading' ORDER BY updated_at DESC LIMIT 1").bind(organizationId,batchId).first<{id:string}>();
  if(!dispatch)return;
  await env.DB.batch([
    env.DB.prepare("UPDATE warehouse_packages SET status='in_stock',updated_at=? WHERE organization_id=? AND status='allocated' AND id IN (SELECT package_id FROM warehouse_dispatch_items WHERE dispatch_id=?)").bind(now,organizationId,dispatch.id),
    env.DB.prepare("UPDATE warehouse_dispatches SET status='cancelled',updated_at=? WHERE id=? AND organization_id=?").bind(now,dispatch.id,organizationId),
  ]);
}
async function batchHasStarted(organizationId:string,batchId:string){const row=await env.DB.prepare(`SELECT EXISTS(SELECT 1 FROM warehouse_dispatches d LEFT JOIN warehouse_dispatch_items di ON di.dispatch_id=d.id WHERE d.organization_id=? AND d.transport_batch_id=? AND d.status!='cancelled' AND (d.status='dispatched' OR di.status!='pending')) started`).bind(organizationId,batchId).first<{started:number}>();return Boolean(row?.started)}
async function editableBatch(organizationId:string,warehouseId:string,batchId:string){const batch=await env.DB.prepare("SELECT id,batch_number FROM transport_batches WHERE id=? AND organization_id=? AND warehouse_id=? AND batch_number LIKE 'PZ-%' AND status IN ('planning','loading')").bind(batchId,organizationId,warehouseId).first<{id:string;batch_number:string}>();if(!batch||await batchHasStarted(organizationId,batchId))return null;return batch}
export function meta(){return[{title:"货物配载 | International TMS"}]}
