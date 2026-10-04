import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistExpenseDirectionAction, retryOrderSettlementSync } from "./expense-direction-submit.server";
import { sqliteD1 } from "./sqlite-d1-test-helper";

let database:DatabaseSync,db:D1Database;
beforeEach(()=>{
  database=new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE order_expense_direction_controls(organization_id TEXT,order_id TEXT,direction TEXT,
    confirmed INTEGER DEFAULT 0,confirmed_by_user_id TEXT,confirmed_at TEXT,
    business_reviewed INTEGER DEFAULT 0,business_reviewed_by_user_id TEXT,business_reviewed_at TEXT,
    business_locked INTEGER DEFAULT 0,business_locked_by_user_id TEXT,business_locked_at TEXT,
    finance_reviewed INTEGER DEFAULT 0,finance_reviewed_by_user_id TEXT,finance_reviewed_at TEXT,
    finance_locked INTEGER DEFAULT 0,finance_locked_by_user_id TEXT,finance_locked_at TEXT,notes TEXT,updated_at TEXT,
    UNIQUE(order_id,direction));
    CREATE TABLE business_expenses(organization_id TEXT,order_id TEXT,direction TEXT,stage TEXT,updated_at TEXT);
    CREATE TABLE audit_logs(id TEXT PRIMARY KEY,organization_id TEXT,actor_user_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,outcome TEXT,metadata_json TEXT,created_at TEXT);
    CREATE TABLE order_settlement_sync_requests(organization_id TEXT,order_id TEXT,revision TEXT,updated_at TEXT,PRIMARY KEY(organization_id,order_id));
    INSERT INTO business_expenses VALUES('org','order','receivable','estimated',NULL);`);
  db=sqliteD1(database);
});
afterEach(()=>database.close());
const input=()=>({db,organizationId:"org",orderId:"order",direction:"receivable" as const,action:"confirm" as const,
  userId:"cs",notes:null,now:"2026-10-04T00:00:00Z",refresh:vi.fn(async()=>{})});

describe("expense signature atomic commit and retry",()=>{
  it("enforces prerequisites in the atomic update and confirms amounts only at final approval",async()=>{
    const request=input(),required=["confirm","business_review","finance_review"] as const;
    expect((await persistExpenseDirectionAction({...request,action:"finance_review",previousActions:["confirm","business_review"],confirmFeesWhenAllActions:required})).applied).toBe(false);
    await persistExpenseDirectionAction({...request,confirmFeesWhenAllActions:required});
    expect(database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("estimated");
    await persistExpenseDirectionAction({...request,action:"business_review",previousActions:["confirm"],confirmFeesWhenAllActions:required});
    await persistExpenseDirectionAction({...request,action:"finance_review",previousActions:["confirm","business_review"],confirmFeesWhenAllActions:required});
    expect(database.prepare("SELECT stage FROM business_expenses").get()?.stage).toBe("confirmed");
  });
  it("retains a saved signature and confirmed expenses when synchronization fails, then clears the marker on retry",async()=>{
    const request=input();request.refresh.mockRejectedValue(new Error("sync unavailable"));
    expect(await persistExpenseDirectionAction(request)).toEqual({applied:true,syncPending:true});
    expect(database.prepare("SELECT confirmed,confirmed_by_user_id FROM order_expense_direction_controls").get()).toEqual({confirmed:1,confirmed_by_user_id:"cs"});
    expect(database.prepare("SELECT stage FROM business_expenses").get()).toEqual({stage:"confirmed"});
    expect(await retryOrderSettlementSync({...request,refresh:async()=>{}})).toBe(false);
    expect(database.prepare("SELECT * FROM order_settlement_sync_requests").all()).toHaveLength(0);
  });
  it("rolls back the signature if confirming its fees fails",async()=>{
    database.exec("CREATE TRIGGER reject_confirm BEFORE UPDATE ON business_expenses BEGIN SELECT RAISE(ABORT,'fee failure');END");
    const request=input();await expect(persistExpenseDirectionAction(request)).rejects.toThrow("fee failure");
    expect(request.refresh).not.toHaveBeenCalled();
    expect(database.prepare("SELECT * FROM order_expense_direction_controls").all()).toHaveLength(0);
    expect(database.prepare("SELECT stage FROM business_expenses").get()).toEqual({stage:"estimated"});
  });
  it("does not overwrite the original signer on a repeated confirmation",async()=>{
    await persistExpenseDirectionAction(input());
    expect(await persistExpenseDirectionAction({...input(),userId:"another"})).toEqual({applied:false,syncPending:false});
    expect(database.prepare("SELECT confirmed_by_user_id FROM order_expense_direction_controls").get()).toEqual({confirmed_by_user_id:"cs"});
  });
  it("preserves a newer recovery request inserted during an older synchronization",async()=>{
    database.exec("INSERT INTO order_settlement_sync_requests VALUES('org','order','old','now')");
    const pending=await retryOrderSettlementSync({...input(),refresh:async()=>{
      database.exec("UPDATE order_settlement_sync_requests SET revision='new'");
    }});
    expect(pending).toBe(true);
    expect(database.prepare("SELECT revision FROM order_settlement_sync_requests").get()).toEqual({revision:"new"});
  });
});
