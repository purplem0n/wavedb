// Monorepo: build @purplemon/wavedb before wave-cli (dist/ is not in git).
// npm tarball: skip — ships prebuilt dist/ without src/.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "packages/wave-cli");
const wavedbDir = join(root, "packages/wavedb");

if (!existsSync(join(cliDir, "src/cli.ts"))) {
  process.exit(0);
}

const wavedbTypes = join(wavedbDir, "dist/index.d.ts");
if (!existsSync(wavedbTypes) && existsSync(join(wavedbDir, "tsconfig.build.json"))) {
  const r = spawnSync("tsc", ["-p", "tsconfig.build.json"], { cwd: wavedbDir, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const r = spawnSync("tsc", ["-p", "tsconfig.build.json"], { cwd: cliDir, stdio: "inherit" });
process.exit(r.status ?? 1);
