import { describe,it,expect,vi } from 'vitest';
import { applyMeetingFlowMigration } from './meeting-flow-migration.mjs';
describe('native MySQL meeting migration contract',()=>{
  it('creates all local feature tables and planned allocation eligibility without executing at import',async()=>{
    const queries=[];
    const connection={query:vi.fn(async(sql,bindings)=>{queries.push({sql,bindings});return [[]];})};
    const addColumn=vi.fn(async()=>{});
    await applyMeetingFlowMigration(connection,addColumn);
    const tables=queries.filter(q=>q.sql.startsWith('CREATE TABLE')).map(q=>q.sql.match(/EXISTS (\w+)/)[1]);
    expect(tables).toEqual(['business_process_policies','business_process_policy_history','order_daily_tracking','order_dispatch_requests','order_payable_offline_approvals','order_commission_records','order_commission_history','hr_report_snapshots','settlement_commit_guards','settlement_cash_allocation_requests']);
    expect(addColumn).toHaveBeenCalledWith(connection,'quotations','intake_payload_hash','VARCHAR(64) NULL');
    expect(addColumn).toHaveBeenCalledWith(connection,'transport_cost_allocations','creation_mode',"VARCHAR(32) NOT NULL DEFAULT 'post_dispatch'");
    const view=queries.find(q=>q.sql.includes('CREATE OR REPLACE VIEW eligible_planned_cost_orders')).sql;
    expect(view).toContain("submission.sync_status='pending'");
    expect(view).toContain("job.status='allocated'");
    expect(view).toContain("o.business_type='ltl'");
    expect(view).toContain("control.finance_locked=1");
    expect(queries.some(q=>q.sql.includes('CREATE UNIQUE INDEX cash_submission_once'))).toBe(true);
  });
});
