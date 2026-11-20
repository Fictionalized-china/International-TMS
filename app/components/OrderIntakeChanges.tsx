import {useEffect,useRef} from "react";
import {useFetcher} from "react-router";
import type {action} from "../routes/admin.order-intake-supplement";
import type {loadOrderIntakeSupplement} from "../lib/order-intake-supplement.server";
import {IntakeOperationsFields} from "./IntakeOperationsFields";
import {IntakeRouteFields} from "./IntakeRouteFields";
import {intakeOperationFields} from "../lib/intake-operations";
import {businessDateTimeLabel} from "../lib/business-time";

const visible=(key:string)=>({isActive:key!=="quotation_intake_entrustedServices",isRequired:false});
const editable=intakeOperationFields.filter(field=>field.kind!=="services").map(field=>field.key);
const statuses:Record<string,string>={pending:"待复核（原资料未变）",approved:"已复核并应用",rejected:"已驳回",withdrawn:"已撤回"};
type Snapshot=Awaited<ReturnType<typeof loadOrderIntakeSupplement>>;

/** Sibling forms: never nest a correction/review form inside the missing-only form. */
export function OrderIntakeChanges({snapshot,endpoint,onSaved,onBusyChange}:{snapshot:Snapshot;endpoint:string;onSaved:()=>void;onBusyChange:(busy:boolean)=>void}){
  const writer=useFetcher<typeof action>(),handled=useRef<string|null>(null);
  const busy=writer.state!=="idle",hasPending=snapshot.changes.requests.some(row=>row.status==="pending");
  useEffect(()=>{onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  useEffect(()=>{
    if(writer.state!=="idle"||!writer.data||!("saveKey"in writer.data)||handled.current===writer.data.saveKey)return;
    handled.current=writer.data.saveKey;onSaved();
  },[writer.state,writer.data,onSaved]);
  return <section className="intake-change-section" aria-label="开单资料更正与复核">
    <h3>已有资料更正与复核</h3>
    <p className="muted">先申请，再由本单审核岗位复核。复核前沿用原资料，不重开已完成节点。已挂配载或已安排运输的线路、承运计划须先在原模块调整；这里不改实际车辆、库存、费用或资金。</p>
    {writer.data&&"formError"in writer.data&&<p className="alert danger" role="alert">{writer.data.formError}</p>}
    {writer.data&&"success"in writer.data&&<p className="alert success" role="status">{writer.data.success}</p>}
    {snapshot.changes.requests.map(row=><article className="intake-change-record" key={row.id}>
      <header><strong>{row.kind==='cargo'?'货物更正 · ':''}{statuses[row.status]??row.status}</strong><span>{row.requester_name} · {businessDateTimeLabel(row.created_at)}</span></header>
      <p>申请依据：{row.reason}</p>
      <div className="table-scroll"><table><thead><tr><th>资料</th><th>更正前</th><th>更正后</th></tr></thead><tbody>{row.differences.map((change,index)=><tr key={index}><th scope="row">{change.label}</th><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div>
      {row.review_notes&&<p>复核记录：{row.reviewer_name} · {row.reviewed_at?businessDateTimeLabel(row.reviewed_at):""} · {row.review_notes}</p>}
      {row.status==="pending"&&(snapshot.changes.canReview||snapshot.changes.canReject||row.canWithdraw)&&<writer.Form method="post" action={endpoint} className="intake-change-review">
        <fieldset disabled={busy}>
          <input type="hidden" name="intent" value="review_intake_change"/><input type="hidden" name="changeId" value={row.id}/>
          <label className="field"><span>复核 / 撤回依据</span><textarea name="reviewNotes" required minLength={2} maxLength={1000} placeholder="说明已核对的依据或驳回、撤回原因"/></label>
          <div className="form-actions">{snapshot.changes.canReview&&<button className="primary" name="decision" value="approved" disabled={busy}>{busy?"正在办理…":"复核通过并应用更正"}</button>}{snapshot.changes.canReject&&<button className="secondary" name="decision" value="rejected" disabled={busy}>驳回，保留原资料</button>}{row.canWithdraw&&<button className="secondary" name="decision" value="withdrawn" disabled={busy}>撤回申请</button>}</div>
        </fieldset>
      </writer.Form>}
      {row.status==="pending"&&!snapshot.changes.canReview&&!snapshot.changes.canReject&&!row.canWithdraw&&<p className="muted">请由本单配置的审核岗位责任人或老板在此复核。</p>}
    </article>)}
    {!snapshot.changes.requests.length&&<p className="muted">暂无更正申请。</p>}
    {snapshot.canEdit&&!hasPending&&<details className="tracking-history-disclosure">
      <summary>申请更正已有开单计划或线路</summary>
      <writer.Form key={snapshot.order.version} method="post" action={endpoint} aria-label="开单资料更正申请">
        <fieldset disabled={busy}>
          <input type="hidden" name="intent" value="request_intake_change"/><input type="hidden" name="version" value={snapshot.order.version}/><input type="hidden" name="requestKey" value={snapshot.changes.requestKey}/>
          <IntakeOperationsFields people={snapshot.people} policy={visible} raw={snapshot.order.operations} defaultTailCarrier="" editableKeys={editable}/>
          <IntakeRouteFields references={snapshot.references} policy={visible} values={snapshot.order.routes}/>
          <label className="field"><span>更正依据</span><textarea name="changeReason" required minLength={2} maxLength={1000} placeholder="说明原资料为何有误及核对依据；未变化的项目保持原值"/></label>
          <button className="primary" disabled={busy}>{busy?"正在提交…":"提交更正，等待复核（不推进节点）"}</button>
        </fieldset>
      </writer.Form>
    </details>}
  </section>;
}
