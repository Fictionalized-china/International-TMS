import { beforeEach, describe, expect, it, vi } from "vitest";

type Candidate = { instance_id:string; order_id:string; audit_only:number };
type OpenTask = {
  instance_id:string;
  target_step_key:string;
  module_code:string;
  field_key:string;
  field_label:string;
};
type RecordedStatement = {
  sql:string;
  bindings:unknown[];
  bind:(...bindings:unknown[])=>RecordedStatement;
  all:<T>()=>Promise<{results:T[]}>;
  first:<T>()=>Promise<T|null>;
  run:()=>Promise<{meta:{changes:number}}>;
};

const testState=vi.hoisted(()=>({
  candidates:[] as Candidate[],
  openTask:null as OpenTask|null,
  documentTotals:new Map<string,number>(),
  prepared:[] as RecordedStatement[],
  batches:[] as RecordedStatement[][],
  runStatements:[] as RecordedStatement[],
  fieldStates:new Map<string,boolean>(),
}));

vi.mock("./workflow-fields.server",()=>({
  loadOrderModuleWorkflowFields:vi.fn(async (_organizationId:string,orderId:string,moduleCode:string)=>[
    {
      stepKey:"order_creation",
      moduleCode,
      fieldKey:"custom_reference",
      present:testState.fieldStates.get(orderId)===true,
    },
  ]),
}));

vi.mock("cloudflare:workers",()=>({
  env:{
    DB:{
      prepare(sql:string){
        const statement:RecordedStatement={
          sql,
          bindings:[],
          bind(...bindings:unknown[]){statement.bindings=bindings;return statement;},
          async all<T>(){
            if(sql.includes("FROM workflow_instances wi")) {
              return {results:[...testState.candidates] as T[]};
            }
            return {results:[]};
          },
          async first<T>(){
            if(sql.includes("FROM workflow_supplement_tasks")) return testState.openTask as T|null;
            if(sql.includes("FROM order_attachments a")) {
              const orderId=String(statement.bindings[1]??"");
              return {total:testState.documentTotals.get(orderId)??0} as T;
            }
            return null;
          },
          async run(){
            testState.runStatements.push(statement);
            return {meta:{changes:1}};
          },
        };
        testState.prepared.push(statement);
        return statement;
      },
      async batch(statements:RecordedStatement[]){
        testState.batches.push(statements);
        return statements.map(()=>({meta:{changes:1}}));
      },
    },
  },
}));

import {
  completeWorkflowSupplementTask,
  synchronizeWorkflowSupplementTasks,
} from "./workflow-supplement.server";
import { loadOrderModuleWorkflowFields } from "./workflow-fields.server";

const baseSyncInput={
  organizationId:"org-1",
  workflowId:"workflow-1",
  targetStepKey:"order_creation",
  moduleCode:"assignment" as const,
  fieldKey:"custom_reference",
  fieldLabel:"补充编号",
  mode:"required" as const,
  actorUserId:"user-1",
};

describe("workflow supplement task presence reconciliation",()=>{
  beforeEach(()=>{
    testState.candidates.length=0;
    testState.openTask=null;
    testState.documentTotals.clear();
    testState.prepared.length=0;
    testState.batches.length=0;
    testState.runStatements.length=0;
    testState.fieldStates.clear();
    vi.mocked(loadOrderModuleWorkflowFields).mockClear();
  });

  it("creates a task only for a historical order whose real field is missing",async()=>{
    testState.candidates.push(
      {instance_id:"instance-present",order_id:"order-present",audit_only:0},
      {instance_id:"instance-missing",order_id:"order-missing",audit_only:0},
    );
    testState.fieldStates.set("order-present",true);
    testState.fieldStates.set("order-missing",false);

    const result=await synchronizeWorkflowSupplementTasks(baseSyncInput);

    expect(result).toEqual({created:1,cancelled:0,autoCompleted:1});
    const statements=testState.batches.flat();
    const inserts=statements.filter((statement)=>statement.sql.includes("INSERT OR IGNORE"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].bindings).toContain("order-missing");
    expect(inserts[0].bindings).not.toContain("order-present");
  });

  it("treats an existing order document as present and does not create a task",async()=>{
    testState.candidates.push({instance_id:"instance-doc",order_id:"order-doc",audit_only:0});
    testState.documentTotals.set("order-doc",1);

    const result=await synchronizeWorkflowSupplementTasks({
      ...baseSyncInput,
      moduleCode:"consignment",
      fieldKey:"document_consignment_letter",
      fieldLabel:"委托书",
    });

    expect(result.created).toBe(0);
    expect(testState.batches.flat().some((statement)=>statement.sql.includes("INSERT OR IGNORE"))).toBe(false);
    expect(loadOrderModuleWorkflowFields).not.toHaveBeenCalled();
  });

  it("refuses to complete an open task while the actual field is still missing",async()=>{
    testState.openTask={
      instance_id:"instance-1",
      target_step_key:"order_creation",
      module_code:"assignment",
      field_key:"custom_reference",
      field_label:"补充编号",
    };
    testState.fieldStates.set("order-1",false);

    await expect(completeWorkflowSupplementTask({
      organizationId:"org-1",
      orderId:"order-1",
      taskId:"task-1",
      actorUserId:"user-1",
      resolutionNote:"已经补录",
    })).rejects.toThrow("请先补齐“补充编号”的真实字段或文件");
    expect(testState.runStatements).toHaveLength(0);
  });

  it("completes an open task after the actual field becomes present",async()=>{
    testState.openTask={
      instance_id:"instance-1",
      target_step_key:"order_creation",
      module_code:"assignment",
      field_key:"custom_reference",
      field_label:"补充编号",
    };
    testState.fieldStates.set("order-1",true);

    await completeWorkflowSupplementTask({
      organizationId:"org-1",
      orderId:"order-1",
      taskId:"task-1",
      actorUserId:"user-1",
      resolutionNote:"已经补录",
    });

    expect(testState.runStatements).toHaveLength(1);
    expect(testState.runStatements[0].sql).toContain("SET status='completed'");
  });
});
