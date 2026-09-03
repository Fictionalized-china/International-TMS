import { env } from "cloudflare:workers";

export type InternalNotification = {
  id:string;
  category:string;
  severity:"info"|"warning"|"critical";
  title:string;
  message:string;
  link:string|null;
  requires_ack:number;
  is_read:number;
  popup_shown_at:string|null;
  acknowledged_at:string|null;
  created_at:string;
};

export async function broadcastInternalNotification(input:{
  organizationId:string;
  actorUserId:string;
  category:string;
  severity:"info"|"warning"|"critical";
  title:string;
  message:string;
  link?:string|null;
  requiresLeadershipAck?:boolean;
}) {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),m.organization_id,m.user_id,?,?,?,?,?,
       CASE WHEN ?=1 AND (m.user_id=? OR EXISTS(
         SELECT 1 FROM membership_roles mr
         JOIN roles r ON r.id=mr.role_id
         WHERE mr.membership_id=m.id AND r.code IN ('owner','boss','developer')
       )) THEN 1 ELSE 0 END,
       0,?,?
     FROM memberships m
     JOIN users u ON u.id=m.user_id AND u.status='active'
     WHERE m.organization_id=? AND m.status='active'`,
  ).bind(
    input.category,input.severity,input.title,input.message,input.link??null,
    input.requiresLeadershipAck?1:0,input.actorUserId,input.actorUserId,now,input.organizationId,
  ).run();
}

export async function listInternalNotifications(
  organizationId:string,
  userId:string,
  limit=100,
) {
  const notifications=await env.DB.prepare(
    `SELECT id,category,severity,title,message,link,requires_ack,is_read,
            popup_shown_at,acknowledged_at,created_at
     FROM internal_notifications
     WHERE organization_id=? AND user_id=? ORDER BY created_at DESC LIMIT ?`,
  ).bind(organizationId,userId,limit).all<InternalNotification>();
  return notifications.results;
}

export async function markAllOrdinaryInternalNotificationsRead(
  organizationId:string,
  userId:string,
) {
  const now=new Date().toISOString();
  await env.DB.prepare(
    `UPDATE internal_notifications SET is_read=1,read_at=COALESCE(read_at,?)
     WHERE organization_id=? AND user_id=? AND is_read=0 AND requires_ack=0`,
  ).bind(now,organizationId,userId).run();
}

export async function markInternalNotification(input:{
  organizationId:string;
  userId:string;
  notificationId:string;
  intent:"read"|"acknowledge";
}) {
  const notification=await env.DB.prepare(
    `SELECT id,requires_ack FROM internal_notifications
     WHERE id=? AND organization_id=? AND user_id=?`,
  ).bind(input.notificationId,input.organizationId,input.userId).first<{id:string;requires_ack:number}>();
  if(!notification)return {ok:false as const,error:"通知不存在"};
  if(notification.requires_ack&&input.intent!=="acknowledge") {
    return {ok:false as const,error:"该重要通知需要明确确认知悉"};
  }
  const now=new Date().toISOString();
  await env.DB.prepare(
    `UPDATE internal_notifications SET is_read=1,read_at=COALESCE(read_at,?),
      acknowledged_at=CASE WHEN ?='acknowledge' THEN COALESCE(acknowledged_at,?) ELSE acknowledged_at END
     WHERE id=? AND organization_id=? AND user_id=?`,
  ).bind(
    now,input.intent,now,input.notificationId,input.organizationId,input.userId,
  ).run();
  return {
    ok:true as const,
    success:notification.requires_ack?"已确认知悉":"通知已读",
    notificationId:input.notificationId,
  };
}

export async function loadInternalNotificationSummary(
  organizationId:string,
  userId:string,
) {
  const now = new Date().toISOString();
  const [count,latest] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) count FROM internal_notifications
       WHERE organization_id=? AND user_id=? AND is_read=0`,
    ).bind(organizationId,userId).first<{count:number}>(),
    env.DB.prepare(
      `UPDATE internal_notifications
       SET popup_shown_at=?
       WHERE id=(
         SELECT id FROM internal_notifications
         WHERE organization_id=? AND user_id=? AND popup_shown_at IS NULL
         ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                  created_at DESC
         LIMIT 1
       )
       AND organization_id=? AND user_id=? AND popup_shown_at IS NULL
       RETURNING id,category,severity,title,message,link,requires_ack,is_read,
                 popup_shown_at,acknowledged_at,created_at`,
    ).bind(now,organizationId,userId,organizationId,userId).first<InternalNotification>(),
  ]);
  return { unreadCount:Number(count?.count||0), latest:latest??null };
}
