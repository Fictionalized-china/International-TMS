// Explicit integration check against the disposable performance database only.
import assert from 'node:assert/strict';
if(process.env.TMS_TEST_MYSQL_ISOLATED!=='1'||process.env.MYSQL_HOST!=='127.0.0.1'||process.env.MYSQL_PORT!=='23317'||process.env.MYSQL_DATABASE!=='itms_candidate') throw new Error('Disposable MySQL opt-in required');
process.env.MYSQL_POOL_SIZE='1';
setTimeout(()=>{console.error('Isolated MySQL verification exceeded 90 seconds');process.exit(1);},90000).unref();
try {
  const {createMysqlD1Database}=await import('../app/runtime/mysql-d1.server.ts');
  const {workflowModuleStateStatements,workflowStepStateStatements}=await import('../app/lib/workflow-state-write-batch.ts');
  const db=createMysqlD1Database();
  // A single isolated pool connection keeps these temporary tables local to
  // this test and shadows the cloned tables without altering their real rows.
  await db.prepare('CREATE TEMPORARY TABLE workflow_instance_step_states(id VARCHAR(64) PRIMARY KEY,instance_id VARCHAR(64),status VARCHAR(32),started_at VARCHAR(64),completed_at VARCHAR(64),updated_at VARCHAR(64))').run();
  await db.prepare('CREATE TEMPORARY TABLE workflow_instance_module_states(id VARCHAR(64) PRIMARY KEY,instance_step_state_id VARCHAR(64),status VARCHAR(32),updated_at VARCHAR(64))').run();
  const updates=Array.from({length:75},(_,i)=>({id:`test-step-${i}`,status:['active','completed','pending'][i%3]}));
  const seed=[];
  for(const [i,row]of updates.entries()) {
    seed.push(db.prepare("INSERT INTO workflow_instance_step_states VALUES(?,'instance','pending',?,?,'old')").bind(row.id,i%2?'started-before':null,i%2?'completed-before':null));
    seed.push(db.prepare("INSERT INTO workflow_instance_module_states VALUES(?,?,'active','old')").bind(`module-${row.id}`,row.id));
  }
  seed.push(db.prepare("INSERT INTO workflow_instance_step_states VALUES('foreign-step','foreign','pending',NULL,NULL,'old')"));
  seed.push(db.prepare("INSERT INTO workflow_instance_module_states VALUES('foreign-module','foreign-step','pending','old')"));
  await db.batch(seed);
  const rows=async()=>({steps:(await db.prepare('SELECT * FROM workflow_instance_step_states ORDER BY id').all()).results,modules:(await db.prepare('SELECT * FROM workflow_instance_module_states ORDER BY id').all()).results});
  const original=await rows();
  const legacy=[];
  for(const row of updates) {
    legacy.push(db.prepare("UPDATE workflow_instance_step_states SET status=?,started_at=CASE WHEN ?='active' THEN COALESCE(started_at,?) ELSE started_at END,completed_at=CASE WHEN ?='completed' THEN COALESCE(completed_at,?) ELSE NULL END,updated_at=? WHERE id=?").bind(row.status,row.status,'now',row.status,'now','now',row.id));
    legacy.push(db.prepare('UPDATE workflow_instance_module_states SET status=?,updated_at=? WHERE id=?').bind(row.status,'now',`module-${row.id}`));
  }
  await db.batch(legacy);const expected=await rows();
  await db.batch([
    ...original.steps.map(row=>db.prepare('UPDATE workflow_instance_step_states SET status=?,started_at=?,completed_at=?,updated_at=? WHERE id=?').bind(row.status,row.started_at,row.completed_at,row.updated_at,row.id)),
    ...original.modules.map(row=>db.prepare('UPDATE workflow_instance_module_states SET status=?,updated_at=? WHERE id=?').bind(row.status,row.updated_at,row.id)),
  ]);
  const statements=[...workflowStepStateStatements(db,'instance',updates,'now'),...workflowModuleStateStatements(db,'instance',updates.map(row=>({...row,id:`module-${row.id}`})),'now')];
  await db.batch(statements);assert.deepEqual(await rows(),expected);
  await db.batch([...workflowStepStateStatements(db,'instance',[{id:'foreign-step',status:'completed'}],'wrong'),...workflowModuleStateStatements(db,'instance',[{id:'foreign-module',status:'completed'}],'wrong')]);
  assert.deepEqual(await rows(),expected);
  await db.prepare('CREATE TEMPORARY TABLE mutation_commit_guards(id VARCHAR(64) PRIMARY KEY,valid INT NOT NULL,created_at VARCHAR(64))').run();
  await assert.rejects(db.batch([
    ...workflowModuleStateStatements(db,'instance',[{id:'module-test-step-2',status:'completed'}],'must-rollback'),
    db.prepare('INSERT INTO mutation_commit_guards(id,valid,created_at) VALUES(?,NULL,?)').bind('guard','now'),
  ]),/mutation_commit_guards/);
  assert.deepEqual(await rows(),expected);
  console.log(JSON.stringify({ok:true,engine:'MySQL 8 isolated',rows:75,legacyStatements:legacy.length,batchedStatements:statements.length,identicalStatusAndTimestamps:true,foreignInstanceUnchanged:true,guardFailureRolledBack:true}));
  process.exit(0);
} catch(error) {console.error(error);process.exit(1);}
