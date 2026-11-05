import { Form } from "react-router";
import { isBossBusinessActor } from "../lib/permission-blocks";
import { sessionSlotFromUrl, withSessionSlot } from "../lib/session-slot";

type Warehouse = { id: string; name: string; warehouse_role: string | null };
export function bossWarehouseHref(warehouse: Warehouse, orderId?: string, screen?: string) {
  const params = new URLSearchParams({ warehouseId: warehouse.id });
  if (orderId) params.set("orderId", orderId);
  return `/warehouse/${screen ?? (warehouse.warehouse_role === "overseas_destination" ? "inbound" : "acceptance")}?${params}`;
}

export function BossWarehouseEntry({ actor, warehouses, orderId, actionUrl, overseas = false, screen }: {
  actor: { positionCode?: string | null; roleCodes?: readonly string[] }; warehouses: Warehouse[];
  orderId: string; actionUrl: string; overseas?: boolean; screen?: string;
}) {
  if (!isBossBusinessActor(actor)) return null;
  const options = warehouses.filter(warehouse => overseas ? warehouse.warehouse_role === "overseas_destination" : warehouse.warehouse_role !== "overseas_destination");
  if (!options.length) return <p className="alert info">当前没有可代办的启用仓库，请先在仓库管理中配置。</p>;
  return <section className="boss-warehouse-entry alert info" aria-label="老板仓库代办">
    <strong>老板可直接办理仓库作业</strong><p>使用当前老板身份进入，不切换员工账号；收货、扫码、装车和签收仍按原流程校验。</p>
    <Form method="post" action={withSessionSlot("/switch-site", sessionSlotFromUrl(actionUrl))} className="row-actions">
      <input type="hidden" name="target" value="warehouse"/>
      <label className="field"><span>办理仓库</span><select name="warehouseTo" required defaultValue={options.length === 1 ? bossWarehouseHref(options[0], orderId, screen) : ""}>
        <option value="">请选择本单实际仓库</option>{options.map(warehouse => <option key={warehouse.id} value={bossWarehouseHref(warehouse, orderId, screen)}>{warehouse.name}</option>)}
      </select></label><button className="secondary">以老板身份进入办理</button>
    </Form>
  </section>;
}
