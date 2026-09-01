import { env } from "cloudflare:workers";
import { Form, Link } from "react-router";
import type { Route } from "./+types/admin.notifications";
import { requireSessionUser } from "../lib/auth.server";
import { valueOf } from "../lib/validation";
import type { InternalNotification } from "../lib/internal-notifications.server";

export async function loader({request}:Route.LoaderArgs) {
  const current=await requireSessionUser(request);
  const notifications=await env.DB.prepare(
    `SELECT id,category,severity,title,message,link,requires_ack,is_read,created_at
     FROM internal_notifications
     WHERE organization_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100`,
  ).bind(current.organizationId,current.userId).all<InternalNotification>();
  return {notifications:notifications.results};
}

export async function action({request}:Route.ActionArgs) {
  const current=await requireSessionUser(request);
  const form=await request.formData();
  const intent=valueOf(form,"intent");
  const now=new Date().toISOString();
  if(intent==="read_all") {
    await env.DB.prepare(
      `UPDATE internal_notifications SET is_read=1,read_at=COALESCE(read_at,?)
       WHERE organization_id=? AND user_id=? AND is_read=0 AND requires_ack=0`,
    ).bind(now,current.organizationId,current.userId).run();
    return {success:"普通通知已全部标记为已读；重要通知仍需逐条确认"};
  }
  if(intent==="read"||intent==="acknowledge") {
    const notificationId=valueOf(form,"notificationId");
    const notification=await env.DB.prepare(
      `SELECT id,requires_ack FROM internal_notifications
       WHERE id=? AND organization_id=? AND user_id=?`,
    ).bind(notificationId,current.organizationId,current.userId).first<{id:string;requires_ack:number}>();
    if(!notification)return {formError:"通知不存在"};
    if(notification.requires_ack&&intent!=="acknowledge")return {formError:"该重要通知需要明确确认知悉"};
    await env.DB.prepare(
      `UPDATE internal_notifications SET is_read=1,read_at=COALESCE(read_at,?),
        acknowledged_at=CASE WHEN ?='acknowledge' THEN COALESCE(acknowledged_at,?) ELSE acknowledged_at END
       WHERE id=? AND organization_id=? AND user_id=?`,
    ).bind(now,intent,now,notificationId,current.organizationId,current.userId).run();
    return {success:notification.requires_ack?"已确认知悉":"通知已读"};
  }
  return {formError:"无效的通知操作"};
}

export default function AdminNotifications({loaderData,actionData}:Route.ComponentProps) {
  const unread=loaderData.notifications.filter((item)=>!item.is_read).length;
  return <div className="page prototype-page">
    <header className="page-header"><div><p className="eyebrow">IN-APP NOTIFICATIONS</p><h1>站内通知</h1><p>工作流变更、补录和高风险业务提醒集中保留；邮件和短信通道暂不启用。</p></div><Form method="post"><input type="hidden" name="intent" value="read_all"/><button className="secondary" disabled={!unread}>普通通知全部已读</button></Form></header>
    {actionData&&"success" in actionData&&actionData.success&&<div className="alert" role="status">{actionData.success}</div>}
    {actionData&&"formError" in actionData&&actionData.formError&&<div className="alert error" role="alert">{actionData.formError}</div>}
    <section className="panel notification-list internal-notification-list">
      {loaderData.notifications.map((item)=><article key={item.id} className={item.is_read?"":"unread"}>
        <span className={`status-pill ${item.severity==="critical"?"danger":item.severity==="warning"?"warning":""}`}>{item.requires_ack?"需确认":item.severity==="warning"?"提醒":"消息"}</span>
        <div><h3>{item.title}</h3><p>{item.message}</p><small>{new Date(item.created_at).toLocaleString("zh-CN")}</small></div>
        <div className="page-actions">{item.link&&<Link className="text-button" to={item.link}>查看对象</Link>}{!item.is_read&&<Form method="post"><input type="hidden" name="intent" value={item.requires_ack?"acknowledge":"read"}/><input type="hidden" name="notificationId" value={item.id}/><button className="text-button">{item.requires_ack?"确认知悉":"标为已读"}</button></Form>}</div>
      </article>)}
      {!loaderData.notifications.length&&<p className="empty-state">暂无站内通知。</p>}
    </section>
  </div>;
}
