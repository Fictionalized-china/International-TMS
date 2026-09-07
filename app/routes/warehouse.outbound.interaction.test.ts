import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));

import * as outboundRoute from "./warehouse.outbound";

type OutboundRouteTestExports = {
  warehouseDispatchCompletionResult?: (input: {
    dispatchNumber: string;
    businessType: string;
    completionWarningText: string;
  }) => Record<string, unknown>;
  OutboundBarcodeInput?: (props: { busy: boolean }) => ReactElement;
  warehouseOutboundWorkflowActionError?: (policy: {
    loadingStage: {
      available: boolean;
      targetStepKey: string | null;
      targetStepName: string | null;
      reason: string | null;
    };
  } | null) => string | null;
  warehouseOutboundRouteSyncState?: (
    stage: {
      available: boolean;
      targetStepKey: string | null;
      targetStepName: string | null;
      reason: string | null;
    } | null,
    currentStepKey: string | null,
  ) => { targetStepKey: string | null; resynchronized: boolean | null; pendingReason: string | null };
  WarehouseOutboundRouteReadOnly?: (props: {
    exitPort: string | null;
    customsLocation: string | null;
    targetStepName: string;
    reason: string;
    exitPolicy?: { isActive: boolean };
    customsPolicy?: { isActive: boolean };
  }) => ReactElement;
  warehouseOutboundNeedsScanDifferenceConfirmation?: (
    scanPolicy: { mode: "hidden" | "optional" | "required" },
    missingScanCount: number,
  ) => boolean;
  warehouseOutboundDispatchScanError?: (
    scanPolicy: { mode: "hidden" | "optional" | "required"; isRequired: boolean },
    total: number,
    loaded: number,
    differenceConfirmed: boolean,
  ) => string | null;
  warehouseOutboundWorkflowSyncPending?: (orders: Array<{
    usesFrozenSnapshot?: boolean;
    currentStepKey?: string | null;
    loadingTargetStepKey?: string | null;
  }>) => boolean;
  warehouseOutboundTaskStage?: (
    task: {
      status: string;
      road_status: string | null;
      actual_departure_at: string | null;
      item_count: number;
      loaded_count: number;
    },
    scanPolicy?: { mode: "hidden" | "optional" | "required"; isRequired: boolean },
    loadingStage?: { available: boolean; reason: string | null },
    workflowSyncPending?: boolean,
  ) => { code: string; label: string; next: string; action: string; tone: string };
  DispatchCard?: (props: Record<string, unknown>) => ReactElement;
  NEW_OUTBOUND_DRIVER_ID?: string;
  validateNewOutboundDriverRegistration?: (input: {
    driverId: string;
    carrierId: string;
    name: string;
    phone: string;
    phoneRequired: boolean;
  }) => string | null;
};

const testExports = outboundRoute as typeof outboundRoute & OutboundRouteTestExports;

