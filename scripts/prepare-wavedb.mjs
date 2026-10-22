// Monorepo dev: compile TypeScript to dist/. npm tarball: skip (dist/ is prebuilt).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages/wavedb");

if (!existsSync(join(pkgDir, "src/index.ts"))) {
  process.exit(0);
}

const r = spawnSync("tsc", ["-p", "tsconfig.build.json"], { cwd: pkgDir, stdio: "inherit" });
process.exit(r.status ?? 1);
