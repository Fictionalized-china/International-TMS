import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { migrateMysql } from "../production/mysql-migrations.mjs";

const manifestPath = resolve(process.argv[2] ?? "production/mysql-bootstrap.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function connectionOptions() {
  const sslMode = (process.env.MYSQL_SSL_MODE ?? "preferred").toLowerCase();
  const ssl = sslMode === "required" ? { rejectUnauthorized: true } : undefined;
  return {
    host: required("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: required("MYSQL_DATABASE"),
    user: required("MYSQL_USER"),
    password: required("MYSQL_PASSWORD"),
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    decimalNumbers: true,
    multipleStatements: false,
    ssl,
  };
}

function decode(value) {
  if (value && typeof value === "object" && typeof value.$binary === "string") {
    return Buffer.from(value.$binary, "base64");
  }
  return value;
}

function mysqlForeignKeySql(foreignKey) {
  // SQLite permits an organization delete to reach the same child through several
  // cascade paths. MySQL rejects some of those graphs while adding the constraint.
  // Production organizations must be deactivated, not hard-deleted, so restricting
  // root-organization deletes is both safer and preserves every non-root FK action.
  if (foreignKey.parent === "organizations" && /ON DELETE CASCADE\b/.test(foreignKey.sql)) {
    return foreignKey.sql.replace(/ON DELETE CASCADE\b/, "ON DELETE RESTRICT");
  }
  return foreignKey.sql;
}

function mysqlRestrictiveForeignKeyFallback(sql) {
  if (/ON DELETE (?:CASCADE|SET NULL)\b/.test(sql)) {
    return sql.replace(/ON DELETE (?:CASCADE|SET NULL)\b/, "ON DELETE RESTRICT");
  }
  return null;
}

async function tableNames(connection) {
  const [rows] = await connection.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
  );
  return rows.map((row) => row.TABLE_NAME ?? row.table_name);
}

