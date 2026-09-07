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

export const INTERNAL_NOTIFICATION_PAGE_SIZE=10;

export type InternalNotificationPage = {
  notifications:InternalNotification[];
  page:number;
  pageCount:number;
  pageSize:number;
  total:number;
  ordinaryUnreadCount:number;
};

export function assignedOrderNotificationStatement(db:D1Database,input:{
  organizationId:string;
  orderId:string;
  assigneeUserId:string;
  actorUserId:string|null;
  stepName:string;
  now:string;
}) {
  return db.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),m.organization_id,m.user_id,
       'order_assignment','warning','新订单待您办理：'||o.order_number,
       '订单 '||o.order_number||' 已进入“'||?||'”，请及时办理。',
       CASE WHEN p.code IN ('WAREHOUSE','OVERSEAS_WAREHOUSE')
         THEN '/warehouse' ELSE '/admin/orders/'||o.id END,
       0,0,?,?
     FROM memberships m
     JOIN users u ON u.id=m.user_id AND u.status='active'
     JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
     JOIN transport_orders o ON o.organization_id=m.organization_id AND o.id=?
     WHERE m.organization_id=? AND m.user_id=? AND m.status='active'
       AND NOT EXISTS(
         SELECT 1 FROM internal_notifications n
         WHERE n.organization_id=m.organization_id AND n.user_id=m.user_id
           AND n.category='order_assignment'
           AND n.message='订单 '||o.order_number||' 已进入“'||?||'”，请及时办理。'
       )`,
  ).bind(
    input.stepName,input.actorUserId,input.now,input.orderId,
    input.organizationId,input.assigneeUserId,input.stepName,
  );
}

export function assignedBatchNotificationStatement(db:D1Database,input:{
  organizationId:string;
  batchId:string;
  batchNumber:string;
  assigneeUserId:string;
  actorUserId:string|null;
  responsibilityLabel:string;
  targetTab?:"tracking"|"documents";
  now:string;
}) {
  const link=`/admin/loading/${encodeURIComponent(input.batchId)}${input.targetTab?`?tab=${input.targetTab}`:""}`;
  return db.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),?,u.id,
       'transport_batch_assignment','warning','新配载单待您办理：'||?,
       '配载单 '||?||' 已将全部挂载订单的'||?||'统一交接给您，请及时办理。',
       ?,0,0,?,?
     FROM users u
     WHERE u.id=? AND u.status='active'
       AND EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.organization_id=? AND m.user_id=u.id AND m.status='active'
       )
       AND NOT EXISTS(
         SELECT 1 FROM internal_notifications n
         WHERE n.organization_id=? AND n.user_id=u.id
           AND n.category='transport_batch_assignment' AND n.link=? AND n.is_read=0
       )`,
  ).bind(
    input.organizationId,input.batchNumber,input.batchNumber,input.responsibilityLabel,
    link,input.actorUserId,input.now,input.assigneeUserId,input.organizationId,
    input.organizationId,link,
  );
}

export function pendingBatchApprovalNotificationStatement(db:D1Database,input:{
  organizationId:string;
  batchId:string;
  batchNumber:string;
  supervisorUserId:string;
  actorUserId:string|null;
  now:string;
}) {
  const link=`/admin/loading/${encodeURIComponent(input.batchId)}`;
  return db.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),?,u.id,
       'transport_batch_approval','warning','配载单待审核与统一分配：'||?,
       '配载单 '||?||' 已提交；请审核并同时指定整批操作与单证负责人。',
       ?,0,0,?,?
     FROM users u
     WHERE u.id=? AND u.status='active'
       AND EXISTS(
         SELECT 1 FROM memberships m
         WHERE m.organization_id=? AND m.user_id=u.id AND m.status='active'
       )
       AND NOT EXISTS(
         SELECT 1 FROM internal_notifications n
         WHERE n.organization_id=? AND n.user_id=u.id
           AND n.category='transport_batch_approval' AND n.link=? AND n.is_read=0
       )`,
  ).bind(
    input.organizationId,input.batchNumber,input.batchNumber,link,input.actorUserId,input.now,
    input.supervisorUserId,input.organizationId,input.organizationId,link,
  );
}

export function warehouseBatchReadyNotificationStatement(db:D1Database,input:{
  organizationId:string;
  batchId:string;
  batchNumber:string;
  warehouseId:string;
  actorUserId:string|null;
  now:string;
}) {
  const link=`/warehouse/outbound?warehouseId=${encodeURIComponent(input.warehouseId)}&view=pending&q=${encodeURIComponent(input.batchNumber)}`;
  return db.prepare(
    `INSERT INTO internal_notifications(
      id,organization_id,user_id,category,severity,title,message,link,requires_ack,
      is_read,created_by_user_id,created_at
     )
     SELECT lower(hex(randomblob(16))),a.organization_id,a.user_id,
       'warehouse_batch_ready','warning','配载单可创建装车任务：'||?,
       '配载单 '||?||' 已审核并完成整批负责人分配，请创建装车任务。',
       ?,0,0,?,?
     FROM warehouse_user_access a
     JOIN users u ON u.id=a.user_id AND u.status='active'
     WHERE a.organization_id=? AND a.warehouse_id=? AND a.access_level IN ('operator','manager')
       AND NOT EXISTS(
         SELECT 1 FROM internal_notifications n
         WHERE n.organization_id=a.organization_id AND n.user_id=a.user_id
           AND n.category='warehouse_batch_ready' AND n.link=? AND n.is_read=0
       )`,
  ).bind(
    input.batchNumber,input.batchNumber,link,input.actorUserId,input.now,
    input.organizationId,input.warehouseId,link,
  );
}

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

export async function listInternalNotificationPage(
  organizationId:string,
  userId:string,
  requestedPage=1,
  pageSize=INTERNAL_NOTIFICATION_PAGE_SIZE,
):Promise<InternalNotificationPage> {
  const safePageSize=Math.max(1,Math.floor(pageSize));
  const summary=await env.DB.prepare(
    `SELECT COUNT(*) total,
            COALESCE(SUM(CASE WHEN is_read=0 AND requires_ack=0 THEN 1 ELSE 0 END),0) ordinary_unread_count
     FROM internal_notifications
     WHERE organization_id=? AND user_id=?`,
  ).bind(organizationId,userId).first<{total:number;ordinary_unread_count:number}>();
  const total=Number(summary?.total||0);
  const pageCount=Math.max(1,Math.ceil(total/safePageSize));
  const page=Math.min(Math.max(1,Math.floor(requestedPage)||1),pageCount);
  const notifications=await env.DB.prepare(
    `SELECT id,category,severity,title,message,link,requires_ack,is_read,
            popup_shown_at,acknowledged_at,created_at
     FROM internal_notifications
     WHERE organization_id=? AND user_id=?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(organizationId,userId,safePageSize,(page-1)*safePageSize).all<InternalNotification>();
  return {
    notifications:notifications.results,
    page,
    pageCount,
    pageSize:safePageSize,
    total,
    ordinaryUnreadCount:Number(summary?.ordinary_unread_count||0),
  };
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
           AND category!='order_assignment'
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
