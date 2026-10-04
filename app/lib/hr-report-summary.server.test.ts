import { describe,it,expect,vi } from 'vitest';
import { summarizeHrReport,type HrReportRow } from './hr-reports.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
describe('HR salesperson summary',()=>{
  it('keeps namesakes separate, shares one departure and does not add pending profit',()=>{
    const first:HrReportRow={id:'order1',order_number:'SO1',salesperson_user_id:'sales1',salesperson_name:'同名人员',status:'completed',paid_on:'2026-09-20',main_plates:'车1',transloading_plates:null,departure_count:1,departure_ids:'batch1',cost_pending:false,revenue:100,cost:60,profit:40,commission_amount:5,commission_status:'paid',commission_paid_on:'2026-09-21',commission_notes:'已发',commission_revision:1};
    const result=summarizeHrReport([first,{...first,id:'order2',order_number:'SO2',salesperson_user_id:'sales2',status:'in_execution',cost_pending:true,profit:null,commission_status:'pending'}]);
    expect(result).toMatchObject({completed:1,departures:1,pendingCost:1});
    expect(result.teams).toEqual([{id:'sales1',name:'同名人员',orders:1,completed:1,profit:40,pendingCost:0,commissionPaid:5},{id:'sales2',name:'同名人员',orders:1,completed:0,profit:0,pendingCost:1,commissionPaid:0}]);
  });
});
