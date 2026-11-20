import type {Route} from "./+types/admin.order-intake-supplement";
import {requireSessionUser} from "../lib/auth.server";
import {activateOrderIntakeRule,correctOrderQuoteCommercial,loadOrderIntakeSupplement,saveOrderIntakeSupplement,supplementMissingOrderServices} from "../lib/order-intake-supplement.server";
import {requestOrderIntakeChange,reviewOrderIntakeChange} from "../lib/order-intake-changes.server";
export async function loader({request,params}:Route.LoaderArgs) {
  const current=await requireSessionUser(request,"order.view");
  try{return await loadOrderIntakeSupplement(current,params.orderId);}
  catch(error){return{loadError:error instanceof Error?error.message:"开单资料读取失败，请重试"};}
}
export async function action({request,params}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"order.view");
  try{const form=await request.formData();const handler=form.get("intent")==="request_intake_change"?requestOrderIntakeChange:form.get("intent")==="review_intake_change"?reviewOrderIntakeChange:form.get("intent")==="apply_intake_rule"?activateOrderIntakeRule:form.get("intent")==="correct_quote_commercial"?correctOrderQuoteCommercial:form.get("intent")==="supplement_missing_services"?supplementMissingOrderServices:saveOrderIntakeSupplement;return{...await handler(current,params.orderId,form),saveKey:crypto.randomUUID()};}
  catch(error){return{formError:error instanceof Error?error.message:"补录失败，请保留输入后重试"};}
}
