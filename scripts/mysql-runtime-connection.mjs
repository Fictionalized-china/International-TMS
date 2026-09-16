import mysql from "mysql2/promise";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function createMysqlRuntimeConnection() {
  return mysql.createConnection({
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
    ssl: (process.env.MYSQL_SSL_MODE ?? "preferred").toLowerCase() === "required"
      ? { rejectUnauthorized: true }
      : undefined,
  });
}
