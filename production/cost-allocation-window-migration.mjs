const definitions=[
  ['trg_cost_allocation_line_insert_frozen_gate','transport_cost_allocation_lines'],
  ['trg_cost_allocation_expense_frozen_gate','business_expenses'],
];
export function configuredCostWindowBody(body,table='transport_cost_allocation_lines'){
  for(const required of['workflow_instance_fields','actual_departure_at','finance_locked','cost_allocation'])if(!body.includes(required))throw new Error('Unrecognized cost allocation guard; refusing to replace it');
  let count=0;
  let result=body.replace(/AND EXISTS\s*\(\s*SELECT 1 FROM warehouse_dispatches dispatch[\s\S]*?\n\s*\)\s*(?=AND NOT EXISTS)/g,()=>{count++;return '';});
  if((body.includes('warehouse_dispatches')&&count!==1)||result.includes('warehouse_dispatches'))throw new Error('Unexpected physical dispatch predicate; original guard unchanged');
  // Older MySQL bootstraps still carry the pre-0177 body. Preserve that
  // condition, adding only 0177's existing server-authored planning exception.
  if(!result.includes('eligible_planned_cost_orders')){
    const match=result.match(/^BEGIN\s+IF\s*\(([\s\S]+)\)\s+THEN SIGNAL([\s\S]+)$/);
    if(!match)throw new Error('Unknown legacy cost guard structure; old guard retained');
    const allocation=table==='business_expenses'?"(SELECT allocation_id FROM transport_cost_allocation_lines WHERE id=NEW.source_id AND organization_id=NEW.organization_id)":"NEW.allocation_id";
    result=`BEGIN IF ((${match[1]}) AND NOT EXISTS(SELECT 1 FROM eligible_planned_cost_orders WHERE organization_id=NEW.organization_id AND order_id=NEW.order_id AND allocation_id=${allocation})) THEN SIGNAL${match[2]}`;
  }
  return result;
}
/** Create the replacement BEFORE dropping the old trigger: failure cannot
 * leave this write path without its existing database guard. */
export async function applyConfiguredCostWindowMigration(connection){
  const [rows]=await connection.query("SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_STATEMENT FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
  for(const [name,table]of definitions){
    const replacement=`${name}_configured`,existing=rows.find(row=>row.TRIGGER_NAME===name),current=rows.find(row=>row.TRIGGER_NAME===replacement);
    if(!existing){
      if(current&&current.ACTION_TIMING==='BEFORE'&&current.EVENT_MANIPULATION==='INSERT'&&current.EVENT_OBJECT_TABLE===table&&!current.ACTION_STATEMENT.includes('warehouse_dispatches')){if(configuredCostWindowBody(current.ACTION_STATEMENT,table)===current.ACTION_STATEMENT)continue;}
      throw new Error(`Missing known cost guard ${name}; no unguarded replacement attempted`);
    }
    if(existing.ACTION_TIMING!=='BEFORE'||existing.EVENT_MANIPULATION!=='INSERT'||existing.EVENT_OBJECT_TABLE!==table)throw new Error('Unexpected cost guard binding');
    const body=configuredCostWindowBody(existing.ACTION_STATEMENT,table);
    if(body===existing.ACTION_STATEMENT)continue;
    if(current){if(current.ACTION_STATEMENT.replaceAll(/\s+/g,' ').trim()!==body.replaceAll(/\s+/g,' ').trim())throw new Error('Replacement cost guard differs; old guard retained');}
    else try{await connection.query(`CREATE TRIGGER \`${replacement}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW ${body}`);}
    catch(error){if(error.code==='ER_BINLOG_CREATE_ROUTINE_NEED_SUPER')throw new Error('Migration 192 requires a database migration administrator to create triggers; original guards retained. No grants or global settings were changed.');throw error;}
    await connection.query(`DROP TRIGGER \`${name}\``);
  }
}
