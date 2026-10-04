import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Modal } from "./Modal";
import { dailyTrackingKindLabels, dailyTrackingKinds } from "../lib/daily-tracking";

export function DailyTrackingForm({orderId,orderNumber,requestId,closeSignal}:{orderId:string;orderNumber:string;requestId:string;closeSignal:unknown}) {
  const busy=useNavigation().state!=="idle";
  return <Modal title={`每日运踪 · ${orderNumber}`} triggerLabel="登记每日运踪" triggerClassName="text-button" closeSignal={closeSignal}>
    <Form method="post" className="form-grid"><input type="hidden" name="intent" value="daily"/><input type="hidden" name="orderId" value={orderId}/><input type="hidden" name="requestId" value={`${requestId}:${orderId}`}/>
      <label>动态类型<select name="eventKind">{dailyTrackingKinds.map(kind=><option key={kind} value={kind}>{dailyTrackingKindLabels[kind]}</option>)}</select></label>
      <label>发生时间（北京时间）<input type="datetime-local" name="eventAt" required defaultValue={new Date(Date.now()+8*3600*1000).toISOString().slice(0,16)}/></label>
      <label>当前地点<input name="location" required maxLength={200}/></label><label>车号 / 换装车号<input name="vehicleReference" maxLength={100}/></label>
      <label className="full">运踪说明 / 排队位置<textarea name="notes" required maxLength={2000}/></label>
      <label><input type="checkbox" name="visible" value="1" defaultChecked/>同步到客户运踪</label>
      <p>此登记不推进主流程、不替代实际出境或仓库扫码。相同状态可每日重复登记。</p><button className="primary" disabled={busy}>保存运踪</button>
    </Form>
  </Modal>;
}

export function DispatchRequestForm({orderId,orderNumber,closeSignal}:{orderId:string;orderNumber:string;closeSignal:unknown}) {
  const busy=useNavigation().state!=="idle";
  return <Modal title={`商务找车 · ${orderNumber}`} triggerLabel="计划到口岸 / 找车" triggerClassName="text-button" closeSignal={closeSignal}><Form method="post" className="form-grid">
    <input type="hidden" name="intent" value="dispatch_request"/><input type="hidden" name="orderId" value={orderId}/>
    <label>计划到口岸（北京时间）<input type="datetime-local" name="plannedPortArrivalAt" required/></label>
    <p>可先保存计划，按配置提前天数自动生成找车待办；也可现在发送。资料不齐时会明确列出缺项。</p>
    <button className="secondary" name="planOnly" value="1" disabled={busy}>仅保存计划</button><button className="primary" disabled={busy}>发送商务找车任务</button>
  </Form></Modal>;
}

export type DispatchResources={carriers:{id:string;name:string}[];vehicles:{id:string;carrier_id:string;plate_number:string}[];drivers:{id:string;carrier_id:string;name:string}[]};
export function DispatchFeedbackForm({orderId,orderNumber,resources,closeSignal}:{orderId:string;orderNumber:string;resources:DispatchResources;closeSignal:unknown}) {
  const [carrier,setCarrier]=useState("");const busy=useNavigation().state!=="idle";
  return <Modal title={`反馈运输资源 · ${orderNumber}`} triggerLabel="办理找车" triggerClassName="primary" closeSignal={closeSignal}><Form method="post" className="form-grid">
    <input type="hidden" name="intent" value="dispatch_fulfill"/><input type="hidden" name="orderId" value={orderId}/>
    <label>承运商<select name="carrierId" required value={carrier} onChange={e=>setCarrier(e.target.value)}><option value="">请选择</option>{resources.carriers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>车辆<select key={`${carrier}:vehicle`} name="vehicleId" required><option value="">请选择</option>{resources.vehicles.filter(v=>v.carrier_id===carrier).map(v=><option key={v.id} value={v.id}>{v.plate_number}</option>)}</select></label>
    <label>司机<select key={`${carrier}:driver`} name="driverId" required><option value="">请选择</option>{resources.drivers.filter(d=>d.carrier_id===carrier).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label>运价<input name="freightAmount" type="number" min="0.01" step="0.01" required/></label><label>币种<input name="currency" defaultValue="CNY" pattern="[A-Z]{3}" required/></label><label>实际汇率<input name="exchangeRate" type="number" min="0.000001" step="0.000001" defaultValue="1" required/></label>
    <label className="full">资源备注<textarea name="notes" maxLength={2000}/></label><p>资源先录入承运商台账。反馈不自动创建配载单，仍由操作主管选择资源配载。</p><button className="primary" disabled={busy}>确认资源已落实</button>
  </Form></Modal>;
}
