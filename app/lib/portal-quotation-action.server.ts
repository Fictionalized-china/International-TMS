import { env } from "cloudflare:workers";
import { acceptQuotation, withdrawQuotationAcceptance } from "./quotation-lifecycle.server";
import { valueOf } from "./validation";

type PortalQuotationActor = {
  organizationId: string;
  userId: string;
};

type PortalQuotationCustomer = {
  id: string;
};

export async function handlePortalQuotationAction(input: {
  request: Request;
  user: PortalQuotationActor;
  customer: PortalQuotationCustomer;
}) {
  const form = await input.request.formData();
  const intent = valueOf(form, "intent");
  const quotationId = valueOf(form, "id");
  if (!quotationId) return { formError: "缺少报价记录" };

  const owned = await env.DB.prepare(
    "SELECT id FROM quotations WHERE id=? AND organization_id=? AND customer_id=? LIMIT 1",
  ).bind(quotationId, input.user.organizationId, input.customer.id).first<{ id: string }>();
  if (!owned) return { formError: "报价不存在或不属于当前客户" };

  try {
    if (intent === "accept_quote" || intent === "accept") {
      const result = await acceptQuotation({
        organizationId: input.user.organizationId,
        quotationId,
        actorUserId: input.user.userId,
        source: "portal",
        request: input.request,
      });
      return {
        success: `报价已确认，系统已${result.created ? "自动创建" : "恢复"}订单 ${result.orderNumber}，入仓唛头已生成`,
      };
    }
    if (intent === "withdraw_quote" || intent === "withdraw") {
      const result = await withdrawQuotationAcceptance({
        organizationId: input.user.organizationId,
        quotationId,
        actorUserId: input.user.userId,
        source: "portal",
      });
      return { success: `报价接受已撤回，订单 ${result.orderNumber || ""} 已保留` };
    }
    return { formError: "不支持的报价操作" };
  } catch (error) {
    return { formError: error instanceof Error ? error.message : String(error) };
  }
}
