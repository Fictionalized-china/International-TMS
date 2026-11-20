import {useCallback,useEffect,useRef,useState} from "react";
import {useFetcher,useLocation} from "react-router";
import type {loader,action} from "../routes/admin.order-intake-supplement";
import type {loadOrderIntakeSupplement} from "../lib/order-intake-supplement.server";
import {Modal} from "./Modal";
import {IntakeOperationsFields} from "./IntakeOperationsFields";
import {IntakeRouteFields} from "./IntakeRouteFields";
import {intakeServiceOptions} from "../lib/intake-operations";
import {OrderIntakeChanges} from "./OrderIntakeChanges";
type Snapshot=Awaited<ReturnType<typeof loadOrderIntakeSupplement>>;
const visible=(key:string)=>({isActive:key!=="quotation_intake_entrustedServices",isRequired:false});
export function OrderIntakeSupplement({orderId}:{orderId:string}) {
  const reader=useFetcher<typeof loader>(),writer=useFetcher<typeof action>(),location=useLocation();
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState("");
  const [changeBusy,setChangeBusy]=useState(false);
  const pending=useRef(false);
  const previousResponse=useRef(writer.data);
  const query=new URLSearchParams();const slot=new URLSearchParams(location.search).get("itmsTab");if(slot)query.set("itmsTab",slot);
  const endpoint=`/admin/orders/${encodeURIComponent(orderId)}/intake-supplement${query.size?`?${query}`:""}`;
  function load(){pending.current=true;previousResponse.current=writer.data;setLoading(true);setLoadError("");setSnapshot(null);reader.load(endpoint);}
  const reloadChanges=useCallback(()=>{pending.current=true;reader.load(endpoint);},[endpoint]);
  useEffect(()=>{
    if(!pending.current||reader.state!=="idle"||!reader.data)return;
    pending.current=false;setLoading(false);
    if("loadError"in reader.data)setLoadError(reader.data.loadError);else setSnapshot(reader.data);
  },[reader.state,reader.data]);
  const busy=writer.state!=="idle"||changeBusy;
  return <div className="order-intake-supplement-entry">
    <p>开单计划、线路和报价归属缺失时可在本订单补录；已有计划与线路可在同页申请更正并复核。历史委托服务按原始依据补齐，不在此处新增流程分支。</p>
    <Modal title="查看与补录开单资料" triggerLabel="查看 / 补齐开单资料" triggerClassName="secondary" size="wide" guardFormChanges={Boolean(snapshot)} dismissible={!busy} closeSignal={writer.data&&"saveKey"in writer.data?writer.data.saveKey:undefined} onOpenChange={open=>{if(open)load();}}>
      {loading&&<p role="status">正在读取当前订单资料…</p>}
      {loadError&&<div role="alert"><p>{loadError}</p><button className="secondary" type="button" onClick={load}>重新读取</button></div>}
      {snapshot&&<writer.Form method="post" action={endpoint} className="order-intake-supplement-form" aria-label="开单资料补录">
        <fieldset className="intake-supplement-fields" disabled={busy}>
        <input type="hidden" name="version" value={snapshot.order.version}/>
        <p className="alert info">{snapshot.order.number} · 本区尚缺 {snapshot.missing.length} 项{snapshot.missing.length?`：${snapshot.missing.join("、")}`:"，无需补录"}。此处只统计计划、线路及报价归属，完整业务门禁还需核对货物、服务与费用。</p>
        {snapshot.ruleError&&<p className="alert warning" role="alert">{snapshot.ruleError}。可先补录缺项；由老板或流程管理员核对货物、服务和费用后，通过下方按钮修复本单规则，不重开运输或库存。</p>}
        {writer.data&&writer.data!==previousResponse.current&&"formError"in writer.data&&<p className="alert danger" role="alert">{writer.data.formError}</p>}
        <IntakeOperationsFields people={snapshot.people} policy={visible} raw={snapshot.order.operations} defaultTailCarrier="" editableKeys={snapshot.canEdit?snapshot.operationKeys:[]}/>
        <IntakeRouteFields references={snapshot.references} policy={visible} values={snapshot.order.routes} editableKeys={snapshot.canEdit?snapshot.routeKeys:[]}/>
        <div className="quote-field-grid">
          <label className="field"><span>报价商务</span>{snapshot.canEdit&&!snapshot.order.commercialId&&!snapshot.order.commercialName?.trim()?<select className="control" name="quoteCommercialUserId" defaultValue=""><option value="">请选择实际报价人（不自动猜填）</option>{snapshot.people.quoteCommercials.map(person=><option key={person.id} value={person.id}>{person.display_name}</option>)}</select>:<input className="control" readOnly value={snapshot.order.commercialName??snapshot.order.commercialId??"尚未记录"}/>}</label>
          {snapshot.canEdit&&(snapshot.missing.length>0||!snapshot.ruleVersion)&&<label className="field"><span>补录 / 规则升级依据</span><textarea name="reason" minLength={2} maxLength={1000} required placeholder="说明所依据的原始委托或业务确认"/></label>}
        </div>
        {snapshot.canEdit&&snapshot.missing.length>0?<button className="primary" disabled={busy}>{busy?"正在保存…":"保存已补资料（不推进节点）"}</button>:<p className="muted">{snapshot.missing.length?"当前账号仅可查看，请由本单业务、操作等有权责任人补录。":"本区资料已完整；修改已有内容需走受控更正。"}</p>}
        <p className="readonly-note">{snapshot.ruleVersion?"本单已绑定录单必填检查；向前办理会重新核对，不影响合法补录、驳回或取消。":"历史订单未静默替换规则。补齐资料、货物与费用后，可应用当前录单检查；不会替换运输工作流或重开已完成事实。"}</p>
        {snapshot.canEdit&&!snapshot.ruleVersion&&snapshot.missing.length===0&&<button className="secondary" name="intent" value="apply_intake_rule" disabled={busy}>{busy?"正在核对…":"核对并应用本单录单检查"}</button>}
        {snapshot.servicesMissing&&<details className="tracking-history-disclosure">
          <summary>补齐缺失的历史委托服务</summary>
          <p>本单没有委托服务记录。请按原始委托选择实际服务，不自动猜填；只能引用本单已经启用的流程分支。</p>
          {snapshot.canEdit?<><div className="check-row">{intakeServiceOptions.map(([code,label])=><label key={code}><input type="checkbox" name="missingServiceCode" value={code}/><span>{label}</span></label>)}</div>
          <label className="field"><span>原始委托依据</span><textarea name="serviceReason" maxLength={1000} placeholder="说明服务的委托依据，不修改原有流程"/></label>
          <button className="secondary" name="intent" value="supplement_missing_services" formNoValidate disabled={busy}>{busy?"正在保存…":"补录委托服务并留痕"}</button></>:<p>请由本单有权补录的业务、操作或老板核对办理。</p>}
        </details>}
        {snapshot.canEdit&&(snapshot.order.commercialId||snapshot.order.commercialName?.trim())&&<details className="tracking-history-disclosure">
          <summary>更正报价商务归属</summary>
          <p>仅在原归属确有错误时使用，需填写依据并保留前后历史。不会改写原始报价、费用或已结算提成。</p>
          <div className="quote-field-grid">
            <label className="field"><span>实际报价商务</span><select name="quoteCommercialCorrectionId" defaultValue={snapshot.order.commercialId??""}><option value="">请选择实际报价人</option>{snapshot.people.quoteCommercials.map(person=><option key={person.id} value={person.id}>{person.display_name}</option>)}</select></label>
            <label className="field"><span>归属更正依据</span><textarea name="correctionReason" maxLength={1000} placeholder="说明原归属为何有误及核对依据"/></label>
          </div>
          <button className="secondary" name="intent" value="correct_quote_commercial" formNoValidate disabled={busy}>{busy?"正在保存…":"保存归属更正并留痕"}</button>
        </details>}
        </fieldset>
      </writer.Form>}
      {snapshot&&<OrderIntakeChanges snapshot={snapshot} endpoint={endpoint} onSaved={reloadChanges} onBusyChange={setChangeBusy}/>}
    </Modal>
    {writer.data&&writer.data!==previousResponse.current&&"success"in writer.data&&<p className="alert success" role="status">{writer.data.success}</p>}
  </div>;
}
