import {DatabaseSync} from "node:sqlite";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {sqliteD1} from "../lib/sqlite-d1-test-helper";
const harness=vi.hoisted(()=>({db:null as unknown as D1Database,beforeBatch:null as null|(()=>void)}));
vi.mock("cloudflare:workers",()=>({env:{get DB(){return harness.db}}}));
vi.mock("../lib/auth.server",()=>({requireSessionUser:async()=>({organizationId:"org",userId:"user"})}));
vi.mock("../lib/warehouse-context.server",()=>({loadWarehouseContext:async()=>({selected:{id:"A"}})}));
vi.mock("../lib/warehouse-access.server",()=>({requireWarehouseAssignment:async()=>{}}));
vi.mock("../lib/audit.server",()=>({writeAudit:async()=>{}}));
import {action} from "./warehouse.inventory";
let sqlite:DatabaseSync;
beforeEach(()=>{
  sqlite=new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE mutation_commit_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1),created_at TEXT);
    CREATE TABLE warehouse_stocktakes(id TEXT PRIMARY KEY,organization_id TEXT,warehouse_id TEXT,location_id TEXT,status TEXT,stocktake_number TEXT,mutation_version INTEGER DEFAULT 0,updated_at TEXT,counted_packages INTEGER,shortage_packages INTEGER,overage_packages INTEGER,completed_by_user_id TEXT,completed_at TEXT);
    CREATE TABLE warehouse_packages(id TEXT PRIMARY KEY,organization_id TEXT,warehouse_id TEXT,barcode TEXT,location_id TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE warehouse_locations(id TEXT PRIMARY KEY,organization_id TEXT,warehouse_id TEXT,status TEXT);
    CREATE TABLE warehouse_stocktake_items(id TEXT PRIMARY KEY,organization_id TEXT,stocktake_id TEXT,package_id TEXT,expected_quantity INTEGER,counted_quantity INTEGER,result TEXT,counted_by_user_id TEXT,counted_at TEXT,UNIQUE(stocktake_id,package_id));
    CREATE TABLE warehouse_package_movements(id TEXT,organization_id TEXT,package_id TEXT,operation_type TEXT,from_location_id TEXT,to_location_id TEXT,operator_user_id TEXT,notes TEXT,occurred_at TEXT,created_at TEXT);
    INSERT INTO warehouse_stocktakes(id,organization_id,warehouse_id,location_id,status,stocktake_number) VALUES('task','org','A','loc','counting','ST');
    INSERT INTO warehouse_packages VALUES('a','org','A','BAR-A','loc','in_stock',NULL),('b','org','B','BAR-B','elsewhere','in_stock',NULL);
    INSERT INTO warehouse_locations VALUES('target','org','A','active');`);
  harness.beforeBatch=null;
  const db=sqliteD1(sqlite);
  harness.db={...db,batch:async statements=>{harness.beforeBatch?.();harness.beforeBatch=null;return db.batch(statements);}} as D1Database;
});
afterEach(()=>sqlite.close());
const submit=(values:Record<string,string>)=>action({request:new Request("http://localhost/warehouse/inventory",{method:"POST",body:new URLSearchParams(values)})} as Parameters<typeof action>[0]);
describe("warehouse inventory scope and terminal guards",()=>{
  it("rejects another warehouse's barcode",async()=>{
    expect(await submit({intent:"count",stocktakeId:"task",barcode:"BAR-B"})).toHaveProperty("formError");
    expect(sqlite.prepare("SELECT COUNT(*) n FROM warehouse_stocktake_items").get()).toEqual({n:0});
  });
  it("counts and closes with consistent totals",async()=>{
    expect(await submit({intent:"count",stocktakeId:"task",barcode:"BAR-A"})).toHaveProperty("success");
    expect(await submit({intent:"complete_stocktake",stocktakeId:"task"})).toHaveProperty("success");
    expect(sqlite.prepare("SELECT status,counted_packages,overage_packages FROM warehouse_stocktakes").get()).toEqual({status:"completed",counted_packages:1,overage_packages:1});
  });
  it("does not let a stale scanner alter a closed stocktake",async()=>{
    harness.beforeBatch=()=>sqlite.exec("UPDATE warehouse_stocktakes SET status='completed',mutation_version=1");
    expect(await submit({intent:"count",stocktakeId:"task",barcode:"BAR-A"})).toHaveProperty("formError");
    expect(sqlite.prepare("SELECT COUNT(*) n FROM warehouse_stocktake_items").get()).toEqual({n:0});
  });
  it("does not move a package dispatched after the initial read",async()=>{
    harness.beforeBatch=()=>sqlite.exec("UPDATE warehouse_packages SET status='dispatched' WHERE id='a'");
    expect(await submit({intent:"move",packageId:"a",targetLocationId:"target"})).toHaveProperty("formError");
    expect(sqlite.prepare("SELECT location_id FROM warehouse_packages WHERE id='a'").get()).toEqual({location_id:"loc"});
    expect(sqlite.prepare("SELECT COUNT(*) n FROM warehouse_package_movements").get()).toEqual({n:0});
  });
});
