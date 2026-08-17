import{describe,expect,it}from"vitest";
import{allocateToOutstanding}from"./settlement";

describe("settlement allocations",()=>{
  it("supports partial allocation across multiple expenses",()=>{
    expect(allocateToOutstanding([{id:"a",outstanding:60},{id:"b",outstanding:80}],100)).toEqual([{id:"a",amount:60},{id:"b",amount:40}]);
  });
  it("rejects over-allocation",()=>{
    expect(()=>allocateToOutstanding([{id:"a",outstanding:10}],10.01)).toThrow("超过");
  });
});
