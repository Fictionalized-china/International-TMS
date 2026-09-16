import { describe,expect,it } from "vitest";
import {
  contactAppliesToQuote,
  parseMarkContactIds,
  parseMarkContactSnapshots,
  recommendedMarkContactIds,
  resolveMarkContactSnapshots,
  type MarkContactOption,
} from "./mark-contacts";

const contacts:MarkContactOption[]=[
  {id:"sales",name:"张三",contact_type:"business",phone:"13800000001",user_id:"sales-1",scope_type:"company",origin_country:null,destination_country:null,destination_warehouse_id:null,is_default:0,sort_order:10,department_id:"sales-dept",department_name:"业务部",position_id:"sales-pos",position_name:"业务岗"},
  {id:"exception",name:"公司值班",contact_type:"exception",phone:"4000000000",user_id:null,scope_type:"company",origin_country:null,destination_country:null,destination_warehouse_id:null,is_default:1,sort_order:20,department_id:"ops-dept",department_name:"操作部",position_id:"ops-pos",position_name:"操作岗"},
  {id:"warehouse",name:"塔什干仓",contact_type:"exception",phone:"998900000000",user_id:null,scope_type:"warehouse",origin_country:null,destination_country:null,destination_warehouse_id:"wh-1",is_default:1,sort_order:30,department_id:"ops-dept",department_name:"操作部",position_id:"warehouse-pos",position_name:"境外仓库岗"},
];

describe("mark contacts",()=>{
  it("rejects duplicate and excessive quotation selections",()=>{
    expect(()=>parseMarkContactIds(["a","a"])).toThrow("重复");
    expect(()=>parseMarkContactIds(["a","b","c","d"])).toThrow("最多");
  });

  it("recommends the salesperson work contact and one default exception contact",()=>{
    expect(recommendedMarkContactIds(contacts,{salespersonId:"sales-1"})).toEqual(["sales"]);
  });

  it("keeps warehouse contacts scoped to their destination warehouse",()=>{
    expect(contactAppliesToQuote(contacts[2],{destinationWarehouseId:"wh-1"})).toBe(true);
    expect(contactAppliesToQuote(contacts[2],{destinationWarehouseId:"wh-2"})).toBe(false);
  });

  it("parses only valid frozen contact snapshots",()=>{
    expect(parseMarkContactSnapshots(JSON.stringify([
      {id:"1",name:"张三",type:"business",phone:"13800000001"},
      {id:"2",name:"无电话",type:"exception",phone:""},
    ]))).toEqual([{id:"1",name:"张三",type:"business",phone:"13800000001"}]);
    expect(parseMarkContactSnapshots(null)).toBeNull();
  });

  it("provides a safe legacy contact array for label previews",()=>{
    expect(resolveMarkContactSnapshots(null,{name:"业务联系",phone:"13800000001"})).toEqual([
      {id:"legacy",name:"业务联系",type:"business",phone:"13800000001"},
    ]);
    expect(resolveMarkContactSnapshots(undefined,{name:"业务联系",phone:null})).toEqual([]);
  });
});
