import { type ReactElement } from "react";
import { Link } from "react-router";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";

export function OrderMarkLabelPage({
  order,
  returnTo,
  downloadTo,
}: {
  order: OrderMarkLabel;
  returnTo: string;
  downloadTo: string;
}) {
  const route = [order.origin_country, order.origin_state, order.origin_city]
    .filter(Boolean)
    .join(" ") + " → " + [order.destination_country, order.destination_state, order.destination_city]
      .filter(Boolean)
      .join(" ");
  return (
    <main className="order-mark-page">
      <header className="order-mark-toolbar no-print">
        <div>
          <span>ORDER MARK LABEL</span>
          <h1>入仓唛头标签</h1>
          <p>客户接受报价后自动生成；唛头号与订单号一致，每个外包装均粘贴此标签。</p>
        </div>
        <div>
          <Link className="secondary" to={returnTo}>返回订单</Link>
          <a className="secondary" href={downloadTo}>下载 SVG</a>
          <button className="primary" type="button" onClick={() => window.print()}>打印标签</button>
        </div>
      </header>
      <OrderMarkLabelPreview order={order} route={route} />
    </main>
  );
}

export function OrderMarkLabelPreview({
  order,
  route: routeOverride,
}: {
  order: OrderMarkLabel;
  route?: string;
}) {
  const route = routeOverride ?? [
    [order.origin_country, order.origin_state, order.origin_city].filter(Boolean).join(" "),
    [order.destination_country, order.destination_state, order.destination_city].filter(Boolean).join(" "),
  ].join(" → ");
  return (
    <section className="order-mark-print-area" aria-label={`订单 ${order.order_number} 的入仓唛头标签`}>
      <article className="order-mark-label">
        <header><strong>OULING 国际物流</strong><span>入仓唛头标签</span></header>
        <Code39 value={order.order_number} />
        <b className="order-mark-number">{order.order_number}</b>
        <dl>
          <div><dt>唛头号</dt><dd>{order.order_number}</dd></div>
          <div><dt>订单号</dt><dd>{order.order_number}</dd></div>
          <div><dt>客户</dt><dd>{order.customer_name}</dd></div>
          <div><dt>货物</dt><dd>{order.cargo_description}</dd></div>
          <div><dt>计划数据</dt><dd>{order.pieces} 件 · {order.gross_weight_kg} KG · {order.volume_cbm} CBM</dd></div>
          <div><dt>运输线路</dt><dd>{route}</dd></div>
          <div><dt>境外目的仓</dt><dd>{order.overseas_warehouse_name || "待确定"}</dd></div>
        </dl>
        <footer>本标签唛头号与条码内容均为订单号；仓库实收件数、重量、体积以现场清点为准。</footer>
      </article>
    </section>
  );
}

function Code39({ value }: { value: string }) {
  const patterns: Record<string, string> = {
    "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
    "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
    A:"wnnnnwnnw",B:"nnwnnwnnw",C:"wnwnnwnnn",D:"nnnnwwnnw",E:"wnnnwwnnn",F:"nnwnwwnnn",
    G:"nnnnnwwnw",H:"wnnnnwwnn",I:"nnwnnwwnn",J:"nnnnwwwnn",K:"wnnnnnnww",L:"nnwnnnnww",
    M:"wnwnnnnwn",N:"nnnnwnnww",O:"wnnnwnnwn",P:"nnwnwnnwn",Q:"nnnnnnwww",R:"wnnnnnwwn",
    S:"nnwnnnwwn",T:"nnnnwnwwn",U:"wwnnnnnnw",V:"nwwnnnnnw",W:"wwwnnnnnn",X:"nwnnwnnnw",
    Y:"wwnnwnnnn",Z:"nwwnwnnnn","-":"nwnnnnwnw","*":"nwnnwnwnn",
  };
  let x = 0;
  const bars: ReactElement[] = [];
  for (const char of `*${value.toUpperCase()}*`) {
    for (const [index, width] of [...(patterns[char] ?? patterns["-"])].entries()) {
      const size = width === "w" ? 3 : 1;
      if (index % 2 === 0) bars.push(<rect key={`${x}-${index}`} x={x} y="0" width={size} height="72" />);
      x += size;
    }
    x += 1;
  }
  return <svg className="order-mark-code39" viewBox={`0 0 ${x} 72`} preserveAspectRatio="none" aria-label={`条码 ${value}`}>{bars}</svg>;
}
