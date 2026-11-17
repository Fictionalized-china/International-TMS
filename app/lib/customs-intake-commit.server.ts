import { intakeGateCommitStatements, prepareOrderIntakeAdvance } from "./order-intake-gate.server";

/** Drafts, corrections and deletions stay reachable. Actual declaration/release
 * consumes the same red-field contract as every other forward action. */
export async function customsIntakeCommitStatements(db:D1Database,organizationId:string,orderId:string,status:string,isDeleted:boolean,now:string){
  if(isDeleted||!["declared","inspecting","released"].includes(status))return[];
  return intakeGateCommitStatements(await prepareOrderIntakeAdvance(organizationId,orderId,db),now,db);
}
