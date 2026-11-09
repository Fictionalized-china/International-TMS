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

export function recommendAllocationMethod(chargeCode:string,weightKg:number,volumeCbm:number,volumeWeightRatioKgPerCbm=300):AllocationMethod{
  if(EQUAL_CHARGES.has(chargeCode.toUpperCase()))return "equal";
  return allocationDensity(weightKg,volumeCbm)<volumeWeightRatioKgPerCbm?"volume":"weight";
}

export function allocationMethodLabel(method:AllocationMethod){
  return method==="weight"?"按实收重量":method==="volume"?"按实收体积":"按订单均分";
}

export function allocateCost(basis:AllocationBasis[],totalAmount:number,method:AllocationMethod):SuggestedAllocation[]{
  if(!basis.length)throw new Error("配载批次没有可分摊订单");
  if(!Number.isFinite(totalAmount)||totalAmount<=0)throw new Error("分摊总金额必须大于 0");
  if(!["weight","volume","equal"].includes(method))throw new Error("分摊方式无效");
  const values=basis.map(item=>method==="weight"?item.actualWeightKg:method==="volume"?item.actualVolumeCbm:1);
  if(values.some(value=>!Number.isFinite(value)||value<0))throw new Error("分摊依据必须为有效的非负数");
  const totalBasis=values.reduce((sum,value)=>sum+value,0);
  if(!Number.isFinite(totalBasis)||totalBasis<=0)throw new Error(method==="weight"?"没有可用的实收重量":"没有可用的实收体积");
  const totalCents=Math.round(totalAmount*100);
  if(!Number.isSafeInteger(totalCents)||totalCents<1)throw new Error("分摊总金额超出有效分币精度范围");
  let allocatedCents=0;
  return basis.map((item,index)=>{
    const ratio=values[index]/totalBasis;
    // Preserve existing rounding and last-line remainder, but never consume
    // more than the unallocated cents when many tiny lines round upwards.
    const remainingCents=totalCents-allocatedCents;
    const cents=index===basis.length-1?remainingCents:Math.min(remainingCents,Math.round(totalCents*ratio));
    allocatedCents+=cents;
    return{...item,ratio:Number(ratio.toFixed(8)),amount:cents/100};
  });
}
