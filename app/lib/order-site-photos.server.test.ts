import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {meetingFixture} from "./meeting-integration-fixture";
import {prepareSitePhotoStatements,listOrderSitePhotos,validateSiteImage} from "./order-site-photos.server";
import {defaultBusinessProcessPolicy,resolveBusinessProcessPolicy,validateBusinessProcessPolicy} from "./business-process-policy";
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
const pixel="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQCej5DwADXAHwCt6haAAAAABJRU5ErkJggg==";
const png=()=>new File([Uint8Array.from(atob(pixel),c=>c.charCodeAt(0))],"现场.png",{type:"image/png"});
function form(){const data=new FormData();data.append("sitePhotos",png());data.append("sitePhotoThumbnails",png());return data;}
function input(){return{organizationId:"org",actorUserId:"owner",form:form(),stage:"domestic_receipt" as const,sourceType:"warehouse_receipt",sourceId:"test-receipt",targets:[{orderId:"order",customerId:"customer"}],occurredAt:fixture.now,now:fixture.now};}
const count=(table:string)=>Number(fixture.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n);
function secondCustomerOrder(){
  fixture.database.prepare("INSERT INTO customers(id,organization_id,code,identity_code,name,created_at,updated_at) VALUES('customer2','org','C2','NEXT2','第二客户',?,?)").run(fixture.now,fixture.now);
  const columns=fixture.database.prepare("PRAGMA table_info(transport_orders)").all().map(row=>String(row.name)),source=fixture.database.prepare("SELECT * FROM transport_orders WHERE id='order'").get()!;
  fixture.database.prepare(`INSERT INTO transport_orders(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...columns.map(column=>column==="id"?"order2":column==="order_number"?"PHOTO-SO2":column==="customer_id"?"customer2":source[column]));
  return[{orderId:"order",customerId:"customer",orderNumber:"TEST-SO"},{orderId:"order2",customerId:"customer2",orderNumber:"PHOTO-SO2"}];
}
beforeEach(async()=>{fixture=await meetingFixture();});afterEach(()=>fixture?.database.close());
describe("shared site photo storage and atomic job association",()=>{
  it("applies the same photo policy to original-only legacy forms without manufacturing a thumbnail or copying a second original",async()=>{
    const data=input();data.form.delete("sitePhotoThumbnails");
    await expect(prepareSitePhotoStatements(fixture.db,data)).rejects.toThrow("缩略图");
    await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,originalOnly:true}));
    expect((await listOrderSitePhotos(fixture.db,"org","order")).photos[0]).toMatchObject({has_thumbnail:0});
    expect(count("order_attachments")).toBe(1);expect(count("warehouse_exception_attachments")).toBe(0);
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.enabled_stages','pickup',?)").run(fixture.now);
    await expect(prepareSitePhotoStatements(fixture.db,{...data,originalOnly:true})).rejects.toThrow("停用");
  });
  it("does not auto-share a private picture with another batch customer's order",async()=>{
    const targets=secondCustomerOrder(),data=input();data.form.set("sitePhotoTargetOrderIds",JSON.stringify([["order"]]));
    await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,targets}));
    expect((await listOrderSitePhotos(fixture.db,"org","order")).photos).toHaveLength(1);
    expect((await listOrderSitePhotos(fixture.db,"org","order2")).photos).toHaveLength(0);
    const audit=JSON.parse(String(fixture.database.prepare("SELECT metadata_json FROM audit_logs WHERE action='order.site_photos.upload'").get()?.metadata_json));expect(audit.orderIds).toEqual(["order"]);
  });
  it("only shares a common batch photo after explicit selection, and denies unknown order IDs",async()=>{
    const targets=secondCustomerOrder(),data=input();
    await expect(prepareSitePhotoStatements(fixture.db,{...data,targets})).rejects.toThrow("不会默认共享");
    data.form.set("sitePhotoTargetOrderIds",JSON.stringify([["outside-this-job"]]));await expect(prepareSitePhotoStatements(fixture.db,{...data,targets})).rejects.toThrow("超出本次作业范围");
    data.form.set("sitePhotoTargetOrderIds",JSON.stringify([["order","order2"]]));await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,targets}));
    expect((await listOrderSitePhotos(fixture.db,"org","order")).photos).toHaveLength(1);expect((await listOrderSitePhotos(fixture.db,"org","order2")).photos).toHaveLength(1);
  });
  it("requires evidence for the configured job without inventing an extra per-order image gate or sharing private photos",async()=>{
    const targets=secondCustomerOrder(),data=input();data.form.set("sitePhotoTargetOrderIds",JSON.stringify([["order"]]));
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.required_stages','domestic_receipt',?)").run(fixture.now);
    await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,targets}));
    expect((await listOrderSitePhotos(fixture.db,"org","order")).photos).toHaveLength(1);expect((await listOrderSitePhotos(fixture.db,"org","order2")).photos).toHaveLength(0);
  });
  it("persists originals and thumbnails separately, lists only metadata and deduplicates exact retries",async()=>{
    const data=input();await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,data));
    await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,data));
    expect(count("order_attachments")).toBe(1);expect(count("order_site_photos")).toBe(1);expect(count("audit_logs")).toBe(1);
    expect(fixture.database.prepare("SELECT public_to_customer,review_status FROM order_document_metadata").get()).toEqual({public_to_customer:1,review_status:"approved"});
    const list=await listOrderSitePhotos(fixture.db,"org","order");
    expect(list.photos[0]).toMatchObject({file_name:"现场.png",stage_code:"domestic_receipt",order_id:"order"});
    expect(JSON.stringify(list)).not.toContain("base64");
    expect((await listOrderSitePhotos(fixture.db,"other-org","order")).photos).toEqual([]);
  });
  it("does not leave any uploaded bytes or association if the business transaction fails",async()=>{
    const prepared=await prepareSitePhotoStatements(fixture.db,input());
    await expect(fixture.db.batch([...prepared,fixture.db.prepare("INSERT INTO deliberately_missing_table(id) VALUES(1)")])).rejects.toThrow();
    for(const table of ["order_attachments","order_site_photos","order_site_photo_submissions","audit_logs"])expect(count(table)).toBe(0);
  });
  it("rejects changed request content and wrong customer/package association, with no second file",async()=>{
    const data=input();await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,data));
    await expect(fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,description:"换了内容"}))).rejects.toThrow();
    await expect(fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,sourceId:"wrong-target",targets:[{orderId:"order",customerId:"not-this-customer"}]}))).rejects.toThrow();
    await expect(fixture.db.batch(await prepareSitePhotoStatements(fixture.db,{...data,sourceId:"wrong-package",targets:[{orderId:"order",customerId:"customer",packageIds:["not-this-order-package"]}]}))).rejects.toThrow();
    expect(count("order_attachments")).toBe(1);expect(count("order_site_photo_submissions")).toBe(1);
  });
  it("requires an enabled configured photo only at that stage and keeps historical files after unplug",async()=>{
    await fixture.db.batch(await prepareSitePhotoStatements(fixture.db,input()));
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_by_user_id,updated_at) VALUES('org','photos.required_stages','domestic_receipt','owner',?)").run(fixture.now);
    await expect(prepareSitePhotoStatements(fixture.db,{...input(),form:new FormData()})).rejects.toThrow("必须上传");
    await expect(prepareSitePhotoStatements(fixture.db,{...input(),stage:"pickup",form:new FormData()})).resolves.toHaveLength(1);
    fixture.database.exec("DELETE FROM business_process_policies;INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.enabled_stages','pickup','2026-11-16')");
    await expect(prepareSitePhotoStatements(fixture.db,input())).rejects.toThrow("已停用");
    expect((await listOrderSitePhotos(fixture.db,"org","order")).photos).toHaveLength(1);
  });
  it("rejects a policy required/disabled deadlock, invalid formats and unreasonable limits",()=>{
    expect(()=>resolveBusinessProcessPolicy([{policy_key:"photos.enabled_stages",policy_value:"pickup"},{policy_key:"photos.required_stages",policy_value:"delivery"}])).toThrow("必须同时开放");
    for(const [key,value] of [["photos.formats","svg"],["photos.max_count","0"],["photos.max_file_kb","99999"],["photos.required_stages","nonexistent"]])expect(()=>validateBusinessProcessPolicy({[key]:value})).toThrow();
  });
  it("checks MIME, magic bytes, file size, duplicate selection and thumbnail presence",async()=>{
    await expect(validateSiteImage(new File(["<svg onload=evil()>"],"fake.png",{type:"image/png"}),10000,["png"])).rejects.toThrow("不是允许的真实");
    await expect(validateSiteImage(new File([await png().arrayBuffer()],"fake.jpg",{type:"image/jpeg"}),10000,["jpeg"])).rejects.toThrow();
    await expect(validateSiteImage(png(),10,["png"])).rejects.toThrow("超过");
    const missing=input();missing.form.delete("sitePhotoThumbnails");await expect(prepareSitePhotoStatements(fixture.db,missing)).rejects.toThrow("缩略图");
    const duplicate=input();duplicate.form.append("sitePhotos",png());duplicate.form.append("sitePhotoThumbnails",png());await expect(prepareSitePhotoStatements(fixture.db,duplicate)).rejects.toThrow("重复图片");
    expect(defaultBusinessProcessPolicy["photos.required_stages"]).toBe("");
  });
  it("does not save after a photo policy changes between validation and commit, including deletion to default",async()=>{
    fixture.database.prepare("INSERT INTO business_process_policies(organization_id,policy_key,policy_value,updated_at) VALUES('org','photos.max_count','2',?)").run(fixture.now);
    const prepared=await prepareSitePhotoStatements(fixture.db,input());
    fixture.database.exec("DELETE FROM business_process_policies");
    await expect(fixture.db.batch(prepared)).rejects.toThrow("mutation_commit_guards");
    expect(count("order_attachments")).toBe(0);
  });
});
