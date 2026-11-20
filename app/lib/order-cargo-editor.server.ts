import {
  MAX_CARGO_IMAGES_PER_ITEM,
  MAX_CARGO_IMAGE_STORED_BYTES,
  cargoImageSourceTypes,
} from "./cargo-images";
import {
  cargoEditorFieldPolicy,
  nextOrderPackageCodeSequence,
  resolveCargoEditorSubmission,
  type CargoEditorRecord,
  type CargoEditorWorkflowField,
} from "./order-cargo-editor";
import { valueOf } from "./validation";
import {loadActivePositionAccessProfile,activePositionProfilePredicate} from "./position-access-profile.server";
import {isBossBusinessActor} from "./permission-blocks";
import {changedRowGuard,guardedBatch,predicateGuard} from "./mutation-guard.server";
import {querySnapshotGuards} from "./query-snapshot-guard.server";
import {sha256} from "./crypto.server";
import {validateSiteImage} from "./order-site-photos.server";
import {readIntakeRuleBinding} from "./order-intake-rule";
import {cargoNativeFieldKeys,cargoNativeFieldPresent} from "./order-intake-facts";
import {serializeWorkflowFieldHandlerPositionCodes} from "./workflow-field-position-access";

type ExistingCargoRow = {
  id: string;
  cargo_name_cn: string;
  cargo_name_en: string | null;
  hs_code: string | null;
  overseas_hs_code: string | null;
  package_type: string;
  package_count: number;
  pieces_per_package: number;
  gross_weight_per_package_kg: number;
  net_weight_per_package_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  volume_per_package_cbm: number;
  declared_value: number;
  currency: string;
  origin_country: string | null;
  brand_model: string | null;
  marks: string | null;
  special_attributes: string | null;
  notes: string | null;
  declared_quantity:number|null;
  declared_unit:string|null;
};

type CargoPackageRow = { id: string; package_sequence: number; status: string };

