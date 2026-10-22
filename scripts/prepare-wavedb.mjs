// Monorepo dev: compile TypeScript to dist/. npm tarball: skip (dist/ is prebuilt).
import { cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages/wavedb");

if (!existsSync(join(pkgDir, "src/index.ts"))) {
  process.exit(0);
}

const r = spawnSync("tsc", ["-p", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

// GitHub / path installs only extract packages/wavedb — embed CLI studio copy when missing.
const pkgStudio = join(pkgDir, "studio");
const cliStudio = join(pkgDir, "..", "wave-cli", "studio");
if (!existsSync(join(pkgStudio, "index.html")) && existsSync(join(cliStudio, "index.html"))) {
  cpSync(cliStudio, pkgStudio, { recursive: true });
}

process.exit(0);
