// Explicit integration check against the disposable performance database only.
import assert from 'node:assert/strict';
if(process.env.TMS_TEST_MYSQL_ISOLATED!=='1'||process.env.MYSQL_HOST!=='127.0.0.1'||process.env.MYSQL_PORT!=='23317'||process.env.MYSQL_DATABASE!=='itms_candidate') throw new Error('Disposable MySQL opt-in required');
process.env.MYSQL_POOL_SIZE='1';
setTimeout(()=>{console.error('Isolated MySQL verification exceeded 90 seconds');process.exit(1);},90000).unref();
try {
  const {createMysqlD1Database}=await import('../app/runtime/mysql-d1.server.ts');
  const {workflowModuleConfigurationStatements,workflowModuleStateStatements,workflowStepStateStatements}=await import('../app/lib/workflow-state-write-batch.ts');
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
  await db.prepare('CREATE TEMPORARY TABLE order_module_instances(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),order_id VARCHAR(64),module_name VARCHAR(128),enabled INT,is_required INT,status VARCHAR(32),current_step_code VARCHAR(64),current_step_name VARCHAR(128),progress_percent INT,updated_at VARCHAR(64))').run();
  const configuration=Array.from({length:140},(_,i)=>({id:`config-${i}`,name:i%3?`renamed-${i}`:null,enabled:i%2,required:Math.floor(i/2)%2,disabledReason:i%5?'disabled':'file index only'}));
  await db.batch(configuration.map((row,i)=>db.prepare("INSERT INTO order_module_instances VALUES(?,'org','order','original',1,1,?,'ready','current',75,'old')").bind(row.id,['not_applicable','completed','in_progress'][i%3])));
  await db.prepare("INSERT INTO order_module_instances VALUES('foreign','foreign-org','order','original',1,1,'completed','ready','current',75,'old')").run();
  const configRows=async()=>(await db.prepare('SELECT * FROM order_module_instances ORDER BY id').all()).results;
  const configOriginal=await configRows();
  await db.batch(configuration.map(row=>db.prepare("UPDATE order_module_instances SET module_name=COALESCE(?,module_name),enabled=?,is_required=?,status=CASE WHEN ?=0 THEN 'not_applicable' WHEN status='not_applicable' THEN 'not_started' ELSE status END,current_step_code=CASE WHEN ?=0 THEN NULL ELSE current_step_code END,current_step_name=CASE WHEN ?=0 THEN ? ELSE current_step_name END,progress_percent=CASE WHEN ?=0 THEN 0 ELSE progress_percent END,updated_at=? WHERE id=?").bind(row.name,row.enabled,row.required,row.enabled,row.enabled,row.enabled,row.disabledReason,row.enabled,'now',row.id)));
  const configExpected=await configRows();
  await db.batch(configOriginal.map(row=>db.prepare('UPDATE order_module_instances SET module_name=?,enabled=?,is_required=?,status=?,current_step_code=?,current_step_name=?,progress_percent=?,updated_at=? WHERE id=?').bind(row.module_name,row.enabled,row.is_required,row.status,row.current_step_code,row.current_step_name,row.progress_percent,row.updated_at,row.id)));
  const configStatements=workflowModuleConfigurationStatements(db,'org','order',[...configuration,{id:'foreign',name:'wrong',enabled:0,required:0,disabledReason:'wrong'}],'now');
  await db.batch(configStatements);assert.deepEqual(await configRows(),configExpected);
  await db.prepare('CREATE TEMPORARY TABLE mutation_commit_guards(id VARCHAR(64) PRIMARY KEY,valid INT NOT NULL,created_at VARCHAR(64))').run();
  await assert.rejects(db.batch([
    ...workflowModuleStateStatements(db,'instance',[{id:'module-test-step-2',status:'completed'}],'must-rollback'),
    ...workflowModuleConfigurationStatements(db,'org','order',[{id:'config-0',name:'must-rollback',enabled:1,required:1,disabledReason:'unused'}],'must-rollback'),
    db.prepare('INSERT INTO mutation_commit_guards(id,valid,created_at) VALUES(?,NULL,?)').bind('guard','now'),
  ]),/mutation_commit_guards/);
  assert.deepEqual(await rows(),expected);
  assert.deepEqual(await configRows(),configExpected);
  console.log(JSON.stringify({ok:true,engine:'MySQL 8 isolated',rows:75,legacyStatements:legacy.length,batchedStatements:statements.length,configurationRows:140,configurationStatements:configStatements.length,identicalStatusAndTimestamps:true,identicalConfiguration:true,foreignInstanceUnchanged:true,guardFailureRolledBack:true}));
  process.exit(0);
} catch(error) {console.error(error);process.exit(1);}