export type OrderCargoEditInput={
  db: D1Database;
  organizationId: string;
  orderId: string;
  orderNumber: string;
  actorUserId: string;
  mode: "create" | "update";
  form: FormData;
  workflowFields: readonly CargoEditorWorkflowField[];
  now?: string;
};
export async function prepareOrderCargoEdit(input:OrderCargoEditInput) {
  const profile=await loadActivePositionAccessProfile(input.db,input.organizationId,input.actorUserId);
  if(!profile)return{ok:false as const,error:"账号岗位或权限已停用，请重新登录"};
  const boss=isBossBusinessActor({positionCode:profile.positionCode,roleCodes:[profile.roleCode]});
  const permission=["order.module.cargo.manage","order.intake.manage","order.manage"].find(code=>profile.permissions.includes(code));
  if(!profile.permissions.includes("order.view")||(!boss&&!permission))return{ok:false as const,error:"当前账号无权维护货物明细"};
  const orderSql="SELECT id,order_number,status,updated_at,inbound_package_locked_at,workflow_instance_id,intake_operations_json,declared_quantity_unit,salesperson_user_id,created_by_user_id,operation_supervisor_user_id,current_assignee_user_id FROM transport_orders WHERE organization_id=? AND id=?";
  const order=await input.db.prepare(orderSql).bind(input.organizationId,input.orderId).first<Record<string,unknown>>();
  if(!order)return{ok:false as const,error:"订单不存在或不属于当前组织"};
  const orderNumber=String(order.order_number);
  if(["completed","cancelled"].includes(String(order.status)))return{ok:false as const,error:"订单已经终结，不能修改货物明细"};
  const responsibility="(?=1 OR salesperson_user_id=? OR created_by_user_id=? OR operation_supervisor_user_id=? OR current_assignee_user_id=? OR EXISTS(SELECT 1 FROM order_module_instances m WHERE m.organization_id=transport_orders.organization_id AND m.order_id=transport_orders.id AND m.enabled=1 AND m.module_code='cargo' AND m.assignee_user_id=?))";
  const responsibleValues=[boss?1:0,...Array(5).fill(input.actorUserId)];
  if(!await input.db.prepare(`SELECT id FROM transport_orders WHERE organization_id=? AND id=? AND ${responsibility}`).bind(input.organizationId,input.orderId,...responsibleValues).first())return{ok:false as const,error:"当前账号不是本单货物维护责任人"};
  const requestKey=valueOf(input.form,"cargoRequestKey");
  if(!/^[a-zA-Z0-9_-]{16,160}$/.test(requestKey))return{ok:false as const,error:"货物保存标识无效，请重新打开货物编辑窗口"};
  const submittedFiles=[...input.form.entries()].filter((entry):entry is [string,File]=>entry[1] instanceof File&&entry[1].size>0);
  if(submittedFiles.length>MAX_CARGO_IMAGES_PER_ITEM||submittedFiles.some(([key,file])=>key!=='images'||file.size>MAX_CARGO_IMAGE_STORED_BYTES))return{ok:false as const,error:"货物图片数量或大小超过限制，请重新选择"};
  if([...input.form.entries()].some(([,value])=>typeof value==='string'&&value.length>4000))return{ok:false as const,error:"货物字段过长，请检查输入内容"};
  const entries=await Promise.all([...input.form.entries()].filter(([key])=>!['cargoRequestKey','cargoOrderVersion','intent'].includes(key)).map(async([key,value])=>[key,typeof value==='string'?value:{name:value.name,type:value.type,hash:await sha256(arrayBufferToBase64(await value.arrayBuffer()))}] as const));
  const payloadHash=await sha256(JSON.stringify({mode:input.mode,orderId:input.orderId,entries:entries.sort((a,b)=>a[0].localeCompare(b[0]))}));
  const prior=await input.db.prepare("SELECT order_id,payload_hash,cargo_item_id,mode,package_count FROM order_cargo_edit_submissions WHERE organization_id=? AND actor_user_id=? AND request_key=?").bind(input.organizationId,input.actorUserId,requestKey).first<{order_id:string;payload_hash:string;cargo_item_id:string;mode:string;package_count:number}>();
  if(prior){if(prior.order_id!==input.orderId||prior.payload_hash!==payloadHash)return{ok:false as const,error:"同一货物请求的内容已变化，请重新打开编辑窗口后保存"};return{ok:true as const,itemId:prior.cargo_item_id,created:prior.mode==='create',packageCount:Number(prior.package_count),repeated:true as const};}
  if(valueOf(input.form,"cargoOrderVersion")!==order.updated_at)return{ok:false as const,error:"订单资料已由其他窗口修改，请刷新货物区后再保存；未覆盖现有资料"};
  const cargoItemId = valueOf(input.form, "cargoItemId");
  if (input.mode === "update" && !cargoItemId)
    return { ok: false as const, error: "请选择要修改的货物明细" };
  if (input.mode === "create" && cargoItemId)
    return { ok: false as const, error: "新增货物不能携带旧明细标识" };
  const existing = cargoItemId
    ? await input.db.prepare(
        `SELECT id,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,package_type,
                package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,
                length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,
                origin_country,brand_model,marks,special_attributes,notes,declared_quantity,declared_unit
         FROM order_cargo_items WHERE id=? AND order_id=? AND organization_id=?`,
      ).bind(cargoItemId, input.orderId, input.organizationId).first<ExistingCargoRow>()
    : null;
  if (cargoItemId && !existing) return { ok: false as const, error: "货物明细不存在或不属于当前订单" };

  const existingImageCount = existing
    ? Number((await input.db.prepare(
        "SELECT COUNT(*) total FROM order_cargo_images WHERE cargo_item_id=? AND order_id=? AND organization_id=?",
      ).bind(existing.id, input.orderId, input.organizationId).first<{ total: number }>())?.total ?? 0)
    : 0;
  const imagePolicy = cargoEditorFieldPolicy(input.workflowFields, "cargo_images");
  const imageFiles = imagePolicy.visible
    ? input.form.getAll("images").filter((entry): entry is File => entry instanceof File && entry.size > 0)
    : [];
  if (existingImageCount + imageFiles.length > MAX_CARGO_IMAGES_PER_ITEM)
    return { ok: false as const, error: `每条货物最多保留 ${MAX_CARGO_IMAGES_PER_ITEM} 张图片` };
  if (imageFiles.some((file) => !cargoImageSourceTypes.has(file.type) || file.size > MAX_CARGO_IMAGE_STORED_BYTES))
    return { ok: false as const, error: "仅支持 JPG、PNG 或 WebP 图片，单张不超过 600 KB" };
  for(const file of imageFiles)await validateSiteImage(file,MAX_CARGO_IMAGE_STORED_BYTES,["jpeg","png","webp"]);

  const submitted: Record<string, string | string[]> = {};
  for (const [name, entry] of input.form.entries()) {
    if (entry instanceof File) continue;
    const previous = submitted[name];
    submitted[name] = previous === undefined
      ? entry
      : Array.isArray(previous) ? [...previous, entry] : [previous, entry];
  }
  const result = resolveCargoEditorSubmission({
    fields: input.workflowFields,
    submitted,
    existing: existing ? existingCargoRecord(existing) : null,
    existingImageCount,
    uploadedImageCount: imageFiles.length,
  });
  if (!result.ok) return result;

  const now = input.now ?? new Date().toISOString();
  const itemId = existing?.id ?? crypto.randomUUID();
  const packages = existing
    ? (await input.db.prepare(
        "SELECT id,package_sequence,status FROM order_cargo_packages WHERE cargo_item_id=? AND order_id=? AND organization_id=? ORDER BY package_sequence",
      ).bind(itemId, input.orderId, input.organizationId).all<CargoPackageRow>()).results
    : [];
  const activePackages = packages.filter((item) => item.status !== "cancelled");
  const materialChanged=!existing||JSON.stringify(cargoBindValues(existingCargoRecord(existing)).slice(0,-1))!==JSON.stringify(cargoBindValues(result.value).slice(0,-1));
  if(materialChanged){
    const binding=readIntakeRuleBinding(order.intake_operations_json);
    if(binding){const candidate={cargo_name_cn:result.value.cargoName,package_type:result.value.packageType,package_count:result.value.packageCount,pieces_per_package:result.value.piecesPerPackage,gross_weight_per_package_kg:result.value.weight,volume_per_package_cbm:result.value.volume,length_cm:result.value.length,width_cm:result.value.width,height_cm:result.value.height,declared_quantity:existing?.declared_quantity??result.value.packageCount*result.value.piecesPerPackage,declared_unit:existing?.declared_unit??order.declared_quantity_unit};
      if(binding.requiredKeys.some(key=>cargoNativeFieldKeys.has(key)&&!cargoNativeFieldPresent(key,[candidate],order)))return{ok:false as const,error:"货物更正后仍须满足本单录单必填要求，请补齐品名、件数、毛重及明确体积等资料（体积允许 0）"};
    }
  }
  if(existing&&activePackages.some(item=>item.status!=="planned")&&materialChanged)
    return{ok:false as const,error:"本条货物已进入仓储作业，不能直接改写原申报或包装依据；备注和照片仍可补充，实物差异请在仓库异常中留痕处理"};
  if (!existing || result.value.packageCount !== activePackages.length) {
    if (order.inbound_package_locked_at)
      return { ok: false as const, error: "国内仓已开始扫码，不能再新增货物或修改计划包装数" };
    const receivedMark = await input.db.prepare(
      "SELECT id FROM order_cargo_packages WHERE order_id=? AND organization_id=? AND status NOT IN ('planned','cancelled') LIMIT 1",
    ).bind(input.orderId, input.organizationId).first<{ id: string }>();
    if (receivedMark)
      return { ok: false as const, error: "货物已进入仓储或后续作业，不能改变计划包装数" };
  }
  if (activePackages.some((item) => item.status !== "planned") && result.value.packageCount !== activePackages.length)
    return { ok: false as const, error: "货物已入库或进入后续作业，不能再修改包装数量" };

  const sourceSql="SELECT id,cargo_name_cn,cargo_name_en,hs_code,overseas_hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,origin_country,brand_model,marks,special_attributes,notes,declared_quantity,declared_unit,line_no,updated_at FROM order_cargo_items WHERE organization_id=? AND order_id=? ORDER BY id";
  const packageSql="SELECT id,cargo_item_id,package_code,package_sequence,status FROM order_cargo_packages WHERE organization_id=? AND order_id=? ORDER BY id";
  const numericColumns=new Set(['package_count','pieces_per_package','gross_weight_per_package_kg','net_weight_per_package_kg','length_cm','width_cm','height_cm','volume_per_package_cbm','declared_value','declared_quantity','line_no']);
  const sources=(await input.db.prepare(sourceSql).bind(input.organizationId,input.orderId).all<Record<string,unknown>>()).results.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value!=null&&numericColumns.has(key)?Number(value):value])));
  const sourcePackages=(await input.db.prepare(packageSql).bind(input.organizationId,input.orderId).all<Record<string,unknown>>()).results;
  const freshPackages=sourcePackages.filter(row=>row.cargo_item_id===itemId);
  if(existing&&(freshPackages.length!==packages.length||packages.some(row=>!freshPackages.some(fresh=>fresh.id===row.id&&Number(fresh.package_sequence)===Number(row.package_sequence)&&fresh.status===row.status))))return{ok:false as const,error:"包装收货或作业状态已变化，请刷新后再核对货物"};
  if((!existing||result.value.packageCount!==activePackages.length)&&sourcePackages.some(row=>!["planned","cancelled"].includes(String(row.status))))return{ok:false as const,error:"货物已进入仓储或后续作业，不能改变计划包装数"};
  // The edit was resolved from an earlier read: do not accidentally bless a newer row.
  if(existing){const fresh=sources.find(row=>row.id===existing.id);if(!fresh||Object.keys(existing).some(key=>{
    const old=existing[key as keyof ExistingCargoRow],value=fresh[key];
    if(old==null||value==null)return old!=null||value!=null;
    return numericColumns.has(key)?Number(value)!==Number(old):String(value)!==String(old);
  }))return{ok:false as const,error:"货物已由其他窗口修改，请刷新后核对"};}
  const ruleSql="SELECT id,field_key,step_key,is_active,is_required,options_text,handler_position_codes FROM workflow_instance_fields WHERE instance_id=? AND module_code='cargo' ORDER BY id";
  const ruleValues=[typeof order.workflow_instance_id==='string'?order.workflow_instance_id:''];
  const rules=(await input.db.prepare(ruleSql).bind(...ruleValues).all<Record<string,unknown>>()).results;
  for(const field of input.workflowFields){
    if(!field.id||field.fieldKey==='__frozen_workflow_field_scope__'||field.id.includes(':runtime-catalog:'))continue;
    const rule=rules.find(row=>row.id===field.id);
    if(order.workflow_instance_id&&(!rule||Boolean(Number(rule.is_active))!==field.isActive||Boolean(Number(rule.is_required))!==field.isRequired||String(rule.options_text??'')!==String(field.optionsText??'')||serializeWorkflowFieldHandlerPositionCodes(String(rule.handler_position_codes??''))!==serializeWorkflowFieldHandlerPositionCodes(field.handlerPositionCodes)))return{ok:false as const,error:"货物字段配置已变化，请刷新本单后按当前配置办理"};
  }
  const imageSql="SELECT id,cargo_item_id,file_name,content_type,size_bytes,created_at FROM order_cargo_images WHERE organization_id=? AND order_id=? ORDER BY id";
  const images=(await input.db.prepare(imageSql).bind(input.organizationId,input.orderId).all<Record<string,unknown>>()).results.map(
    row=>({...row,size_bytes:Number(row.size_bytes)}) as Record<string,unknown>,
  );
  if(existing&&images.filter(row=>row.cargo_item_id===existing.id).length!==existingImageCount)return{ok:false as const,error:"货物照片已由其他窗口修改，请刷新后核对"};
  const authority=activePositionProfilePredicate({organizationId:input.organizationId,userId:input.actorUserId,profile,requiredPermissions:["order.view",...(!boss?[permission!]:[])]});
  const guards: D1PreparedStatement[] = [
    predicateGuard(input.db,authority.sql,authority.values,now),
    ...querySnapshotGuards(input.db,orderSql,[input.organizationId,input.orderId],[order],now),
    ...querySnapshotGuards(input.db,sourceSql,[input.organizationId,input.orderId],sources,now),
    ...querySnapshotGuards(input.db,packageSql,[input.organizationId,input.orderId],sourcePackages,now),
    ...querySnapshotGuards(input.db,ruleSql,ruleValues,rules,now),
    ...querySnapshotGuards(input.db,imageSql,[input.organizationId,input.orderId],images,now),
    predicateGuard(input.db,`EXISTS(SELECT 1 FROM transport_orders WHERE organization_id=? AND id=? AND ${responsibility})`,[input.organizationId,input.orderId,...responsibleValues],now),
  ];
  const statements=[...guards];
  if (existing) {
    statements.push(input.db.prepare(
      `UPDATE order_cargo_items SET cargo_name_cn=?,cargo_name_en=?,hs_code=?,overseas_hs_code=?,
        package_type=?,package_count=?,pieces_per_package=?,gross_weight_per_package_kg=?,net_weight_per_package_kg=?,
        length_cm=?,width_cm=?,height_cm=?,volume_per_package_cbm=?,declared_value=?,currency=?,origin_country=?,
        brand_model=?,marks=?,special_attributes=?,notes=?,updated_at=?
       WHERE id=? AND order_id=? AND organization_id=?`,
    ).bind(...cargoBindValues(result.value), now, itemId, input.orderId, input.organizationId),changedRowGuard(input.db,now));
  } else {
    const line = await input.db.prepare(
      "SELECT COALESCE(MAX(line_no),0)+1 line_no FROM order_cargo_items WHERE order_id=? AND organization_id=?",
    ).bind(input.orderId, input.organizationId).first<{ line_no: number }>();
    statements.push(input.db.prepare(
      `INSERT INTO order_cargo_items(id,organization_id,order_id,line_no,cargo_name_cn,cargo_name_en,hs_code,
        overseas_hs_code,package_type,package_count,pieces_per_package,gross_weight_per_package_kg,
        net_weight_per_package_kg,length_cm,width_cm,height_cm,volume_per_package_cbm,declared_value,currency,
        origin_country,brand_model,marks,special_attributes,notes,created_at,updated_at,declared_quantity,declared_unit)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT declared_quantity_unit FROM transport_orders WHERE organization_id=? AND id=?),'件'))`,
    ).bind(itemId, input.organizationId, input.orderId, line?.line_no ?? 1, ...cargoBindValues(result.value), now, now,result.value.packageCount*result.value.piecesPerPackage,input.organizationId,input.orderId));
  }

  if (result.value.packageCount < activePackages.length) {
    for (const item of activePackages.slice(result.value.packageCount)) {
      statements.push(input.db.prepare(
        "UPDATE order_cargo_packages SET status='cancelled' WHERE id=? AND cargo_item_id=? AND organization_id=? AND status='planned'",
      ).bind(item.id, itemId, input.organizationId),changedRowGuard(input.db,now));
    }
  } else if (result.value.packageCount > activePackages.length) {
    const sequenceStart = packages.reduce((max, item) => Math.max(max, item.package_sequence), 0) + 1;
    const existingCodes = (await input.db.prepare(
      "SELECT package_code FROM order_cargo_packages WHERE order_id=? AND organization_id=?",
    ).bind(input.orderId, input.organizationId).all<{ package_code: string }>()).results;
    const globalSequence = nextOrderPackageCodeSequence(
      orderNumber,
      existingCodes.map((item) => item.package_code),
    );
    for (let index = 0; index < result.value.packageCount - activePackages.length; index++) {
      const packageNumber = globalSequence + index;
      statements.push(input.db.prepare(
        "INSERT INTO order_cargo_packages(id,organization_id,order_id,cargo_item_id,package_code,package_sequence,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(), input.organizationId, input.orderId, itemId,
        `${orderNumber}-IN-${String(packageNumber).padStart(3, "0")}`,
        sequenceStart + index, now,
      ));
    }
  }

  for (let index = 0; index < imageFiles.length; index++) {
    const file = imageFiles[index];
    const dataUrl = `data:${file.type};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
    statements.push(input.db.prepare(
      `INSERT INTO order_cargo_images(id,organization_id,order_id,cargo_item_id,file_name,content_type,
       size_bytes,data_url,sort_order,created_by_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(), input.organizationId, input.orderId, itemId, file.name, file.type,
      file.size, dataUrl, existingImageCount + index, input.actorUserId, now,
    ));
  }

  statements.push(input.db.prepare(
    `UPDATE transport_orders SET
      cargo_description=COALESCE((SELECT GROUP_CONCAT(cargo_name_cn,'、') FROM order_cargo_items WHERE order_id=? AND organization_id=?),'未填写'),
      pieces=COALESCE((SELECT SUM(COALESCE(declared_quantity,package_count*pieces_per_package)) FROM order_cargo_items WHERE order_id=? AND organization_id=?),1),
      planned_inbound_package_count=COALESCE((SELECT SUM(package_count) FROM order_cargo_items WHERE order_id=? AND organization_id=?),1),
      gross_weight_kg=COALESCE((SELECT SUM(package_count*gross_weight_per_package_kg) FROM order_cargo_items WHERE order_id=? AND organization_id=?),0),
      volume_cbm=COALESCE((SELECT SUM(package_count*volume_per_package_cbm) FROM order_cargo_items WHERE order_id=? AND organization_id=?),0),
      updated_at=? WHERE id=? AND organization_id=?`,
  ).bind(
    input.orderId, input.organizationId, input.orderId, input.organizationId,
    input.orderId, input.organizationId, input.orderId, input.organizationId,
    input.orderId, input.organizationId,
    now, input.orderId, input.organizationId,
  ));
  statements.push(changedRowGuard(input.db,now),
    input.db.prepare("INSERT INTO order_cargo_edit_submissions(id,organization_id,order_id,actor_user_id,request_key,payload_hash,cargo_item_id,mode,package_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.organizationId,input.orderId,input.actorUserId,requestKey,payloadHash,itemId,input.mode,result.value.packageCount,now),
    input.db.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,'success',?,?)").bind(crypto.randomUUID(),input.organizationId,input.actorUserId,existing?'order.cargo.update':'order.cargo.create','order_cargo_item',itemId,JSON.stringify({orderId:input.orderId,before:existing?existingCargoRecord(existing):null,after:result.value,imageCount:imageFiles.length,source:'order_detail',requestKey}),now));
  const source={order:Object.fromEntries(Object.entries(order).filter(([key])=>key!=='updated_at')),cargo:sources,packages:sourcePackages,rules,images};
  return {ok:true as const,repeated:false as const,itemId,created:!existing,packageCount:result.value.packageCount,guards,statements,source,sourceHash:await sha256(JSON.stringify(source)),payloadHash,reviewRequired:materialChanged&&!["draft","submitted","rejected"].includes(String(order.status)),before:existing?existingCargoRecord(existing):null,after:result.value};
}

