import {EventEmitter} from 'node:events';
import {describe,it,expect} from 'vitest';
import {createRequestProfiler} from './profile-order-requests.mjs';

describe('opt-in request profiler',()=>{
  it('isolates concurrent requests and excludes SQL values and request context',async()=>{
    const logs=[];const profiler=createRequestProfiler({emit:value=>logs.push(JSON.parse(value))});
    const client=profiler.instrument({async execute(sql,values){await Promise.resolve();return values;}});
    const run=(path,sql)=>{
      const response=Object.assign(new EventEmitter(),{statusCode:200});
      return profiler.handle({url:path,method:'GET'},response,async()=>{
        const value=await client.execute(sql,['secret-password']);response.emit('finish');return value;
      });
    };
    expect(await Promise.all([run('/admin/orders/a?itmsTab=secret-window','SELECT ?'),run('/admin/orders/b?cookie=secret-cookie','UPDATE x SET y=?')])).toEqual([['secret-password'],['secret-password']]);
    expect(logs.map(row=>row.count)).toEqual([1,1]);
    expect(logs.map(row=>row.queries[0].command)).toEqual(['SELECT','UPDATE']);
    expect(JSON.stringify(logs)).not.toMatch(/secret-|SELECT \?|SET y/);
  });
  it('preserves errors and does not double-wrap a reused transaction connection',async()=>{
    const logs=[];const profiler=createRequestProfiler({emit:value=>logs.push(JSON.parse(value))});
    const failure=new Error('expected');
    const connection={async execute(){throw failure;},async release(){}};
    const pool=profiler.instrument({async getConnection(){return connection;}});
    const response=Object.assign(new EventEmitter(),{statusCode:500});
    await profiler.handle({url:'/',method:'POST'},response,async()=>{
      const first=await pool.getConnection(),second=await pool.getConnection();expect(first).toBe(second);
      await expect(first.execute('SELECT ?',[])).rejects.toBe(failure);response.emit('finish');
    });
    expect(logs[0].count).toBe(1);expect(logs[0].queries[0].failures).toBe(1);
  });
});
