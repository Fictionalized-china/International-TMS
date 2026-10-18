// Run against the release environment. Only connection-local TEMPORARY tables are written.
import mysql from 'mysql2/promise';
const connection=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});
try {
  await connection.query('CREATE TEMPORARY TABLE tms_guard_probe(id INT PRIMARY KEY,value INT NOT NULL) ENGINE=InnoDB');
  await connection.query('CREATE TEMPORARY TABLE tms_commit_probe(id INT PRIMARY KEY,valid INT NOT NULL CHECK(valid=1)) ENGINE=InnoDB');
  await connection.execute('INSERT INTO tms_guard_probe VALUES(1,10)');
  await connection.beginTransaction();
  await connection.execute('UPDATE tms_guard_probe SET value=20 WHERE id=1');
  await connection.execute('INSERT INTO tms_commit_probe SELECT 1,CASE WHEN ROW_COUNT()=1 THEN 1 ELSE NULL END');
  const [valid]=await connection.execute('SELECT valid FROM tms_commit_probe WHERE id=1');
  if(Number(valid[0]?.valid)!==1)throw new Error('Successful write failed the guard');
  await connection.commit();
  await connection.beginTransaction();
  let refused=false;
  try {
    await connection.execute('UPDATE tms_guard_probe SET value=30 WHERE id=1');
    await connection.execute('UPDATE tms_guard_probe SET value=99 WHERE id=2');
    await connection.execute('INSERT INTO tms_commit_probe SELECT 2,CASE WHEN ROW_COUNT()=1 THEN 1 ELSE NULL END');
    const [rows]=await connection.execute('SELECT valid FROM tms_commit_probe WHERE id=2');
    if(Number(rows[0]?.valid)!==1)throw new Error('guard rejected');
  } catch {refused=true;}
  await connection.rollback();
  const [rows]=await connection.execute('SELECT value FROM tms_guard_probe WHERE id=1');
  if(!refused||Number(rows[0]?.value)!==20)throw new Error('Zero-row guard failed to roll back dependent writes');
  const [unchanged]=await connection.execute('UPDATE tms_guard_probe SET value=value WHERE id=1');
  if(unchanged.affectedRows!==1)throw new Error('MySQL client must report matched rows for conditional no-op locks');
  console.log('MySQL prepared ROW_COUNT guards: success, stale-write rollback and matched-row semantics passed. No persistent business rows changed.');
} finally {await connection.end();}
