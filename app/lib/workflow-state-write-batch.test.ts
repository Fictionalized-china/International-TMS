import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import { workflowModuleStateStatements, workflowStepStateStatements, type WorkflowStateWrite } from "./workflow-state-write-batch";

const open: DatabaseSync[]=[];
afterEach(()=>{for(const db of open.splice(0))db.close();});
function setup() {
  const sql=new DatabaseSync(":memory:");open.push(sql);
  sql.exec(`CREATE TABLE workflow_instance_step_states(id TEXT PRIMARY KEY,instance_id TEXT,status TEXT,started_at TEXT,completed_at TEXT,updated_at TEXT);
    CREATE TABLE workflow_instance_module_states(id TEXT PRIMARY KEY,instance_step_state_id TEXT,status TEXT,updated_at TEXT);`);
  return {sql,db:sqliteD1(sql)};
}
describe("set-based workflow projection writes",()=>{
  it("preserves the per-row status and timestamps across binding-limit chunks",async()=>{
    const {sql,db}=setup();const boundCounts:number[]=[];
    const prepare=db.prepare.bind(db);
    vi.spyOn(db,"prepare").mockImplementation(query=>{
      const statement=prepare(query),bind=statement.bind.bind(statement);
      statement.bind=(...values)=>{boundCounts.push(values.length);return bind(...values);};return statement;
    });
    const updates:WorkflowStateWrite[]=Array.from({length:75},(_,i)=>({id:`step-${i}`,status:i%3===0?"active":i%3===1?"completed":"pending"}));
    for(const [i,row] of updates.entries()) {
      sql.prepare("INSERT INTO workflow_instance_step_states VALUES(?,'instance','pending',?,?, 'old')").run(row.id,i%2?"started-before":null,i%2?"completed-before":null);
      sql.prepare("INSERT INTO workflow_instance_module_states VALUES(?,?,'active','old')").run(`module-${row.id}`,row.id);
    }
    await db.batch(workflowStepStateStatements(db,"instance",updates,"now"));
    await db.batch(workflowModuleStateStatements(db,"instance",updates.map(row=>({...row,id:`module-${row.id}`})),"now"));
    for(const [i,row] of updates.entries()) {
      expect(sql.prepare("SELECT status,started_at,completed_at,updated_at FROM workflow_instance_step_states WHERE id=?").get(row.id)).toEqual({status:row.status,started_at:i%2?"started-before":row.status==="active"?"now":null,completed_at:row.status==="completed"?(i%2?"completed-before":"now"):null,updated_at:"now"});
      expect(sql.prepare("SELECT status,updated_at FROM workflow_instance_module_states WHERE id=?").get(`module-${row.id}`)).toEqual({status:row.status,updated_at:"now"});
    }
    expect(Math.max(...boundCounts)).toBeLessThanOrEqual(100);
    expect(boundCounts.length).toBeLessThan(10);
  });
  it("does not update an id belonging to another workflow instance",async()=>{
    const {sql,db}=setup();
    sql.exec("INSERT INTO workflow_instance_step_states VALUES('foreign-step','foreign','pending',NULL,NULL,'old'); INSERT INTO workflow_instance_module_states VALUES('foreign-module','foreign-step','pending','old')");
    await db.batch(workflowStepStateStatements(db,"instance",[{id:"foreign-step",status:"completed"}],"now"));
    await db.batch(workflowModuleStateStatements(db,"instance",[{id:"foreign-module",status:"completed"}],"now"));
    expect(sql.prepare("SELECT status,updated_at FROM workflow_instance_step_states").get()).toEqual({status:"pending",updated_at:"old"});
    expect(sql.prepare("SELECT status,updated_at FROM workflow_instance_module_states").get()).toEqual({status:"pending",updated_at:"old"});
  });
  it("does not build empty IN clauses",()=>{
    const {db}=setup();
    expect(workflowModuleStateStatements(db,"instance",[],"now")).toEqual([]);
    expect(workflowStepStateStatements(db,"instance",[],"now")).toEqual([]);
  });
});
