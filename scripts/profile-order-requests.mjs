// Explicit, loopback-only diagnostic launcher. Never import from the normal server.
import http from 'node:http';
import mysql from 'mysql2/promise';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function createRequestProfiler({emit=console.log,now=()=>performance.now()}={}) {
  const context=new AsyncLocalStorage();
  const wrapped=new WeakSet();
  function instrument(client) {
    if(wrapped.has(client)) return client;
    wrapped.add(client);
    for(const name of ['execute','query','beginTransaction','commit','rollback']) {
      if(typeof client[name]!=='function') continue;
      const original=client[name];
      client[name]=function(...args) {
        const stats=context.getStore();
        if(!stats) return original.apply(this,args);
        const started=now();
        const sql=typeof args[0]==='string'?args[0]:args[0]?.sql;
        const key=sql?createHash('sha256').update(sql).digest('hex').slice(0,12):name;
        const command=sql?/^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase()??'OTHER':name.toUpperCase();
        let row=stats.queries.get(key);
        if(!row) {
          row={key,command,count:0,milliseconds:0,failures:0,caller:new Error().stack?.split('\n').slice(4,6).map(line=>line.replace(/file:\/\/[^ ]*\//g,'').trim())};
          stats.queries.set(key,row);
        }
        row.count++;
        try {
          return Promise.resolve(original.apply(this,args)).then(result=>{
            row.milliseconds+=now()-started;return result;
          },error=>{row.milliseconds+=now()-started;row.failures++;throw error;});
        } catch(error) {row.milliseconds+=now()-started;row.failures++;throw error;}
      };
    }
    if(typeof client.getConnection==='function') {
      const acquire=client.getConnection;
      client.getConnection=async function(...args) {
        const stats=context.getStore(),started=now();
        try {return instrument(await acquire.apply(this,args));}
        finally {if(stats) stats.acquireMilliseconds+=now()-started;}
      };
    }
    return client;
  }
  function handle(request,response,listener) {
    const stats={started:now(),queries:new Map(),acquireMilliseconds:0};
    // Only the path class is logged. Query strings include session/window context.
    const path=(request.url??'/').split('?')[0];
    const kind=path.includes('/orders/')?'order':path.includes('/orders')?'orders':path.includes('/login')?'login':'other';
    response.once('finish',()=>{
      const queries=[...stats.queries.values()];
      // Bound each log record: journald splits very large JSON lines, making the
      // diagnostic data unreadable. Counts cover all queries; details are top 16.
      emit(JSON.stringify({kind,method:request.method,status:response.statusCode,milliseconds:Math.round(now()-stats.started),acquireMilliseconds:Math.round(stats.acquireMilliseconds),count:queries.reduce((sum,item)=>sum+item.count,0),queryShapes:queries.length,queries:queries.sort((a,b)=>b.count-a.count||b.milliseconds-a.milliseconds).slice(0,16).map(item=>({...item,milliseconds:Math.round(item.milliseconds)}))}));
    });
    return context.run(stats,()=>listener(request,response));
  }
  return {instrument,handle};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.env.TMS_PROFILE_LOCAL!=='1'||!['127.0.0.1','::1'].includes(process.env.HOST??'127.0.0.1')) throw new Error('Profiler requires explicit loopback opt-in');
  const profiler=createRequestProfiler();
  const createPool=mysql.createPool;
  mysql.createPool=(...args)=>profiler.instrument(createPool(...args));
  const createServer=http.createServer;
  http.createServer=function(listener) {
    return createServer.call(this,(request,response)=>profiler.handle(request,response,listener));
  };
  syncBuiltinESMExports();
  await import('../production/server.mjs');
}
