import { describe,expect,it,vi } from 'vitest';
import { applyIsoTimestampMigration } from './iso-timestamp-migration.mjs';

describe('ISO timestamp native storage upgrade',()=>{
  it('converts only feature timestamps, preserves nullable columns and canonicalizes historical UTC dates',async()=>{
    const queries=[];
    const connection={query:vi.fn(async(sql,values)=>{
      queries.push({sql,values});
      if(sql.includes('information_schema.columns'))return [[
        {table_name:'order_daily_tracking',column_name:'event_at',data_type:'datetime',is_nullable:'NO',column_default:null,extra:''},
        {table_name:'loading_planning_submissions',column_name:'sync_started_at',data_type:'datetime',is_nullable:'YES',column_default:null,extra:''},
      ]];
      return [[]];
    })};
    await applyIsoTimestampMigration(connection);
    expect(queries.map(q=>q.sql).join('\n')).toContain('`event_at` VARCHAR(32) NOT NULL');
    expect(queries.map(q=>q.sql).join('\n')).toContain('`sync_started_at` VARCHAR(32) NULL');
    expect(queries[0].values).not.toContain('transport_orders');
    expect(queries[0].values).not.toContain('shipments');
    expect(queries.map(q=>q.sql).join('\n')).toContain("LIKE '____-__-__ __:__:__%'");
  });
  it('retries normalization without repeating a completed type conversion',async()=>{
    const connection={query:vi.fn(async sql=>sql.includes('information_schema.columns')?[[{table_name:'business_process_policies',column_name:'updated_at',data_type:'varchar',is_nullable:'NO'}]]:[[]])};
    await applyIsoTimestampMigration(connection);
    expect(connection.query.mock.calls.some(([sql])=>sql.startsWith('ALTER'))).toBe(false);
    expect(connection.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(true);
  });
  it('fails closed on a default or a target outside the explicit feature allowlist',async()=>{
    const column={table_name:'order_daily_tracking',column_name:'event_at',data_type:'datetime',is_nullable:'NO',column_default:'CURRENT_TIMESTAMP',extra:''};
    const connection={query:vi.fn(async()=>[[column]])};
    await expect(applyIsoTimestampMigration(connection)).rejects.toThrow('unexpected default');
    column.table_name='transport_orders';
    await expect(applyIsoTimestampMigration(connection)).rejects.toThrow('Unexpected timestamp migration target');
    expect(connection.query.mock.calls.some(([sql])=>sql.startsWith('ALTER'))).toBe(false);
  });
});
