import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Semver from this package's package.json (runtime — matches published @purplemon/wavedb). */
export function wavedbPackageVersion(): string {
  if (cached) return cached;
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  cached = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  return cached;
}
