import { join } from "node:path";

/** Package root (`examples/hono-marketplace`), from `src/db/paths.ts`. */
const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

/** Same path `wave studio` uses when run from the example directory. */
export function marketplaceWavePath(): string {
  return process.env.WAVE_PATH ?? join(PACKAGE_ROOT, "data.wave");
}
