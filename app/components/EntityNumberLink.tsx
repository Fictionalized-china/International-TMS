import { Link } from "react-router";

type EntityNumberLinkProps = {
  id: string;
  number: string;
  className?: string;
};

type OrderNumberLinkListProps = {
  orders: Array<{ id: string; number: string }>;
  separator?: string;
};

function classes(className?: string) {
  return ["entity-number-link", className].filter(Boolean).join(" ");
}

export function OrderNumberLink({ id, number, className }: EntityNumberLinkProps) {
  return (
    <Link
      aria-label={`查看订单 ${number}`}
      className={classes(className)}
      title={`查看订单 ${number}`}
      to={`/admin/orders/${id}`}
    >
      {number}
    </Link>
  );
}

export function BatchNumberLink({ id, number, className }: EntityNumberLinkProps) {
  return (
    <Link
      aria-label={`查看配载单 ${number}`}
      className={classes(className)}
      title={`查看配载单 ${number}`}
      to={`/admin/loading/${id}`}
    >
      {number}
    </Link>
  );
}

export function OrderNumberLinkList({ orders, separator = "、" }: OrderNumberLinkListProps) {
  if (!orders.length) return <>—</>;
  return <>{orders.map((order, index) => (
    <span key={order.id}>
      {index > 0 && separator}
      <OrderNumberLink id={order.id} number={order.number}/>
    </span>
  ))}</>;
}
