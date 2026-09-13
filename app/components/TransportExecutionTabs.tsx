import { NavLink } from "react-router";

export function TransportExecutionTabs() {
  return (
    <nav className="peer-page-tabs transport-execution-tabs" aria-label="运输执行视图">
      <NavLink to="/admin/shipments">运单执行</NavLink>
      <NavLink to="/admin/domestic-tracking">在途车辆</NavLink>
    </nav>
  );
}