async function removeOwnedObjects(connection) {
  await connection.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const trigger of [...manifest.triggers].reverse()) {
      await connection.query(`DROP TRIGGER IF EXISTS \`${trigger.name.replaceAll("`", "``")}\``);
    }
    for (const table of [...manifest.tables].reverse()) {
      await connection.query(`DROP TABLE IF EXISTS \`${table.table.replaceAll("`", "``")}\``);
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS=1");
  }
}

async function insertSeed(connection) {
  for (const group of manifest.seed) {
    if (group.rows.length === 0) continue;
    const columns = Object.keys(group.rows[0]);
    const quoted = columns.map((column) => `\`${column.replaceAll("`", "``")}\``).join(",");
    for (let start = 0; start < group.rows.length; start += 100) {
      const chunk = group.rows.slice(start, start + 100);
      const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
      const values = chunk.flatMap((row) => columns.map((column) => decode(row[column])));
      await connection.execute(
        `INSERT INTO \`${group.table.replaceAll("`", "``")}\` (${quoted}) VALUES ${placeholders}`,
        values,
      );
    }
    process.stdout.write(`Seeded ${group.table}: ${group.rows.length}\n`);
  }
}

const connection = await mysql.createConnection(connectionOptions());
try {
  await connection.query("SET SESSION time_zone='+00:00'");
  await connection.query(
    "CREATE TABLE IF NOT EXISTS `_tms_mysql_bootstrap` (" +
      "`id` TINYINT NOT NULL PRIMARY KEY,`schema_sha256` CHAR(64) NOT NULL," +
      "`status` VARCHAR(16) NOT NULL,`started_at` DATETIME(3) NOT NULL," +
      "`completed_at` DATETIME(3) NULL,`error_message` VARCHAR(512) NULL" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci",
  );
  const [stateRows] = await connection.query("SELECT * FROM `_tms_mysql_bootstrap` WHERE id=1");
  const current = stateRows[0];
  const existingTables = (await tableNames(connection)).filter((name) => name !== "_tms_mysql_bootstrap");

  if (current?.status === "ready" && current.schema_sha256 === manifest.schemaSha256) {
    console.log("MySQL schema already initialized and verified by bootstrap hash.");
    process.exitCode = 0;
  } else {
    if (existingTables.length && !current) {
      throw new Error("Refusing to initialize a non-empty database not owned by this bootstrap.");
    }
    if (current && current.schema_sha256 !== manifest.schemaSha256) {
      throw new Error("Database belongs to a different schema bootstrap; automatic overwrite is refused.");
    }
    if (existingTables.length) await removeOwnedObjects(connection);
    await connection.execute(
      "INSERT INTO `_tms_mysql_bootstrap` (id,schema_sha256,status,started_at,completed_at,error_message) " +
        "VALUES (1,?,'initializing',UTC_TIMESTAMP(3),NULL,NULL) " +
        "ON DUPLICATE KEY UPDATE status='initializing',started_at=UTC_TIMESTAMP(3),completed_at=NULL,error_message=NULL",
      [manifest.schemaSha256],
    );
    try {
      for (const table of manifest.tables) await connection.query(table.sql);
      for (const index of manifest.indexes) await connection.query(index.sql);
      for (const index of manifest.partialIndexes) {
        for (const statement of index.sql) await connection.query(statement);
      }
      await insertSeed(connection);
      for (const foreignKey of manifest.foreignKeys) {
        const sql = mysqlForeignKeySql(foreignKey);
        try {
          await connection.query(sql);
        } catch (error) {
          const restrictiveFallbackErrors = new Set([
            1215, // MySQL rejects an incompatible cascade graph.
            3823, // A referential action conflicts with a CHECK constraint.
          ]);
          const fallbackSql = restrictiveFallbackErrors.has(error?.errno)
            ? mysqlRestrictiveForeignKeyFallback(sql)
            : null;
          if (fallbackSql && fallbackSql !== sql) {
            try {
              await connection.query(fallbackSql);
              console.warn(
                `MySQL rejected the cascading delete graph for ${foreignKey.name}; ` +
                  "installed the same relationship with ON DELETE RESTRICT.",
              );
              continue;
            } catch {
              // Fall through to the full diagnostic for the original relationship.
            }
          }
          console.error(`Failed foreign key ${foreignKey.name} on ${foreignKey.table}:`);
          console.error(sql);
          try {
            const [warningRows] = await connection.query("SHOW WARNINGS");
            for (const warning of warningRows) {
              console.error(
                `MySQL warning ${warning.Code ?? warning.code ?? ""}: ${warning.Message ?? warning.message ?? ""}`,
              );
            }
            const [engineRows] = await connection.query("SHOW ENGINE INNODB STATUS");
            const status = String(engineRows[0]?.Status ?? engineRows[0]?.STATUS ?? "");
            const marker = "LATEST FOREIGN KEY ERROR";
            const start = status.indexOf(marker);
            if (start >= 0) {
              const section = status.slice(start, start + 4000);
              console.error(section);
            }
          } catch (statusError) {
            console.error("Unable to read InnoDB status:", statusError);
          }
          throw error;
        }
      }
      for (const trigger of manifest.triggers) await connection.query(trigger.sql);
      await connection.execute(
        "UPDATE `_tms_mysql_bootstrap` SET status='ready',completed_at=UTC_TIMESTAMP(3),error_message=NULL WHERE id=1",
      );
      console.log(
        `MySQL initialized: ${manifest.expected.applicationTables} tables, ` +
          `${manifest.expected.foreignKeys} foreign keys, ${manifest.expected.triggers} triggers.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const keepFailedSchema = process.env.MYSQL_INIT_KEEP_FAILED_SCHEMA === "1";
      if (!keepFailedSchema) {
        await removeOwnedObjects(connection).catch(() => undefined);
      }
      await connection.execute(
        "UPDATE `_tms_mysql_bootstrap` SET status='failed',completed_at=UTC_TIMESTAMP(3),error_message=? WHERE id=1",
        [message],
      );
      if (keepFailedSchema) {
        console.error("Failed schema retained for diagnostics because MYSQL_INIT_KEEP_FAILED_SCHEMA=1.");
      }
      throw error;
    }
  }
  const migrationStatus = await migrateMysql(connection);
  console.log(`MySQL incremental schema ready at version ${migrationStatus.version}.`);
} finally {
  await connection.end();
}
