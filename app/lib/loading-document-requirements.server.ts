import { env } from "cloudflare:workers";
import {
  resolveLoadingDocumentRequirements,
  type LoadingDocumentWorkflowField,
  type LoadingOrderDocumentModule,
  type OrderLoadingDocumentRequirements,
} from "./loading-document-requirements";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";

export async function loadOrderLoadingDocumentRequirements(
  organizationId: string,
  orderIds: readonly string[],
): Promise<OrderLoadingDocumentRequirements[]> {
  const uniqueOrderIds = [...new Set(orderIds.filter(Boolean))];
  if (!uniqueOrderIds.length) return [];

  const placeholders = uniqueOrderIds.map(() => "?").join(",");
  const customsRows = await env.DB.prepare(
    `SELECT o.id order_id,
       CASE WHEN EXISTS(
         SELECT 1 FROM order_module_instances mi
         WHERE mi.organization_id=o.organization_id AND mi.order_id=o.id
           AND mi.module_code='customs' AND mi.enabled=1
       ) THEN 1 ELSE 0 END customs_enabled
     FROM transport_orders o
     WHERE o.organization_id=? AND o.id IN (${placeholders})`,
  )
    .bind(organizationId, ...uniqueOrderIds)
    .all<{ order_id: string; customs_enabled: number }>();
  const customsEnabledByOrder = new Map(
    customsRows.results.map((row) => [row.order_id, row.customs_enabled === 1]),
  );

  const moduleCodes: readonly LoadingOrderDocumentModule[] = [
    "consignment",
    "customs",
  ];
  return Promise.all(
    uniqueOrderIds.map(async (orderId) => {
      const fieldGroups = await Promise.all(
        moduleCodes.map(async (moduleCode) => [
          moduleCode,
          await loadOrderModuleWorkflowFields(
            organizationId,
            orderId,
            moduleCode,
          ),
        ] as const),
      );
      return resolveLoadingDocumentRequirements({
        orderId,
        customsEnabled: customsEnabledByOrder.get(orderId) ?? false,
        fieldsByModule: Object.fromEntries(fieldGroups) as Partial<
          Record<
            LoadingOrderDocumentModule,
            readonly LoadingDocumentWorkflowField[]
          >
        >,
      });
    }),
  );
}
