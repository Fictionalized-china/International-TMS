import { env } from "cloudflare:workers";
import type { Route } from "./+types/dashboard.audit";
import { requireSessionUser } from "../lib/auth.server";

type AuditRow = { id: string; action: string; resource_type: string; outcome: string; display_name: string | null; ip_address: string | null; created_at: string };

export async function loader({ request }: Route.LoaderArgs) {
  const current = await requireSessionUser(request, "audit.view");
  const logs = await env.DB.prepare(`SELECT a.id, a.action, a.resource_type, a.outcome, a.ip_address, a.created_at, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 100`).bind(current.organizationId).all<AuditRow>();
  return { logs: logs.results };
}

export function meta() { return [{ title: "审计日志 | International TMS" }]; }

const labels: Record<string, string> = { "system.bootstrap": "初始化系统", "auth.login": "后台登录", "auth.locked": "登录锁定", "portal.login": "门户登录", "auth.logout": "退出登录", "user.create": "创建用户", "membership.active": "恢复用户", "membership.disabled": "停用用户", "membership.role.assign": "分配角色", "role.create": "创建角色", "master.create": "创建基础数据", "master.toggle": "更新基础数据", "customer.create": "创建客户", "customer.contact.create": "添加联系人", "customer.address.create": "添加地址", "portal.account.create": "开通门户", "sales.lead.create": "创建销售线索", "sales.lead.stage": "更新线索状态", "sales.opportunity.create": "创建商机", "sales.opportunity.stage": "更新商机阶段", "sales.activity.create": "创建销售活动", "quote.create": "创建报价", "quote.status": "更新报价", "portal.quote.response": "客户确认报价", "order.create": "创建订单", "order.status": "更新订单", "portal.order.submit": "客户提交订单", "carrier.create": "创建承运商", "shipment.create": "创建运单", "shipment.leg.create": "添加运输分段", "shipment.status": "更新运输轨迹", "invoice.create": "创建账单", "invoice.status": "更新账单", "security.session.revoke": "撤销会话", "security.user.unlock": "解除登录限制" };

export default function Audit({ loaderData }: Route.ComponentProps) {
  return <><header className="page-header"><div><p className="eyebrow">AUDIT TRAIL</p><h1>审计日志</h1><p>展示当前组织最近 100 条关键安全操作。</p></div></header><section className="panel"><div className="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>事件</th><th>对象</th><th>来源 IP</th><th>结果</th></tr></thead><tbody>{loaderData.logs.map(log => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString("zh-CN")}</td><td>{log.display_name || "系统/未知"}</td><td>{labels[log.action] || log.action}</td><td>{log.resource_type}</td><td>{log.ip_address || "—"}</td><td><span className={`status-pill ${log.outcome !== "success" ? "off" : ""}`}>{log.outcome === "success" ? "成功" : "失败"}</span></td></tr>)}</tbody></table></div></section></>;
}
