export type ChargeWeightMode="max_actual_volume"|"actual"|"volume"|"density";
export type PricingMode="first_additional"|"tier_unit"|"multi_additional"|"tier_first_additional"|"density_tier";

export type PricingProduct={
  chargeWeightMode:ChargeWeightMode;pricingMode:PricingMode;minWeight:number;maxWeight:number|null;volumeDivisor:number;roundingUnit:number;
  densityThreshold:number;densityLowMode:"actual"|"volume";densityHighMode:"actual"|"volume";
  firstWeight:number;firstPrice:number;additionalWeight:number;additionalPrice:number;minimumCharge:number;
  handlingFee:number;fuelSurchargeRate:number;cargoSurchargeRate:number;
};
export type PriceTier={from:number;to:number|null;billingUnit:"KG"|"CBM";unitSize:number|null;unitPrice:number|null;firstWeight:number|null;firstPrice:number|null;additionalWeight:number|null;additionalPrice:number|null};

export function calculateChargeableWeight(product:PricingProduct,actualWeight:number,volumeCbm:number){
  const volumeWeight=volumeCbm>0?(volumeCbm*1_000_000)/product.volumeDivisor:0;
  const density=volumeCbm>0?actualWeight/volumeCbm:null;
  let raw=actualWeight;
  if(product.chargeWeightMode==="volume")raw=volumeWeight;
  if(product.chargeWeightMode==="max_actual_volume")raw=Math.max(actualWeight,volumeWeight);
  if(product.chargeWeightMode==="density"){
    const mode=density!==null&&density<product.densityThreshold?product.densityLowMode:product.densityHighMode;
    raw=mode==="volume"?volumeWeight:actualWeight;
  }
  const withMinimum=Math.max(raw,product.minWeight),rounded=Math.ceil(withMinimum/product.roundingUnit)*product.roundingUnit;
  return{actualWeight,volumeCbm,volumeWeight:round(volumeWeight,3),density:density===null?null:round(density,3),chargeableWeight:round(rounded,3)};
}

export function calculatePrice(product:PricingProduct,tiers:PriceTier[],actualWeight:number,volumeCbm:number){
  if(actualWeight<=0||volumeCbm<0)return null;
  const weight=calculateChargeableWeight(product,actualWeight,volumeCbm);
  if(product.maxWeight!==null&&weight.chargeableWeight>product.maxWeight)return null;
  let base:number|null=null;
  if(product.pricingMode==="first_additional"){
    base=weight.chargeableWeight<=product.firstWeight?product.firstPrice:product.firstPrice+Math.ceil((weight.chargeableWeight-product.firstWeight)/product.additionalWeight)*product.additionalPrice;
  }else if(product.pricingMode==="density_tier"){
    if(weight.density===null)return null;
    const tier=matchTier(tiers,weight.density);
    if(!tier||tier.unitPrice===null)return null;
    base=(tier.billingUnit==="CBM"?volumeCbm:actualWeight)*tier.unitPrice;
  }else if(product.pricingMode==="tier_unit"){
    const tier=matchTier(tiers,weight.chargeableWeight);
    if(!tier||!tier.unitSize||tier.unitPrice===null)return null;
    base=Math.ceil(weight.chargeableWeight/tier.unitSize)*tier.unitPrice;
  }else if(product.pricingMode==="tier_first_additional"){
    const tier=matchTier(tiers,weight.chargeableWeight);
    if(!tier||!tier.firstWeight||tier.firstPrice===null||!tier.additionalWeight||tier.additionalPrice===null)return null;
    base=weight.chargeableWeight<=tier.firstWeight?tier.firstPrice:tier.firstPrice+Math.ceil((weight.chargeableWeight-tier.firstWeight)/tier.additionalWeight)*tier.additionalPrice;
  }else{
    let total=product.firstPrice,cursor=product.firstWeight;
    if(weight.chargeableWeight<=cursor)base=total;
    else for(const tier of [...tiers].sort((a,b)=>a.from-b.from)){
      const end=tier.to===null?weight.chargeableWeight:Math.min(weight.chargeableWeight,tier.to);
      const start=Math.max(cursor,tier.from);
      if(end<=start)continue;
      if(!tier.unitSize||tier.unitPrice===null)return null;
      total+=Math.ceil((end-start)/tier.unitSize)*tier.unitPrice;cursor=Math.max(cursor,end);
      if(cursor>=weight.chargeableWeight){base=total;break;}
    }
  }
  if(base===null)return null;
  base=Math.max(base,product.minimumCharge);
  const fuel=base*product.fuelSurchargeRate,cargo=base*product.cargoSurchargeRate,total=base+fuel+cargo+product.handlingFee;
  return{weight,baseFreight:round(base,2),fuelSurcharge:round(fuel,2),cargoSurcharge:round(cargo,2),handlingFee:product.handlingFee,total:round(total,2)};
}

function matchTier(tiers:PriceTier[],value:number){return [...tiers].sort((a,b)=>a.from-b.from).find(tier=>value>tier.from&&(tier.to===null||value<=tier.to));}
function round(value:number,digits:number){const factor=10**digits;return Math.round((value+Number.EPSILON)*factor)/factor;}
