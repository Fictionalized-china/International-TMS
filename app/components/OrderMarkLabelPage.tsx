import { type ReactElement } from "react";
import { Form, Link } from "react-router";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";

export function OrderMarkLabelPage({
  order,
  returnTo,
  downloadTo,
  canReviseInboundPackages = false,
  revisionMessage,
}: {
  order: OrderMarkLabel;
  returnTo: string;
  downloadTo: string;
  canReviseInboundPackages?: boolean;
  revisionMessage?: { success?: string; formError?: string };
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
          <p>客户接受报价后按预计入仓包装数自动生成；每个外包装使用一张唯一唛头。</p>
        </div>
        <div>
          <Link className="secondary" to={returnTo}>返回订单</Link>
          <a className="secondary" href={downloadTo}>下载 SVG</a>
          <button className="primary" type="button" onClick={() => window.print()}>打印标签</button>
        </div>
      </header>
      {revisionMessage?.formError && <div className="alert error no-print">{revisionMessage.formError}</div>}
      {revisionMessage?.success && <div className="alert success no-print">{revisionMessage.success}</div>}
      <section className="order-mark-revision no-print">
        <div><strong>预计入仓包装：{order.planned_inbound_package_count} 包</strong><span>{order.inbound_package_locked_at ? "国内仓已开始扫码，包装数和唛头已锁定" : "首次扫码前可由本单业务员修订；保存后旧唛头立即失效"}</span></div>
        {canReviseInboundPackages && !order.inbound_package_locked_at && <Form method="post" className="order-mark-revision-form"><label><span>新包装数</span><input type="number" name="plannedPackageCount" min="1" max="500" step="1" defaultValue={order.planned_inbound_package_count} required/></label><button className="primary">重新生成唛头</button></Form>}
      </section>
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
  const marks=order.marks.length?order.marks:[{id:order.id,code:`${order.order_number}-IN-001`,sequence:1,revision:1}];
  return (
    <section className="order-mark-print-area" aria-label={`订单 ${order.order_number} 的入仓唛头标签`}>
      {marks.map((mark)=><article className="order-mark-label" key={mark.id}>
        <header><strong>OULING 国际物流</strong><span>入仓唛头标签</span></header>
        <Code39 value={mark.code} />
        <b className="order-mark-number">{mark.code}</b>
        <dl>
          <div><dt>入仓唛头</dt><dd>{mark.code}</dd></div>
          <div><dt>订单号</dt><dd>{order.order_number}</dd></div>
          <div><dt>包装序号</dt><dd>{mark.sequence}/{order.planned_inbound_package_count}（预计）</dd></div>
          <div><dt>客户</dt><dd>{order.customer_name}</dd></div>
          <div><dt>货物</dt><dd>{order.cargo_description}</dd></div>
          <div><dt>商品数量</dt><dd>{order.pieces} {order.declared_quantity_unit}</dd></div>
          <div><dt>预计包装</dt><dd>{order.planned_inbound_package_count} 包 · {order.planned_inbound_package_type}</dd></div>
          <div><dt>运输线路</dt><dd>{route}</dd></div>
          <div><dt>境外目的仓</dt><dd>{order.overseas_warehouse_name || "待确定"}</dd></div>
        </dl>
        <footer>条码唯一对应本入仓包装；国内仓扫码收货，最终出库包装另行生成 OUL。</footer>
      </article>)}
    </section>
  );
}

export function Code39({ value }: { value: string }) {
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
