export const ORDER_QUEUE_LIMIT = 10;

export type OrderQueueContext = {
  returnTo: string;
  orderIds: string[];
};

export type OrderQueueNavigation = OrderQueueContext & {
  currentIndex: number;
  previousOrderId: string | null;
  nextOrderId: string | null;
};

function safeOrderListPath(value: string | null | undefined) {
  if (!value) return "/admin/orders?view=orders";
  const allowedReturnPath = value.startsWith("/admin/orders") || value.startsWith("/admin/billing");
  if (!allowedReturnPath || value.startsWith("//")) {
    return "/admin/orders?view=orders";
  }
  return value;
}

function normalizeOrderIds(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, ORDER_QUEUE_LIMIT);
}

export function orderQueueContextFromList(input: {
  returnTo: string;
  orderIds: readonly string[];
}): OrderQueueContext {
  return {
    returnTo: safeOrderListPath(input.returnTo),
    orderIds: normalizeOrderIds(input.orderIds),
  };
}

export function readOrderQueueNavigation(
  searchParams: URLSearchParams,
  currentOrderId: string,
): OrderQueueNavigation {
  const orderIds = normalizeOrderIds((searchParams.get("orderQueue") || "").split(","));
  const currentIndex = orderIds.indexOf(currentOrderId);
  return {
    returnTo: safeOrderListPath(searchParams.get("returnTo")),
    orderIds,
    currentIndex,
    previousOrderId: currentIndex > 0 ? orderIds[currentIndex - 1] : null,
    nextOrderId: currentIndex >= 0 && currentIndex < orderIds.length - 1 ? orderIds[currentIndex + 1] : null,
  };
}

export function appendOrderQueueContext(
  href: string,
  context: Pick<OrderQueueContext, "returnTo" | "orderIds">,
) {
  if (!context.orderIds.length) return href;
  const [pathAndQuery, hash = ""] = href.split("#", 2);
  const [path, query = ""] = pathAndQuery.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("returnTo", safeOrderListPath(context.returnTo));
  params.set("orderQueue", normalizeOrderIds(context.orderIds).join(","));
  const suffix = params.toString();
  return `${path}${suffix ? `?${suffix}` : ""}${hash ? `#${hash}` : ""}`;
}

export function orderDetailQueueHref(orderId: string, context: OrderQueueContext) {
  return appendOrderQueueContext(`/admin/orders/${encodeURIComponent(orderId)}`, context);
}
