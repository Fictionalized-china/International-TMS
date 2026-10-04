import { describe,it,expect } from "vitest";
import { hrReportPeriod,reportCsv } from "./hr-reports";
describe("HR reports",()=>{
  it("uses Shanghai calendar weeks/months across year boundaries",()=>{
    expect(hrReportPeriod(new Date("2026-01-01T02:00:00Z"),"month",true)).toEqual({from:"2025-12-01",to:"2025-12-31"});
    expect(hrReportPeriod(new Date("2026-01-05T02:00:00Z"),"week",true)).toEqual({from:"2025-12-29",to:"2026-01-04"});
  });
  it("escapes quotes and neutralizes spreadsheet formula injection",()=>{
    expect(reportCsv([["=1+1","\t@SUM(A1)",'车"号']])).toContain('"\'=1+1"');
    expect(reportCsv([['车"号']])).toContain('"车""号"');
  });
});
