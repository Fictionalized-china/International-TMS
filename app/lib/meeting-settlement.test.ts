import { describe,expect,it } from "vitest";
import { defaultBusinessProcessPolicy } from "./business-process-policy";
import { settlementSequenceReason,settlementActorPositions } from "./meeting-settlement";
import { emptyExpenseDirectionControl } from "./expense-control";
const fields=[{fieldKey:"customer_service_confirmation",isActive:true,isRequired:true},{fieldKey:"business_review",isActive:true,isRequired:true},{fieldKey:"finance_review",isActive:true,isRequired:true}];
describe("meeting settlement chain and hot-plug",()=>{
  it("blocks skipping required actions",()=>{
    const control=emptyExpenseDirectionControl("receivable");
    expect(settlementSequenceReason(control,"finance_review",fields,defaultBusinessProcessPolicy)).toContain("前序");
    expect(settlementSequenceReason({...control,confirmed:1},"business_review",fields,defaultBusinessProcessPolicy)).toBeNull();
    expect(settlementSequenceReason({...control,confirmed:1},"finance_review",fields,defaultBusinessProcessPolicy)).toContain("前序");
  });
  it("skips hidden/optional predecessors without deadlock and retains completed signatures",()=>{
    const control=emptyExpenseDirectionControl("payable");
    const optional=fields.map(f=>({...f,isRequired:false}));
    expect(settlementSequenceReason(control,"finance_review",optional,defaultBusinessProcessPolicy)).toBeNull();
    expect(settlementSequenceReason({...control,finance_reviewed:1},"finance_review",fields,defaultBusinessProcessPolicy)).toBeNull();
    expect(settlementSequenceReason(control,"finance_review",fields,{...defaultBusinessProcessPolicy,"settlement.sequential":"0"})).toBeNull();
  });
  it("uses configurable actors for both chains",()=>{
    expect(settlementActorPositions(defaultBusinessProcessPolicy,"receivable","confirm")).toEqual(["SALES","CS"]);
    expect(settlementActorPositions(defaultBusinessProcessPolicy,"payable","confirm")).toEqual(["OPERATION","BUSINESS_ROUTE"]);
    expect(settlementActorPositions({...defaultBusinessProcessPolicy,"receivable.approve_positions":"BOSS"},"receivable","finance_review")).toEqual(["BOSS"]);
  });
});
