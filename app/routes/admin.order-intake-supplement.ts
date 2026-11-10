import type {Route} from "./+types/admin.order-intake-supplement";
import {requireSessionUser} from "../lib/auth.server";
import {loadOrderIntakeSupplement,saveOrderIntakeSupplement} from "../lib/order-intake-supplement.server";
export async function loader({request,params}:Route.LoaderArgs) {
  const current=await requireSessionUser(request,"order.view");
  try{return await loadOrderIntakeSupplement(current,params.orderId);}
  catch(error){return{loadError:error instanceof Error?error.message:"开单资料读取失败，请重试"};}
}
export async function action({request,params}:Route.ActionArgs) {
  const current=await requireSessionUser(request,"order.view");
  try{return{...await saveOrderIntakeSupplement(current,params.orderId,await request.formData()),saveKey:crypto.randomUUID()};}
  catch(error){return{formError:error instanceof Error?error.message:"补录失败，请保留输入后重试"};}
}
