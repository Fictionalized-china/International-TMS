import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestListener } from "@react-router/node";
import mysql from "mysql2/promise";
import * as build from "../build/server/index.js";
import { inspectMysqlSchema } from "./mysql-migrations.mjs";
import { resolveStaticRequestPath, safeRequestPathname } from "./server-utils.mjs";

const root = resolve(fileURLToPath(new URL("../build/client", import.meta.url)));
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3100);
const listener = createRequestListener({ build, mode: process.env.NODE_ENV ?? "production" });
let readinessPool;
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function getReadinessPool() {
  if (readinessPool) return readinessPool;
  readinessPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    connectionLimit: 1,
    waitForConnections: true,
    queueLimit: 1,
    connectTimeout: Number(process.env.MYSQL_CONNECT_TIMEOUT_MS ?? 5000),
  });
  return readinessPool;
}

async function isDatabaseReady() {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE || !process.env.MYSQL_USER) {
    return { ready: false, reason: "configuration_missing" };
  }
  const connection = await getReadinessPool().getConnection();
  try {
    return inspectMysqlSchema(connection);
  } finally {
    connection.release();
  }
}

async function serveStatic(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const resolved = resolveStaticRequestPath(root, request.url, request.headers.host);
  if (resolved.kind !== "candidate") return false;
  const { path: candidate, pathname } = resolved;
  try {
    if (!(await stat(candidate)).isFile()) return false;
  } catch {
    return false;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", mime[extname(candidate)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
  if (request.method === "HEAD") response.end();
  else {
    const stream = createReadStream(candidate);
    stream.on("error", (error) => {
      console.error("Static asset read failed", { candidate, error });
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "static_asset_read_failed" });
      else response.destroy(error);
    });
    stream.pipe(response);
  }
  return true;
}

async function handleRequest(request, response) {
  if (safeRequestPathname(request.url, request.headers.host).kind === "malformed") {
    sendJson(response, 400, { ok: false, error: "malformed_url" });
    return;
  }
  if (request.url === "/healthz") {
    sendJson(response, 200, { ok: true, service: "international-tms" });
    return;
  }
  if (request.url === "/readyz") {
    try {
      const database = await isDatabaseReady();
      sendJson(response, database.ready ? 200 : 503, {
        ok: database.ready,
        service: "international-tms",
        database: database.ready ? "ready" : "schema_not_ready",
        schemaVersion: database.version ?? null,
        requiredSchemaVersion: database.requiredVersion ?? null,
      });
    } catch (error) {
      console.error("Database readiness check failed", error);
      sendJson(response, 503, { ok: false, service: "international-tms", database: "unavailable" });
    }
    return;
  }
  if (await serveStatic(request, response)) return;
  await listener(request, response);
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error("Unhandled request failure", error);
    if (response.headersSent || response.destroyed) {
      if (!response.destroyed) response.destroy(error);
      return;
    }
    sendJson(response, 500, { ok: false, error: "internal_server_error" });
  });
});

server.listen(port, host, () => {
  console.log(`International TMS listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(async () => {
    if (readinessPool) await readinessPool.end();
    process.exit(0);
  }));
}
