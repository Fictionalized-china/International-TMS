import { spawnSync } from "node:child_process";

const compatibility = spawnSync(process.execPath, ["scripts/check-mysql-compatibility.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (compatibility.error) throw compatibility.error;
if (compatibility.status !== 0) process.exit(compatibility.status ?? 1);

const result = spawnSync(process.execPath, ["node_modules/@react-router/dev/bin.cjs", "build"], {
  cwd: process.cwd(),
  env: { ...process.env, TMS_RUNTIME: "mysql" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const sanitize = spawnSync(process.execPath, ["scripts/sanitize-build.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (sanitize.error) throw sanitize.error;
process.exit(sanitize.status ?? 0);
