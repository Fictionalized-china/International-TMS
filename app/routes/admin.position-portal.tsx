import { env } from "cloudflare:workers";
import { Link } from "react-router";
import type { Route } from "./+types/admin.position-portal";
import { requireSessionUser } from "../lib/auth.server";
import {
  positionPortalForUser,
  visiblePortalLinks,
} from "../lib/position-portal";
import { orderNextGuidance, type GuidanceModule } from "../lib/order-guidance";
import { orderResponsiblePosition } from "../lib/order-responsibility";
import type { OrderModuleCode } from "../lib/order-modules";

type PortalTask = {
  order_id: string;
  order_number: string;
  customer_name: string;
  module_code: string;
  module_name: string;
  module_status: string;
  current_step_name: string | null;
  assignee_name: string | null;
  next_action: string;
  blocker: string | null;
  responsible_position_name: string;
  href: string;
  updated_at: string;
};

type PortalModuleRow = GuidanceModule & {
  order_id: string;
  order_number: string;
  order_status: string;
  customer_name: string;
  updated_at: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request);
  const config = positionPortalForUser(current);
  const rows = await env.DB.prepare(
    `SELECT o.id order_id,o.order_number,o.status order_status,c.name customer_name,
            m.module_code,m.module_name,m.enabled,m.is_required,m.status,
            m.current_step_code,m.current_step_name,m.blocking_reason,
            m.progress_percent,u.display_name assignee_name,m.updated_at
       FROM transport_orders o
       JOIN customers c ON c.id=o.customer_id AND c.organization_id=o.organization_id
       JOIN order_module_instances m ON m.order_id=o.id AND m.organization_id=o.organization_id
       LEFT JOIN users u ON u.id=m.assignee_user_id
      WHERE o.organization_id=?
        AND o.status NOT IN ('completed','cancelled')
        AND m.enabled=1
      ORDER BY o.updated_at DESC,m.updated_at DESC`,
  )
    .bind(current.organizationId)
    .all<PortalModuleRow>();

  const isBoss = current.roleCodes.some(
    (code) => code === "owner" || code === "boss",
  );
  const modulesByOrder = new Map<string, PortalModuleRow[]>();
  for (const row of rows.results) {
    const modules = modulesByOrder.get(row.order_id) ?? [];
    modules.push(row);
    modulesByOrder.set(row.order_id, modules);
  }
  const tasks: PortalTask[] = [];
  for (const modules of modulesByOrder.values()) {
    const order = modules[0];
    const guidance = orderNextGuidance({
      orderId: order.order_id,
      orderStatus: order.order_status,
      modules,
    });
    const moduleCode = guidance.moduleCode as OrderModuleCode | null;
    if (!moduleCode) continue;
    const responsible = orderResponsiblePosition(moduleCode, order.order_status);
    if (!isBoss && current.positionCode !== responsible.code) continue;
    const target = modules.find((module) => module.module_code === moduleCode);
    if (!target) continue;
    tasks.push({
      order_id: order.order_id,
      order_number: order.order_number,
      customer_name: order.customer_name,
      module_code: moduleCode,
      module_name: target.module_name,
      module_status: target.status,
      current_step_name: target.current_step_name,
      assignee_name: target.assignee_name,
      next_action: guidance.action,
      blocker: guidance.blocker,
      responsible_position_name: responsible.name,
      href: guidance.href,
      updated_at: target.updated_at,
    });
  }
  tasks.sort((left, right) => {
    if (Boolean(left.blocker) !== Boolean(right.blocker)) {
      return left.blocker ? -1 : 1;
    }
    return right.updated_at.localeCompare(left.updated_at);
  });
  return {
    current,
    config,
    links: visiblePortalLinks(config, current.permissions),
    tasks: tasks.slice(0, 50),
  };
}

export function meta() {
  return [{ title: "岗位门户 | International TMS" }];
}

export default function PositionPortal({ loaderData }: Route.ComponentProps) {
  const { current, config, links, tasks } = loaderData;
  return (
    <>
      <header className="page-header position-portal-header">
        <div>
          <p className="eyebrow">POSITION PORTAL</p>
          <h1>{config.title}</h1>
          <p>{current.displayName} · {config.description}</p>
        </div>
        <span className="status-pill">{tasks.length} 项当前待办</span>
      </header>

      <section className="position-portal-summary">
        <article>
          <span>可以查看</span>
          <div>{config.viewAreas.map((item) => <b key={item}>{item}</b>)}</div>
        </article>
        <article>
          <span>可以操作</span>
          <div>{config.operateAreas.map((item) => <b key={item}>{item}</b>)}</div>
        </article>
      </section>

      <section className="position-portal-links" aria-label="岗位快捷入口">
        {links.map((link) => (
          <Link key={link.href} to={link.href}>
            <strong>{link.label}</strong>
            <span>{link.description}</span>
          </Link>
        ))}
      </section>

      <section className="panel position-portal-tasks">
        <div className="panel-header">
          <div>
            <h2>我的岗位工作队列</h2>
            <p>按订单当前流程节点自动分配到本岗位；每票订单只显示一个当前待办。</p>
          </div>
          <Link className="secondary" to="/admin/orders">查看订单工作台</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>订单</th>
                <th>客户</th>
                <th>负责岗位</th>
                <th>当前办理</th>
                <th>负责人</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={`${task.order_id}:${task.module_code}`}>
                  <td><Link className="text-button" to={task.href}>{task.order_number}</Link></td>
                  <td>{task.customer_name}</td>
                  <td>{task.responsible_position_name}</td>
                  <td>
                    <strong>{task.current_step_name || task.module_name}</strong>
                    <small>{task.next_action}</small>
                  </td>
                  <td>{task.assignee_name || "待分配"}</td>
                  <td><span className="status-pill">{moduleStatusLabel(task.module_status)}</span></td>
                  <td>
                    <Link className="text-button" to={task.href}>
                      进入办理
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!tasks.length && <p className="empty-state">当前岗位暂无待办订单。</p>}
      </section>
    </>
  );
}

function moduleStatusLabel(status: string) {
  return ({
    not_started: "待开始",
    in_progress: "办理中",
    blocked: "有阻断",
    completed: "已完成",
  } as Record<string, string>)[status] ?? status;
}
