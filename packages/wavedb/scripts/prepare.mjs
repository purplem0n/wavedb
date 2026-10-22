// Monorepo: compile TypeScript to dist/. npm tarball: skip (dist/ is prebuilt).
import { cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(pkgDir, "src/index.ts"))) {
  process.exit(0);
}

const tscBin = join(pkgDir, "node_modules", "typescript", "bin", "tsc");
const tsc = existsSync(tscBin) ? [process.execPath, tscBin] : ["tsc"];
const r = spawnSync(tsc[0], tsc.slice(1).concat(["-p", "tsconfig.build.json"]), {
  cwd: pkgDir,
  stdio: "inherit",
});
if (r.status !== 0) process.exit(r.status ?? 1);

const pkgStudio = join(pkgDir, "studio");
const cliStudio = join(pkgDir, "..", "wave-cli", "studio");
if (!existsSync(join(pkgStudio, "index.html")) && existsSync(join(cliStudio, "index.html"))) {
  cpSync(cliStudio, pkgStudio, { recursive: true });
}

process.exit(0);
