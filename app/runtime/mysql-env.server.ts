import { createMysqlD1Database } from "./mysql-d1.server";

export const env = {
  DB: createMysqlD1Database(),
  APP_NAME: process.env.APP_NAME ?? "International TMS",
  APP_ENV: process.env.APP_ENV ?? process.env.NODE_ENV ?? "production",
  SESSION_TTL_SECONDS: process.env.SESSION_TTL_SECONDS ?? "28800",
  BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN ?? "",
} as unknown as Cloudflare.Env;
