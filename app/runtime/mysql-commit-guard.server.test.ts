import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
const mock=vi.hoisted(()=>{
  const connection={beginTransaction:vi.fn(async()=>{}),commit:vi.fn(async()=>{}),rollback:vi.fn(async()=>{}),release:vi.fn(),execute:vi.fn()};
  return {connection,pool:{pool:{on:vi.fn()},getConnection:vi.fn(async()=>connection)}};
});
vi.mock('mysql2/promise',()=>({default:{createPool:()=>mock.pool}}));
import { createMysqlD1Database } from './mysql-d1.server';
beforeEach(()=>{
  vi.clearAllMocks();for(const name of ['MYSQL_HOST','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD'])vi.stubEnv(name,'test-only');
});
afterEach(()=>vi.unstubAllEnvs());
describe('MySQL financial commit guards',()=>{
  it('rolls back even when a non-strict database silently stored zero',async()=>{
    mock.connection.execute.mockImplementation(async(sql:string)=>sql.startsWith('SELECT valid')?[[{valid:0}]]:[{affectedRows:1}]);
    const db=createMysqlD1Database();
    await expect(db.batch([db.prepare('INSERT INTO settlement_commit_guards(id,valid,created_at) SELECT ?,NULL,?').bind('guard','now'),db.prepare('UPDATE business_expenses SET amount=100')])).rejects.toThrow('settlement_commit_guards');
    expect(mock.connection.rollback).toHaveBeenCalledTimes(1);expect(mock.connection.commit).not.toHaveBeenCalled();
    expect(mock.connection.execute).toHaveBeenCalledTimes(2);
  });
  it('commits valid guards and refuses a non-transactional guard write',async()=>{
    mock.connection.execute.mockImplementation(async(sql:string)=>sql.startsWith('SELECT valid')?[[{valid:1}]]:[{affectedRows:1}]);
    const db=createMysqlD1Database();await db.batch([db.prepare('INSERT INTO settlement_commit_guards(id,valid,created_at) SELECT ?,1,?').bind('guard','now')]);
    expect(mock.connection.commit).toHaveBeenCalledTimes(1);
    await expect(db.prepare('INSERT INTO settlement_commit_guards(id,valid,created_at) SELECT ?,1,?').bind('guard','now').run()).rejects.toThrow('inside a transaction');
  });
});
