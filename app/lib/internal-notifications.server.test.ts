import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = {sql:string;bindings:unknown[]};

const database=vi.hoisted(()=>{
  const queries:Query[]=[];
  let popupAvailable=true;
  let requiresAck=1;
  const notification={
    id:"notice-1",
    category:"workflow_field_policy_changed",
    severity:"critical" as const,
    title:"工作流字段规则已变更：委托书",
    message:"测试消息",
    link:"/admin/workflow?workflowId=workflow-1",
    requires_ack:1,
    is_read:0,
    popup_shown_at:"2026-09-04T00:00:00.000Z",
    acknowledged_at:null,
    created_at:"2026-09-04T00:00:00.000Z",
  };
  return {
    queries,
    reset(){queries.length=0;popupAvailable=true;requiresAck=1;},
    DB:{
      prepare(sql:string){
        const query={sql,bindings:[] as unknown[]};
        queries.push(query);
        return {
          bind(...bindings:unknown[]){query.bindings=bindings;return this;},
          async first<T>(){
            if(sql.includes("COUNT(*)"))return {count:1} as T;
            if(sql.includes("UPDATE internal_notifications")&&sql.includes("RETURNING")){
              if(!popupAvailable)return null;
              popupAvailable=false;
              return notification as T;
            }
            if(sql.includes("SELECT id,requires_ack"))return {id:"notice-1",requires_ack:requiresAck} as T;
            return null;
          },
          async all<T>(){return {results:[notification] as T[]};},
          async run(){return {meta:{changes:1}};},
        };
      },
    },
  };
});

vi.mock("cloudflare:workers",()=>({env:{DB:database.DB}}));

import {
  assignedBatchNotificationStatement,
  assignedOrderNotificationStatement,
  listInternalNotifications,
  loadInternalNotificationSummary,
  markInternalNotification,
  orderDocumentSupplementNotificationStatement,
  pendingBatchApprovalNotificationStatement,
  warehouseBatchReadyNotificationStatement,
} from "./internal-notifications.server";

describe("internal notification delivery",()=>{
  beforeEach(()=>database.reset());

  it("atomically claims a popup once per recipient while keeping it unread",async()=>{
    const first=await loadInternalNotificationSummary("org-1","user-1");
    const second=await loadInternalNotificationSummary("org-1","user-1");

    expect(first.unreadCount).toBe(1);
    expect(first.latest?.id).toBe("notice-1");
    expect(second.latest).toBeNull();
    const claim=database.queries.find((query)=>query.sql.includes("RETURNING"));
    expect(claim?.sql).toContain("popup_shown_at IS NULL");
    expect(claim?.sql).toContain("category!='order_assignment'");
    expect(claim?.bindings.slice(1)).toEqual(["org-1","user-1","org-1","user-1"]);
  });

  it("keeps already displayed notifications in the account history",async()=>{
    const rows=await listInternalNotifications("org-1","user-1");
    expect(rows).toHaveLength(1);
    const query=database.queries.at(-1);
    expect(query?.sql).not.toContain("popup_shown_at IS NULL");
    expect(query?.bindings).toEqual(["org-1","user-1",100]);
  });

  it("requires explicit acknowledgement and scopes the update to one account",async()=>{
    await expect(markInternalNotification({
      organizationId:"org-1",
      userId:"user-1",
      notificationId:"notice-1",
      intent:"read",
    })).resolves.toEqual({ok:false,error:"该重要通知需要明确确认知悉"});

    const result=await markInternalNotification({
      organizationId:"org-1",
      userId:"user-1",
      notificationId:"notice-1",
      intent:"acknowledge",
    });
    expect(result).toMatchObject({ok:true,notificationId:"notice-1"});
    const update=database.queries.find((query)=>query.sql.includes("acknowledged_at=CASE"));
    expect(update?.bindings.slice(-3)).toEqual(["notice-1","org-1","user-1"]);
  });

  it("targets one assigned account and deduplicates the same order step",async()=>{
    const statement=assignedOrderNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",
      orderId:"order-1",
      assigneeUserId:"user-2",
      actorUserId:"user-1",
      stepName:"委托审核",
      now:"2026-09-04T00:00:00.000Z",
    });
    await statement.run();
    const query=database.queries.at(-1);
    expect(query?.sql).toContain("m.user_id=?");
    expect(query?.sql).toContain("NOT EXISTS");
    expect(query?.bindings).toEqual([
      "委托审核","user-1","2026-09-04T00:00:00.000Z","order-1","org-1","user-2","委托审核",
    ]);
  });

  it("deep-links operation and document assignees to their own batch workbench",async()=>{
    await assignedBatchNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",batchId:"batch 1",batchNumber:"PZ-001",assigneeUserId:"operation-1",
      actorUserId:"supervisor-1",responsibilityLabel:"操作职责",targetTab:"tracking",now:"2026-09-04T00:00:00.000Z",
    }).run();
    const operation=database.queries.at(-1);
    expect(operation?.sql).toContain("n.category='transport_batch_assignment'");
    expect(operation?.bindings).toContain("/admin/loading/batch%201?tab=tracking");

    await assignedBatchNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",batchId:"batch-1",batchNumber:"PZ-001",assigneeUserId:"document-1",
      actorUserId:"supervisor-1",responsibilityLabel:"单证与报关职责",targetTab:"documents",now:"2026-09-04T00:00:00.000Z",
    }).run();
    expect(database.queries.at(-1)?.bindings).toContain("/admin/loading/batch-1?tab=documents");
  });

  it("notifies the exact supervisor when a batch is submitted",async()=>{
    await pendingBatchApprovalNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",batchId:"batch-1",batchNumber:"PZ-001",supervisorUserId:"supervisor-1",
      actorUserId:"warehouse-1",now:"2026-09-04T00:00:00.000Z",
    }).run();
    const query=database.queries.at(-1);
    expect(query?.sql).toContain("u.id=?");
    expect(query?.sql).toContain("transport_batch_approval");
    expect(query?.bindings).toContain("supervisor-1");
    expect(query?.bindings).toContain("/admin/loading/batch-1");
  });

  it("notifies only warehouse operators and managers with a filtered outbound link",async()=>{
    await warehouseBatchReadyNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",batchId:"batch-1",batchNumber:"PZ-20260907-001",warehouseId:"warehouse 1",
      actorUserId:"supervisor-1",now:"2026-09-04T00:00:00.000Z",
    }).run();
    const query=database.queries.at(-1);
    expect(query?.sql).toContain("a.access_level IN ('operator','manager')");
    expect(query?.sql).toContain("warehouse_batch_ready");
    expect(query?.bindings).toContain("/warehouse/outbound?warehouseId=warehouse%201&view=pending&q=PZ-20260907-001");
  });

  it("routes a missing document notice to the order salesperson supplement portal",async()=>{
    await orderDocumentSupplementNotificationStatement(database.DB as unknown as D1Database,{
      organizationId:"org-1",orderId:"order 1",fieldLabel:"合同",
      actorUserId:"warehouse-1",now:"2026-09-10T00:00:00.000Z",
    }).run();
    const query=database.queries.at(-1);
    expect(query?.sql).toContain("COALESCE(q.salesperson_user_id,o.salesperson_user_id)");
    expect(query?.sql).toContain("order_document_supplement");
    expect(query?.sql).toContain("NOT EXISTS");
    expect(query?.bindings).toContain("/admin/orders/order%201?drawer=supplements");
    expect(query?.bindings).toContain("合同");
  });
});
