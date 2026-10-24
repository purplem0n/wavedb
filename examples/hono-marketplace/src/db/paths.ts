import { join } from "node:path";

/** Package root (`examples/hono-marketplace`), from `src/db/paths.ts`. */
const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

/** Database path for the app, seed, and `bun run studio` (`scripts/studio-cli.ts` → `wave studio`). */
export function marketplaceWavePath(): string {
  return process.env.WAVE_DB_PATH ?? process.env.WAVE_PATH ?? join(PACKAGE_ROOT, "data.wave");
}
