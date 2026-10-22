#!/usr/bin/env node
/**
 * After npm/bun install: fetch prebuilt wave.<platform>-<arch>.node from GitHub
 * Releases when optional @purplemon/wavedb-* packages are missing (e.g. Linux on npm).
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = require(join(pkgRoot, "package.json"));

const platform = process.platform;
const arch = process.arch;
const file = `wave.${platform}-${arch}.node`;
const dest = join(pkgRoot, "native", file);

if (process.env.WAVE_SKIP_NATIVE_DOWNLOAD === "1") {
  process.exit(0);
}
if (existsSync(dest)) {
  process.exit(0);
}
try {
  require(`@purplemon/wavedb-${platform}-${arch}`);
  process.exit(0);
} catch {
  /* optional platform package not installed */
}

const repo = (process.env.WAVE_NATIVE_GITHUB_REPO || "purplem0n/wavedb").replace(/^\/+|\/+$/g, "");
const version = process.env.WAVE_NATIVE_VERSION || pkg.version;
const tag = version.startsWith("v") ? version : `v${version}`;
const url = `https://github.com/${repo}/releases/download/${tag}/${file}`;

const required = process.env.WAVE_NATIVE_REQUIRED === "1";

async function main() {
  console.log(`[wavedb] downloading ${file} from GitHub release ${tag}…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    const msg = `[wavedb] no prebuild at ${url} (HTTP ${res.status}). Install @purplemon/wavedb-${platform}-${arch}, set WAVE_NATIVE_PATH, or tag a GitHub release with native assets.`;
    if (required) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
    process.exit(0);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`[wavedb] installed native addon → ${dest}`);
}

main().catch((err) => {
  console.error(`[wavedb] native download failed: ${err.message}`);
  process.exit(required ? 1 : 0);
});
