import {describe,it,expect}from"vitest";
import {recoveredSupplementedIntake}from"./quote-order-intake-recovery";
const source=JSON.stringify({intakeOperations:{headCarrier:"旧头程",tailCarrier:"旧尾程"},intakeRoute:{exit_port:"OLD",domestic_agent:null},quoteCommercialUserId:null,quoteCommercialName:null});
const order={intake_operations_json:JSON.stringify({headCarrier:"订单补录头程",tailCarrier:"旧尾程"}),exit_port:"OLD",domestic_agent:"补录代理",quote_commercial_user_id:"commercial",quote_commercial_name_snapshot:"真实报价人"};
const quote={intake_operations_json:JSON.stringify({headCarrier:"旧头程",tailCarrier:"旧尾程"}),intake_route_recorded:1,exit_port:"OLD",domestic_agent:null,quote_commercial_user_id:null,quote_commercial_name_snapshot:null};
describe("three-way quote recovery after order supplements",()=>{
  it("keeps order-only supplements and source snapshots, while accepting unrelated quote corrections",()=>{
    const changed={...quote,intake_operations_json:JSON.stringify({headCarrier:"旧头程",tailCarrier:"新尾程"})};
    const result=recoveredSupplementedIntake(order,changed,source);expect(JSON.parse(result.intake_operations_json!)).toMatchObject({headCarrier:"订单补录头程",tailCarrier:"新尾程"});expect(result.domestic_agent).toBe("补录代理");expect(result.quote_commercial_user_id).toBe("commercial");
    expect(JSON.parse(source).intakeOperations.headCarrier).toBe("旧头程");
  });
  it("rejects conflicting changes instead of picking a silent winner",()=>{
    expect(()=>recoveredSupplementedIntake(order,{...quote,intake_operations_json:JSON.stringify({headCarrier:"报价又改成另一计划"})},source)).toThrow("已在订单补录");
    expect(()=>recoveredSupplementedIntake(order,{...quote,domestic_agent:"另一代理"},source)).toThrow("国内代理");
    expect(()=>recoveredSupplementedIntake(order,{...quote,quote_commercial_user_id:"other",quote_commercial_name_snapshot:"另一人"},source)).toThrow("报价商务");
  });
  it("accepts matching corrections",()=>{
    const result=recoveredSupplementedIntake(order,{...quote,intake_operations_json:order.intake_operations_json,domestic_agent:order.domestic_agent},source);
    expect(JSON.parse(result.intake_operations_json!).headCarrier).toBe("订单补录头程");
  });
  it("does not guess a winner when historical source evidence is malformed",()=>{
    expect(()=>recoveredSupplementedIntake(order,quote,"bad JSON")).toThrow("已在订单补录");
  });
});
