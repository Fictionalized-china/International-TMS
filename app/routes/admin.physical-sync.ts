import {physicalSyncAccess} from "../lib/physical-operation-sync-access.server";
import type {Route} from "./+types/admin.physical-sync";
export const loader=({request,params}:Route.LoaderArgs)=>physicalSyncAccess(request,"admin",params.orderId);
export const action=({request,params}:Route.ActionArgs)=>physicalSyncAccess(request,"admin",params.orderId,true);
