// Copy packages/wave-studio/dist → embed targets for npm / GitHub installs.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages", "wave-studio", "dist");
const dests = [
  join(root, "packages", "wave-cli", "studio"),
  join(root, "packages", "wavedb", "studio"),
];

if (!existsSync(join(src, "index.html"))) {
  console.error("missing wave-studio build; run: bun run test:studio");
  process.exit(1);
}
for (const dest of dests) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  console.log(`studio assets -> ${dest}`);
}
