import { inspectMysqlSchema } from "../production/mysql-migrations.mjs";
import { createMysqlRuntimeConnection } from "./mysql-runtime-connection.mjs";

const connection = await createMysqlRuntimeConnection();
try {
  const status = await inspectMysqlSchema(connection);
  if (!status.ready) throw new Error(`MySQL runtime schema is not ready: ${JSON.stringify(status)}`);
  console.log(`MySQL runtime schema ready at version ${status.version}.`);
} finally {
  await connection.end();
}
