import { DatabaseSync } from "node:sqlite";
import { describe,it,expect } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import { changedRowGuard, guardedBatch } from "./mutation-guard.server";
describe("conditional mutation transaction integrity",()=>{
  it("rolls back earlier writes and prevents dependent writes on a stale snapshot",async()=>{
    const sqlite=new DatabaseSync(":memory:");
    try {
      sqlite.exec("CREATE TABLE mutation_commit_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1),created_at TEXT); CREATE TABLE orders(id TEXT PRIMARY KEY,status TEXT,owner TEXT); CREATE TABLE history(id TEXT); INSERT INTO orders VALUES('one','signed','original')");
      const db=sqliteD1(sqlite);
      await expect(guardedBatch(db,[
        db.prepare("UPDATE orders SET owner='wrong' WHERE id='one'"),
        db.prepare("UPDATE orders SET status='cancelled' WHERE id='one' AND status='in_transit'"),
        changedRowGuard(db,"now"),db.prepare("INSERT INTO history VALUES('incorrect')"),
      ],"conflict")).rejects.toThrow("conflict");
      expect(sqlite.prepare("SELECT status,owner FROM orders").get()).toEqual({status:"signed",owner:"original"});
      expect(sqlite.prepare("SELECT COUNT(*) n FROM history").get()).toEqual({n:0});
      await guardedBatch(db,[db.prepare("UPDATE orders SET owner='correct' WHERE id='one' AND status='signed'"),changedRowGuard(db,"now")],"conflict");
      expect(sqlite.prepare("SELECT owner FROM orders").get()).toEqual({owner:"correct"});
    } finally {sqlite.close();}
  });
});
