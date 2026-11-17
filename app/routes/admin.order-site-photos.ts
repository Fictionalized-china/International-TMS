import type { Route } from "./+types/admin.order-site-photos";
import {loadSitePhotoPanel,uploadSitePhotoSupplement} from "../lib/order-site-photo-access.server";
export const loader=({request,params}:Route.LoaderArgs)=>loadSitePhotoPanel(request,"admin",params.orderId);
export const action=({request,params}:Route.ActionArgs)=>uploadSitePhotoSupplement(request,"admin",params.orderId);
