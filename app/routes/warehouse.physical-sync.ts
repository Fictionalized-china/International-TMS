import {physicalSyncAccess} from "../lib/physical-operation-sync-access.server";
import type {Route} from "./+types/warehouse.physical-sync";
export const loader=({request,params}:Route.LoaderArgs)=>physicalSyncAccess(request,"warehouse",params.orderId);
export const action=({request,params}:Route.ActionArgs)=>physicalSyncAccess(request,"warehouse",params.orderId,true);
