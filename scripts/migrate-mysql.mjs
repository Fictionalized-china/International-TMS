import { migrateMysql } from "../production/mysql-migrations.mjs";
import { createMysqlRuntimeConnection } from "./mysql-runtime-connection.mjs";

const connection = await createMysqlRuntimeConnection();
try {
  const status = await migrateMysql(connection);
  console.log(`MySQL migrations ready at version ${status.version}; applied: ${status.appliedVersions.join(",") || "none"}.`);
} finally {
  await connection.end();
}
