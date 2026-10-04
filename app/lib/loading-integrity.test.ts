import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";

const migration=readFileSync(new URL("../../migrations/0167_loading_integrity_and_sync.sql",import.meta.url),"utf8");
let database:DatabaseSync, db:D1Database;
const base=`CREATE TABLE transport_batches(id TEXT PRIMARY KEY,organization_id TEXT,status TEXT);
  CREATE TABLE transport_batch_orders(id TEXT PRIMARY KEY,organization_id TEXT,batch_id TEXT,order_id TEXT,status TEXT,UNIQUE(batch_id,order_id));
  CREATE TABLE warehouse_packing_jobs(id TEXT PRIMARY KEY,status TEXT,transport_batch_id TEXT);
  INSERT INTO warehouse_packing_jobs VALUES('job','labelled',NULL);`;
beforeEach(()=>{database=new DatabaseSync(":memory:");database.exec(base+ migration);db=sqliteD1(database);});
afterEach(()=>database.close());
const batch=(id:string,order="order",org="org") => db.batch([
  db.prepare("INSERT INTO transport_batches VALUES(?,?,'planning')").bind(id,org),
  db.prepare("UPDATE warehouse_packing_jobs SET status='allocated',transport_batch_id=? WHERE id='job' AND status='labelled' AND transport_batch_id IS NULL").bind(id),
  db.prepare("INSERT INTO transport_batch_orders VALUES(?,?,?,?,'planned')").bind(id+order,org,id,order),
]);

describe("active order occupancy database guard",()=>{
  it("rolls back the losing batch after two sessions read the same eligible packing job",async()=>{
    const firstRead=database.prepare("SELECT id FROM warehouse_packing_jobs WHERE status='labelled'").all();
    const secondRead=database.prepare("SELECT id FROM warehouse_packing_jobs WHERE status='labelled'").all();
    expect(firstRead).toEqual(secondRead);
    await batch("winner");
    await expect(batch("loser")).rejects.toThrow("transport_batch_order_claims");
    expect(database.prepare("SELECT id FROM transport_batches").all()).toEqual([{id:"winner"}]);
    expect(database.prepare("SELECT transport_batch_id FROM warehouse_packing_jobs").get()).toEqual({transport_batch_id:"winner"});
    expect(database.prepare("SELECT batch_id FROM transport_batch_order_claims").all()).toEqual([{batch_id:"winner"}]);
  });
  it("releases removed orders and prevents reactivation while another batch owns them",async()=>{
    await batch("first");
    database.exec("UPDATE transport_batch_orders SET status='removed' WHERE batch_id='first'");
    await batch("next");
    expect(()=>database.exec("UPDATE transport_batch_orders SET status='planned' WHERE batch_id='first'"))
      .toThrow("transport_batch_order_claims");
    expect(database.prepare("SELECT status FROM transport_batch_orders WHERE batch_id='first'").get()).toEqual({status:"removed"});
  });
  it("releases cancellations but fails an unsafe restoration atomically",async()=>{
    await batch("first");database.exec("UPDATE transport_batches SET status='cancelled' WHERE id='first'");
    await batch("next");
    expect(()=>database.exec("UPDATE transport_batches SET status='planning' WHERE id='first'")).toThrow();
    expect(database.prepare("SELECT status FROM transport_batches WHERE id='first'").get()).toEqual({status:"cancelled"});
    database.exec("DELETE FROM transport_batch_orders WHERE batch_id='next'");
    database.exec("UPDATE transport_batches SET status='planning' WHERE id='first'");
    expect(database.prepare("SELECT batch_id FROM transport_batch_order_claims").all()).toEqual([{batch_id:"first"}]);
  });
  it("keeps arrived orders occupied and permits independent organizations",async()=>{
    await batch("one");database.exec("UPDATE transport_batch_orders SET status='arrived';UPDATE transport_batches SET status='arrived'");
    await expect(batch("sameOrg")).rejects.toThrow();
    await batch("otherOrg","order","other");
    expect(database.prepare("SELECT COUNT(*) total FROM transport_batch_order_claims").get()).toEqual({total:2});
  });
  it("does not claim rows added to a cancelled batch",async()=>{
    database.exec("INSERT INTO transport_batches VALUES('cancelled','org','cancelled');INSERT INTO transport_batch_orders VALUES('old','org','cancelled','order','planned')");
    await batch("active");
    expect(database.prepare("SELECT batch_id FROM transport_batch_order_claims").all()).toEqual([{batch_id:"active"}]);
  });
  it("refuses existing duplicate active orders without altering their history",()=>{
    const legacy=new DatabaseSync(":memory:");
    try {
      legacy.exec(base+"INSERT INTO transport_batches VALUES('a','org','planning'),('b','org','loading');INSERT INTO transport_batch_orders VALUES('a1','org','a','order','planned'),('b1','org','b','order','planned');BEGIN");
      expect(()=>legacy.exec(migration)).toThrow();legacy.exec("ROLLBACK");
      expect(legacy.prepare("SELECT COUNT(*) total FROM transport_batch_orders").get()).toEqual({total:2});
    } finally {legacy.close();}
  });
});
