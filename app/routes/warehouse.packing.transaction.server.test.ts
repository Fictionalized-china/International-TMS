import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {meetingFixture} from "../lib/meeting-integration-fixture";
import {physicalWarehouseStockSql} from "../lib/physical-warehouse-stock";
const state=vi.hoisted(()=>({env:{} as {DB:D1Database},actor:{} as object}));
vi.mock("cloudflare:workers",()=>({env:state.env}));
vi.mock("../lib/auth.server",()=>({requireSessionUser:async()=>state.actor}));
vi.mock("../lib/warehouse-context.server",()=>({loadWarehouseContext:async()=>({selected:{id:"wh",warehouse_role:"domestic_collection"}})}));
vi.mock("../lib/warehouse-access.server",()=>({requireWarehouseAssignment:async()=>undefined}));
vi.mock("../lib/workflow-supplement.server",()=>({ensureMissingLoadingDocumentSupplements:async()=>undefined}));
import {action} from "./warehouse.packing";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();state.env.DB=fixture.db;state.actor=fixture.actors.get("owner")!;
  const s=fixture.database,n=fixture.now;
  s.prepare("INSERT INTO warehouses(id,organization_id,code,name,created_at,updated_at) VALUES('wh','org','WH','国内仓',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_zones(id,organization_id,warehouse_id,code,name,created_at,updated_at) VALUES('zone','org','wh','Z','到货',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_locations(id,organization_id,warehouse_id,zone_id,code,name,created_at,updated_at) VALUES('loc','org','wh','zone','L','收货位',?,?)").run(n,n);
  s.prepare("INSERT INTO shipments(id,organization_id,shipment_number,order_id,customer_id,status,created_at,updated_at) VALUES('shipment','org','PACK-SHP','order','customer','picked_up',?,?)").run(n,n);
  s.prepare("INSERT INTO warehouse_receipts(id,organization_id,receipt_number,shipment_id,warehouse_id,location_id,status,total_packages,total_weight_kg,total_volume_cbm,cargo_complete,received_by_user_id,received_at,created_at,updated_at) VALUES('receipt','org','PACK-IN','shipment','wh','loc','completed',500,500,0.5,1,'owner',?,?,?)").run(n,n,n);
  const insert=s.prepare("INSERT INTO warehouse_packages(id,organization_id,receipt_id,shipment_id,warehouse_id,location_id,barcode,package_number,pieces,weight_kg,volume_cbm,status,label_kind,lifecycle_status,created_at,updated_at) VALUES(?,'org','receipt','shipment','wh','loc',?,?,1,1,0.001,'in_stock','inbound_mark','active',?,?)");
  for(let i=0;i<500;i++)insert.run(`in${i}`,`IN-${i}`,`IN-${i}`,n,n);
  const prepare=fixture.db.prepare.bind(fixture.db);
  vi.spyOn(fixture.db,"prepare").mockImplementation(sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);vi.spyOn(statement,"bind").mockImplementation((...values)=>{expect(values.length).toBeLessThanOrEqual(100);return bind(...values);});return statement;});
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
async function submit(values:Record<string,string>){return action({request:new Request("http://local.test/warehouse/packing?warehouseId=wh",{method:"POST",body:new URLSearchParams(values)}),params:{},context:undefined} as never);}
async function create(){
  const values:Record<string,string>={intent:"create_packing",orderId:"order",packingMode:"preserve"};
  for(let i=0;i<500;i++)for(const key of["weightKg","lengthCm","widthCm","heightCm"])values[`${key}_${i}`]=key==="weightKg"?"1":"10";
  return submit(values);
}
describe("500-package packing and cancellation through the real action",()=>{
  it("packs all sources, confirms labels, and restores all sources when cancelled without excessive SQL bindings",async()=>{
    const result=await create();expect(result).toMatchObject({success:expect.stringContaining("500")});
    const id=String((result as {jobId:string}).jobId),s=fixture.database;
    expect(s.prepare("SELECT COUNT(*) n FROM warehouse_packing_job_sources").get()?.n).toBe(500);
    expect(s.prepare("SELECT COUNT(*) n FROM warehouse_packages WHERE label_kind='oul' AND lifecycle_status='active'").get()?.n).toBe(500);
    expect(s.prepare(`SELECT COUNT(*) n FROM warehouse_packages p WHERE ${physicalWarehouseStockSql()}`).get()?.n).toBe(500);
    expect(await submit({intent:"confirm_labelled",jobId:id})).toMatchObject({success:expect.stringContaining("待配载池")});
    expect(await submit({intent:"cancel_packing",jobId:id})).toMatchObject({success:expect.stringContaining("已作废")});
    expect(s.prepare("SELECT COUNT(*) n FROM warehouse_packages WHERE label_kind='inbound_mark' AND status='in_stock'").get()?.n).toBe(500);
    expect(s.prepare("SELECT COUNT(*) n FROM warehouse_packages WHERE label_kind='oul' AND lifecycle_status='voided'").get()?.n).toBe(500);
    expect(s.prepare(`SELECT COUNT(*) n FROM warehouse_packages p WHERE ${physicalWarehouseStockSql()}`).get()?.n).toBe(500);
    expect(await submit({intent:"cancel_packing",jobId:id})).toMatchObject({formError:expect.any(String)});
  });
  it("does not confirm a stale cancelled job or report a false success",async()=>{
    const result=await create(),id=String((result as {jobId:string}).jobId),original=fixture.db.batch.bind(fixture.db);
    fixture.db.batch=async statements=>{fixture.database.prepare("UPDATE warehouse_packing_jobs SET status='cancelled' WHERE id=?").run(id);return original(statements);};
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    expect(await submit({intent:"confirm_labelled",jobId:id})).toMatchObject({formError:expect.any(String)});log.mockRestore();
    expect(fixture.database.prepare("SELECT labeling_confirmed_at FROM warehouse_packing_jobs WHERE id=?").get(id)?.labeling_confirmed_at).toBeNull();
  });
});
