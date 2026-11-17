import {useEffect,useRef,useState} from "react";
import {useFetcher,useLocation,useRevalidator} from "react-router";
import {sitePhotoStages} from "../lib/business-process-policy";
import type {SitePhotoSummary} from "../lib/order-site-photos.server";
import type {loadSitePhotoPanel} from "../lib/order-site-photo-access.server";
import {businessDateTimeLabel} from "../lib/business-time";
import {sitePhotoImageHeader,assertSitePhotoDimensions} from "../lib/site-photo-image";

/** Keep originals in the native form, create small previews once, and never
 * upload while merely choosing/removing a file. A failed submit retains them. */
type PhotoOrderOption={orderId:string;orderNumber:string;customerName?:string};
export function SitePhotoPicker({scopeLabel="本次作业",limits,stage,orders}:{scopeLabel?:string;limits?:{count:number;fileBytes:number;enabledStages?:string[];requiredStages?:string[]};stage?:string;orders?:PhotoOrderOption[]}){
  const originals=useRef<HTMLInputElement>(null),thumbnails=useRef<HTMLInputElement>(null),generation=useRef(0);
  const chosen=useRef<{file:File;thumbnail:File;url:string;orderIds:string[]}[]>([]);
  const [items,setItems]=useState<typeof chosen.current>([]),[preparing,setPreparing]=useState(false),[error,setError]=useState("");
  useEffect(()=>()=>{generation.current++;for(const item of chosen.current)URL.revokeObjectURL(item.url);},[]);
  const install=(next:typeof chosen.current)=>{
    const data=new DataTransfer(),thumbs=new DataTransfer();next.forEach(item=>{data.items.add(item.file);thumbs.items.add(item.thumbnail);});
    if(originals.current){originals.current.files=data.files;originals.current.setCustomValidity(orders&&orders.length>1&&next.some(item=>!item.orderIds.length)?"请为每张照片选择适用订单，整批共用需明确选择全部订单":"");}if(thumbnails.current)thumbnails.current.files=thumbs.files;
    chosen.current=next;setItems(next);
  };
  async function select(files:File[]){
    const version=++generation.current;setPreparing(true);setError("");originals.current?.setCustomValidity("正在生成图片预览，请稍候");
    const next:typeof chosen.current=[];
    try{
      if(files.length>(limits?.count??8))throw new Error(`每次最多 ${limits?.count??8} 张，请减少图片数量`);
      for(const file of files){
        if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>(limits?.fileBytes??2*1024*1024))throw new Error(`${file.name}格式不支持或过大，请压缩后重新选择`);
        assertSitePhotoDimensions(sitePhotoImageHeader(new Uint8Array(await file.arrayBuffer())));
        const bitmap=await createImageBitmap(file);
        try{
          if(bitmap.width*bitmap.height>40_000_000)throw new Error("图片尺寸过大，请压缩后重新选择");
          const scale=Math.min(1,320/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement("canvas");
          canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
          const ctx=canvas.getContext("2d");if(!ctx)throw new Error("当前浏览器无法生成预览，请换用最新浏览器");
          ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
          const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("预览生成失败，请重新选择")),"image/jpeg",0.75));
          next.push({file,thumbnail:new File([blob],`preview-${next.length}.jpg`,{type:"image/jpeg"}),url:URL.createObjectURL(blob),orderIds:orders?.length===1?[orders[0].orderId]:[]});
        }finally{bitmap.close();}
      }
      if(version!==generation.current){next.forEach(item=>URL.revokeObjectURL(item.url));return;}
      chosen.current.forEach(item=>URL.revokeObjectURL(item.url));install(next);
    }catch(reason){next.forEach(item=>URL.revokeObjectURL(item.url));if(version===generation.current){const message=reason instanceof Error&&/[\u4e00-\u9fff]/.test(reason.message)?reason.message:"图片损坏或无法生成预览，请重新选择有效的静态照片";setError(message);originals.current?.setCustomValidity(message);}}
    finally{if(version===generation.current)setPreparing(false);}
  }
  const required=Boolean(stage&&limits?.requiredStages?.includes(stage));
  if(stage&&limits?.enabledStages&&!limits.enabledStages.includes(stage))return <p className="site-photo-picker">当前节点照片上传已按配置停用，已保存的照片仍可查看。</p>;
  return <div className="site-photo-picker">
    <label className="field"><span>现场照片{required&&<b className="required-mark"> *</b>}{limits&&`（最多 ${limits.count} 张，每张 ${Math.floor(limits.fileBytes/1024)} KB）`}</span><input ref={originals} type="file" name="sitePhotos" required={required} accept="image/jpeg,image/png,image/webp" multiple onChange={event=>void select(Array.from(event.target.files??[]))}/></label>
    <input ref={thumbnails} type="file" name="sitePhotoThumbnails" multiple hidden aria-hidden="true" tabIndex={-1}/>
    {orders&&orders.length>1&&<input type="hidden" name="sitePhotoTargetOrderIds" value={JSON.stringify(items.map(item=>item.orderIds))}/>}
    <small>{scopeLabel}的照片会保存到系统并自动展示给所属客户，请勿上传内部账单或其他客户资料。原图保留，列表仅加载缩略图。{orders&&orders.length>1&&"每张照片必须选择适用订单；未选订单不会收到该照片。"}</small>
    {preparing&&<p role="status">正在准备预览，请稍候…</p>}{error&&<p role="alert" className="danger-text">{error}</p>}
    {items.length>0&&<ul className="site-photo-previews">{items.map((item,index)=><li key={`${item.file.name}-${index}`}><img src={item.url} alt={`${item.file.name} 预览`}/><span>{item.file.name}</span>{orders&&orders.length>1&&<PhotoOrderScope orders={orders} selected={item.orderIds} onChange={orderIds=>install(chosen.current.map((value,i)=>i===index?{...value,orderIds}:value))}/>}<button type="button" disabled={preparing} className="secondary" onClick={()=>{URL.revokeObjectURL(item.url);install(chosen.current.filter((_,i)=>i!==index));setError("");}}>移除</button></li>)}</ul>}
  </div>;
}

