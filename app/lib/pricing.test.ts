import{describe,expect,it}from"vitest";
import{calculatePrice,type PricingProduct,type PriceTier}from"./pricing";
const product:PricingProduct={chargeWeightMode:"density",pricingMode:"density_tier",minWeight:0,maxWeight:null,volumeDivisor:5000,roundingUnit:.5,densityThreshold:250,densityLowMode:"volume",densityHighMode:"actual",firstWeight:1,firstPrice:0,additionalWeight:.5,additionalPrice:0,minimumCharge:0,handlingFee:0,fuelSurchargeRate:0,cargoSurchargeRate:0};
const tiers:PriceTier[]=[{from:100,to:150,billingUnit:"CBM",unitSize:1,unitPrice:61,firstWeight:null,firstPrice:null,additionalWeight:null,additionalPrice:null},{from:300,to:350,billingUnit:"KG",unitSize:1,unitPrice:.29,firstWeight:null,firstPrice:null,additionalWeight:null,additionalPrice:null}];
describe("logistics pricing",()=>{
  it("charges light cargo by CBM",()=>{const result=calculatePrice(product,tiers,1200,10);expect(result?.weight.density).toBe(120);expect(result?.baseFreight).toBe(610)});
  it("charges heavy cargo by KG",()=>{const result=calculatePrice(product,tiers,3200,10);expect(result?.weight.density).toBe(320);expect(result?.baseFreight).toBe(928)});
});
