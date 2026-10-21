// Copy packages/wavedb/native/*.node into optional wavedb-<platform>-<arch> packages for npm.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = join(root, "packages", "wavedb", "native");
const pkgRoot = join(root, "packages");

const map = {
  "wave.darwin-arm64.node": "wavedb-darwin-arm64",
  "wave.darwin-x64.node": "wavedb-darwin-x64",
  "wave.linux-arm64.node": "wavedb-linux-arm64",
  "wave.linux-x64.node": "wavedb-linux-x64",
  "wave.win32-x64.node": "wavedb-win32-x64",
};

let n = 0;
for (const [file, pkg] of Object.entries(map)) {
  const src = join(nativeDir, file);
  if (!existsSync(src)) continue;
  const dir = join(pkgRoot, pkg);
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, file));
  writeFileSync(join(dir, "index.js"), `module.exports = require("./${file}");\n`);
  n++;
}

console.log(`synced ${n} native artifact(s) (${readdirSync(nativeDir).filter((f) => f.endsWith(".node")).join(", ")})`);
