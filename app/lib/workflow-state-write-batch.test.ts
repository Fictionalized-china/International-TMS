import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "./sqlite-d1-test-helper";
import { workflowModuleConfigurationStatements, workflowModuleStateStatements, workflowStepStateStatements, type WorkflowModuleConfigurationWrite, type WorkflowStateWrite } from "./workflow-state-write-batch";

const open: DatabaseSync[]=[];
afterEach(()=>{for(const db of open.splice(0))db.close();});
function setup() {
  const sql=new DatabaseSync(":memory:");open.push(sql);
  sql.exec(`CREATE TABLE workflow_instance_step_states(id TEXT PRIMARY KEY,instance_id TEXT,status TEXT,started_at TEXT,completed_at TEXT,updated_at TEXT);
    CREATE TABLE workflow_instance_module_states(id TEXT PRIMARY KEY,instance_step_state_id TEXT,status TEXT,updated_at TEXT);`);
  return {sql,db:sqliteD1(sql)};
}
describe("set-based workflow projection writes",()=>{
  it("matches every legacy configuration field across mixed rules and binding chunks",async()=>{
    const {sql,db}=setup();
    sql.exec(`CREATE TABLE order_module_instances(id TEXT PRIMARY KEY,organization_id TEXT,order_id TEXT,module_name TEXT,enabled INTEGER,is_required INTEGER,status TEXT,current_step_code TEXT,current_step_name TEXT,progress_percent INTEGER,updated_at TEXT)`);
    const updates:WorkflowModuleConfigurationWrite[]=Array.from({length:140},(_,i)=>({id:`module-${i}`,name:i%3?`renamed-${i}`:null,enabled:i%2,required:Math.floor(i/2)%2,disabledReason:i%5?"未启用":"文件仅查询"}));
    for(const [i,row] of updates.entries())sql.prepare("INSERT INTO order_module_instances VALUES(?,'org','order','original',1,1,?,'ready','current',75,'old')").run(row.id,['not_applicable','completed','in_progress'][i%3]);
    sql.exec("INSERT INTO order_module_instances VALUES('foreign','other-org','order','original',1,1,'completed','ready','current',75,'old')");
    const original=sql.prepare('SELECT * FROM order_module_instances ORDER BY id').all();
    for(const row of updates)await db.prepare(`UPDATE order_module_instances SET module_name=COALESCE(?,module_name),enabled=?,is_required=?,status=CASE WHEN ?=0 THEN 'not_applicable' WHEN status='not_applicable' THEN 'not_started' ELSE status END,current_step_code=CASE WHEN ?=0 THEN NULL ELSE current_step_code END,current_step_name=CASE WHEN ?=0 THEN ? ELSE current_step_name END,progress_percent=CASE WHEN ?=0 THEN 0 ELSE progress_percent END,updated_at=? WHERE id=?`).bind(row.name,row.enabled,row.required,row.enabled,row.enabled,row.enabled,row.disabledReason,row.enabled,'now',row.id).run();
    const expected=sql.prepare('SELECT * FROM order_module_instances ORDER BY id').all();
    sql.exec('DELETE FROM order_module_instances');
    for(const row of original)sql.prepare('INSERT INTO order_module_instances VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row) as (string|number|null)[]);
    const sizes:number[]=[];const prepare=db.prepare.bind(db);
    vi.spyOn(db,'prepare').mockImplementation(query=>{const stmt=prepare(query),bind=stmt.bind.bind(stmt);stmt.bind=(...values)=>{sizes.push(values.length);return bind(...values);};return stmt;});
    await db.batch(workflowModuleConfigurationStatements(db,'org','order',[...updates,{id:'foreign',name:'wrong',enabled:0,required:0,disabledReason:'wrong'}],'now'));
    expect(sql.prepare('SELECT * FROM order_module_instances ORDER BY id').all()).toEqual(expected);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.length).toBeLessThan(20);
    expect(workflowModuleConfigurationStatements(db,'org','order',[],'now')).toEqual([]);
  });
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
