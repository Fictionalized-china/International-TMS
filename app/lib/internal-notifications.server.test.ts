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
  listInternalNotifications,
  loadInternalNotificationSummary,
  markInternalNotification,
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
});
