import {describe,expect,it} from "vitest";
import {
  hasBlockingActiveException,
  isActiveExceptionStatus,
  orderExceptionStatusForSeverities,
  type ExceptionSeverity,
} from "./batch-exception-policy";

describe("batch exception policy",()=>{
  it("only treats open and processing exceptions as active",()=>{
    expect(isActiveExceptionStatus("open")).toBe(true);
    expect(isActiveExceptionStatus("processing")).toBe(true);
    expect(isActiveExceptionStatus("resolved")).toBe(false);
    expect(isActiveExceptionStatus("cancelled")).toBe(false);
  });

  it("maps low-risk exceptions to warnings and high-risk exceptions to errors",()=>{
    expect(orderExceptionStatusForSeverities([])).toBe("normal");
    expect(orderExceptionStatusForSeverities(["low","medium"])).toBe("warning");
    expect(orderExceptionStatusForSeverities(["low","high"])).toBe("exception");
    expect(orderExceptionStatusForSeverities(["critical"])).toBe("exception");
  });

  it("never lets resolved history block future progress",()=>{
    expect(hasBlockingActiveException([
      {status:"resolved",blocksProgress:1},
      {status:"cancelled",blocksProgress:1},
      {status:"open",blocksProgress:0},
    ])).toBe(false);
    expect(hasBlockingActiveException([{status:"processing",blocksProgress:1}])).toBe(true);
  });

  it("remains deterministic under a large policy workload",()=>{
    const severities:ExceptionSeverity[]=["low","medium","high","critical"];
    let warnings=0,errors=0;
    for(let index=0;index<100_000;index++){
      const status=orderExceptionStatusForSeverities([severities[index%severities.length]]);
      if(status==="warning")warnings++;
      if(status==="exception")errors++;
    }
    expect({warnings,errors}).toEqual({warnings:50_000,errors:50_000});
  });
});
