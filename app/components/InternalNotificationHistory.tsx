import { Form, Link, useSearchParams } from "react-router";
import type { InternalNotification } from "../lib/internal-notifications.server";
import { ActionToast } from "./ActionToast";

type NotificationActionData = {
  success?:string;
  formError?:string;
};

export function InternalNotificationHistory({
  notifications,
  page,
  pageCount,
  pageSize,
  total,
  ordinaryUnreadCount,
  actionData,
  allowObjectLinks=true,
}: {
  notifications:InternalNotification[];
  page:number;
  pageCount:number;
  pageSize:number;
  total:number;
  ordinaryUnreadCount:number;
  actionData?:NotificationActionData;
  allowObjectLinks?:boolean;
}) {
  const [searchParams]=useSearchParams();
  const pageHref=(nextPage:number)=>{
    const next=new URLSearchParams(searchParams);
    next.set("page",String(nextPage));
    return `?${next.toString()}`;
  };
  const pageNumbers=Array.from(new Set([1,page-1,page,page+1,pageCount]))
    .filter((value)=>value>=1&&value<=pageCount)
    .sort((left,right)=>left-right);
  return <div className="page prototype-page">
    <header className="page-header">
      <div>
        <p className="eyebrow">IN-APP NOTIFICATIONS</p>
        <h1>通知</h1>
        <p>弹窗消息在这里永久留存；每条新通知只自动弹出一次，重要通知需逐条确认。</p>
      </div>
      <Form method="post">
        <input type="hidden" name="intent" value="read_all"/>
        <button className="secondary" disabled={!ordinaryUnreadCount}>普通通知全部已读（{ordinaryUnreadCount}）</button>
      </Form>
    </header>
    <ActionToast data={actionData}/>
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
      <footer className="pagination consolidation-pagination internal-notification-pagination" aria-label="通知分页">
        <span>每页 {pageSize} 条 · 第 {page} / {pageCount} 页 · 共 {total} 条</span>
        <div>
          {page>1
            ? <Link className="secondary" to={pageHref(page-1)}>上一页</Link>
            : <span className="secondary disabled" aria-disabled="true">上一页</span>}
          {pageNumbers.map((pageNumber,index)=>[
            index>0&&pageNumber-pageNumbers[index-1]>1
              ? <span key={`gap-${pageNumber}`} aria-hidden="true">…</span>
              : null,
            pageNumber===page
              ? <span key={pageNumber} className="consolidation-pagination-current" aria-current="page">{pageNumber}</span>
              : <Link key={pageNumber} className="secondary" to={pageHref(pageNumber)} aria-label={`第 ${pageNumber} 页`}>{pageNumber}</Link>,
          ])}
          {page<pageCount
            ? <Link className="secondary" to={pageHref(page+1)}>下一页</Link>
            : <span className="secondary disabled" aria-disabled="true">下一页</span>}
        </div>
      </footer>
    </section>
  </div>;
}
