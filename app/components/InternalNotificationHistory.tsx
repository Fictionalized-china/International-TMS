import { Form, Link } from "react-router";
import type { InternalNotification } from "../lib/internal-notifications.server";

type NotificationActionData = {
  success?:string;
  formError?:string;
};

export function InternalNotificationHistory({
  notifications,
  actionData,
  allowObjectLinks=true,
}: {
  notifications:InternalNotification[];
  actionData?:NotificationActionData;
  allowObjectLinks?:boolean;
}) {
  const ordinaryUnread=notifications.filter((item)=>!item.is_read&&!item.requires_ack).length;
  return <div className="page prototype-page">
    <header className="page-header">
      <div>
        <p className="eyebrow">IN-APP NOTIFICATIONS</p>
        <h1>通知</h1>
        <p>弹窗消息在这里永久留存；每条新通知只自动弹出一次，重要通知需逐条确认。</p>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="read_all"/>
        <button className="secondary" disabled={!ordinaryUnread}>普通通知全部已读（{ordinaryUnread}）</button>
      </Form>
    </header>
    {actionData?.success&&<div className="alert" role="status">{actionData.success}</div>}
    {actionData?.formError&&<div className="alert error" role="alert">{actionData.formError}</div>}
    <section className="panel notification-list internal-notification-list">
      {notifications.map((item)=><article key={item.id} className={item.is_read?"":"unread"}>
        <span className={`status-pill ${item.severity==="critical"?"danger":item.severity==="warning"?"warning":""}`}>
          {item.requires_ack
            ? item.acknowledged_at?"已确认":"待确认"
            : item.is_read?"已读":item.severity==="warning"?"提醒":"未读"}
        </span>
        <div>
          <h3>{item.title}</h3>
          <p>{item.message}</p>
          <small>{new Date(item.created_at).toLocaleString("zh-CN")}</small>
        </div>
        <div className="page-actions">
          {allowObjectLinks&&item.link&&<Link className="text-button" to={item.link}>查看对象</Link>}
          {((item.requires_ack&&!item.acknowledged_at)||(!item.requires_ack&&!item.is_read))&&<Form method="post">
            <input type="hidden" name="intent" value={item.requires_ack?"acknowledge":"read"}/>
            <input type="hidden" name="notificationId" value={item.id}/>
            <button className="text-button">{item.requires_ack?"确认知悉":"标为已读"}</button>
          </Form>}
        </div>
      </article>)}
      {!notifications.length&&<p className="empty-state">暂无通知。</p>}
    </section>
  </div>;
}
