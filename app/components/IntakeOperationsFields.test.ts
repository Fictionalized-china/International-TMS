import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it } from "vitest";
import { IntakeOperationsFields } from "./IntakeOperationsFields";
describe("intake planned facts UI",()=>{
  const props={people:{businessAssistant:[{id:"s",display_name:"业务甲"}],customerService:[{id:"c",display_name:"客服甲"}]},policy:()=>({isActive:true,isRequired:false}),defaultTailCarrier:"口岸调度"};
  it("shows labeled single-source inputs and no actual car or driver requirement",()=>{
    const html=renderToStaticMarkup(createElement(IntakeOperationsFields,{...props,direct:true}));
    expect(html).toContain('name="intake_tailCarrier"');expect(html).toContain('value="口岸调度"');expect(html).toContain('北京时间');expect(html).toContain('name="intake_businessAssistant"');expect(html).toContain('name="intake_entrustedServices"');expect(html).not.toContain('车牌');
    expect(html).toContain('name="intake_businessMajor"');expect(html).toContain('name="intake_businessKind"');expect(html).toContain('与整车/拼车的装车方式分别记录');
  });
  it("respects hidden auxiliary fields",()=>expect(renderToStaticMarkup(createElement(IntakeOperationsFields,{...props,policy:()=>({isActive:false,isRequired:false})}))).not.toContain('<input'));
  it("makes recorded values read-only in missing-only remediation and does not prefill invalid legacy counts",()=>{
    const html=renderToStaticMarkup(createElement(IntakeOperationsFields,{...props,raw:JSON.stringify({headCarrier:"已记录计划",headVehicleCount:0}),editableKeys:["headVehicleCount"]}));
    expect(html).not.toContain('name="intake_headCarrier"');expect(html).toContain('value="已记录计划"');
    expect(html).toContain('name="intake_headVehicleCount"');expect(html).not.toContain('value="0"');expect(html).not.toContain('required=""');
  });
  it("formats stored UTC back to Beijing time without shifting a correction",()=>{
    const html=renderToStaticMarkup(createElement(IntakeOperationsFields,{...props,raw:JSON.stringify({plannedDeparture:"2026-11-10T01:00:00.000Z"})}));
    expect(html).toContain('value="2026-11-10T09:00"');
  });
});
