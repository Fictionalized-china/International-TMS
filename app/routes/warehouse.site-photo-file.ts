import type { Route } from "./+types/warehouse.site-photo-file";
import {loadSitePhotoFile} from "../lib/order-site-photo-access.server";
export const loader=({request,params}:Route.LoaderArgs)=>loadSitePhotoFile(request,"warehouse",params.photoId);
