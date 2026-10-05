import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMysqlRuntimeConnection } from './mysql-runtime-connection.mjs';
const connection=await createMysqlRuntimeConnection();
try {
  const [routines]=await connection.query('SELECT COUNT(*) count FROM information_schema.routines WHERE routine_schema=DATABASE()');
  const [events]=await connection.query('SELECT COUNT(*) count FROM information_schema.events WHERE event_schema=DATABASE()');
  if(Number(routines[0].count)||Number(events[0].count))throw new Error('Stored routines/events need a matching-version full backup client');
  const queries={
    users:'SELECT id,email,password_hash,status FROM users ORDER BY id',
    orders:'SELECT id,organization_id,order_number,customer_id,status,workflow_instance_id FROM transport_orders ORDER BY id',
    expenses:'SELECT id,organization_id,order_id,direction,stage,currency,amount,counterparty_name FROM business_expenses ORDER BY id',
  };
  const result={};
  for(const [name,sql] of Object.entries(queries)) {
    const [rows]=await connection.query(sql);
    result[name]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  if(process.argv[2]) {
    const previous=JSON.parse(await readFile(process.argv[2],'utf8'));
    if(JSON.stringify(previous)!==JSON.stringify(result))throw new Error('Deployment changed user, order, or expense core data');
    console.log('Core user/order/expense data unchanged');
  } else console.log(JSON.stringify(result,null,2));
}finally{await connection.end();}
