import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const forbiddenBuildFiles = [resolve("build/server/.dev.vars")];

for (const filePath of forbiddenBuildFiles) {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

const remainingFiles = forbiddenBuildFiles.filter((filePath) => existsSync(filePath));
if (remainingFiles.length > 0) {
  throw new Error(`Build sanitization failed: ${remainingFiles.join(", ")}`);
}

console.log("Build sanitization passed: local environment files removed.");
