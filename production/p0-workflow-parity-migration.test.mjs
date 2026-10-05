import { describe,it,expect,vi } from 'vitest';
import { applyP0WorkflowParityMigration } from './p0-workflow-parity-migration.mjs';
describe('native P0 meeting workflow parity',()=>{
  it('retains grants, enables tracking and covers versioned families and unfinished snapshots only',async()=>{
    const queries=[];const connection={query:vi.fn(async(sql,values)=>{queries.push({sql,values});return [[]];})};
    await applyP0WorkflowParityMigration(connection);
    expect(queries.some(q=>q.sql.startsWith('DELETE'))).toBe(false);
    expect(queries.some(q=>q.sql.includes("code IN ('OPERATION','TRACKING')")&&q.sql.includes("status='active'"))).toBe(true);
    expect(queries.some(q=>q.sql.includes("code='BUSINESS_SUPERVISOR'")&&q.sql.includes("status='disabled'"))).toBe(true);
    expect(queries.some(q=>q.sql.includes("tms-default%"))).toBe(true);
    const hotplug=queries.filter(q=>q.sql.startsWith('UPDATE workflow_instance')&&q.sql.includes('responsibility_position_code='));
    expect(hotplug.length).toBe(4);
    for(const query of hotplug)expect(query.sql).toContain("step.status NOT IN ('completed','not_applicable')");
    expect(queries.some(q=>/UPDATE transport_orders|UPDATE business_expenses/.test(q.sql))).toBe(false);
    expect(queries.some(q=>q.values?.includes('tracking.daily.manage'))).toBe(true);
  });
});
