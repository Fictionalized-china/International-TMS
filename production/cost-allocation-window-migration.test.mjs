import {describe,expect,it} from 'vitest';
import {configuredCostWindowBody,applyConfiguredCostWindowMigration} from './cost-allocation-window-migration.mjs';
const body=`BEGIN IF (NOT EXISTS(SELECT 1 FROM workflow_instance_fields WHERE field_key='cost_allocation' AND actual_departure_at IS NULL AND finance_locked=0
    AND EXISTS (
      SELECT 1 FROM warehouse_dispatches dispatch
      WHERE dispatch.status='dispatched'
    )
    AND NOT EXISTS(SELECT 1 FROM order_tracking_milestones))) THEN SIGNAL SQLSTATE '45000'; END IF; END`;
describe('configured cost window migration',()=>{
  it('removes only the obsolete dispatch check and keeps the actual-exit, field and lock gates',()=>{
    const result=configuredCostWindowBody(body);expect(result).not.toContain('warehouse_dispatches');
    expect(configuredCostWindowBody(result)).toBe(result);
    for(const required of['actual_departure_at IS NULL','finance_locked=0','workflow_instance_fields','order_tracking_milestones'])expect(result).toContain(required);
    expect(()=>configuredCostWindowBody('BEGIN unknown END')).toThrow('Unrecognized');
  });
  it('does not drop an old guard if replacement creation fails',async()=>{
    const events=[],connection={query:async sql=>{events.push(sql);if(sql.startsWith('SELECT'))return[[{TRIGGER_NAME:'trg_cost_allocation_line_insert_frozen_gate',ACTION_TIMING:'BEFORE',EVENT_MANIPULATION:'INSERT',EVENT_OBJECT_TABLE:'transport_cost_allocation_lines',ACTION_STATEMENT:body}]];if(sql.startsWith('CREATE'))throw new Error('Cannot create trigger');return[[]];}};
    await expect(applyConfiguredCostWindowMigration(connection)).rejects.toThrow('Cannot create');expect(events.some(sql=>sql.startsWith('DROP'))).toBe(false);
  });
});
