export type AllocationMethod="weight"|"volume"|"equal";

export type AllocationBasis={
  orderId:string;
  actualWeightKg:number;
  actualVolumeCbm:number;
};

export type SuggestedAllocation=AllocationBasis&{
  ratio:number;
  amount:number;
};

const EQUAL_CHARGES=new Set(["TRANSIT_CUSTOMS","CUSTOMS","INBOUND_WAREHOUSE"]);

export function allocationDensity(weightKg:number,volumeCbm:number){
  return volumeCbm>0?weightKg/volumeCbm:0;
}

export function recommendAllocationMethod(chargeCode:string,weightKg:number,volumeCbm:number):AllocationMethod{
  if(EQUAL_CHARGES.has(chargeCode.toUpperCase()))return "equal";
  return allocationDensity(weightKg,volumeCbm)<300?"volume":"weight";
}

export function allocationMethodLabel(method:AllocationMethod){
  return method==="weight"?"按实收重量":method==="volume"?"按实收体积":"按订单均分";
}

export function allocateCost(basis:AllocationBasis[],totalAmount:number,method:AllocationMethod):SuggestedAllocation[]{
  if(!basis.length)throw new Error("配载批次没有可分摊订单");
  if(!Number.isFinite(totalAmount)||totalAmount<=0)throw new Error("分摊总金额必须大于 0");
  const values=basis.map(item=>method==="weight"?item.actualWeightKg:method==="volume"?item.actualVolumeCbm:1);
  const totalBasis=values.reduce((sum,value)=>sum+value,0);
  if(totalBasis<=0)throw new Error(method==="weight"?"没有可用的实收重量":"没有可用的实收体积");
  const totalCents=Math.round(totalAmount*100);
  let allocatedCents=0;
  return basis.map((item,index)=>{
    const ratio=values[index]/totalBasis;
    const cents=index===basis.length-1?totalCents-allocatedCents:Math.round(totalCents*ratio);
    allocatedCents+=cents;
    return{...item,ratio:Number(ratio.toFixed(8)),amount:cents/100};
  });
}
