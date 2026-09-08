import { describe, expect, it } from "vitest";
import {
  validateWorkflowOperationalGateStructure,
  validateWorkflowCoreStepOrder,
  validateWorkflowCoreModuleBindings,
  validateWorkflowResponsibilityReadiness,
} from "./workflow-publication-validation";

const steps = [
  { id: "review-step", step_key: "completion_review", name: "完成复盘", is_active: 1 },
];
const reviewModule = {
  id: "review-module",
  step_id: "review-step",
  module_code: "review",
  display_name: "订单复盘",
  is_active: 1,
  is_required: 1,
  responsibility_position_code: "FINANCE_ACCOUNTING",
  completion_mode: "all_tasks" as const,
};
const reviewTask = {
  id: "review-task",
  step_module_id: "review-module",
  name: "复盘并归档",
  task_type: "review" as const,
  is_required: 1,
  is_active: 1,
  responsibility_position_code: null,
};
const finance = {
  code: "FINANCE_ACCOUNTING",
  name: "财务会计岗",
  status: "active",
  active_member_count: 1,
  permission_codes: "order.view,order.module.review.manage,billing.expense.approve",
};

describe("workflow publication responsibility readiness", () => {
  it("accepts an explicit, staffed and authorized review finalizer", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [reviewTask],
        positions: [finance],
      }),
    ).toEqual([]);
  });

  it("rejects an unstaffed human task without duplicating workflow authority in module roles", () => {
    const issues = validateWorkflowResponsibilityReadiness({
      steps,
      modules: [reviewModule],
      tasks: [reviewTask],
      positions: [{ ...finance, active_member_count: 0, permission_codes: "order.view" }],
    });
    expect(issues.join("\n")).toContain("没有符合节点资格的有效账号");

    const permissionIssues = validateWorkflowResponsibilityReadiness({
      steps,
      modules: [reviewModule],
      tasks: [reviewTask],
      positions: [{ ...finance, permission_codes: "order.view,billing.expense.approve" }],
    });
    expect(permissionIssues.join("\n")).not.toContain("order.module.review.manage");
  });

  it("rejects missing or disabled responsibility positions", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [{ ...reviewTask, responsibility_position_code: "DISABLED" }],
        positions: [{ ...finance, code: "DISABLED", status: "disabled" }],
      }).join("\n"),
    ).toContain("不存在或已停用");

    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [{ ...reviewModule, responsibility_position_code: null }],
        tasks: [reviewTask],
        positions: [finance],
      }).join("\n"),
    ).toContain("未配置责任岗位");
  });

  it("requires review to remain an explicit human finalization gate", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [{ ...reviewModule, completion_mode: "automatic" }],
        tasks: [],
        positions: [finance],
      }).join("\n"),
    ).toContain("不能自动完成");

    expect(
      validateWorkflowResponsibilityReadiness({
        steps,
        modules: [reviewModule],
        tasks: [{ ...reviewTask, task_type: "system", is_required: 1 }],
        positions: [finance],
      }).join("\n"),
    ).toContain("必办的人工复盘任务");
  });

  it("does not demand a human assignee for automatic or system work", () => {
    const autoModule = {
      ...reviewModule,
      id: "auto-module",
      module_code: "documents",
      display_name: "系统文件同步",
      completion_mode: "automatic" as const,
      responsibility_position_code: null,
    };
    expect(
      validateWorkflowResponsibilityReadiness({
        steps: [{ ...steps[0], step_key: "outbound_transport", name: "出境运输" }],
        modules: [autoModule],
        tasks: [],
        positions: [],
      }),
    ).toEqual([]);
  });

  it("rejects a required human module whose human tasks are all optional", () => {
    expect(
      validateWorkflowResponsibilityReadiness({
        steps: [{ id: "cost-step", step_key: "reconciliation", name: "对账结算", is_active: 1 }],
        modules: [{
          ...reviewModule,
          id: "cost-module",
          step_id: "cost-step",
          module_code: "costs",
          display_name: "费用结算",
          responsibility_position_code: "CS",
        }],
        tasks: [{
          ...reviewTask,
          id: "optional-cost-task",
          step_module_id: "cost-module",
          name: "核对费用",
          task_type: "form",
          is_required: 0,
          responsibility_position_code: "CS",
        }],
        positions: [{
          ...finance,
          code: "CS",
          name: "客服岗",
          permission_codes: "order.view,order.module.costs.manage",
        }],
      }).join("\n"),
    ).toContain("费用结算");
  });

  it("does not impose the required-human-task gate on optional, automatic or system-only modules", () => {
    const step = { id: "step", step_key: "outbound_transport", name: "出境运输", is_active: 1 };
    const optionalHumanModule = {
      ...reviewModule,
      id: "optional-module",
      step_id: step.id,
      module_code: "tracking",
      display_name: "选办运踪",
      is_required: 0,
      responsibility_position_code: "OPERATION",
    };
    const systemModule = {
      ...optionalHumanModule,
      id: "system-module",
      display_name: "系统同步",
      is_required: 1,
    };
    const operation = { ...finance, code: "OPERATION", name: "操作岗", permission_codes: "order.view" };
    expect(validateWorkflowResponsibilityReadiness({
      steps: [step], modules: [optionalHumanModule],
      tasks: [{ ...reviewTask, step_module_id: optionalHumanModule.id, task_type: "form", is_required: 0, responsibility_position_code: "OPERATION" }],
      positions: [operation],
    })).toEqual([]);
    expect(validateWorkflowResponsibilityReadiness({
      steps: [step], modules: [systemModule],
      tasks: [{ ...reviewTask, step_module_id: systemModule.id, task_type: "system", is_required: 0, responsibility_position_code: null }],
      positions: [],
    })).toEqual([]);
  });

  it("accepts the three active settlement signoffs only when their frozen owners can execute them", () => {
    const settlementStep = {
      id: "settlement-step",
      step_key: "reconciliation",
      name: "对账结算",
      is_active: 1,
    };
    const costsModule = {
      ...reviewModule,
      id: "costs-module",
      step_id: settlementStep.id,
      module_code: "costs",
      display_name: "费用结算",
      responsibility_position_code: "CS",
    };
    const customerService = {
      ...finance,
      code: "CS",
      name: "客服岗",
      permission_codes: "order.view,order.module.costs.manage",
    };
    const salesperson = {
      ...finance,
      code: "SALES",
      name: "业务岗",
      permission_codes: "order.view,quote.manage",
    };

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep, ...steps],
      modules: [costsModule, reviewModule],
      tasks: [
        {
          ...reviewTask,
          id: "costs-task",
          task_key: "handle_costs",
          step_module_id: costsModule.id,
          name: "确认三方费用",
          task_type: "form",
          responsibility_position_code: "CS",
        },
        reviewTask,
      ],
      positions: [
        customerService,
        salesperson,
        { ...finance, permission_codes: `${finance.permission_codes},billing.expense.approve` },
      ],
      fields: [
        { step_id: settlementStep.id, module_code: "costs", field_key: "customer_service_confirmation", is_required: 1, is_active: 1 },
        { step_id: settlementStep.id, module_code: "costs", field_key: "business_review", is_required: 0, is_active: 1 },
        { step_id: settlementStep.id, module_code: "costs", field_key: "finance_review", is_required: 1, is_active: 1 },
      ],
    })).toEqual([]);
  });

  it("rejects enabled customer-service signoff when its frozen source or account readiness is invalid", () => {
    const settlementStep = { id: "settlement-step", step_key: "reconciliation", name: "对账结算", is_active: 1 };
    const field = {
      step_id: settlementStep.id,
      module_code: "costs",
      field_key: "customer_service_confirmation",
      is_required: 0,
      is_active: 1,
    };
    const costsModule = {
      ...reviewModule,
      id: "costs-module",
      step_id: settlementStep.id,
      module_code: "costs",
      display_name: "费用结算",
      responsibility_position_code: "CS",
    };
    const customerService = {
      ...finance,
      code: "CS",
      name: "客服岗",
      permission_codes: "order.view,order.module.costs.manage",
    };

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep],
      modules: [{ ...costsModule, responsibility_position_code: "OPERATION" }],
      tasks: [],
      positions: [customerService],
      fields: [field],
    }).join("\n")).toContain("对应费用模块责任岗位必须为 CS");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep], modules: [costsModule], tasks: [], positions: [], fields: [field],
    }).join("\n")).toContain("岗位 CS 不存在或已停用");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep], modules: [costsModule], tasks: [],
      positions: [{ ...customerService, active_member_count: 0 }], fields: [field],
    }).join("\n")).toContain("没有可用账号");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep], modules: [costsModule], tasks: [],
      positions: [{ ...customerService, permission_codes: "order.view" }], fields: [field],
    }).join("\n")).toContain("order.module.costs.manage");

    const operation = {
      ...finance,
      code: "OPERATION",
      name: "操作岗",
      permission_codes: "order.view,order.module.costs.manage",
    };
    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep],
      modules: [costsModule],
      tasks: [{
        ...reviewTask,
        step_module_id: costsModule.id,
        task_type: "form",
        responsibility_position_code: "OPERATION",
      }],
      positions: [customerService, operation],
      fields: [field],
    }).join("\n")).toContain("不支持由任务覆写其他岗位");
  });

  it("rejects enabled business and finance signoffs without their runtime owners and dedicated permission", () => {
    const settlementStep = { id: "settlement-step", step_key: "reconciliation", name: "对账结算", is_active: 1 };
    const review = {
      ...reviewModule,
      id: "finance-review-module",
      step_id: settlementStep.id,
    };
    const businessField = {
      step_id: settlementStep.id,
      module_code: "costs",
      field_key: "business_review",
      is_required: 1,
      is_active: 1,
    };
    const financeField = { ...businessField, field_key: "finance_review" };

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep], modules: [], tasks: [], positions: [], fields: [businessField],
    }).join("\n")).toContain("岗位 SALES 不存在或已停用");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep],
      modules: [{ ...review, responsibility_position_code: "OPERATION" }],
      tasks: [], positions: [], fields: [financeField],
    }).join("\n")).toContain("责任岗位必须为 FINANCE_ACCOUNTING");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep], modules: [review], tasks: [], positions: [{
        ...finance,
        permission_codes: "order.view,order.module.review.manage",
      }], fields: [financeField],
    }).join("\n")).toContain("billing.expense.approve");

    const operation = {
      ...finance,
      code: "OPERATION",
      name: "操作岗",
      permission_codes: "order.view,order.module.review.manage",
    };
    expect(validateWorkflowResponsibilityReadiness({
      steps: [settlementStep],
      modules: [review],
      tasks: [{
        ...reviewTask,
        step_module_id: review.id,
        responsibility_position_code: "OPERATION",
      }],
      positions: [
        { ...finance, permission_codes: `${finance.permission_codes},billing.expense.approve` },
        operation,
      ],
      fields: [financeField],
    }).join("\n")).toContain("不支持由复盘任务覆写其他岗位");
  });

  it("rejects finance signoff when review and approval permissions are split across different accounts", () => {
    const settlementStep = { id: "settlement-step", step_key: "reconciliation", name: "对账结算", is_active: 1 };
    const reviewStep = { id: "review-step", step_key: "completion_review", name: "完成复盘", is_active: 1 };
    const review = {
      ...reviewModule,
      id: "finance-review-module",
      step_id: reviewStep.id,
      responsibility_position_code: "FINANCE_ACCOUNTING",
    };
    const financeField = {
      step_id: settlementStep.id,
      module_code: "costs",
      field_key: "finance_review",
      is_required: 1,
      is_active: 1,
    };
    const issueText = validateWorkflowResponsibilityReadiness({
      steps: [settlementStep, reviewStep],
      modules: [review],
      tasks: [{
        id: "finance-review-task",
        step_module_id: review.id,
        name: "办理订单复盘",
        task_type: "form",
        is_required: 1,
        is_active: 1,
        responsibility_position_code: null,
      }],
      positions: [{
        ...finance,
        permission_codes: "order.view,order.module.review.manage,billing.expense.approve",
        active_member_permissions: [
          { membershipId: "finance-review", permissionCodes: ["order.module.review.manage"] },
          { membershipId: "finance-approval", permissionCodes: ["billing.expense.approve"] },
        ],
      }],
      fields: [financeField],
    }).join("\n");

    expect(issueText).toContain("同一有效个人账号");
    expect(issueText).toContain("全部必办节点");
  });

  it("requires one ordinary-order assignee to remain eligible for every required node", () => {
    const assignmentStep = {
      id: "assignment-step",
      step_key: "task_assignment",
      name: "任务分配",
      is_active: 1,
    };
    const domesticStep = {
      id: "domestic-step",
      step_key: "domestic_execution",
      name: "国内运输",
      is_active: 1,
    };
    const outboundStep = {
      id: "outbound-step",
      step_key: "outbound_transport",
      name: "出境运输",
      is_active: 1,
    };
    const transportModule = {
      ...reviewModule,
      id: "transport-module",
      step_id: domesticStep.id,
      module_code: "transport",
      display_name: "国内运输",
      responsibility_position_code: "OPERATION",
    };
    const trackingModule = {
      ...reviewModule,
      id: "tracking-module",
      step_id: outboundStep.id,
      module_code: "tracking",
      display_name: "运踪",
      responsibility_position_code: "OPERATION",
    };
    const tasks = [
      {
        ...reviewTask,
        id: "transport-task",
        step_module_id: transportModule.id,
        name: "办理国内运输",
      },
      {
        ...reviewTask,
        id: "tracking-task",
        step_module_id: trackingModule.id,
        name: "登记运踪",
      },
    ];
    const position = {
      code: "OPERATION",
      name: "操作岗",
      status: "active",
      active_member_count: 2,
      permission_codes: "order.module.transport.manage,order.module.tracking.manage",
    };
    const base = {
      steps: [assignmentStep, domesticStep, outboundStep],
      modules: [transportModule, trackingModule],
      tasks,
      fields: [],
    };

    const splitIssues = validateWorkflowResponsibilityReadiness({
      ...base,
      positions: [{
        ...position,
        active_member_permissions: [
          {
            membershipId: "operation-a",
            permissionCodes: ["order.view"],
            workflowAccessOverrides: [{
              stepKey: "outbound_transport",
              moduleCode: "tracking",
              effect: "deny" as const,
            }],
          },
          {
            membershipId: "operation-b",
            permissionCodes: ["order.view"],
            workflowAccessOverrides: [{
              stepKey: "domestic_execution",
              moduleCode: "transport",
              effect: "deny" as const,
            }],
          },
        ],
      }],
    }).join("\n");
    expect(splitIssues).toContain("没有同一有效个人账号");

    const completeIssues = validateWorkflowResponsibilityReadiness({
      ...base,
      positions: [{
        ...position,
        active_member_count: 1,
        active_member_permissions: [{
          membershipId: "operation-complete",
          permissionCodes: ["order.view"],
        }],
      }],
    }).join("\n");
    expect(completeIssues).not.toContain("没有同一有效个人账号");

    const protectedOwnerIssues = validateWorkflowResponsibilityReadiness({
      ...base,
      positions: [{
        ...position,
        active_member_count: 1,
        permission_codes: null,
        active_member_permissions: [{
          membershipId: "operation-owner",
          permissionCodes: ["*"],
        }],
      }],
    }).join("\n");
    expect(protectedOwnerIssues).toBe("");

    const denyAwareIssues = validateWorkflowResponsibilityReadiness({
      ...base,
      positions: [{
        ...position,
        active_member_count: 1,
        active_member_permissions: [{
          membershipId: "operation-denied",
          permissionCodes: ["order.view"],
          workflowAccessOverrides: [{
            stepKey: "outbound_transport",
            moduleCode: "tracking",
            effect: "deny" as const,
          }],
        }],
      }],
    }).join("\n");
    expect(denyAwareIssues).toContain("没有同一有效个人账号");
  });

  it("rejects required system tasks without a runtime auto-handler and accepts supported handlers", () => {
    const standardStep = { id: "tracking-step", step_key: "outbound_transport", name: "出境运输", is_active: 1 };
    const customStep = { ...standardStep, id: "custom-step", step_key: "custom_clearance", name: "自定义清关" };
    const systemModule = {
      ...reviewModule,
      id: "tracking-module",
      step_id: standardStep.id,
      module_code: "tracking",
      display_name: "运踪同步",
      responsibility_position_code: null,
    };
    const systemTask = {
      ...reviewTask,
      id: "system-task",
      task_key: "sync_tracking",
      step_module_id: systemModule.id,
      name: "自动同步运踪",
      task_type: "system" as const,
      responsibility_position_code: null,
    };

    expect(validateWorkflowResponsibilityReadiness({
      steps: [standardStep], modules: [systemModule], tasks: [systemTask], positions: [],
    }).join("\n")).toContain("没有受支持的自动处理器");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [customStep],
      modules: [{ ...systemModule, step_id: customStep.id }],
      tasks: [{ ...systemTask, task_key: "handle_tracking" }],
      positions: [],
    }).join("\n")).toContain("没有受支持的自动处理器");

    expect(validateWorkflowResponsibilityReadiness({
      steps: [standardStep], modules: [systemModule],
      tasks: [{ ...systemTask, task_key: "handle_runtime_bridge" }], positions: [],
    })).toEqual([]);
  });
});