export async function saveOrderCargoItem(input:OrderCargoEditInput){
  const prepared=await prepareOrderCargoEdit(input);if(!prepared.ok)return prepared;
  if(!prepared.repeated){
    if(prepared.reviewRequired)return{ok:false as const,error:"已审核货物的关键更正须先申请并由本单审核岗位复核，不能直接覆盖原审批依据"};
    await guardedBatch(input.db,prepared.statements,"保存期间订单、货物、包装状态或权限已变化，本次未保存，请刷新后重试");
  }
  return{ok:true as const,itemId:prepared.itemId,created:prepared.created,packageCount:prepared.packageCount};
}

function existingCargoRecord(row: ExistingCargoRow): CargoEditorRecord {
  return {
    cargoName: row.cargo_name_cn,
    cargoNameEn: row.cargo_name_en ?? "",
    hsCode: row.hs_code ?? "",
    overseasHsCode: row.overseas_hs_code ?? "",
    packageType: row.package_type,
    packageCount: Number(row.package_count),
    piecesPerPackage: Number(row.pieces_per_package),
    weight: Number(row.gross_weight_per_package_kg),
    netWeight: Number(row.net_weight_per_package_kg),
    length: Number(row.length_cm),
    width: Number(row.width_cm),
    height: Number(row.height_cm),
    volume: Number(row.volume_per_package_cbm),
    declaredValue: Number(row.declared_value),
    currency: row.currency,
    originCountry: row.origin_country ?? "",
    brandModel: row.brand_model ?? "",
    marks: row.marks ?? "",
    specialAttributes: row.special_attributes ?? "",
    notes: row.notes ?? "",
  };
}

function cargoBindValues(value: CargoEditorRecord) {
  return [
    value.cargoName, value.cargoNameEn || null, value.hsCode || null, value.overseasHsCode || null,
    value.packageType, value.packageCount, value.piecesPerPackage, value.weight, value.netWeight,
    value.length, value.width, value.height, value.volume, value.declaredValue, value.currency || "USD",
    value.originCountry || null, value.brandModel || null, value.marks || null,
    value.specialAttributes || null, value.notes || null,
  ];
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
