// Read local pages using temporary test sessions. No orders or workflow data are edited.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const base=new URL(process.argv[2] || "http://127.0.0.1:5189");
if (!["localhost","127.0.0.1","[::1]"].includes(base.hostname)) throw new Error("此脚本仅限本地系统");
const folder=resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const file=readdirSync(folder).find((name)=>name.endsWith(".sqlite") && name!=="metadata.sqlite");
if (!file) throw new Error("未找到本地 D1");
const db=new DatabaseSync(resolve(folder,file));
db.exec("PRAGMA busy_timeout=5000");
const sessions=[],results=[];
try {
  for (const position of ["BOSS","OPERATION_SUPERVISOR","TRACKING","OPERATION","DOC","FINANCE_ACCOUNTING"]) {
    const member=db.prepare(`SELECT m.user_id,m.organization_id FROM memberships m
      JOIN users u ON u.id=m.user_id AND u.status='active'
      JOIN positions p ON p.id=m.position_id AND p.organization_id=m.organization_id AND p.status='active'
      WHERE m.status='active' AND p.code=? AND u.email LIKE '%@e2e.test' LIMIT 1`).get(position);
    if (!member) {results.push({position,skipped:"无本地测试账号"});continue;}
    const token=randomBytes(32).toString("base64url"),slot=randomUUID(),id=randomUUID(),now=new Date().toISOString();
    db.prepare("INSERT INTO sessions(id,user_id,organization_id,token_hash,expires_at,last_seen_at,created_at,site) VALUES(?,?,?,?,?,?,?,'admin')")
      .run(id,member.user_id,member.organization_id,createHash("sha256").update(token).digest("hex"),new Date(Date.now()+600_000).toISOString(),now,now);
    sessions.push(id);
    const order=db.prepare("SELECT id FROM transport_orders WHERE organization_id=? AND status NOT IN ('draft','cancelled') ORDER BY updated_at DESC LIMIT 1").get(member.organization_id);
    const batch=db.prepare("SELECT id FROM transport_batches WHERE organization_id=? AND status!='cancelled' AND batch_number LIKE 'PZ%' ORDER BY created_at DESC LIMIT 1").get(member.organization_id);
    const paths=["/admin/loading","/admin/loading?destination=莫斯科&departureFrom=2026-09-01&departureTo=2026-10-31","/admin/tracking-center"];
    if (batch) paths.push(`/admin/loading/${batch.id}?tab=tracking`);
    if (order && ["BOSS","FINANCE_ACCOUNTING","OPERATION"].includes(position)) paths.push(`/admin/orders/${order.id}?stage=reconciliation&module=costs`);
    for (const path of paths) {
      const url=new URL(path,base);url.searchParams.set("itmsTab",slot);
      const response=await fetch(url,{headers:{cookie:`itms_admin_session_${slot}=${token}`},redirect:"manual",signal:AbortSignal.timeout(30_000)});
      const html=await response.text();
      const recovery=html.includes("SYSTEM RECOVERY")||html.includes("系统暂时无法完成请求");
      results.push({position,path,status:response.status,recovery});
      if (response.status>=500 || (response.status===200 && recovery)) throw new Error(`本地页面异常：${position} ${path} ${response.status}`);
      if (![200,403,404].includes(response.status)) throw new Error(`本地会话或页面跳转异常：${position} ${path} ${response.status}`);
      if (path==="/admin/loading" && response.status===200 && !html.includes("应用高级筛选")) throw new Error("高级筛选未显示");
    }
  }
  const duplicate=db.prepare(`SELECT COUNT(*) total FROM (SELECT bo.organization_id,bo.order_id
    FROM transport_batch_orders bo JOIN transport_batches b ON b.id=bo.batch_id AND b.organization_id=bo.organization_id
    WHERE bo.status!='removed' AND b.status!='cancelled' GROUP BY bo.organization_id,bo.order_id HAVING COUNT(*)>1)`).get();
  console.log(JSON.stringify({results,duplicateActiveOrders:duplicate.total},null,2));
} finally {
  for (const id of sessions) db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  db.close();
}
