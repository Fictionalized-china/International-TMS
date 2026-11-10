import { describe,expect,it } from "vitest";
import { captureIntakeDraft,intakeDraftValues,parseIntakeDraftPayload } from "./intake-drafts";
describe("intake draft payload",()=>{
  it("retains blank, zero, repeated fees and services without turning a draft into a complete order",()=>{
    const form=new FormData();form.set("intakeRequestId","request-draft-0001");form.set("intent","create");form.set("weight","");form.set("volume","0");form.append("chargeName","包装费");form.append("chargeName","包装费");form.append("intake_entrustedServices","pickup");
    const payload=captureIntakeDraft(form),values=intakeDraftValues(payload);
    expect(values.get("weight")).toBe("");expect(values.get("volume")).toBe("0");expect(values.all("chargeName")).toEqual(["包装费","包装费"]);expect(values.all("intent")).toEqual([]);
  });
  it("warns that real files must be reselected instead of claiming to retain uploads",()=>{
    const form=new FormData();form.set("intakeRequestId","request-draft-0001");form.append("photo",new File(["picture"],"photo.png"));
    expect(captureIntakeDraft(form)).toEqual({fields:[["intakeRequestId","request-draft-0001"]],filesOmitted:["photo.png"]});
  });
  it.each(["bad","[]",JSON.stringify({fields:[["intakeRequestId","short"]]}),JSON.stringify({fields:[["intakeRequestId","request-draft-0001"],["intent","create"]]}),JSON.stringify({fields:[["intakeRequestId","request-draft-0001"],["x",{}]]})])("rejects malformed payload %s",raw=>expect(()=>parseIntakeDraftPayload(raw)).toThrow());
  it("limits bytes, not only character count",()=>{
    const raw=JSON.stringify({fields:[["intakeRequestId","request-draft-0001"],["notes","中".repeat(70000)]]});
    expect(()=>parseIntakeDraftPayload(raw)).toThrow("200 KB");
  });
});
