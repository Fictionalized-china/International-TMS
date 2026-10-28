import { useRef, useState } from "react";
import { Modal } from "./Modal";
import { OrderMarkLabelPreview } from "./OrderMarkLabelPage";
import { usePortalHref } from "./PortalNavigation";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";

export function OrderMarkLabelModal({ order }: { order: OrderMarkLabel }) {
  const downloadTo = usePortalHref(`/portal/orders/${order.id}/mark-label/download`);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [activeMark, setActiveMark] = useState(0);
  const markCount = Math.max(1, order.marks.length);
  const showMark = (index: number) => {
    const next = Math.max(0, Math.min(index, markCount - 1));
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTo({ left: next * (viewport.clientWidth + 12), behavior: "smooth" });
    setActiveMark(next);
  };
  return (
    <Modal
      title={`查看唛头 · ${order.order_number}`}
      triggerLabel="查看唛头"
      triggerClassName="btn small"
      size="wide"
      dialogClassName="order-mark-preview-modal"
      initialFocusSelector="[data-mark-next], [data-mark-print]"
    >
      <div className="order-mark-dialog">
        <div className="order-mark-dialog-status no-print" role="status">
          <div><span>报价接受后已自动生成</span><strong>唛头号：{order.order_number}</strong></div>
          <time dateTime={order.label_generated_at}>生成时间：{formatDateTime(order.label_generated_at)}</time>
        </div>
        {markCount > 1 && <div className="order-mark-carousel-controls no-print" aria-label="唛头翻页">
          <strong>第 {activeMark + 1} / {markCount} 张唛头</strong>
          <div>
            <button className="btn" type="button" disabled={activeMark === 0} onClick={() => showMark(activeMark - 1)}>← 上一张</button>
            <button className="btn" type="button" data-mark-next disabled={activeMark >= markCount - 1} onClick={() => showMark(activeMark + 1)}>下一张 →</button>
          </div>
        </div>}
        <div className="order-mark-carousel-viewport" ref={viewportRef} onScroll={(event) => {
          const viewport = event.currentTarget;
          if (viewport.clientWidth > 0) setActiveMark(Math.min(markCount - 1, Math.round(viewport.scrollLeft / (viewport.clientWidth + 12))));
        }}>
          <OrderMarkLabelPreview order={order} />
        </div>
        <footer className="order-mark-dialog-actions no-print">
          <a className="btn" href={downloadTo}>下载 SVG</a>
          <button
            className="btn primary"
            type="button"
            data-mark-print
            onClick={printOrderMark}
          >
            打印唛头
          </button>
        </footer>
      </div>
    </Modal>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function printOrderMark() {
  const cleanup = () => document.body.classList.remove("printing-order-mark");
  document.body.classList.add("printing-order-mark");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  window.setTimeout(cleanup, 1_000);
}
