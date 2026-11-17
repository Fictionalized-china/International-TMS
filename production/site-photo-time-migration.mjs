export async function applySitePhotoTimeMigration(connection){
  const tables=['order_site_photo_submissions','order_site_photos','physical_operation_sync_jobs'];
  const names=['created_at','updated_at','occurred_at'];
  const [columns]=await connection.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,extra FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name IN (?,?,?) AND column_name IN (?,?,?)`,[...tables,...names]);
  const normalized=columns.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key.toLowerCase(),value])));
  for(const column of normalized){
    if(!tables.includes(column.table_name)||!names.includes(column.column_name)||column.column_default!=null||column.extra)throw new Error('Unexpected site-photo timestamp target; no broad conversion allowed');
    const table=`\`${column.table_name}\``,field=`\`${column.column_name}\``;
    if(['datetime','timestamp'].includes(column.data_type))await connection.query(`ALTER TABLE ${table} MODIFY COLUMN ${field} VARCHAR(32) ${column.is_nullable==='YES'?'NULL':'NOT NULL'}`);
    else if(column.data_type!=='varchar')throw new Error('Unknown site-photo timestamp type');
    await connection.query(`UPDATE ${table} SET ${field}=CONCAT(DATE_FORMAT(CAST(${field} AS DATETIME(3)),'%Y-%m-%dT%H:%i:%s.'),LEFT(DATE_FORMAT(CAST(${field} AS DATETIME(3)),'%f'),3),'Z') WHERE ${field} LIKE '____-__-__ __:__:__%'`);
  }
}
