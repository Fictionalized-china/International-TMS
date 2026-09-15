import{describe,expect,it}from"vitest";
import{allocateCost,allocationDensity,recommendAllocationMethod}from"./cost-allocation";

describe("cost allocation",()=>{
  it("uses volume below the 300 kg/cbm density boundary",()=>{
    expect(allocationDensity(500,2)).toBe(250);
    expect(recommendAllocationMethod("FREIGHT",500,2)).toBe("volume");
    expect(recommendAllocationMethod("FREIGHT",600,2)).toBe("weight");
  });

  it("uses equal allocation for fixed per-order charges",()=>{
    expect(recommendAllocationMethod("CUSTOMS",900,1)).toBe("equal");
  });

  it("keeps rounded line amounts equal to the header total",()=>{
    const lines=allocateCost([
      {orderId:"a",actualWeightKg:100,actualVolumeCbm:1},
      {orderId:"b",actualWeightKg:200,actualVolumeCbm:1},
      {orderId:"c",actualWeightKg:300,actualVolumeCbm:1},
    ],100,"weight");
    expect(lines.map(line=>line.amount)).toEqual([16.67,33.33,50]);
    expect(lines.reduce((sum,line)=>sum+line.amount,0)).toBe(100);
  });

  it("splits equal charges without losing the final cent",()=>{
    const lines=allocateCost([
      {orderId:"a",actualWeightKg:1,actualVolumeCbm:1},
      {orderId:"b",actualWeightKg:1,actualVolumeCbm:1},
      {orderId:"c",actualWeightKg:1,actualVolumeCbm:1},
    ],10,"equal");
    expect(lines.map(line=>line.amount)).toEqual([3.33,3.33,3.34]);
  });
});
