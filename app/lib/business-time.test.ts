import { describe,expect,it } from "vitest";
import { normalizeBusinessPlanTime,businessDateTimeLabel } from "./business-time";
describe("business plan time",()=>{
  it("round trips Beijing plans independent of the runtime timezone",()=>{
    const utc=normalizeBusinessPlanTime("2026-11-10T09:30");
    expect(utc).toBe("2026-11-10T01:30:00.000Z");
    expect(businessDateTimeLabel(utc)).toBe("2026-11-10 09:30");
    expect(normalizeBusinessPlanTime(utc)).toBe(utc);
  });
  it.each(["2026-02-30T09:00","2026-11-10T24:00","2026-11-10T09:60","2026-11-10T09:00:60","garbage"])("rejects rollover or invalid time %s",value=>expect(()=>normalizeBusinessPlanTime(value)).toThrow());
  it("keeps an absent plan absent",()=>expect(normalizeBusinessPlanTime("")).toBeNull());
});
