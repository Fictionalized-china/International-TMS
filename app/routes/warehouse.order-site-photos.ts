import type { Route } from "./+types/warehouse.order-site-photos";
import {loadSitePhotoPanel,uploadSitePhotoSupplement} from "../lib/order-site-photo-access.server";
export const loader=({request,params}:Route.LoaderArgs)=>loadSitePhotoPanel(request,"warehouse",params.orderId);
export const action=({request,params}:Route.ActionArgs)=>uploadSitePhotoSupplement(request,"warehouse",params.orderId);
