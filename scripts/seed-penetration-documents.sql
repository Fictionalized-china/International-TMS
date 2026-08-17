-- Native file pickers are outside the in-app browser automation surface.
-- Seed pending test evidence only; approval is still performed through the UI.
INSERT OR IGNORE INTO order_attachments
  (id, organization_id, order_id, customer_id, file_name, content_type, size_bytes, data_url, uploaded_by_user_id, source, created_at)
SELECT
  o.id || '-pen-' || d.code,
  o.organization_id,
  o.id,
  o.customer_id,
  'PEN-' || o.order_number || '-' || d.code || '.pdf',
  'application/pdf',
  47,
  'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0Y=',
  '9793c075-b7a6-45d2-9ba9-84221d069c06',
  'admin',
  '2026-08-13T20:05:00.000Z'
FROM transport_orders o
CROSS JOIN (
  SELECT 'consignment_letter' code UNION ALL
  SELECT 'contract' UNION ALL
  SELECT 'commercial_invoice' UNION ALL
  SELECT 'packing_list' UNION ALL
  SELECT 'customs_document'
) d
WHERE o.id IN (
  'ff1cb1ca-4615-43d6-9d76-10d1ae7cd7d1',
  'c34f7b33-ef3f-49a5-b82a-95237a48c721',
  '6c59f03b-5c8a-4a69-9db7-e0855303b623'
);

INSERT OR IGNORE INTO order_document_metadata
  (attachment_id, organization_id, order_id, document_category, description, public_to_customer, review_status, updated_at)
SELECT
  a.id,
  a.organization_id,
  a.order_id,
  substr(a.id, instr(a.id, '-pen-') + 5),
  '旧系统订单数据穿透测试凭证',
  0,
  'pending',
  '2026-08-13T20:05:00.000Z'
FROM order_attachments a
WHERE a.id LIKE '%-pen-%'
  AND a.order_id IN (
    'ff1cb1ca-4615-43d6-9d76-10d1ae7cd7d1',
    'c34f7b33-ef3f-49a5-b82a-95237a48c721',
    '6c59f03b-5c8a-4a69-9db7-e0855303b623'
  );
