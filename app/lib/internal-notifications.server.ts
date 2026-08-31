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
}) {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),m.organization_id,m.user_id,?,?,?,?,?,
       CASE WHEN m.user_id=? OR EXISTS(
         SELECT 1 FROM membership_roles mr
         JOIN roles r ON r.id=mr.role_id
         WHERE mr.membership_id=m.id AND r.code IN ('owner','boss','developer')
       ) THEN 1 ELSE 0 END,
       0,?,?
     FROM memberships m
     JOIN users u ON u.id=m.user_id AND u.status='active'
     WHERE m.organization_id=? AND m.status='active'`,
  ).bind(
    input.category,input.severity,input.title,input.message,input.link??null,
    input.actorUserId,input.actorUserId,now,input.organizationId,
  ).run();
}

export async function loadInternalNotificationSummary(
  organizationId:string,
  userId:string,
) {
  const [count,latest] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) count FROM internal_notifications
       WHERE organization_id=? AND user_id=? AND is_read=0`,
    ).bind(organizationId,userId).first<{count:number}>(),
    env.DB.prepare(
      `SELECT id,category,severity,title,message,link,requires_ack,is_read,created_at
       FROM internal_notifications
       WHERE organization_id=? AND user_id=? AND is_read=0
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                created_at DESC LIMIT 1`,
    ).bind(organizationId,userId).first<InternalNotification>(),
  ]);
  return { unreadCount:Number(count?.count||0), latest:latest??null };
}
