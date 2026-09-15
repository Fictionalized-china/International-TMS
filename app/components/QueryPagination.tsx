import { Link, useLocation } from "react-router";

type QueryPaginationProps = {
  page: number;
  pageCount: number;
  pageSize?: number;
  total: number;
  pageParam?: string;
  unit?: string;
};

export function QueryPagination({
  page,
  pageCount,
  pageSize = 10,
  total,
  pageParam = "page",
  unit = "单",
}: QueryPaginationProps) {
  const location = useLocation();
  if (pageCount <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams(location.search);
    params.set(pageParam, String(target));
    return `${location.pathname}?${params.toString()}${location.hash}`;
  };
  const pageNumbers = Array.from(new Set([1, page - 1, page, page + 1, pageCount]))
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((left, right) => left - right);

  return <footer className="pagination consolidation-pagination query-pagination" aria-label="订单分页">
    <span>每页 {pageSize} {unit} · 第 {page} / {pageCount} 页 · 共 {total} {unit}</span>
    <div>
      {page > 1
        ? <Link className="secondary" to={href(page - 1)}>上一页</Link>
        : <span className="secondary disabled" aria-disabled="true">上一页</span>}
      {pageNumbers.map((pageNumber) => pageNumber === page
        ? <span key={pageNumber} className="consolidation-pagination-current" aria-current="page">{pageNumber}</span>
        : <Link key={pageNumber} className="secondary" to={href(pageNumber)} aria-label={`第 ${pageNumber} 页`}>{pageNumber}</Link>)}
      {page < pageCount
        ? <Link className="secondary" to={href(page + 1)}>下一页</Link>
        : <span className="secondary disabled" aria-disabled="true">下一页</span>}
    </div>
  </footer>;
}
