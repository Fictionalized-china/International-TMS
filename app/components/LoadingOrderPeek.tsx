import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { LoadingPlanningCandidate } from "../lib/loading-batch-planning.server";

type PeekPosition = { left: number; top: number };

/** A viewport-level tooltip avoids clipping inside the horizontally scrollable planning table. */
export function LoadingOrderPeek({ order }: { order: LoadingPlanningCandidate }) {
  const tooltipId = useId();
  const [position, setPosition] = useState<PeekPosition | null>(null);
  const show = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    setPosition({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
      top: bounds.bottom + 260 < window.innerHeight ? bounds.bottom + 8 : Math.max(8, bounds.top - 252),
    });
  };
  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [position]);
  const destination = [order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" · ");
  return <span className="loading-order-peek-trigger" onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => setPosition(null)} onFocus={(event) => show(event.currentTarget)} onBlur={() => setPosition(null)}>
    <Link className="entity-number-link" to={`/admin/orders/${order.order_id}`} aria-label={`查看订单 ${order.order_number}，聚焦可预览配载资料`} aria-describedby={position ? tooltipId : undefined}>{order.order_number}</Link>
    {position && typeof document !== "undefined" && createPortal(<div className="loading-order-peek-card" id={tooltipId} role="tooltip" style={position}>
      <strong>{order.order_number} · {order.customer_name}</strong>
      <dl>
        <div><dt>货物</dt><dd>{order.cargo_names || order.cargo_description || "未填写货名"}</dd></div>
        <div><dt>起运 / 目的</dt><dd>{order.origin_city || "未填写"} → {destination || "未填写"}</dd></div>
        <div><dt>仓库</dt><dd>{order.warehouse_name} → {order.overseas_warehouse_name || "未设置"}</dd></div>
        <div><dt>口岸 / 清关</dt><dd>{order.exit_port_name || order.exit_port || "待配载确认"} / {order.customs_location_name || order.customs_location || "待配载确认"}</dd></div>
        <div><dt>仓库实收</dt><dd>{order.package_count} 包 · {order.pieces} 件 · {Number(order.weight_kg).toFixed(2)} KG · {Number(order.volume_cbm).toFixed(3)} CBM</dd></div>
      </dl>
      <small>同仓、同目的仓、同操作主管的订单才可拼批；口岸和清关地请按实际线路核对。</small>
    </div>, document.body)}
  </span>;
}
