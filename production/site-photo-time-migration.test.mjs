import {describe,expect,it} from 'vitest';
import {applySitePhotoTimeMigration} from './site-photo-time-migration.mjs';
describe('feature-owned ISO timestamp parity',()=>{
  it('converts only the declared photo/job time columns and retains UTC milliseconds',async()=>{
    const queries=[],db={query:async(sql,values)=>{queries.push({sql,values});if(sql.startsWith('SELECT'))return [[{TABLE_NAME:'order_site_photos',COLUMN_NAME:'occurred_at',DATA_TYPE:'datetime',IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:''}]];return[[]];}};
    await applySitePhotoTimeMigration(db);expect(queries[1].sql).toBe('ALTER TABLE `order_site_photos` MODIFY COLUMN `occurred_at` VARCHAR(32) NOT NULL');
    expect(queries[2].sql).toContain("%Y-%m-%dT%H:%i:%s.");expect(queries[2].sql).toContain("LEFT(DATE_FORMAT");
    expect(queries.some(query=>query.sql.includes('transport_orders'))).toBe(false);
  });
  it('refuses an unrelated schema column rather than adjusting core business tables',async()=>{
    await expect(applySitePhotoTimeMigration({query:async()=>[[{table_name:'transport_orders',column_name:'created_at',data_type:'datetime',column_default:null,extra:''}]]})).rejects.toThrow('Unexpected');
  });
});
