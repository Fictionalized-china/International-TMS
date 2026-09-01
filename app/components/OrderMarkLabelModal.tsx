import { Modal } from "./Modal";
import { OrderMarkLabelPreview } from "./OrderMarkLabelPage";
import { usePortalHref } from "./PortalNavigation";
import type { OrderMarkLabel } from "../lib/order-mark-label.server";

export function OrderMarkLabelModal({ order }: { order: OrderMarkLabel }) {
  const downloadTo = usePortalHref(`/portal/orders/${order.id}/mark-label/download`);
  return (
    <Modal
      title={`查看唛头 · ${order.order_number}`}
      triggerLabel="查看唛头"
      triggerClassName="btn small"
      size="wide"
      dialogClassName="order-mark-preview-modal"
      initialFocusSelector="[data-mark-print]"
    >
      <div className="order-mark-dialog">
        <div className="order-mark-dialog-status no-print" role="status">
          <div><span>报价接受后已自动生成</span><strong>唛头号：{order.order_number}</strong></div>
          <time dateTime={order.label_generated_at}>生成时间：{formatDateTime(order.label_generated_at)}</time>
        </div>
        <OrderMarkLabelPreview order={order} />
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
