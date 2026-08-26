-- Warehouse loading-document uploads are operational handoff files and do not
-- require the admin document-review workflow. Backfill historical uploads that
-- were created before the warehouse route started storing them as approved.
UPDATE order_document_metadata AS metadata
SET review_status = 'approved',
    reviewed_by_user_id = COALESCE(
      metadata.reviewed_by_user_id,
      (SELECT attachment.uploaded_by_user_id
       FROM order_attachments AS attachment
       WHERE attachment.id = metadata.attachment_id)
    ),
    reviewed_at = COALESCE(
      metadata.reviewed_at,
      (SELECT attachment.created_at
       FROM order_attachments AS attachment
       WHERE attachment.id = metadata.attachment_id),
      metadata.updated_at
    )
WHERE metadata.review_status = 'pending'
  AND metadata.document_category IN (
    'consignment_letter',
    'commercial_invoice',
    'packing_list',
    'customs_document',
    'customs_declaration_file'
  )
  AND EXISTS (
    SELECT 1
    FROM order_attachments AS attachment
    JOIN transport_batch_orders AS batch_order
      ON batch_order.order_id = metadata.order_id
     AND batch_order.organization_id = metadata.organization_id
     AND batch_order.status != 'removed'
    JOIN transport_batches AS batch
      ON batch.id = batch_order.batch_id
     AND batch.organization_id = batch_order.organization_id
     AND batch.batch_number LIKE 'PZ-%'
    WHERE attachment.id = metadata.attachment_id
      AND attachment.source = 'admin'
      AND substr(metadata.description, 1, length(batch.batch_number)) = batch.batch_number
  );
