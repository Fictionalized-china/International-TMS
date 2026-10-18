import { describe, expect, it } from "vitest";
import { calculatePrice, calculateChargeableWeight, type PricingProduct, type PriceTier } from "./pricing";
import { storedDataUrlResponse } from "./stored-file-response.server";
import { deriveTrackingCenterState } from "./tracking-center";
import { normalizeBusinessPlanTime, storedBusinessTimestamp } from "./business-time";

const product: PricingProduct = { chargeWeightMode:"actual",pricingMode:"tier_unit",minWeight:0,maxWeight:null,volumeDivisor:5000,roundingUnit:0.01,densityThreshold:250,densityLowMode:"volume",densityHighMode:"actual",firstWeight:1,firstPrice:10,additionalWeight:1,additionalPrice:2,minimumCharge:0,handlingFee:0,fuelSurchargeRate:0,cargoSurchargeRate:0 };
const tier: PriceTier = { from:0,to:null,billingUnit:"KG",unitSize:1,unitPrice:10,firstWeight:null,firstPrice:null,additionalWeight:null,additionalPrice:null };
describe("cloud stability regressions", () => {
  it("does not round exact decimal steps into another billing unit", () => {
    expect(calculateChargeableWeight(product, 0.07, 0).chargeableWeight).toBe(0.07);
    expect(calculateChargeableWeight(product, 0.071, 0).chargeableWeight).toBe(0.08);
  });
  it("uses CBM for CBM tier charges", () => {
    expect(calculatePrice(product, [{...tier,billingUnit:"CBM"}], 100, 2)?.total).toBe(20);
  });
  it("rejects uncovered multi-additional intervals", () => {
    expect(calculatePrice({...product,pricingMode:"multi_additional"}, [{...tier,from:5}], 6, 0)).toBeNull();
  });
  it("rejects non-finite inputs and zero continuation units", () => {
    expect(calculatePrice(product, [tier], NaN, 1)).toBeNull();
    expect(calculatePrice({...product,pricingMode:"first_additional",additionalWeight:0}, [], 2, 0)).toBeNull();
  });
  it("reads URL-encoded generated manifests, including Unicode", async () => {
    const html = "<html><body>配载单</body></html>";
    const response = storedDataUrlResponse({dataUrl:`data:text/html;charset=utf-8,${encodeURIComponent(html)}`,fileName:"配载单.html",contentType:"text/html",disposition:"inline"});
    expect(await response.text()).toBe(html);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  });
  it("keeps uploaded base64 data readable and rejects malformed data", async () => {
    expect(await storedDataUrlResponse({dataUrl:"data:application/pdf;base64,QUJD",fileName:"a.pdf"}).text()).toBe("ABC");
    expect(() => storedDataUrlResponse({dataUrl:"data:text/html;charset=utf-8,%XX",fileName:"a.html"})).toThrow();
  });
  it("interprets legacy datetime-local plans as Beijing business time", () => {
    expect(storedBusinessTimestamp("2026-10-17T12:00")).toBe(Date.parse("2026-10-17T04:00:00Z"));
    expect(storedBusinessTimestamp("2026-10-17 04:00:00")).toBe(Date.parse("2026-10-17T04:00:00Z"));
    expect(normalizeBusinessPlanTime("2026-10-17T12:00")).toBe("2026-10-17T04:00:00.000Z");
    expect(()=>normalizeBusinessPlanTime("2026-02-30T12:00")).toThrow();
    const source={orderStatus:"in_execution",isOverdue:false,exceptionStatus:"normal",assignmentId:"a",batchId:null,batchRoadStatus:null,plannedArrivalAt:"2026-10-17T12:00",actualArrivalAt:null,latestEventAt:null};
    expect(deriveTrackingCenterState(source,new Date("2026-10-17T08:00:00Z")).warning.code).toBe("overdue");
  });
});
