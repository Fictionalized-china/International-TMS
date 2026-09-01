import type { OrderModuleCode } from "./order-modules";

export type WorkflowFieldMode = "required" | "optional" | "hidden";
export type WorkflowFieldRequirementSource = "legacy_required" | "new_system";

export type WorkflowFieldCatalogItem = {
  fieldKey: string;
  label: string;
  fieldType: string;
  stepKey: string;
  moduleCode: OrderModuleCode;
  defaultMode: WorkflowFieldMode;
  requirementSource: WorkflowFieldRequirementSource;
  helpText: string;
  optionsText?: string;
};

// This baseline contains fields confirmed as mandatory in the legacy forms or
// explicitly approved as operational hard gates. Other new-system workflow,
// portal and control fields stay visible but optional.
export const legacyRequiredWorkflowFieldKeys: ReadonlySet<string> = new Set([
  "document_consignment_letter",
  "primary_operator",
  "domestic_carrier_id",
  "domestic_planned_departure_at",
  "main_carrier_id",
  "main_vehicle_type",
  "planned_exit_at",
  "declaration_stage",
  "declaration_status",
  "declaration_number",
  "declaration_type",
  "declaration_title",
  "declaring_company",
  "declared_at",
  "declared_amount",
  "declaration_currency",
  "declaration_gross_weight",
  "actual_departure_at",
  "actual_exit_at",
  "tracking_milestone",
  "tracking_event_at",
  "tracking_location",
  "overseas_arrival_at",
  "overseas_pickup_contact",
  "pickup_completed_at",
  "domestic_freight_amount",
  "domestic_freight_currency",
  "domestic_payable_charge_name",
  "domestic_payable_quantity",
  "domestic_payable_exchange_rate",
  "receivable_expenses",
  "payable_expenses",
  "expense_currency",
  "expense_exchange_rate",
  "expense_direction",
  "expense_charge_name",
  "expense_counterparty",
  "expense_quantity",
  "expense_unit_price",
  "document_commercial_invoice",
  "document_packing_list",
  "document_customs_document",
  "document_customs_declaration_file",
  "document_delivery_receipt",
]);

const field = (
  stepKey: string,
  moduleCode: OrderModuleCode,
  fieldKey: string,
  label: string,
  fieldType: string,
  defaultMode: WorkflowFieldMode,
  helpText: string,
  optionsText?: string,
): WorkflowFieldCatalogItem => ({
  stepKey,
  moduleCode,
  fieldKey,
  label,
  fieldType,
  defaultMode: stepKey === "order_creation"
    ? fieldKey === "document_consignment_letter" ? "required" : "hidden"
    : legacyRequiredWorkflowFieldKeys.has(fieldKey)
      ? "required"
      : defaultMode === "hidden"
        ? "hidden"
        : "optional",
  requirementSource: legacyRequiredWorkflowFieldKeys.has(fieldKey)
    ? "legacy_required"
    : "new_system",
  helpText,
  optionsText,
});

