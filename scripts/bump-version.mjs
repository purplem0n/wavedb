// Bump semver across monorepo packages. Patch auto-increments; at patch > 100 → patch 0, minor +1.
// Major (and optional minor) via BUMP=major|minor or --major / --minor.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_MAX = 100;

const versionPaths = [
  "package.json",
  "packages/wavedb/package.json",
  "packages/wave-cli/package.json",
  "packages/wave-studio/package.json",
  "packages/wavedb-darwin-arm64/package.json",
  "packages/wavedb-darwin-x64/package.json",
  "packages/wavedb-linux-arm64/package.json",
  "packages/wavedb-linux-x64/package.json",
  "packages/wavedb-win32-x64/package.json",
];

function parseArgs() {
  if (process.argv.includes("--major")) return "major";
  if (process.argv.includes("--minor")) return "minor";
  const env = process.env.BUMP?.toLowerCase();
  if (env === "major" || env === "minor" || env === "patch") return env;
  return "patch";
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(v);
  if (!m) throw new Error(`Invalid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function nextVersion(current, bump) {
  const [major, minor, patch] = parseSemver(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  let p = patch + 1;
  let mi = minor;
  if (p > PATCH_MAX) {
    p = 0;
    mi += 1;
  }
  return `${major}.${mi}.${p}`;
}

function readJson(rel) {
  const path = join(root, rel);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function writeJson({ path, data }) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

const bump = parseArgs();
const dryRun = process.argv.includes("--dry-run");
const source = readJson("packages/wavedb/package.json");
const current = source.data.version;
const next = nextVersion(current, bump);

if (dryRun) {
  console.log(`${current} -> ${next} (${bump})`);
  process.exit(0);
}

for (const rel of versionPaths) {
  const j = readJson(rel);
  j.data.version = next;
  writeJson(j);
}

console.log(`Bumped ${current} -> ${next} (${bump})`);

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  appendFileSync(outFile, `version=${next}\n`);
}
