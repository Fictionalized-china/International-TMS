-- Safe repair for the two currently deployed built-in road workflows.
--
-- Candidate selection is deliberately fail-closed:
--   * exact definition identity only: active/published LTL tms-default-v3 v3
--     or canonical FTL tms-ftl-standard v1 (never LIKE/family-wide scanning);
--   * exactly the 16 known historical modules and 16 known factory tasks;
--   * every module property and every task property except task requiredness
--     must match the known historical baseline;
--   * one changed or extra module/task rejects the entire workflow.
--
-- Existing order instances keep their frozen snapshots. Task is_required is
-- intentionally preserved, as are definition validation status/messages.

WITH
old_modules(
  step_key,module_code,display_name,ltl_sort_order,ftl_sort_order,
  is_required,is_active,position_code,completion_mode
) AS (VALUES
  ('quotation','consignment','询价与报价',10,10,1,1,'SALES','all_tasks'),
  ('order_creation','consignment','委托信息',10,10,1,1,'OPERATION','all_tasks'),
  ('order_creation','cargo','货物信息',270,270,0,1,'OPERATION','all_tasks'),
  ('order_creation','costs','费用结算',1400,1400,0,0,'FINANCE_ACCOUNTING','all_tasks'),
  ('consignment_approval','consignment','委托信息',480,480,0,1,'OPERATION','all_tasks'),
  ('task_assignment','assignment','任务分配',10,10,1,1,'OPERATION_SUPERVISOR','all_tasks'),
  ('domestic_execution','transport','国内运输',10,10,1,1,'SALES','all_tasks'),
  ('warehouse_receiving','warehouse','仓库入库',640,640,0,1,'WAREHOUSE','all_tasks'),
  ('port_loading','loading','装车与出库',10,900,1,1,'LOADING','all_tasks'),
  ('outbound_transport','tracking','运输执行与跟踪',10,10,1,1,'TRACKING','all_tasks'),
  ('outbound_transport','documents','文件记录',910,910,0,0,'OPERATION','all_tasks'),
  ('outbound_transport','customs','报关作业',930,930,1,1,'DOC','all_tasks'),
  ('overseas_pickup','overseas_warehouse','境外仓自提',10,10,1,1,'OVERSEAS_WAREHOUSE','all_tasks'),
  ('reconciliation','costs','费用结算',10,10,1,1,'FINANCE_ACCOUNTING','all_tasks'),
  ('completion_review','review','订单复盘',10,10,0,1,'FINANCE_ACCOUNTING','all_tasks'),
  ('completion_review','exceptions','异常处理',1280,1280,0,1,'OPERATION','all_tasks')
),
new_modules(
  step_key,module_code,display_name,sort_order,is_required,is_active,
  position_code,completion_mode
) AS (VALUES
  ('quotation','consignment','询价与报价',10,1,1,'SALES','all_tasks'),
  ('order_creation','consignment','委托信息',10,1,1,'SALES','all_tasks'),
  ('order_creation','cargo','货物信息',20,0,1,'SALES','all_tasks'),
  ('order_creation','costs','预录费用',30,0,1,'FINANCE_ACCOUNTING','all_tasks'),
  ('consignment_approval','consignment','委托审核',10,1,1,'BUSINESS_SUPERVISOR','manual_confirm'),
  ('task_assignment','assignment','任务分配',10,1,1,'OPERATION_SUPERVISOR','all_tasks'),
  ('domestic_execution','transport','国内运输',10,1,1,'OPERATION','all_tasks'),
  ('warehouse_receiving','warehouse','国内仓入库',10,1,1,'WAREHOUSE','all_tasks'),
  ('port_loading','loading','装车与出库',10,1,1,'WAREHOUSE','all_tasks'),
  ('outbound_transport','documents','报关文件',10,0,1,'DOC','all_tasks'),
  ('outbound_transport','customs','报关作业',20,1,1,'DOC','all_tasks'),
  ('outbound_transport','tracking','出境运输与运踪',30,1,1,'OPERATION','all_tasks'),
  ('overseas_pickup','overseas_warehouse','境外仓与客户自提',10,1,1,'OVERSEAS_WAREHOUSE','all_tasks'),
  ('reconciliation','costs','三方费用结算',10,1,1,'CS','all_tasks'),
  ('completion_review','exceptions','异常处理',10,0,1,'OPERATION','all_tasks'),
  ('completion_review','review','订单复盘',20,1,1,'FINANCE_ACCOUNTING','manual_confirm')
),
old_tasks(
  step_key,module_code,task_key,name,task_type,sort_order,is_active,
  position_code,instructions
) AS (VALUES
  ('quotation','consignment','handle_quotation','填写询价并完成报价','system',10,1,'SALES','首次保存报价时锁定整车或拼车工作流版本；客户接受后完成本节点。'),
  ('order_creation','consignment','handle_consignment','办理委托信息','form',10,1,'OPERATION',NULL),
  ('order_creation','cargo','handle_cargo','办理货物信息','form',10,1,'OPERATION',NULL),
  ('order_creation','costs','handle_costs','办理费用结算','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('consignment_approval','consignment','handle_consignment','办理委托信息','form',10,1,'OPERATION',NULL),
  ('task_assignment','assignment','handle_assignment','办理任务分配','form',10,1,'OPERATION_SUPERVISOR',NULL),
  ('domestic_execution','transport','handle_transport','办理国内运输','form',10,1,'SALES',NULL),
  ('warehouse_receiving','warehouse','handle_warehouse','办理仓库入库','form',10,1,'WAREHOUSE',NULL),
  ('port_loading','loading','handle_loading','办理装车与出库','form',10,1,'LOADING',NULL),
  ('outbound_transport','tracking','handle_tracking','办理运输执行与跟踪','form',10,1,'TRACKING',NULL),
  ('outbound_transport','documents','handle_documents','办理文件记录','form',10,1,'OPERATION',NULL),
  ('outbound_transport','customs','handle_customs','办理报关作业','form',10,1,'DOC',NULL),
  ('overseas_pickup','overseas_warehouse','handle_overseas_warehouse','办理境外仓自提','form',10,1,'OVERSEAS_WAREHOUSE',NULL),
  ('reconciliation','costs','handle_costs','办理费用结算','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('completion_review','review','handle_review','办理订单复盘','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('completion_review','exceptions','handle_exceptions','办理异常处理','form',10,1,'OPERATION',NULL)
),
candidate_workflows(id) AS (
  SELECT definition.id
  FROM workflow_definitions definition
  WHERE definition.status='active'
    AND definition.lifecycle_status='published'
    AND definition.based_on_workflow_id IS NULL
    AND (
      (
        definition.code='tms-default-v3'
        AND definition.version_number=3
        AND definition.road_load_type='ltl'
        AND definition.name='拼车型汽运订单标准流程'
        AND definition.template_family_id=definition.organization_id || ':tms-default'
      )
      OR
      (
        definition.code='tms-ftl-standard'
        AND definition.version_number=1
        AND definition.road_load_type='ftl'
        AND definition.name='整车型汽运订单标准流程'
        AND definition.id=definition.organization_id || ':tms-ftl-standard'
        AND definition.template_family_id=definition.id
      )
    )
    AND 16=(
      SELECT COUNT(*) FROM workflow_step_modules module
      WHERE module.workflow_id=definition.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_step_modules module
      JOIN workflow_steps step
        ON step.id=module.step_id AND step.workflow_id=module.workflow_id
      LEFT JOIN old_modules expected
        ON expected.step_key=step.step_key
       AND expected.module_code=module.module_code
       AND expected.display_name=module.display_name
       AND module.sort_order=CASE definition.code
             WHEN 'tms-default-v3' THEN expected.ltl_sort_order
             ELSE expected.ftl_sort_order
           END
       AND expected.is_required=module.is_required
       AND expected.is_active=module.is_active
       AND expected.position_code=module.responsibility_position_code
       AND expected.completion_mode=module.completion_mode
      WHERE module.workflow_id=definition.id
        AND expected.step_key IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM old_modules expected
      WHERE 1<>(
        SELECT COUNT(*)
        FROM workflow_step_modules module
        JOIN workflow_steps step
          ON step.id=module.step_id AND step.workflow_id=module.workflow_id
        WHERE module.workflow_id=definition.id
          AND expected.step_key=step.step_key
          AND expected.module_code=module.module_code
          AND expected.display_name=module.display_name
          AND module.sort_order=CASE definition.code
                WHEN 'tms-default-v3' THEN expected.ltl_sort_order
                ELSE expected.ftl_sort_order
              END
          AND expected.is_required=module.is_required
          AND expected.is_active=module.is_active
          AND expected.position_code=module.responsibility_position_code
          AND expected.completion_mode=module.completion_mode
      )
    )
    AND 16=(
      SELECT COUNT(*) FROM workflow_module_tasks task
      WHERE task.workflow_id=definition.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_module_tasks task
      JOIN workflow_step_modules module
        ON module.id=task.step_module_id AND module.workflow_id=task.workflow_id
      JOIN workflow_steps step
        ON step.id=module.step_id AND step.workflow_id=module.workflow_id
      LEFT JOIN old_tasks expected
        ON expected.step_key=step.step_key
       AND expected.module_code=module.module_code
       AND expected.task_key=task.task_key
       AND expected.name=task.name
       AND expected.task_type=task.task_type
       AND expected.sort_order=task.sort_order
       AND expected.is_active=task.is_active
       AND expected.position_code=task.responsibility_position_code
       AND COALESCE(expected.instructions,'')=COALESCE(task.instructions,'')
      WHERE task.workflow_id=definition.id
        AND expected.step_key IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM old_tasks expected
      WHERE 1<>(
        SELECT COUNT(*)
        FROM workflow_module_tasks task
        JOIN workflow_step_modules module
          ON module.id=task.step_module_id AND module.workflow_id=task.workflow_id
        JOIN workflow_steps step
          ON step.id=module.step_id AND step.workflow_id=module.workflow_id
        WHERE task.workflow_id=definition.id
          AND expected.step_key=step.step_key
          AND expected.module_code=module.module_code
          AND expected.task_key=task.task_key
          AND expected.name=task.name
          AND expected.task_type=task.task_type
          AND expected.sort_order=task.sort_order
          AND expected.is_active=task.is_active
          AND expected.position_code=task.responsibility_position_code
          AND COALESCE(expected.instructions,'')=COALESCE(task.instructions,'')
      )
    )
)
UPDATE workflow_step_modules
SET display_name=(
      SELECT expected.display_name
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    sort_order=(
      SELECT expected.sort_order
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    is_required=(
      SELECT expected.is_required
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    is_active=(
      SELECT expected.is_active
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    responsibility_position_code=(
      SELECT expected.position_code
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    completion_mode=(
      SELECT expected.completion_mode
      FROM workflow_steps step
      JOIN new_modules expected ON expected.step_key=step.step_key
      WHERE step.id=workflow_step_modules.step_id
        AND step.workflow_id=workflow_step_modules.workflow_id
        AND expected.module_code=workflow_step_modules.module_code
    ),
    updated_at=CURRENT_TIMESTAMP
WHERE workflow_id IN (SELECT id FROM candidate_workflows);

-- The module update runs first. The task candidate therefore requires the
-- complete new module fingerprint plus the complete old task fingerprint.
-- This also makes a retry safe if execution stopped between the two updates.
WITH
new_modules(
  step_key,module_code,display_name,sort_order,is_required,is_active,
  position_code,completion_mode
) AS (VALUES
  ('quotation','consignment','询价与报价',10,1,1,'SALES','all_tasks'),
  ('order_creation','consignment','委托信息',10,1,1,'SALES','all_tasks'),
  ('order_creation','cargo','货物信息',20,0,1,'SALES','all_tasks'),
  ('order_creation','costs','预录费用',30,0,1,'FINANCE_ACCOUNTING','all_tasks'),
  ('consignment_approval','consignment','委托审核',10,1,1,'BUSINESS_SUPERVISOR','manual_confirm'),
  ('task_assignment','assignment','任务分配',10,1,1,'OPERATION_SUPERVISOR','all_tasks'),
  ('domestic_execution','transport','国内运输',10,1,1,'OPERATION','all_tasks'),
  ('warehouse_receiving','warehouse','国内仓入库',10,1,1,'WAREHOUSE','all_tasks'),
  ('port_loading','loading','装车与出库',10,1,1,'WAREHOUSE','all_tasks'),
  ('outbound_transport','documents','报关文件',10,0,1,'DOC','all_tasks'),
  ('outbound_transport','customs','报关作业',20,1,1,'DOC','all_tasks'),
  ('outbound_transport','tracking','出境运输与运踪',30,1,1,'OPERATION','all_tasks'),
  ('overseas_pickup','overseas_warehouse','境外仓与客户自提',10,1,1,'OVERSEAS_WAREHOUSE','all_tasks'),
  ('reconciliation','costs','三方费用结算',10,1,1,'CS','all_tasks'),
  ('completion_review','exceptions','异常处理',10,0,1,'OPERATION','all_tasks'),
  ('completion_review','review','订单复盘',20,1,1,'FINANCE_ACCOUNTING','manual_confirm')
),
old_tasks(
  step_key,module_code,task_key,name,task_type,sort_order,is_active,
  position_code,instructions
) AS (VALUES
  ('quotation','consignment','handle_quotation','填写询价并完成报价','system',10,1,'SALES','首次保存报价时锁定整车或拼车工作流版本；客户接受后完成本节点。'),
  ('order_creation','consignment','handle_consignment','办理委托信息','form',10,1,'OPERATION',NULL),
  ('order_creation','cargo','handle_cargo','办理货物信息','form',10,1,'OPERATION',NULL),
  ('order_creation','costs','handle_costs','办理费用结算','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('consignment_approval','consignment','handle_consignment','办理委托信息','form',10,1,'OPERATION',NULL),
  ('task_assignment','assignment','handle_assignment','办理任务分配','form',10,1,'OPERATION_SUPERVISOR',NULL),
  ('domestic_execution','transport','handle_transport','办理国内运输','form',10,1,'SALES',NULL),
  ('warehouse_receiving','warehouse','handle_warehouse','办理仓库入库','form',10,1,'WAREHOUSE',NULL),
  ('port_loading','loading','handle_loading','办理装车与出库','form',10,1,'LOADING',NULL),
  ('outbound_transport','tracking','handle_tracking','办理运输执行与跟踪','form',10,1,'TRACKING',NULL),
  ('outbound_transport','documents','handle_documents','办理文件记录','form',10,1,'OPERATION',NULL),
  ('outbound_transport','customs','handle_customs','办理报关作业','form',10,1,'DOC',NULL),
  ('overseas_pickup','overseas_warehouse','handle_overseas_warehouse','办理境外仓自提','form',10,1,'OVERSEAS_WAREHOUSE',NULL),
  ('reconciliation','costs','handle_costs','办理费用结算','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('completion_review','review','handle_review','办理订单复盘','form',10,1,'FINANCE_ACCOUNTING',NULL),
  ('completion_review','exceptions','handle_exceptions','办理异常处理','form',10,1,'OPERATION',NULL)
),
candidate_workflows(id) AS (
  SELECT definition.id
  FROM workflow_definitions definition
  WHERE definition.status='active'
    AND definition.lifecycle_status='published'
    AND definition.based_on_workflow_id IS NULL
    AND (
      (
        definition.code='tms-default-v3'
        AND definition.version_number=3
        AND definition.road_load_type='ltl'
        AND definition.name='拼车型汽运订单标准流程'
        AND definition.template_family_id=definition.organization_id || ':tms-default'
      )
      OR
      (
        definition.code='tms-ftl-standard'
        AND definition.version_number=1
        AND definition.road_load_type='ftl'
        AND definition.name='整车型汽运订单标准流程'
        AND definition.id=definition.organization_id || ':tms-ftl-standard'
        AND definition.template_family_id=definition.id
      )
    )
    AND 16=(
      SELECT COUNT(*) FROM workflow_step_modules module
      WHERE module.workflow_id=definition.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_step_modules module
      JOIN workflow_steps step
        ON step.id=module.step_id AND step.workflow_id=module.workflow_id
      LEFT JOIN new_modules expected
        ON expected.step_key=step.step_key
       AND expected.module_code=module.module_code
       AND expected.display_name=module.display_name
       AND expected.sort_order=module.sort_order
       AND expected.is_required=module.is_required
       AND expected.is_active=module.is_active
       AND expected.position_code=module.responsibility_position_code
       AND expected.completion_mode=module.completion_mode
      WHERE module.workflow_id=definition.id
        AND expected.step_key IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM new_modules expected
      WHERE 1<>(
        SELECT COUNT(*)
        FROM workflow_step_modules module
        JOIN workflow_steps step
          ON step.id=module.step_id AND step.workflow_id=module.workflow_id
        WHERE module.workflow_id=definition.id
          AND expected.step_key=step.step_key
          AND expected.module_code=module.module_code
          AND expected.display_name=module.display_name
          AND expected.sort_order=module.sort_order
          AND expected.is_required=module.is_required
          AND expected.is_active=module.is_active
          AND expected.position_code=module.responsibility_position_code
          AND expected.completion_mode=module.completion_mode
      )
    )
    AND 16=(
      SELECT COUNT(*) FROM workflow_module_tasks task
      WHERE task.workflow_id=definition.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_module_tasks task
      JOIN workflow_step_modules module
        ON module.id=task.step_module_id AND module.workflow_id=task.workflow_id
      JOIN workflow_steps step
        ON step.id=module.step_id AND step.workflow_id=module.workflow_id
      LEFT JOIN old_tasks expected
        ON expected.step_key=step.step_key
       AND expected.module_code=module.module_code
       AND expected.task_key=task.task_key
       AND expected.name=task.name
       AND expected.task_type=task.task_type
       AND expected.sort_order=task.sort_order
       AND expected.is_active=task.is_active
       AND expected.position_code=task.responsibility_position_code
       AND COALESCE(expected.instructions,'')=COALESCE(task.instructions,'')
      WHERE task.workflow_id=definition.id
        AND expected.step_key IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM old_tasks expected
      WHERE 1<>(
        SELECT COUNT(*)
        FROM workflow_module_tasks task
        JOIN workflow_step_modules module
          ON module.id=task.step_module_id AND module.workflow_id=task.workflow_id
        JOIN workflow_steps step
          ON step.id=module.step_id AND step.workflow_id=module.workflow_id
        WHERE task.workflow_id=definition.id
          AND expected.step_key=step.step_key
          AND expected.module_code=module.module_code
          AND expected.task_key=task.task_key
          AND expected.name=task.name
          AND expected.task_type=task.task_type
          AND expected.sort_order=task.sort_order
          AND expected.is_active=task.is_active
          AND expected.position_code=task.responsibility_position_code
          AND COALESCE(expected.instructions,'')=COALESCE(task.instructions,'')
      )
    )
)
UPDATE workflow_module_tasks
SET responsibility_position_code=(
      SELECT expected.position_code
      FROM workflow_step_modules module
      JOIN workflow_steps step
        ON step.id=module.step_id AND step.workflow_id=module.workflow_id
      JOIN new_modules expected
        ON expected.step_key=step.step_key AND expected.module_code=module.module_code
      WHERE module.id=workflow_module_tasks.step_module_id
        AND module.workflow_id=workflow_module_tasks.workflow_id
    ),
    updated_at=CURRENT_TIMESTAMP
WHERE workflow_id IN (SELECT id FROM candidate_workflows);

-- validation_status and validation_message remain untouched. Only the normal
-- publication validator may declare a workflow valid.