describe("workflow core step order", () => {
  it("allows custom nodes between correctly ordered core nodes", () => {
    expect(validateWorkflowCoreStepOrder([
      { id: "q", step_key: "quotation", name: "询价", is_active: 1, sort_order: 10 },
      { id: "custom", step_key: "custom_check", name: "自定义查验", is_active: 1, sort_order: 15 },
      { id: "o", step_key: "order_creation", name: "委托", is_active: 1, sort_order: 20 },
      { id: "a", step_key: "consignment_approval", name: "审批", is_active: 1, sort_order: 30 },
    ])).toEqual([]);
  });

  it("rejects a core node moved ahead of its semantic prerequisite", () => {
    expect(validateWorkflowCoreStepOrder([
      { id: "q", step_key: "quotation", name: "询价", is_active: 1, sort_order: 10 },
      { id: "o", step_key: "order_creation", name: "委托", is_active: 1, sort_order: 20 },
      { id: "assign", step_key: "task_assignment", name: "分配", is_active: 1, sort_order: 25 },
      { id: "approve", step_key: "consignment_approval", name: "审批", is_active: 1, sort_order: 30 },
    ])[0]).toContain("不能倒置基础节点");
  });

  it("rejects duplicate enabled required placements for one module code", () => {
    const duplicateSteps = [
      { id: "first", step_key: "domestic_execution", name: "国内运输", is_active: 1 },
      { id: "second", step_key: "custom_transport_check", name: "运输复核", is_active: 1 },
    ];
    const duplicateModules = duplicateSteps.map((step, index) => ({
      ...reviewModule,
      id: `transport-${index}`,
      step_id: step.id,
      module_code: "transport",
      display_name: index === 0 ? "国内运输" : "运输复核",
      responsibility_position_code: "OPERATION",
    }));
    const operation = {
      ...finance,
      code: "OPERATION",
      name: "操作岗",
      permission_codes: "order.module.transport.manage",
    };

    expect(validateWorkflowResponsibilityReadiness({
      steps: duplicateSteps,
      modules: duplicateModules,
      tasks: duplicateModules.map((module, index) => ({
        ...reviewTask,
        id: `transport-task-${index}`,
        step_module_id: module.id,
        task_type: "form",
        responsibility_position_code: "OPERATION",
      })),
      positions: [operation],
    }).join("\n")).toContain("同一模块编码");
  });

  it("allows only the three status-driven required consignment placements", () => {
    const coreSteps = [
      { id: "quotation", step_key: "quotation", name: "询价报价", is_active: 1 },
      { id: "creation", step_key: "order_creation", name: "委托资料", is_active: 1 },
      { id: "approval", step_key: "consignment_approval", name: "委托审批", is_active: 1 },
    ];
    const coreModules = coreSteps.map((step) => ({
      ...reviewModule,
      id: `consignment:${step.id}`,
      step_id: step.id,
      module_code: "consignment",
      display_name: step.name,
      responsibility_position_code: "SALES",
    }));
    const issues = validateWorkflowResponsibilityReadiness({
      steps: coreSteps,
      modules: coreModules,
      tasks: [],
      positions: [],
    }).join("\n");
    expect(issues).not.toContain("同一模块编码");

    expect(validateWorkflowResponsibilityReadiness({
      steps: coreSteps.slice(0, 2),
      modules: coreModules.slice(0, 2),
      tasks: [],
      positions: [],
    }).join("\n")).toContain("同一模块编码");

    const customStep = {
      id: "custom-consignment",
      step_key: "custom_consignment_check",
      name: "委托复核",
      is_active: 1,
    };
    expect(validateWorkflowResponsibilityReadiness({
      steps: [...coreSteps, customStep],
      modules: [
        ...coreModules,
        {
          ...reviewModule,
          id: "consignment:custom",
          step_id: customStep.id,
          module_code: "consignment",
          display_name: customStep.name,
          responsibility_position_code: "SALES",
        },
      ],
      tasks: [],
      positions: [],
    }).join("\n")).toContain("同一模块编码");
  });

  it("requires status-driven core nodes to keep their semantic modules", () => {
    const statusSteps = [
      { id: "quotation", step_key: "quotation", name: "询价报价", is_active: 1 },
      { id: "creation", step_key: "order_creation", name: "委托资料", is_active: 1 },
      { id: "approval", step_key: "consignment_approval", name: "委托审批", is_active: 1 },
      { id: "assignment", step_key: "task_assignment", name: "任务分配", is_active: 1 },
    ];
    const invalidModules = [
      { ...reviewModule, id: "quote-costs", step_id: "quotation", module_code: "costs" },
      { ...reviewModule, id: "cargo", step_id: "creation", module_code: "cargo" },
      { ...reviewModule, id: "tracking", step_id: "approval", module_code: "tracking" },
      { ...reviewModule, id: "transport", step_id: "assignment", module_code: "transport" },
    ];

    const issues = validateWorkflowCoreModuleBindings(statusSteps, invalidModules).join("\n");
    expect(issues).toContain("询价报价");
    expect(issues).toContain("委托信息");
    expect(issues).toContain("委托审核");
    expect(issues).toContain("任务分配");

    const validModules = [
      { ...reviewModule, id: "consignment-quotation", step_id: "quotation", module_code: "consignment" },
      { ...reviewModule, id: "consignment-create", step_id: "creation", module_code: "consignment" },
      {
        ...reviewModule,
        id: "consignment-approve",
        step_id: "approval",
        module_code: "consignment",
        completion_mode: "manual_confirm" as const,
      },
      { ...reviewModule, id: "assignment-module", step_id: "assignment", module_code: "assignment" },
    ];
    const approvalTask = {
      ...reviewTask,
      id: "approval-task",
      step_module_id: "consignment-approve",
      task_type: "review" as const,
      is_required: 1,
    };
    expect(validateWorkflowCoreModuleBindings(
      statusSteps,
      validModules,
      [approvalTask],
    )).toEqual([]);
    expect(validateWorkflowCoreModuleBindings(
      statusSteps,
      validModules.map((module) => module.id === "consignment-approve"
        ? { ...module, completion_mode: "all_tasks" as const }
        : module),
      [approvalTask],
    ).join("\n")).toContain("人工确认模式");
    expect(validateWorkflowCoreModuleBindings(
      statusSteps,
      validModules,
      [],
    ).join("\n")).toContain("必办审核任务");
  });

});

