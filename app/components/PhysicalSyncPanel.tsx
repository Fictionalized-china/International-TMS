import {useEffect,useState} from "react";
import {useFetcher,useLocation,useRevalidator} from "react-router";
type Result={jobs:{id:string;kind:string;status:string;last_error:string|null;canRetry:boolean}[];success?:string};
export function PhysicalSyncPanel({orderId,site="admin",initiallyOpen=false}:{orderId:string;site?:"admin"|"warehouse";initiallyOpen?:boolean}){
  const fetcher=useFetcher<Result>(),location=useLocation(),revalidator=useRevalidator(),[open,setOpen]=useState(initiallyOpen);
  const query=new URLSearchParams();for(const key of["itmsTab","warehouseId"]){const value=new URLSearchParams(location.search).get(key);if(value)query.set(key,value);}
  const endpoint=`/${site}/orders/${encodeURIComponent(orderId)}/physical-sync?${query}`;
  useEffect(()=>{if(open&&orderId)fetcher.load(endpoint);},[endpoint,open]);
  useEffect(()=>{if(fetcher.state==="idle"&&fetcher.data?.success)revalidator.revalidate();},[fetcher.data]);
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)} className="tracking-history-disclosure"><summary>实物作业后的流程同步 / 重试</summary>
    <p>只修复已保存作业的流程状态，不重复收货、装车、签收或资金操作。</p>
    {fetcher.state!=="idle"&&<p role="status">正在核对同步任务…</p>}
    {fetcher.data?.success&&<p role="status">{fetcher.data.success}</p>}
    {fetcher.data?.jobs.length===0&&<p>当前没有待重试任务。</p>}
    {fetcher.data?.jobs.map(job=><div key={job.id} className="alert warning"><strong>{job.kind==="domestic_receipt"?"国内收货":job.kind==="overseas_receipt"?"境外收货":"境外签收"}：实物已保存，流程待同步</strong><p>{job.last_error||"任务正在同步或等待重试；请勿重复办理实物操作。"}</p>{!job.canRetry&&<p>请由仓库操作、相应模块负责人或老板办理同步。</p>}</div>)}
    {fetcher.data?.jobs.some(job=>job.canRetry)&&<fetcher.Form method="post" action={endpoint}><button className="secondary" disabled={fetcher.state!=="idle"}>{fetcher.state==="idle"?"重试流程同步（不重复实物作业）":"正在同步…"}</button></fetcher.Form>}
  </details>;
}
