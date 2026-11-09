import{describe,expect,it}from"vitest";
import{allocateCost,allocationDensity,recommendAllocationMethod}from"./cost-allocation";

describe("cost allocation",()=>{
  it("uses volume below the 300 kg/cbm density boundary",()=>{
    expect(allocationDensity(500,2)).toBe(250);
    expect(recommendAllocationMethod("FREIGHT",500,2)).toBe("volume");
    expect(recommendAllocationMethod("FREIGHT",600,2)).toBe("weight");
  });

  it("uses the configured volume-weight boundary",()=>{
    expect(recommendAllocationMethod("FREIGHT",700,2,400)).toBe("volume");
    expect(recommendAllocationMethod("FREIGHT",800,2,400)).toBe("weight");
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

  it.each(["equal", "weight", "volume"] as const)("never produces a negative remainder for tiny %s allocations",method=>{
    const basis=Array.from({length:6},(_,index)=>({orderId:String(index),actualWeightKg:1,actualVolumeCbm:1}));
    const lines=allocateCost(basis,0.03,method);
    expect(lines.every(line=>line.amount>=0)).toBe(true);
    expect(lines.reduce((sum,line)=>sum+Math.round(line.amount*100),0)).toBe(3);
    expect(allocateCost(basis,0.03,method)).toEqual(lines);
  });

  it("conserves cents across many small totals and weighted orders",()=>{
    for(const count of [2,3,6,31,100])for(const totalCents of [1,2,3,7,99,100,101]){
      const basis=Array.from({length:count},(_,index)=>({orderId:String(index),actualWeightKg:index%5,actualVolumeCbm:(index+1)/10}));
      for(const method of ["equal","weight","volume"] as const){
        const lines=allocateCost(basis,totalCents/100,method);
        expect(lines.every(line=>Number.isFinite(line.amount)&&line.amount>=0)).toBe(true);
        expect(lines.reduce((sum,line)=>sum+Math.round(line.amount*100),0)).toBe(totalCents);
      }
    }
  });

  it.each([-1,NaN,Infinity])("rejects invalid selected allocation basis %s",value=>{
    const basis=[{orderId:"bad",actualWeightKg:value,actualVolumeCbm:1},{orderId:"good",actualWeightKg:2,actualVolumeCbm:1}];
    expect(()=>allocateCost(basis,1,"weight")).toThrow();
  });

  it("rejects amounts outside safe cent precision before producing line amounts",()=>{
    const basis=[{orderId:"a",actualWeightKg:1,actualVolumeCbm:1}];
    for(const total of [0,0.001,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER])expect(()=>allocateCost(basis,total,"equal")).toThrow();
  });
});
