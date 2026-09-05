import { describe, expect, it } from "vitest";
import {
  BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS,
  batchInitialResponsibilityDisabledReasons,
  batchInitialResponsibilityReadiness,
  batchResponsibilityPermissionDisabledReasons,
  buildBatchInitialResponsibilityRestrictions,
  buildConfiguredBatchResponsibilityTargets,
  findBatchInitialResponsibilityConflict,
  batchRequiresSupervisorApproval,
  batchSharedResponsibilityIsActive,
  canOrdinaryReassignBatchResponsibility,
} from "./batch-responsibility";

describe("batch responsibility policy", () => {
  it("requires full downstream permissions for PZ assignees", () => {
    expect(BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.operation).toEqual([
      ["transport.batch.assigned.view"],
      ["order.module.tracking.manage"],
      ["order.module.exceptions.manage"],
    ]);
    expect(BATCH_RESPONSIBILITY_PERMISSION_REQUIREMENTS.document).toEqual([
      ["transport.batch.assigned.view"],
      ["order.module.documents.manage"],
      ["order.module.customs.manage"],
    ]);

    const baseMember = {
      display_name: "candidate",
      department_id: "department-1",
      department_name: "transport",
      position_id: "position-1",
      position_name: "position",
    };
    const operationMembers = [
      {
        ...baseMember,
        id: "qualified-operation",
        permission_codes: "transport.batch.assigned.view,order.module.tracking.manage,order.module.exceptions.manage",
      },
      {
        ...baseMember,
        id: "missing-exceptions",
        permission_codes: "transport.batch.assigned.view,order.module.tracking.manage",
      },
      { ...baseMember, id: "protected-owner", permission_codes: "*" },
    ];
    expect(Object.keys(batchResponsibilityPermissionDisabledReasons(
      operationMembers,
      "operation",
    ))).toEqual(["missing-exceptions"]);
    expect(Object.keys(batchResponsibilityPermissionDisabledReasons([{
      ...baseMember,
      id: "missing-customs",
      permission_codes: "transport.batch.assigned.view,order.module.documents.manage",
    }], "document"))).toEqual(["missing-customs"]);
  });

  it("applies supervisor approval only to consolidated PZ batches", () => {
    expect(batchRequiresSupervisorApproval("PZ-20260905-001")).toBe(true);
    expect(batchRequiresSupervisorApproval("FTL-20260905-001")).toBe(false);
  });

  it("allows ordinary reassignment only before actual exit", () => {
    expect(canOrdinaryReassignBatchResponsibility({
      batchNumber: "PZ-20260905-001",
      approvalStatus: "approved",
      roadStatus: "loaded_waiting_exit",
      actualDepartureAt: null,
    })).toBe(true);
    expect(canOrdinaryReassignBatchResponsibility({
      batchNumber: "PZ-20260905-001",
      approvalStatus: "approved",
      roadStatus: "outbound_in_transit",
      actualDepartureAt: "2026-09-05T03:00:00.000Z",
    })).toBe(false);
  });

  it("ends shared PZ operation and document responsibility at overseas arrival", () => {
    expect(batchSharedResponsibilityIsActive("outbound_in_transit")).toBe(true);
    expect(batchSharedResponsibilityIsActive("overseas_arrived")).toBe(false);
    expect(batchSharedResponsibilityIsActive("waiting_pickup")).toBe(false);
  });

  it("excludes every mounted order's former downstream operator and document clerk", () => {
    const restrictions = buildBatchInitialResponsibilityRestrictions([
      {
        orderId: "order-228",
        orderNumber: "SO2026090400228",
        moduleCode: "configured-operation-a",
        positionCode: "OPERATION",
        assigneeUserId: "operator-old-a",
        assigneeName: "原操作甲",
      },
      {
        orderId: "order-229",
        orderNumber: "SO2026090400229",
        moduleCode: "configured-operation-b",
        positionCode: "OPERATION",
        assigneeUserId: "operator-old-a",
        assigneeName: "原操作甲",
      },
      {
        orderId: "order-230",
        orderNumber: "SO2026090400230",
        moduleCode: "configured-operation-a",
        positionCode: "OPERATION",
        assigneeUserId: "operator-old-b",
        assigneeName: "原操作乙",
      },
      {
        orderId: "order-228",
        orderNumber: "SO2026090400228",
        moduleCode: "configured-document-a",
        positionCode: "DOC",
        assigneeUserId: "document-old-a",
        assigneeName: "原单证甲",
      },
      {
        orderId: "order-229",
        orderNumber: "SO2026090400229",
        moduleCode: "configured-document-b",
        positionCode: "DOC",
        assigneeUserId: "document-old-b",
        assigneeName: "原单证乙",
      },
      {
        orderId: "order-ignored",
        orderNumber: "SO-IGNORED",
        moduleCode: "costs",
        positionCode: "FINANCE_ACCOUNTING",
        assigneeUserId: "finance-user",
        assigneeName: "财务",
      },
    ]);

    expect(restrictions.operation.map((item) => item.userId)).toEqual([
      "operator-old-a",
      "operator-old-b",
    ]);
    expect(restrictions.operation[0]).toMatchObject({
      userName: "原操作甲",
      orderNumbers: ["SO2026090400228", "SO2026090400229"],
      moduleCodes: ["configured-operation-a", "configured-operation-b"],
    });
    expect(restrictions.document.map((item) => item.userId)).toEqual([
      "document-old-a",
      "document-old-b",
    ]);
    expect(restrictions.operation.some((item) => item.userId === "finance-user")).toBe(false);
  });

  it("returns the same explanatory conflict used by UI disabling and POST validation", () => {
    const restrictions = buildBatchInitialResponsibilityRestrictions([
      {
        orderId: "order-228",
        orderNumber: "SO2026090400228",
        moduleCode: "future-operation-module",
        positionCode: "OPERATION",
        assigneeUserId: "operator-old",
        assigneeName: "原操作员",
      },
      {
        orderId: "order-229",
        orderNumber: "SO2026090400229",
        moduleCode: "future-document-module",
        positionCode: "DOC",
        assigneeUserId: "document-old",
        assigneeName: "原单证员",
      },
    ]);

    const operationConflict = findBatchInitialResponsibilityConflict(restrictions, {
      operationAssigneeUserId: "operator-old",
      documentAssigneeUserId: "document-new",
    });
    expect(operationConflict).toEqual({
      kind: "operation",
      userId: "operator-old",
      reason: "原操作员是挂载订单 SO2026090400228 的原操作负责人；PZ 首次统一分配必须更换新操作负责人。",
    });
    expect(batchInitialResponsibilityDisabledReasons(restrictions, "operation")).toEqual({
      "operator-old": operationConflict?.reason,
    });
    expect(findBatchInitialResponsibilityConflict(restrictions, {
      operationAssigneeUserId: "operator-new",
      documentAssigneeUserId: "document-old",
    })?.kind).toBe("document");
    expect(findBatchInitialResponsibilityConflict(restrictions, {
      operationAssigneeUserId: "operator-new",
      documentAssigneeUserId: "document-new",
    })).toBeNull();
  });

  it("projects configured frozen groups without relying on module names", () => {
    const targets = buildConfiguredBatchResponsibilityTargets({
      orderId: "order-228",
      operationAssigneeUserId: "operator-new",
      documentAssigneeUserId: "document-new",
      manifest: {
        workflowInstanceId: "workflow-228",
        configurationErrors: [],
        groups: [
          {
            positionCode: "OPERATION",
            modules: [{
              moduleCode: "future-work-renamed-by-config",
              primaryOwner: true,
              taskStateIds: ["task-operation"],
            }],
          },
          {
            positionCode: "DOC",
            modules: [{
              moduleCode: "future-work-renamed-by-config",
              primaryOwner: false,
              taskStateIds: ["task-document"],
            }],
          },
          {
            positionCode: "FINANCE_ACCOUNTING",
            modules: [{
              moduleCode: "costs",
              primaryOwner: true,
              taskStateIds: ["task-costs"],
            }],
          },
        ],
      },
    });

    expect(targets).toEqual([
      expect.objectContaining({
        positionCode: "OPERATION",
        assigneeUserId: "operator-new",
        moduleCodes: ["future-work-renamed-by-config"],
        primaryModuleCodes: ["future-work-renamed-by-config"],
        taskStateIds: ["task-operation"],
      }),
      expect.objectContaining({
        positionCode: "DOC",
        assigneeUserId: "document-new",
        moduleCodes: ["future-work-renamed-by-config"],
        primaryModuleCodes: [],
        taskStateIds: ["task-document"],
      }),
    ]);
  });
  it("rejects split permissions when no operation account has the complete PZ set", () => {
    const restrictions = buildBatchInitialResponsibilityRestrictions([]);
    const readiness = batchInitialResponsibilityReadiness([
      {
        id: "operation-view-tracking",
        display_name: "操作甲",
        department_id: "department-operation",
        department_name: "操作部",
        position_id: "position-operation",
        position_code: "OPERATION",
        position_name: "操作岗",
        permission_codes: "transport.batch.assigned.view,order.module.tracking.manage",
      },
      {
        id: "operation-exception",
        display_name: "操作乙",
        department_id: "department-operation",
        department_name: "操作部",
        position_id: "position-operation",
        position_code: "OPERATION",
        position_name: "操作岗",
        permission_codes: "order.module.exceptions.manage",
      },
    ], restrictions);
    expect(readiness.operation).toEqual([]);
  });

  it("rejects complete candidates when every candidate is an original order owner", () => {
    const restrictions = buildBatchInitialResponsibilityRestrictions([{
      orderId: "order-1",
      orderNumber: "SO-001",
      moduleCode: "tracking",
      positionCode: "OPERATION",
      assigneeUserId: "operation-original",
      assigneeName: "原操作员",
    }]);
    const readiness = batchInitialResponsibilityReadiness([{
      id: "operation-original",
      display_name: "原操作员",
      department_id: "department-operation",
      department_name: "操作部",
      position_id: "position-operation",
      position_code: "OPERATION",
      position_name: "操作岗",
      permission_codes: "transport.batch.assigned.view,order.module.tracking.manage,order.module.exceptions.manage",
    }], restrictions);
    expect(readiness.operation).toEqual([]);
  });

  it("accepts fresh operation and document candidates with complete permissions", () => {
    const restrictions = buildBatchInitialResponsibilityRestrictions([]);
    const common = {
      department_id: "department",
      department_name: "运输部",
      position_id: "position",
      position_name: "岗位",
    };
    const readiness = batchInitialResponsibilityReadiness([
      {
        ...common,
        id: "operation-fresh",
        display_name: "新操作员",
        position_code: "OPERATION",
        permission_codes: "transport.batch.assigned.view,order.module.tracking.manage,order.module.exceptions.manage",
      },
      {
        ...common,
        id: "document-fresh",
        display_name: "新单证员",
        position_code: "DOC",
        permission_codes: "transport.batch.assigned.view,order.module.documents.manage,order.module.customs.manage",
      },
    ], restrictions);
    expect(readiness.operation.map((member) => member.id)).toEqual(["operation-fresh"]);
    expect(readiness.document.map((member) => member.id)).toEqual(["document-fresh"]);
  });

});
