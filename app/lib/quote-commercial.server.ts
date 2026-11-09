import { listActiveOrganizationAssigneeCandidates } from "./organization-assignee.server";
import { policyPositions, type BusinessProcessPolicy } from "./business-process-policy";

export type QuoteCommercialOption = { id: string; display_name: string };

/** Use the shared active department/position/role rules, not customer ownership. */
export async function listQuoteCommercialOptions(organizationId: string, policy: BusinessProcessPolicy): Promise<QuoteCommercialOption[]> {
  const members = await listActiveOrganizationAssigneeCandidates({
    organizationId,
    positionCodes: policyPositions(policy, "order.quote_commercial_positions"),
  });
  return [...new Map(members.map(member => [member.id, {id: member.id, display_name: member.display_name}])).values()];
}

export async function resolveQuoteCommercial(input: {
  organizationId: string;
  userId: string;
  required: boolean;
  policy: BusinessProcessPolicy;
}) {
  const userId = input.userId.trim();
  if (!userId) {
    if (input.required) throw new Error("请选择实际报价商务，不能以业务员或录单人代替");
    return null;
  }
  const member = (await listQuoteCommercialOptions(input.organizationId, input.policy)).find(item => item.id === userId);
  if (!member) throw new Error("所选报价商务不属于当前组织的可用报价岗位，请重新选择");
  return member;
}