function PhotoOrderScope({orders,selected,onChange}:{orders:PhotoOrderOption[];selected:string[];onChange:(ids:string[])=>void}){
  const [query,setQuery]=useState("");const filtered=orders.filter(order=>`${order.orderNumber} ${order.customerName??""}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <details className="site-photo-order-scope"><summary>{selected.length?`适用 ${selected.length} / ${orders.length} 票订单`:"请选择照片适用订单 *"}</summary>
    {orders.length>5&&<label className="field"><span>筛选订单号或客户</span><input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>}
    <label><input type="checkbox" checked={selected.length===orders.length} onChange={event=>onChange(event.target.checked?orders.map(order=>order.orderId):[])}/>整批公共现场，明确适用于全部 {orders.length} 票</label>
    <div>{filtered.map(order=><label key={order.orderId}><input type="checkbox" checked={selected.includes(order.orderId)} onChange={event=>onChange(event.target.checked?[...selected,order.orderId]:selected.filter(id=>id!==order.orderId))}/><span>{order.orderNumber}{order.customerName&&<small>{order.customerName}</small>}</span></label>)}</div>
  </details>;
}

export function SitePhotoGallery({photos,basePath,context=""}:{photos:SitePhotoSummary[];basePath:string;context?:string}){
  const href=(id:string,thumbnail=false)=>`${basePath}/${encodeURIComponent(id)}?${context}${context?"&":""}${thumbnail?"size=thumbnail":"size=original"}`;
  return photos.length?<ul className="site-photo-gallery">{photos.map(photo=><li key={photo.id}><a href={href(photo.id)} target="_blank" rel="noreferrer" aria-label={`查看原图：${photo.file_name}`}>{photo.has_thumbnail===0?<span className="site-photo-legacy-preview">历史现场凭证 · 点击查看原图</span>:<img src={href(photo.id,true)} loading="lazy" decoding="async" alt={photo.description||photo.file_name}/>}</a><strong>{sitePhotoStages[photo.stage_code]||"现场照片"}</strong><span>{photo.description||photo.file_name}</span><small><time dateTime={photo.occurred_at}>{businessDateTimeLabel(photo.occurred_at)}（北京时间）</time></small></li>)}</ul>:<p className="empty-state">暂无现场照片。</p>;
}

export function SitePhotoPanel({orderId,site="admin",scopeLabel}:{orderId:string;site?:"admin"|"warehouse";scopeLabel?:string}){
  const view=useFetcher<Awaited<ReturnType<typeof loadSitePhotoPanel>>>(),location=useLocation(),revalidator=useRevalidator();
  const [uploading,setUploading]=useState(false),[result,setResult]=useState<{success?:string;formError?:string}>({});
  const params=new URLSearchParams(location.search),context=new URLSearchParams();for(const key of ["itmsTab","warehouseId"]){const value=params.get(key);if(value)context.set(key,value);}
  const endpoint=`/${site}/order-site-photos/${encodeURIComponent(orderId)}?${context}`;
  const currentEndpoint=useRef(endpoint);currentEndpoint.current=endpoint;
  useEffect(()=>{currentEndpoint.current=endpoint;return()=>{currentEndpoint.current="";};},[endpoint]);
  const [requestKey,setRequestKey]=useState("");
  useEffect(()=>{view.load(endpoint);setRequestKey(crypto.randomUUID());setUploading(false);setResult({});},[endpoint]);
  async function submit(form:HTMLFormElement){
    if(uploading)return;const targetEndpoint=endpoint,body=new FormData(form);setUploading(true);setResult({});
    try{
      const response=await fetch(endpoint,{method:"POST",body,credentials:"same-origin",signal:AbortSignal.timeout(45000)});
      if(currentEndpoint.current!==targetEndpoint)return;
      if(!response.ok||!response.headers.get("content-type")?.includes("application/json"))throw new Error("登录、权限或网络状态已变化，照片选择仍保留，请核对后重试");
      const data=await response.json() as {success?:string;formError?:string;savedKey?:string};
      if(!data.success||data.savedKey!==requestKey)throw new Error(data.formError||"尚未收到保存确认，可保留当前照片重试");
      // Refresh the index/counts and its active photo fetcher once. A native
      // retry-safe upload must not leave the parent file center stale.
      setResult({success:data.success});setRequestKey(crypto.randomUUID());revalidator.revalidate();
    }catch(error){if(currentEndpoint.current===targetEndpoint)setResult({formError:error instanceof Error&&!["AbortError","TimeoutError","TypeError"].includes(error.name)?error.message:"网络中断或响应超时，照片选择仍保留；直接重试不会重复新增"});}
    finally{if(currentEndpoint.current===targetEndpoint)setUploading(false);}
  }
  const data=view.data;
  return <section className="site-photo-section" aria-label="现场照片"><h3>现场照片与客户同步</h3>
    {!data?<p role="status">正在读取照片…</p>:<>
      <SitePhotoGallery photos={data.photos} basePath={`/${site}/site-photos`} context={context.toString()}/>
      <div className="site-photo-pagination"><button type="button" className="secondary" disabled={view.state!=="idle"||data.page<=1} onClick={()=>view.load(`${endpoint}&page=${data.page-1}`)}>上一页</button><span>第 {data.page} 页</span><button type="button" className="secondary" disabled={view.state!=="idle"||!data.hasMore} onClick={()=>view.load(`${endpoint}&page=${data.page+1}`)}>下一页</button></div>
      {data.stages.length>0&&<details className="site-photo-supplement"><summary>补传提货、收货或换装现场照片</summary><form method="post" encType="multipart/form-data" action={endpoint} onSubmit={event=>{event.preventDefault();void submit(event.currentTarget);}}>
        <input type="hidden" name="photoRequestKey" value={requestKey}/><label className="field"><span>照片所属作业</span><select name="stage" required>{data.stages.map(stage=><option key={stage} value={stage}>{sitePhotoStages[stage]}</option>)}</select></label>
        <label className="field"><span>现场说明（选填）</span><input name="description" maxLength={500} placeholder="例如到货外观、换装记录，不更改业务状态"/></label>
        <SitePhotoPicker key={`${endpoint}:${requestKey}`} limits={data.limits} scopeLabel={scopeLabel}/>
        {result.formError&&<p role="alert" className="danger-text">{result.formError}</p>}{result.success&&<p role="status">{result.success}</p>}
        {uploading&&<progress aria-label="照片正在上传"/>}<button className="primary" disabled={uploading||!requestKey}>{uploading?"正在保存照片…":"保存照片并同步客户"}</button>
      </form></details>}
    </>}
  </section>;
}