describe("workflow operational gate structure", () => {
  it("rejects customs release without a declaration source", () => {
    const outboundStep = {
      id: "outbound",
      step_key: "outbound_transport",
      name: "Outbound transport",
      is_active: 1,
      sort_order: 80,
    };
    const customsModule = {
      id: "customs-outbound",
      step_id: outboundStep.id,
      module_code: "customs",
      display_name: "Customs",
      is_active: 1,
      is_required: 1,
      responsibility_position_code: "DOC",
      completion_mode: "all_tasks" as const,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [outboundStep],
      modules: [customsModule],
      fields: [{
        step_id: outboundStep.id,
        module_code: "customs",
        field_key: "customs_release",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain("customs_release");
    expect(issues.join("\n")).toContain("customs_declarations");
  });

  it("rejects customs release before declaration entry", () => {
    const releaseStep = {
      id: "release",
      step_key: "customs_release_gate",
      name: "Release",
      is_active: 1,
      sort_order: 50,
    };
    const declarationStep = {
      id: "declaration",
      step_key: "customs_declaration_entry",
      name: "Declaration",
      is_active: 1,
      sort_order: 60,
    };
    const modules = [releaseStep, declarationStep].map((step) => ({
      id: `customs-${step.id}`,
      step_id: step.id,
      module_code: "customs",
      display_name: "Customs",
      is_active: 1,
      is_required: 0,
      responsibility_position_code: "DOC",
      completion_mode: "all_tasks" as const,
    }));

    const issues = validateWorkflowOperationalGateStructure({
      steps: [releaseStep, declarationStep],
      modules,
      fields: [
        {
          step_id: releaseStep.id,
          module_code: "customs",
          field_key: "customs_release",
          is_required: 0,
          is_active: 1,
        },
        {
          step_id: declarationStep.id,
          module_code: "customs",
          field_key: "customs_declarations",
          is_required: 0,
          is_active: 1,
        },
      ],
    });

    expect(issues.join("\n")).toContain(
      "customs_release 不能早于 customs_declarations",
    );
  });

  it("rejects an active customs field without an active customs module on its node", () => {
    const customsStep = {
      id: "customs",
      step_key: "customs_entry",
      name: "Customs entry",
      is_active: 1,
      sort_order: 60,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [customsStep],
      modules: [],
      fields: [{
        step_id: customsStep.id,
        module_code: "customs",
        field_key: "customs_declarations",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain("customs_declarations");
    expect(issues.join("\n")).toContain("customs 模块");
  });

  it("keeps declaration mutation fields on the declaration-entry node", () => {
    const declarationStep = {
      id: "declaration",
      step_key: "customs_declaration_entry",
      name: "Declaration entry",
      is_active: 1,
      sort_order: 50,
    };
    const amendmentStep = {
      id: "amendment",
      step_key: "customs_amendment",
      name: "Amendment",
      is_active: 1,
      sort_order: 60,
    };
    const modules = [declarationStep, amendmentStep].map((step) => ({
      id: `customs-${step.id}`,
      step_id: step.id,
      module_code: "customs",
      display_name: "Customs",
      is_active: 1,
      is_required: 0,
      responsibility_position_code: "DOC",
      completion_mode: "all_tasks" as const,
    }));

    const issues = validateWorkflowOperationalGateStructure({
      steps: [declarationStep, amendmentStep],
      modules,
      fields: [
        {
          step_id: declarationStep.id,
          module_code: "customs",
          field_key: "customs_declarations",
          is_required: 1,
          is_active: 1,
        },
        {
          step_id: amendmentStep.id,
          module_code: "customs",
          field_key: "declaration_number",
          is_required: 1,
          is_active: 1,
        },
      ],
    });

    expect(issues.join("\n")).toContain("declaration_number");
    expect(issues.join("\n")).toContain("customs_declarations 所在节点");
  });

  it("keeps actual exit strictly after the required loading operation", () => {
    const loadingStep = {
      id: "loading",
      step_key: "port_loading",
      name: "Loading",
      is_active: 1,
      sort_order: 70,
    };
    const exitStep = {
      id: "exit",
      step_key: "outbound_transport",
      name: "Exit",
      is_active: 1,
      sort_order: 60,
    };
    const modules = [
      {
        id: "loading-module",
        step_id: loadingStep.id,
        module_code: "loading",
        display_name: "Loading",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "WAREHOUSE",
        completion_mode: "all_tasks" as const,
      },
      {
        id: "tracking-module",
        step_id: exitStep.id,
        module_code: "tracking",
        display_name: "Tracking",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "OPERATION",
        completion_mode: "all_tasks" as const,
      },
    ];

    const issues = validateWorkflowOperationalGateStructure({
      steps: [exitStep, loadingStep],
      modules,
      fields: [{
        step_id: exitStep.id,
        module_code: "tracking",
        field_key: "actual_exit_at",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain(
      "actual_exit_at 必须位于必办 loading 模块之后",
    );
  });

  it("rejects a required origin release gate after actual exit", () => {
    const steps = [
      { id: "exit", step_key: "outbound_transport", name: "Exit", is_active: 1, sort_order: 70 },
      { id: "declaration", step_key: "customs_entry", name: "Declaration", is_active: 1, sort_order: 80 },
      { id: "release", step_key: "customs_release", name: "Release", is_active: 1, sort_order: 90 },
    ];
    const modules = [
      {
        id: "tracking-exit",
        step_id: "exit",
        module_code: "tracking",
        display_name: "Tracking",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "OPERATION",
        completion_mode: "all_tasks" as const,
      },
      ...["declaration", "release"].map((stepId) => ({
        id: `customs-${stepId}`,
        step_id: stepId,
        module_code: "customs",
        display_name: "Customs",
        is_active: 1,
        is_required: 0,
        responsibility_position_code: "DOC",
        completion_mode: "all_tasks" as const,
      })),
    ];

    const issues = validateWorkflowOperationalGateStructure({
      steps,
      modules,
      fields: [
        {
          step_id: "exit",
          module_code: "tracking",
          field_key: "actual_exit_at",
          is_required: 1,
          is_active: 1,
        },
        {
          step_id: "declaration",
          module_code: "customs",
          field_key: "customs_declarations",
          is_required: 1,
          is_active: 1,
        },
        {
          step_id: "release",
          module_code: "customs",
          field_key: "customs_release",
          is_required: 1,
          is_active: 1,
        },
      ],
    });

    expect(issues.join("\n")).toContain(
      "必填 customs_release 不能位于 actual_exit_at 之后",
    );
  });

  it("requires actual exit to stay on a node with an active tracking module", () => {
    const exitStep = {
      id: "exit",
      step_key: "outbound_transport",
      name: "Exit",
      is_active: 1,
      sort_order: 80,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [exitStep],
      modules: [],
      fields: [{
        step_id: exitStep.id,
        module_code: "tracking",
        field_key: "actual_exit_at",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain("actual_exit_at");
    expect(issues.join("\n")).toContain("tracking 模块");
  });

  it("requires a required loading operation when actual exit is enabled", () => {
    const exitStep = {
      id: "exit",
      step_key: "outbound_transport",
      name: "Exit",
      is_active: 1,
      sort_order: 80,
    };
    const trackingModule = {
      id: "tracking-exit",
      step_id: exitStep.id,
      module_code: "tracking",
      display_name: "Tracking",
      is_active: 1,
      is_required: 1,
      responsibility_position_code: "OPERATION",
      completion_mode: "all_tasks" as const,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [exitStep],
      modules: [trackingModule],
      fields: [{
        step_id: exitStep.id,
        module_code: "tracking",
        field_key: "actual_exit_at",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain(
      "actual_exit_at 已启用，但没有启用且必办的 loading 模块",
    );
  });

  it("requires loading confirmation to stay on a node with an active loading module", () => {
    const loadingStep = {
      id: "loading",
      step_key: "port_loading",
      name: "Loading",
      is_active: 1,
      sort_order: 70,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [loadingStep],
      modules: [],
      fields: [{
        step_id: loadingStep.id,
        module_code: "loading",
        field_key: "loading_scan_confirmation",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain("loading_scan_confirmation");
    expect(issues.join("\n")).toContain("loading 模块");
  });

  it("rejects declaration mutation fields without the declaration anchor", () => {
    const customsStep = {
      id: "customs",
      step_key: "customs_entry",
      name: "Customs entry",
      is_active: 1,
      sort_order: 60,
    };
    const customsModule = {
      id: "customs-module",
      step_id: customsStep.id,
      module_code: "customs",
      display_name: "Customs",
      is_active: 1,
      is_required: 1,
      responsibility_position_code: "DOC",
      completion_mode: "all_tasks" as const,
    };

    const issues = validateWorkflowOperationalGateStructure({
      steps: [customsStep],
      modules: [customsModule],
      fields: [{
        step_id: customsStep.id,
        module_code: "customs",
        field_key: "declaration_number",
        is_required: 1,
        is_active: 1,
      }],
    });

    expect(issues.join("\n")).toContain("declaration_number");
    expect(issues.join("\n")).toContain("customs_declarations");
  });

  it("allows declaration and required release before the loading node", () => {
    const steps = [
      { id: "customs", step_key: "origin_customs", name: "Origin customs", is_active: 1, sort_order: 50 },
      { id: "loading", step_key: "port_loading", name: "Loading", is_active: 1, sort_order: 70 },
      { id: "exit", step_key: "outbound_transport", name: "Exit", is_active: 1, sort_order: 80 },
    ];
    const modules = [
      {
        id: "customs-module",
        step_id: "customs",
        module_code: "customs",
        display_name: "Customs",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "DOC",
        completion_mode: "all_tasks" as const,
      },
      {
        id: "loading-module",
        step_id: "loading",
        module_code: "loading",
        display_name: "Loading",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "WAREHOUSE",
        completion_mode: "all_tasks" as const,
      },
      {
        id: "tracking-module",
        step_id: "exit",
        module_code: "tracking",
        display_name: "Tracking",
        is_active: 1,
        is_required: 1,
        responsibility_position_code: "OPERATION",
        completion_mode: "all_tasks" as const,
      },
    ];
    const fields = [
      { step_id: "customs", module_code: "customs", field_key: "customs_declarations", is_required: 1, is_active: 1 },
      { step_id: "customs", module_code: "customs", field_key: "customs_release", is_required: 1, is_active: 1 },
      { step_id: "loading", module_code: "loading", field_key: "loading_scan_confirmation", is_required: 1, is_active: 1 },
      { step_id: "exit", module_code: "tracking", field_key: "actual_exit_at", is_required: 1, is_active: 1 },
    ];

    expect(validateWorkflowOperationalGateStructure({
      steps,
      modules,
      fields,
    })).toEqual([]);
  });

  it("allows an optional destination release after actual exit", () => {
    const steps = [
      { id: "loading", step_key: "port_loading", name: "Loading", is_active: 1, sort_order: 70 },
      { id: "exit", step_key: "outbound_transport", name: "Exit", is_active: 1, sort_order: 80 },
      { id: "declaration", step_key: "destination_declaration", name: "Destination declaration", is_active: 1, sort_order: 90 },
      { id: "release", step_key: "destination_release", name: "Destination release", is_active: 1, sort_order: 100 },
    ];
    const modules = [
      {
        id: "loading-module", step_id: "loading", module_code: "loading",
        display_name: "Loading", is_active: 1, is_required: 1,
        responsibility_position_code: "WAREHOUSE", completion_mode: "all_tasks" as const,
      },
      {
        id: "tracking-module", step_id: "exit", module_code: "tracking",
        display_name: "Tracking", is_active: 1, is_required: 1,
        responsibility_position_code: "OPERATION", completion_mode: "all_tasks" as const,
      },
      ...["declaration", "release"].map((stepId) => ({
        id: `customs-${stepId}`, step_id: stepId, module_code: "customs",
        display_name: "Customs", is_active: 1, is_required: 0,
        responsibility_position_code: "DOC", completion_mode: "all_tasks" as const,
      })),
    ];
    const fields = [
      { step_id: "loading", module_code: "loading", field_key: "loading_scan_confirmation", is_required: 1, is_active: 1 },
      { step_id: "exit", module_code: "tracking", field_key: "actual_exit_at", is_required: 1, is_active: 1 },
      { step_id: "declaration", module_code: "customs", field_key: "customs_declarations", is_required: 0, is_active: 1 },
      { step_id: "release", module_code: "customs", field_key: "customs_release", is_required: 0, is_active: 1 },
    ];

    expect(validateWorkflowOperationalGateStructure({
      steps,
      modules,
      fields,
    })).toEqual([]);
  });
});