// These are business facts, not another storage model. Built-in fields read
// from their owning order/module tables; only user-created custom fields use
// the generic workflow value table.
export const workflowFieldCatalog: WorkflowFieldCatalogItem[] = [
  field("order_creation", "consignment", "customer_id", "委托客户", "customer", "required", "本订单的委托客户。"),
  field("order_creation", "consignment", "quotation_id", "已接受报价", "select", "optional", "有正式报价时关联，未报价订单可以不填。"),
  field("order_creation", "consignment", "order_date", "接单日期", "date", "required", "业务正式接单日期。"),
  field("order_creation", "consignment", "business_nature", "业务性质", "select", "optional", "出口、进口、过境或国内业务。", "export|出口\nimport|进口\ntransit|过境\ndomestic|国内"),
  field("order_creation", "consignment", "shipper_customer_id", "发货人", "customer", "required", "从客户管理中选择发货人。"),
  field("order_creation", "consignment", "pickup_address_id", "常用提货地", "select", "hidden", "报价阶段已确定提货地址，订单审批不重复填写。"),
  field("order_creation", "consignment", "shipper_contact", "提货联系人", "text", "required", "客户工厂或提货地点联系人。"),
  field("order_creation", "consignment", "shipper_phone", "提货联系电话", "text", "required", "提货现场联系电话。"),
  field("order_creation", "consignment", "origin_country", "起运国家/地区", "select", "required", "国内提货起点所属国家或地区。"),
  field("order_creation", "consignment", "origin_state", "起运省/州", "select", "required", "国内提货起点所属省或州。"),
  field("order_creation", "consignment", "origin_city", "起运城市", "select", "required", "国内提货起点城市。"),
  field("order_creation", "consignment", "origin_address", "提货地址", "textarea", "hidden", "报价阶段保存为运输数据，订单审批不重复显示。"),
  field("order_creation", "consignment", "consignee_name", "收货人", "text", "required", "境外收货人。"),
  field("order_creation", "consignment", "consignee_contact", "收货联系人", "text", "optional", "境外收货联系人。"),
  field("order_creation", "consignment", "consignee_phone", "收货联系电话", "text", "optional", "境外收货联系电话。"),
  field("order_creation", "consignment", "destination_country", "目的国家/地区", "select", "required", "最终目的国家或地区。"),
  field("order_creation", "consignment", "destination_state", "目的省/州", "select", "required", "最终目的省或州。"),
  field("order_creation", "consignment", "destination_city", "目的城市", "select", "required", "最终目的城市。"),
  field("order_creation", "consignment", "destination_address", "送货地址", "textarea", "hidden", "系统按境外目的仓地址自动生成。"),
  field("order_creation", "consignment", "overseas_warehouse_id", "境外目的仓", "warehouse", "required", "只能选择启用且角色为境外目的仓的仓库。"),
  field("order_creation", "consignment", "overseas_warehouse_address_note", "境外目的仓地址备注", "textarea", "optional", "门牌、联系人、提货窗口等订单专属说明。"),
  field("order_creation", "consignment", "requested_pickup_date", "预约提货时间", "datetime", "required", "客户和业务员约定的提货时间。"),
  field("order_creation", "consignment", "cargo_ready_at", "货好时间", "datetime", "optional", "操作员判断货物是否可提的参考时间，不作为默认审批门禁。"),
  field("order_creation", "consignment", "requested_delivery_date", "要求送达日", "date", "optional", "客户要求的送达日期。"),
  field("order_creation", "consignment", "ro_agent", "RO代理", "text", "optional", "旧系统使用的RO代理信息。"),
  field("order_creation", "consignment", "special_instructions", "备注", "textarea", "optional", "订单级补充说明。"),

  field("order_creation", "cargo", "cargo_name_cn", "中文品名", "text", "required", "每条货物明细的中文品名。"),
  field("order_creation", "cargo", "cargo_name_en", "英文品名", "text", "optional", "每条货物明细的英文品名。"),
  field("order_creation", "cargo", "hs_code", "国内HS Code", "text", "optional", "国内申报使用的HS编码。"),
  field("order_creation", "cargo", "overseas_hs_code", "境外HS Code", "text", "optional", "目的国申报使用的HS编码。"),
  field("order_creation", "cargo", "package_type", "包装类型", "select", "required", "箱、托盘、木箱、袋装或其他包装。", "carton|纸箱\npallet|托盘\nwooden_case|木箱\nbag|袋装\nother|其他"),
  field("order_creation", "cargo", "package_count", "包装数", "number", "required", "相同规格包装的数量。"),
  field("order_creation", "cargo", "pieces_per_package", "每包装件数", "number", "required", "一个包装内包含的货物件数。"),
  field("order_creation", "cargo", "gross_weight_per_package_kg", "单包装毛重KG", "number", "required", "单个包装的毛重。"),
  field("order_creation", "cargo", "net_weight_per_package_kg", "单包装净重KG", "number", "optional", "单个包装的净重。"),
  field("order_creation", "cargo", "length_cm", "长度CM", "number", "optional", "单包装外尺寸长度。"),
  field("order_creation", "cargo", "width_cm", "宽度CM", "number", "optional", "单包装外尺寸宽度。"),
  field("order_creation", "cargo", "height_cm", "高度CM", "number", "optional", "单包装外尺寸高度。"),
  field("order_creation", "cargo", "volume_per_package_cbm", "单包装体积CBM", "number", "required", "可手工填写，也可由长宽高自动计算。"),
  field("order_creation", "cargo", "declared_value", "申报货值", "amount", "optional", "货物申报价值。"),
  field("order_creation", "cargo", "currency", "货值币种", "select", "optional", "申报货值币种。", "CNY\nUSD\nKZT\nUZS\nRUB"),
  field("order_creation", "cargo", "origin_country_cargo", "货物原产国", "select", "optional", "货物原产国家或地区。"),
  field("order_creation", "cargo", "brand_model", "品牌/型号", "text", "optional", "品牌、规格或型号。"),
  field("order_creation", "cargo", "marks", "唛头", "text", "optional", "包装唛头或识别标记。"),
  field("order_creation", "cargo", "special_attributes", "货物属性", "multiselect", "optional", "易碎、危险品、温控等属性。"),
  field("order_creation", "cargo", "cargo_images", "货物图片", "attachment", "optional", "货物或包装图片。"),
  field("order_creation", "cargo", "cargo_notes", "货物备注", "textarea", "optional", "货物明细补充说明。"),

  field("consignment_approval", "consignment", "approval_result", "订单审批结果", "select", "required", "业务主管查看完整委托资料后通过或退回。", "approved|通过\nrejected|退回"),
  field("task_assignment", "assignment", "primary_operator", "主操作员", "select", "required", "审核通过后由操作主管人工指定。"),
  field("task_assignment", "assignment", "module_assignees", "模块负责人", "multiselect", "required", "按模组选择具体岗位和具体人员。"),
  field("task_assignment", "assignment", "assignment_due_at", "办理期限", "datetime", "hidden", "第一期暂不配置办理时限。"),
  field("task_assignment", "assignment", "assignment_notes", "派单说明", "textarea", "optional", "操作主管派单说明。"),
  field("task_assignment", "assignment", "assignment_scope", "分配范围", "multiselect", "required", "选择本次需要分配负责人的业务模组。"),
  field("task_assignment", "assignment", "pre_payable_expenses", "应付费用确认", "text", "hidden", "应付费用由业务员在国内运输开始时随承运商安排登记。"),

  field("domestic_execution", "transport", "domestic_carrier_id", "国内承运商", "supplier", "required", "从承运商管理中选择，联系人和电话自动带入。"),
  field("domestic_execution", "transport", "domestic_vehicle_type", "国内车型", "text", "required", "国内提货车辆车型。"),
  field("domestic_execution", "transport", "domestic_plate_number", "国内车牌号", "vehicle", "required", "国内提货车辆车牌。"),
  field("domestic_execution", "transport", "domestic_driver_name", "国内司机姓名", "driver", "required", "国内段司机姓名。"),
  field("domestic_execution", "transport", "domestic_driver_phone", "国内司机手机号", "text", "required", "国内段司机联系电话。"),
  field("domestic_execution", "transport", "domestic_driver_id_number", "国内司机证件号", "text", "optional", "国内段司机身份证或其他证件号码。"),
  field("domestic_execution", "transport", "domestic_planned_departure_at", "计划提货时间", "datetime", "required", "国内车辆计划到客户工厂提货时间。"),
  field("domestic_execution", "transport", "domestic_planned_arrival_at", "计划到仓时间", "datetime", "required", "国内车辆计划到国内仓/口岸仓时间。"),
  field("domestic_execution", "transport", "domestic_actual_pickup_at", "实际提货时间", "datetime", "optional", "司机实际完成提货的时间。"),
  field("domestic_execution", "transport", "domestic_actual_arrival_at", "实际到仓时间", "datetime", "optional", "车辆实际到达国内仓/口岸仓时间。"),
  field("domestic_execution", "transport", "domestic_freight_amount", "国内运费单价", "amount", "required", "业务员安排国内承运商时登记预计应付单价。"),
  field("domestic_execution", "transport", "domestic_freight_currency", "国内运费币种", "select", "required", "业务员安排国内承运商时确认应付币种。", "CNY\nUSD\nKZT\nUZS\nRUB"),
  field("domestic_execution", "transport", "domestic_payable_charge_name", "应付费用名称", "text", "required", "随国内承运商安排登记的应付费用名称。"),
  field("domestic_execution", "transport", "domestic_payable_quantity", "应付计价数量", "number", "required", "国内运输应付费用的计价数量。"),
  field("domestic_execution", "transport", "domestic_payable_exchange_rate", "应付费用汇率", "number", "required", "国内运输应付费用折算汇率。"),
  field("domestic_execution", "transport", "domestic_loading_requirements", "国内装载要求", "textarea", "optional", "客户工厂提货和国内运输过程中的装载要求。"),
  field("domestic_execution", "transport", "domestic_transport_notes", "国内运输备注", "textarea", "optional", "国内提货、运输和到仓补充说明。"),

  field("warehouse_receiving", "warehouse", "warehouse_receipt", "到仓收货记录", "text", "required", "仓库扫码收货记录。"),
  field("warehouse_receiving", "warehouse", "warehouse_barcode", "货物标签条码", "text", "optional", "扫描现有货物条码；未填写时由系统自动生成。"),
  field("warehouse_receiving", "warehouse", "actual_package_type", "实际包装类型", "select", "required", "仓库按实收货物选择包装类型。", "carton|纸箱\npallet|托盘\nwooden_case|木箱\nbag|袋装\nother|其他"),
  field("warehouse_receiving", "warehouse", "actual_package_count", "实收包装数", "number", "required", "仓库实际收到的包装数量。"),
  field("warehouse_receiving", "warehouse", "actual_pieces", "实收件数", "number", "required", "仓库实际收到的货物件数。"),
  field("warehouse_receiving", "warehouse", "actual_weight_kg", "实收重量KG", "number", "required", "配载、容量校验和成本分摊使用的实际重量。"),
  field("warehouse_receiving", "warehouse", "actual_volume_cbm", "实测体积CBM", "number", "required", "配载、容量校验和成本分摊使用的实际体积。"),
  field("warehouse_receiving", "warehouse", "warehouse_location", "入库库位", "warehouse", "required", "货物当前库位。"),
  field("warehouse_receiving", "warehouse", "receipt_evidence", "收货凭证", "attachment", "optional", "照片、单证或现场凭证索引。"),
  field("warehouse_receiving", "warehouse", "receipt_difference", "实收差异", "textarea", "optional", "预录与实收差异及处理结果。"),
  field("warehouse_receiving", "warehouse", "warehouse_receipt_notes", "收货备注", "textarea", "optional", "仓库收货现场说明和异常备注。"),
  field("warehouse_receiving", "warehouse", "cargo_complete_set", "货齐状态", "select", "required", "整票货物全部到齐并完成实收登记后，才可进入出口准备。", "ready|货齐\nexception|异常"),

  field("port_loading", "loading", "exit_port", "出境口岸", "border_port", "required", "确定运输方案后选择实际出境口岸。"),
  field("port_loading", "loading", "customs_location", "起运地清关地", "select", "required", "从基础数据选择起运地清关地点。"),
  field("port_loading", "loading", "transit_locations", "中转地", "multiselect", "optional", "按顺序选择线路中转地。"),
  field("port_loading", "loading", "route_code", "运输线路说明", "textarea", "optional", "可填写途经地点、换装点或特殊行驶要求，不作为配载门禁。"),
  field("port_loading", "loading", "loading_batch", "配载单", "text", "optional", "仅拼车订单使用；以整票订单为最小单位进入配载单。"),
  field("port_loading", "loading", "consolidation_warehouse", "集货仓库", "warehouse", "required", "只能选择国内集货仓或口岸仓。"),
  field("port_loading", "loading", "main_carrier_id", "出境承运商", "supplier", "required", "配载批次的出境承运商。"),
  field("port_loading", "loading", "main_vehicle_type", "出境车型", "text", "required", "出境运输车辆车型。"),
  field("port_loading", "loading", "main_plate_number", "出境车牌号", "vehicle", "required", "出境运输车辆车牌。"),
  field("port_loading", "loading", "main_driver_name", "出境司机姓名", "driver", "required", "出境运输司机。"),
  field("port_loading", "loading", "main_driver_phone", "出境司机手机号", "text", "required", "出境司机联系电话。"),
  field("port_loading", "loading", "vehicle_capacity_weight", "车辆载重参考KG", "number", "optional", "仅供人工判断装载方案，系统不校验是否超载。"),
  field("port_loading", "loading", "vehicle_capacity_volume", "车辆容积参考CBM", "number", "optional", "仅供人工判断装载方案，系统不校验是否超载。"),
  field("port_loading", "loading", "planned_exit_at", "计划出境发车时间", "datetime", "required", "配载单计划发车时间。"),
  field("port_loading", "loading", "planned_arrival_at", "计划境外到仓时间", "datetime", "optional", "配载单预计到达境外目的仓时间。"),
  field("port_loading", "loading", "loading_instruction", "装载要求/实际路线", "textarea", "optional", "装载、加固和线路要求。"),
  field("port_loading", "loading", "loading_notes", "配载备注", "textarea", "optional", "批次业务说明。"),
  field("port_loading", "loading", "loading_handover_notes", "装车交接备注", "textarea", "optional", "仓库装车、交接和出库补充说明。"),
  field("port_loading", "loading", "loading_scan_confirmation", "逐件扫码装车", "select", "required", "要求仓库按车辆逐件扫描并确认整票装车。", "1|已完成扫码装车"),
  field("port_loading", "loading", "cost_allocation", "拼车成本分摊", "text", "optional", "仅拼车订单使用；系统按1:300生成建议，人工可修改确认后才入账，只影响内部毛利和应付。"),

  field("outbound_transport", "documents", "predeparture_documents", "发运前文件", "attachment", "required", "委托书、商业发票、装箱单及报关资料为必需文件；报关单/预录报关单可选。"),
  field("outbound_transport", "documents", "document_review", "文件审核", "select", "required", "必需文件全部审核通过或归档。", "approved|审核通过\narchived|已归档"),
  field("outbound_transport", "documents", "document_category", "文件类型", "select", "required", "上传文件所属的业务资料类型。"),
  field("outbound_transport", "documents", "document_attachment", "业务文件", "attachment", "required", "实际上传的发运前业务文件。"),
  field("outbound_transport", "documents", "document_description", "文件说明", "textarea", "optional", "文件内容、版本或特殊用途说明。"),
  field("outbound_transport", "documents", "document_public_to_customer", "客户可见", "select", "optional", "决定文件是否同步到客户门户。", "1|客户可见\n0|仅内部"),
  field("order_creation", "consignment", "document_consignment_letter", "委托书", "attachment", "required", "客户确认运输委托后必须上传；报价已确定的客户、线路与货物资料只读继承，不重复填写。"),
  field("order_creation", "consignment", "document_contract", "合同", "attachment", "hidden", "默认按客户资料归档；仅在工作流明确启用订单级合同时显示。"),
  field("outbound_transport", "customs", "document_commercial_invoice", "商业发票", "attachment", "required", "办理报关申报时使用的商业发票。"),
  field("outbound_transport", "customs", "document_packing_list", "装箱单", "attachment", "required", "办理报关申报时使用的装箱明细。"),
  field("outbound_transport", "customs", "document_customs_document", "报关资料", "attachment", "required", "起运地、过境地或目的地申报所需的配套资料。"),
  field("outbound_transport", "customs", "document_customs_declaration_file", "报关单 / 预录报关单", "attachment", "optional", "可选上传预录或正式报关单文件；正式报关单号与海关放行状态仍在报关作业登记。"),
  field("outbound_transport", "customs", "document_border_document", "口岸文件", "attachment", "optional", "口岸交接、过境或查验文件。"),
  field("outbound_transport", "tracking", "document_transshipment_order", "换装单", "attachment", "optional", "发生换装、转关或车辆交接后上传相应凭证。"),
  field("overseas_pickup", "overseas_warehouse", "document_pod", "POD", "attachment", "optional", "境外仓交付或客户提货完成后上传交付证明。"),
  field("overseas_pickup", "overseas_warehouse", "document_delivery_receipt", "签收单", "attachment", "optional", "境外仓扫码核对并完成客户自提出库后，可选上传签收文件作为补充归档。"),
  field("overseas_pickup", "overseas_warehouse", "document_return_receipt", "回单", "attachment", "optional", "客户签收回单或业务回执。"),
  field("reconciliation", "costs", "document_billing_statement", "账单", "attachment", "optional", "对账完成后上传客户或供应商账单。"),
  field("reconciliation", "costs", "document_payment_receipt", "收付款凭证", "attachment", "optional", "收付款或核销完成后上传银行回单等凭证。"),
  field("outbound_transport", "customs", "customs_declarations", "报关申报明细", "text", "required", "支持同一订单多张报关单。"),
  field("outbound_transport", "customs", "declaration_stage", "报关作业阶段", "select", "required", "区分起运地、过境地和目的地报关/清关。", "origin|起运地报关\ntransit|过境地报关/清关\ndestination|目的地清关"),
  field("outbound_transport", "customs", "declaration_status", "申报单状态", "select", "required", "记录申报单当前处于已申报、已放行或已删单状态。", "declared|已申报，待放行\nreleased|已放行\ncancelled|已删单"),
  field("outbound_transport", "customs", "declaration_number", "报关单号", "text", "required", "报关申报单号。"),
  field("outbound_transport", "customs", "declaration_type", "申报类型", "select", "required", "起运地、过境地或目的地申报类型。"),
  field("outbound_transport", "customs", "declaration_title", "申报抬头", "text", "required", "报关申报抬头。"),
  field("outbound_transport", "customs", "declaring_company", "申报公司", "text", "required", "实际申报公司。"),
  field("outbound_transport", "customs", "declared_at", "申报时间", "datetime", "required", "实际申报时间。"),
  field("outbound_transport", "customs", "declared_amount", "申报金额", "amount", "required", "申报总金额。"),
  field("outbound_transport", "customs", "declaration_currency", "申报币种", "select", "required", "申报金额币种。", "CNY\nUSD\nKZT\nUZS\nRUB"),
  field("outbound_transport", "customs", "declaration_gross_weight", "申报毛重KG", "number", "required", "报关单申报毛重。"),
  field("outbound_transport", "customs", "declaration_change_flags", "删单/重报/改单/查验标记", "multiselect", "optional", "保留删单、重报、改单及查验历史。"),
  field("outbound_transport", "customs", "declaration_change_reason", "申报变更原因", "textarea", "optional", "发生删单、重报或改单时填写。"),
  field("outbound_transport", "customs", "customs_release", "海关放行", "datetime", "required", "所有未删单的起运地报关单全部放行后通过门禁。"),
  field("outbound_transport", "tracking", "actual_departure_at", "实际发车时间", "datetime", "required", "通过出境门禁后登记实际发车。"),
  field("outbound_transport", "tracking", "actual_exit_at", "实际出境时间", "datetime", "required", "录入后订单进入出境运输中。"),
  field("outbound_transport", "tracking", "tracking_milestone", "运输节点", "select", "required", "选择本次需要登记的运输节点。"),
  field("outbound_transport", "tracking", "tracking_milestone_name", "节点名称", "text", "optional", "运输节点对内和对客户展示的名称。"),
  field("outbound_transport", "tracking", "tracking_event_at", "节点发生时间", "datetime", "required", "该运输节点实际发生的时间。"),
  field("outbound_transport", "tracking", "tracking_location", "运踪地点", "text", "required", "当前运输节点地点。"),
  field("outbound_transport", "tracking", "tracking_vehicle", "当前车辆/车牌", "vehicle", "optional", "换装后应更新客户可见车号。"),
  field("outbound_transport", "tracking", "tracking_notes", "运踪说明", "textarea", "optional", "节点情况及异常说明。"),
  field("outbound_transport", "tracking", "visible_to_customer", "客户可见", "select", "required", "决定该运踪节点是否展示给客户。", "1|可见\n0|内部"),

  field("overseas_pickup", "overseas_warehouse", "overseas_arrival_at", "境外目的仓到仓时间", "datetime", "required", "批次动作，同一批次订单同步到仓。"),
  field("overseas_pickup", "overseas_warehouse", "overseas_arrival_notes", "到仓说明", "textarea", "optional", "卸车、入仓或换装说明。"),
  field("overseas_pickup", "overseas_warehouse", "customer_notified_at", "系统通知时间", "datetime", "required", "境外仓完成入库清点后由系统自动记录。"),
  field("overseas_pickup", "overseas_warehouse", "customer_notification_notes", "通知说明", "textarea", "optional", "电话、邮件或客户门户通知结果。"),
  field("overseas_pickup", "overseas_warehouse", "overseas_pickup_contact", "提货人/签收人", "text", "required", "客户实际提货人或签收人。"),
  field("overseas_pickup", "overseas_warehouse", "pickup_proof", "提货凭证", "attachment", "optional", "扫码、自提或签收凭证。"),
  field("overseas_pickup", "overseas_warehouse", "pickup_completed_at", "提货完成时间", "datetime", "required", "全部货物提走后记录完成时间。"),
  field("overseas_pickup", "overseas_warehouse", "pickup_completion_notes", "交付说明", "textarea", "optional", "提货完成、签收和异常补充说明。"),

  field("order_creation", "costs", "pre_receivable_expenses", "已接受报价应收费用", "text", "hidden", "应收费用在询价报价中确认，创建订单时仅继承，不在订单提交阶段重复填写。"),
  field("reconciliation", "costs", "receivable_expenses", "应收费用", "text", "required", "客户应收明细，不受拼车成本分摊直接影响。"),
  field("reconciliation", "costs", "payable_expenses", "应付费用", "text", "required", "承运商、仓库、报关等应付明细。"),
  field("reconciliation", "costs", "expense_currency", "费用币种", "select", "required", "费用原币。", "CNY\nUSD\nKZT\nUZS\nRUB"),
  field("reconciliation", "costs", "expense_exchange_rate", "汇率", "number", "required", "折算本位币汇率。"),
  field("reconciliation", "costs", "expense_direction", "费用方向", "select", "required", "区分客户应收和供应商应付。", "receivable|应收\npayable|应付"),
  field("reconciliation", "costs", "expense_charge_code", "费用代码", "text", "optional", "公司内部费用项目代码。"),
  field("reconciliation", "costs", "expense_charge_name", "费用名称", "text", "required", "实际费用项目名称。"),
  field("reconciliation", "costs", "expense_counterparty", "往来单位", "text", "required", "应收客户或应付供应商。"),
  field("reconciliation", "costs", "expense_quantity", "数量", "number", "required", "费用计价数量。"),
  field("reconciliation", "costs", "expense_unit_price", "单价", "amount", "required", "费用原币单价。"),
  field("reconciliation", "costs", "expense_tax_rate", "税率", "number", "optional", "费用税率百分比。"),
  field("reconciliation", "costs", "expense_occurred_on", "发生日期", "date", "optional", "费用实际发生日期。"),
  field("reconciliation", "costs", "expense_foreign_account_no", "国外账单号", "text", "optional", "境外供应商账单或结算编号。"),
  field("reconciliation", "costs", "expense_is_internal", "内部费用", "select", "optional", "标记仅用于内部核算的费用。", "1|是\n0|否"),
  field("reconciliation", "costs", "expense_notes", "费用备注", "textarea", "optional", "费用依据和补充说明。"),
  field("reconciliation", "costs", "business_review", "业务审核", "select", "required", "业务确认费用与业务事实一致。", "approved|通过\nrejected|退回"),
  field("reconciliation", "costs", "finance_review", "财务审核", "select", "required", "财务确认费用、税率和结算对象。", "approved|通过\nrejected|退回"),
  field("reconciliation", "costs", "reconciliation_statement", "对账单", "attachment", "required", "应收/应付对账单。"),
  field("reconciliation", "costs", "invoice_records", "开票/收票记录", "text", "required", "销项开票或进项收票。"),
  field("reconciliation", "costs", "cash_records", "收付款流水", "text", "required", "真实银行或现金收付款流水。"),
  field("reconciliation", "costs", "writeoff_records", "核销记录", "text", "required", "对账单、发票与收付款核销。"),

  field("completion_review", "exceptions", "exception_records", "异常记录", "text", "optional", "资料、货物、报关、配载、运输或费用异常。"),
  field("completion_review", "review", "customer_dispute_summary", "客户异议摘要", "textarea", "optional", "客户异议、处理结果和遗留事项。"),
  field("completion_review", "review", "review_result", "复盘结论", "textarea", "required", "业务、时效、费用、利润、异常和资料完整性复盘。"),
  field("completion_review", "review", "review_improvements", "改进事项", "textarea", "optional", "后续流程或客户服务改进项。"),
  field("domestic_execution", "transport", "domestic_loading_mode", "装车方式", "select", "optional", "国内运输安排采用整车或拼车装车。", "ftl|整车\nltl|拼车"),
  field("domestic_execution", "transport", "domestic_vehicle_count", "车辆数目", "number", "optional", "本次国内运输安排使用的车辆数量。"),
  field("port_loading", "loading", "overseas_carrier_name", "境外承运方", "supplier", "required", "整车/拼车方案确定后登记；拼车按配载单同步全部订单。"),
  field("port_loading", "loading", "overseas_vehicle_type", "境外车型", "text", "required", "境外运输或换装后使用的车型。"),
  field("port_loading", "loading", "overseas_vehicle_count", "境外车辆数目", "number", "required", "境外运输使用的车辆数量。"),
  field("port_loading", "loading", "overseas_vehicle_plate", "境外车牌号", "vehicle", "required", "境外运输或换装后的车辆车牌。"),
  field("port_loading", "loading", "overseas_driver_name", "境外司机姓名", "driver", "required", "境外运输司机姓名。"),
  field("port_loading", "loading", "overseas_driver_phone", "境外司机电话", "text", "required", "境外运输司机联系电话。"),
].map((item) =>
  item.fieldKey === "domestic_vehicle_type"
    ? {
        ...item,
        fieldType: "select",
        optionsText: "卡车\n尖程拼车\n13米平板\n13.5米高栏\n13.7米平板\n17.5米平板\n17.5米厢式车\n13米高栏\n16米厢式车\n13米厢式车\n冷藏车",
      }
    : item,
);

