export const ORDER_LIST_PAGE_SIZE = 10;

export function readListPage(searchParams: URLSearchParams, key = "page") {
  const value = Number(searchParams.get(key));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

export function paginateList<T>(items: T[], requestedPage: number, pageSize = ORDER_LIST_PAGE_SIZE) {
  const safePageSize = Math.max(1, Math.floor(pageSize) || ORDER_LIST_PAGE_SIZE);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const start = (page - 1) * safePageSize;

  return {
    items: items.slice(start, start + safePageSize),
    page,
    pageCount,
    pageSize: safePageSize,
    total,
  };
}
