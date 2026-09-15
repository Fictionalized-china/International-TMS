import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { InternalNotification } from "../lib/internal-notifications.server";
import { AppIcon } from "./AppIcon";
import { Modal } from "./Modal";

export function InternalNotificationCenter({
  unreadCount,
  latest,
  historyPath="/admin/notifications",
  actionPath=historyPath,
  allowObjectLink=true,
}: {
  unreadCount:number;
  latest:InternalNotification|null;
  historyPath?:string;
  actionPath?:string;
  allowObjectLink?:boolean;
}) {
  const fetcher = useFetcher<{success?:string;notificationId?:string}>();
  const [open,setOpen] = useState(false);
  useEffect(() => {
    if (!latest) return;
    const safeToInterrupt = () => {
      const active = document.activeElement;
      return !(
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      );
    };
    if (safeToInterrupt()) {
      setOpen(true);
      return;
    }
    const showAtSafePoint = () => {
      if (!safeToInterrupt()) return;
      setOpen(true);
      document.removeEventListener("focusout",showAtSafePoint);
    };
    document.addEventListener("focusout",showAtSafePoint);
    return () => document.removeEventListener("focusout",showAtSafePoint);
  },[latest?.id]);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data?.success &&
      fetcher.data.notificationId === latest?.id
    ) setOpen(false);
  },[fetcher.state,fetcher.data,latest?.id]);
  return <>
    <Link
      className="admin-topbar-link internal-notification-trigger"
      to={historyPath}
      aria-label={`站内通知，${unreadCount} 条未读`}
    >
      <AppIcon name="bell" size={16}/><span>通知</span>
      {unreadCount>0 && <b>{unreadCount>99?"99+":unreadCount}</b>}
    </Link>
    {latest && <Modal
      title={latest.requires_ack?"重要变更 · 请确认知悉":"站内通知"}
      isOpen={open}
      onOpenChange={setOpen}
      closeOnBackdrop={false}
      dismissible={!latest.requires_ack}
      initialFocusSelector="[data-notification-ack]"
    >
      <article className={`internal-notification-card ${latest.severity}`}>
        <span>{latest.severity==="critical"?"重要":latest.severity==="warning"?"提醒":"消息"}</span>
        <h3>{latest.title}</h3>
        <p>{latest.message}</p>
        <time>{new Date(latest.created_at).toLocaleString("zh-CN")}</time>
        <div className="confirm-action-buttons">
          <Link className="secondary" to={historyPath} onClick={() => setOpen(false)}>查看全部</Link>
          {allowObjectLink && latest.link && <Link className="secondary" to={latest.link} onClick={() => setOpen(false)}>查看影响对象</Link>}
          <fetcher.Form method="post" action={actionPath}>
            <input type="hidden" name="intent" value={latest.requires_ack?"acknowledge":"read"}/>
            <input type="hidden" name="notificationId" value={latest.id}/>
            <button className="primary" data-notification-ack disabled={fetcher.state!=="idle"}>
              {latest.requires_ack?"确认知悉":"知道了"}
            </button>
          </fetcher.Form>
        </div>
      </article>
    </Modal>}
  </>;
}
