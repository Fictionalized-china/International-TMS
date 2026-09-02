import { useState } from "react";
import { useNavigation } from "react-router";
import { Modal } from "./Modal";
import { PortalForm as Form } from "./PortalNavigation";
import {
  formatPickupAppointment,
  pickupAppointmentPeriods,
} from "../lib/pickup-appointment";

export type PortalPickupAppointmentOrder = {
  id: string;
  order_number: string;
  overseas_operation_status: string | null;
  pickup_appointment_at: string | null;
  pickup_appointment_period: string | null;
};

export function PortalPickupAppointment({
  order,
  returnTo,
}: {
  order: PortalPickupAppointmentOrder;
  returnTo: "/portal" | "/portal/orders";
}) {
  const navigation = useNavigation();
  const [period, setPeriod] = useState(
    order.pickup_appointment_period || "morning",
  );
  if (!order.overseas_operation_status || !["notified", "appointment"].includes(order.overseas_operation_status))
    return null;

  const hasAppointment = Boolean(order.pickup_appointment_at);
  return (
    <Modal
      title={`${hasAppointment ? "修改" : "预约"}提货时间 · ${order.order_number}`}
      triggerLabel={hasAppointment ? "修改预约" : "预约提货"}
      triggerClassName="btn small pickup-appointment-trigger"
      initialFocusSelector="input[name='appointmentDate']"
    >
      <Form method="post" action="/portal/pickup-appointment" className="pickup-appointment-form">
        <input type="hidden" name="orderId" value={order.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div className="pickup-appointment-summary">
          <span>货物状态</span>
          <strong>已到境外目的仓，等待客户自提</strong>
          <small>当前预约：{formatPickupAppointment(order.pickup_appointment_at, order.pickup_appointment_period)}</small>
        </div>
        <label className="field">
          <span>提货日期 *</span>
          <input
            type="date"
            name="appointmentDate"
            defaultValue={order.pickup_appointment_at?.slice(0, 10) || ""}
            required
          />
        </label>
        <fieldset className="pickup-period-fieldset">
          <legend>提货时段 *</legend>
          <div className="pickup-period-options">
            {pickupAppointmentPeriods.map((item) => (
              <label key={item.value} className={period === item.value ? "selected" : ""}>
                <input
                  type="radio"
                  name="appointmentPeriod"
                  value={item.value}
                  checked={period === item.value}
                  onChange={() => setPeriod(item.value)}
                />
                <strong>{item.label}</strong>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="field-hint">仓库将同步看到本次预约；如行程变化，可在提货前再次修改。</p>
        <button className="primary" disabled={navigation.state !== "idle"}>
          {navigation.state !== "idle" ? "正在保存…" : "确认预约"}
        </button>
      </Form>
    </Modal>
  );
}