describe("warehouse outbound interaction safety", () => {
  it("validates an unregistered driver before the loading task can register and use it", () => {
    expect(testExports.NEW_OUTBOUND_DRIVER_ID).toBe("__new_outbound_driver__");
    const validate = testExports.validateNewOutboundDriverRegistration;
    expect(validate).toBeTypeOf("function");
    expect(validate?.({ driverId: "registered", carrierId: "", name: "", phone: "", phoneRequired: true })).toBeNull();
    expect(validate?.({ driverId: "__new_outbound_driver__", carrierId: "", name: "张三", phone: "13800001111", phoneRequired: true })).toContain("承运商");
    expect(validate?.({ driverId: "__new_outbound_driver__", carrierId: "carrier-1", name: "张", phone: "13800001111", phoneRequired: true })).toContain("2 个字符");
    expect(validate?.({ driverId: "__new_outbound_driver__", carrierId: "carrier-1", name: "张三", phone: "", phoneRequired: true })).toContain("手机号");
    expect(validate?.({ driverId: "__new_outbound_driver__", carrierId: "carrier-1", name: "张三", phone: "13800001111", phoneRequired: true })).toBeNull();
  });

  it("returns FTL dispatch success without requesting an automatic native print dialog", () => {
    expect(testExports.warehouseDispatchCompletionResult).toBeTypeOf("function");

    const result = testExports.warehouseDispatchCompletionResult?.({
      dispatchNumber: "OUT-001",
      businessType: "ftl",
      completionWarningText: "",
    });

    expect(result).toEqual({
      success: "OUT-001 已完成整车装车出库交接，车辆与司机信息已同步管理端；后续由订单的报关及出境运输节点确认实际出境",
    });
    expect(result).not.toHaveProperty("printHandoverSignal");
  });

  it("locks the barcode input while the previous scan submission is revalidating", () => {
    expect(testExports.OutboundBarcodeInput).toBeTypeOf("function");

    const busyMarkup = renderToStaticMarkup(
      testExports.OutboundBarcodeInput?.({ busy: true }) as ReactElement,
    );
    const idleMarkup = renderToStaticMarkup(
      testExports.OutboundBarcodeInput?.({ busy: false }) as ReactElement,
    );

    expect(busyMarkup).toContain("disabled");
    expect(idleMarkup).not.toContain("disabled");
  });

  it("fails closed when the server cannot prove the loading workflow policy", () => {
    expect(testExports.warehouseOutboundWorkflowActionError?.(null)).toBe(
      "当前订单工作流已隐藏装车与出库模块，不能继续办理",
    );
    expect(testExports.warehouseOutboundWorkflowActionError?.({
      loadingStage: {
        available: false,
        targetStepKey: "custom_loading_gate",
        targetStepName: "自定义装车办理",
        reason: "当前处于“国内运输完成”，进入“自定义装车办理”后开放装车与出库办理",
      },
    })).toBe("当前处于“国内运输完成”，进入“自定义装车办理”后开放装车与出库办理");
    expect(testExports.warehouseOutboundWorkflowActionError?.({
      loadingStage: {
        available: true,
        targetStepKey: "custom_loading_gate",
        targetStepName: "自定义装车办理",
        reason: null,
      },
    })).toBeNull();
  });

  it("synchronizes route fields against the frozen custom target instead of a canonical step key", () => {
    const stage = {
      available: true,
      targetStepKey: "custom_loading_gate",
      targetStepName: "自定义装车办理",
      reason: null,
    };
    expect(testExports.warehouseOutboundRouteSyncState?.(stage,"custom_loading_gate")).toEqual({
      targetStepKey: "custom_loading_gate",
      resynchronized: false,
      pendingReason: "当前仍处于“自定义装车办理”，尚有其他工作流必填项待补",
    });
    expect(testExports.warehouseOutboundRouteSyncState?.(stage,"next_custom_step")).toEqual({
      targetStepKey: "custom_loading_gate",
      resynchronized: true,
      pendingReason: null,
    });
    expect(testExports.warehouseOutboundRouteSyncState?.({ ...stage,targetStepKey:null },"port_loading")).toEqual({
      targetStepKey: null,
      resynchronized: null,
      pendingReason: "该历史订单没有冻结装车节点，路线已保存，但无法判定工作流同步结果",
    });
    expect(testExports.warehouseOutboundRouteSyncState?.(stage,null)).toEqual({
      targetStepKey: "custom_loading_gate",
      resynchronized: null,
      pendingReason: "工作流同步后未返回当前节点，请刷新后重试",
    });
  });

  it("renders a genuine read-only route view without disabled form controls", () => {
    expect(testExports.WarehouseOutboundRouteReadOnly).toBeTypeOf("function");
    const markup=renderToStaticMarkup(testExports.WarehouseOutboundRouteReadOnly?.({
      exitPort:"阿拉山口",
      customsLocation:"深圳海关",
      targetStepName:"自定义装车办理",
      reason:"当前节点仅可查看",
      exitPolicy:{isActive:true},
      customsPolicy:{isActive:true},
    }) as ReactElement);

    expect(markup).toContain("自定义装车办理");
    expect(markup).toContain("阿拉山口");
    expect(markup).toContain("深圳海关");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("disabled");
  });

  it("renders no route section when both frozen route fields are hidden", () => {
    const markup=renderToStaticMarkup(testExports.WarehouseOutboundRouteReadOnly?.({
      exitPort:"不应展示",
      customsLocation:"不应展示",
      targetStepName:"自定义装车办理",
      reason:"当前节点仅可查看",
      exitPolicy:{isActive:false},
      customsPolicy:{isActive:false},
    }) as ReactElement);

    expect(markup).toBe("");
  });

  it("does not require a second difference acknowledgement when scanning is hidden", () => {
    expect(testExports.warehouseOutboundNeedsScanDifferenceConfirmation).toBeTypeOf("function");
    expect(testExports.warehouseOutboundNeedsScanDifferenceConfirmation?.({mode:"hidden"},3)).toBe(false);
    expect(testExports.warehouseOutboundNeedsScanDifferenceConfirmation?.({mode:"optional"},3)).toBe(true);
    expect(testExports.warehouseOutboundNeedsScanDifferenceConfirmation?.({mode:"required"},3)).toBe(false);
  });

  it("re-evaluates the final frozen scan mode before physical dispatch", () => {
    expect(testExports.warehouseOutboundDispatchScanError).toBeTypeOf("function");
    expect(testExports.warehouseOutboundDispatchScanError?.(
      { mode: "required", isRequired: true }, 4, 3, true,
    )).toContain("逐件扫码为必填");
    expect(testExports.warehouseOutboundDispatchScanError?.(
      { mode: "optional", isRequired: false }, 4, 3, false,
    )).toContain("再次明确确认");
    expect(testExports.warehouseOutboundDispatchScanError?.(
      { mode: "hidden", isRequired: false }, 4, 0, false,
    )).toBeNull();
  });

  it("detects a completed physical dispatch whose frozen workflow still points at loading", () => {
    expect(testExports.warehouseOutboundWorkflowSyncPending).toBeTypeOf("function");
    expect(testExports.warehouseOutboundWorkflowSyncPending?.([{
      usesFrozenSnapshot: true,
      currentStepKey: "custom_loading",
      loadingTargetStepKey: "custom_loading",
    }])).toBe(true);
    expect(testExports.warehouseOutboundWorkflowSyncPending?.([{
      usesFrozenSnapshot: true,
      currentStepKey: "customs",
      loadingTargetStepKey: "custom_loading",
    }])).toBe(false);
  });

  it("uses each task frozen scan policy and synchronization state in the task center", () => {
    expect(testExports.warehouseOutboundTaskStage).toBeTypeOf("function");
    const task={status:"loading",road_status:null,actual_departure_at:null,item_count:4,loaded_count:0};
    expect(testExports.warehouseOutboundTaskStage?.(
      task,{mode:"hidden",isRequired:false},{available:true,reason:null},false,
    ).code).toBe("handover_ready");
    expect(testExports.warehouseOutboundTaskStage?.(
      task,{mode:"required",isRequired:true},{available:true,reason:null},false,
    ).code).toBe("waiting_scan");
    expect(testExports.warehouseOutboundTaskStage?.(
      task,{mode:"required",isRequired:true},{available:false,reason:"动态门禁关闭"},false,
    )).toMatchObject({code:"workflow_blocked",next:"动态门禁关闭"});
    expect(testExports.warehouseOutboundTaskStage?.(
      {...task,status:"dispatched"},{mode:"required",isRequired:true},{available:false,reason:null},true,
    ).code).toBe("workflow_sync_pending");
  });

  it("renders a warehouse viewer task as genuine read-only content without mutation controls", () => {
    const DispatchCard=testExports.DispatchCard;
    expect(DispatchCard).toBeTypeOf("function");
    const markup=renderToStaticMarkup(createElement(MemoryRouter,null,DispatchCard?DispatchCard({
      warehouseId:"warehouse-1",
      task:{
        id:"dispatch-1",dispatch_number:"OUT-001",business_type:"ltl",transport_batch_id:"batch-1",
        batch_number:"PZ-001",order_number:"SO-001",order_numbers:"SO-001",customer_name:"客户",
        customer_names:"客户",item_count:1,loaded_count:0,vehicle_plate:"新A001",driver_name:"司机",
        destination:"目的地",planned_departure_at:null,
      },
      items:[],itemPagination:{page:1,pageCount:1,pageSize:10,total:0},busy:false,canOperate:false,
      workflowPolicy:{
        loadingStage:{available:true,targetStepKey:"loading",targetStepName:"装车",reason:null},
        scanConfirmation:{isActive:true,isRequired:true,mode:"required"},
        batchFields:{planned_exit_at:{isActive:true,isRequired:true,mode:"required"}},
      },
      resourceDifferences:[],resourcePolicyError:null,
    }):null));
    expect(markup).toContain("当前账户仅可查看");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("disabled");
  });
});