export const workflowFieldCatalogByKey = new Map(
  workflowFieldCatalog.map((item) => [item.fieldKey, item]),
);

export const workflowFieldModes: { value: WorkflowFieldMode; label: string }[] = [
  { value: "required", label: "必须填写" },
  { value: "optional", label: "可填可不填" },
  { value: "hidden", label: "不显示" },
];

export type WorkflowFieldPolicyLike = {
  fieldKey: string;
  isActive: boolean;
  isRequired: boolean;
};

export function workflowFieldPolicy(
  fields: readonly WorkflowFieldPolicyLike[],
  fieldKey: string,
  fallbackMode: WorkflowFieldMode = "optional",
) {
  const configured = fields.find((field) => field.fieldKey === fieldKey);
  if (configured)
    return {
      isActive: configured.isActive,
      isRequired: configured.isActive && configured.isRequired,
    };
  const fallback = workflowFieldModeFlags(fallbackMode);
  return {
    isActive: Boolean(fallback.isActive),
    isRequired: Boolean(fallback.isRequired),
  };
}

export function workflowFieldMode(field: { is_active: number; is_required: number }): WorkflowFieldMode {
  if (!field.is_active) return "hidden";
  return field.is_required ? "required" : "optional";
}

export function workflowFieldModeFlags(mode: string) {
  if (mode === "required") return { isActive: 1, isRequired: 1 };
  if (mode === "optional") return { isActive: 1, isRequired: 0 };
  return { isActive: 0, isRequired: 0 };
}
