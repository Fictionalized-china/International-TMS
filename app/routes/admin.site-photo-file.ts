import type { Route } from "./+types/admin.site-photo-file";
import {loadSitePhotoFile} from "../lib/order-site-photo-access.server";
export const loader=({request,params}:Route.LoaderArgs)=>loadSitePhotoFile(request,"admin",params.photoId);
