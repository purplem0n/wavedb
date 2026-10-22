// Bump semver across monorepo packages and Cargo.toml [workspace.package]. Patch auto-increments; at patch > 100 → patch 0, minor +1.
// Baseline = max(package.json, latest v* git tag) so tags and manifests stay aligned.
// --align-only: if package.json is behind the latest tag, set versions to the tag (no increment).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const alignOnly = process.argv.includes("--align-only");
  if (process.argv.includes("--major")) return { bump: "major", alignOnly };
  if (process.argv.includes("--minor")) return { bump: "minor", alignOnly };
  const env = process.env.BUMP?.toLowerCase();
  const bump =
    env === "major" || env === "minor" || env === "patch" ? env : "patch";
  return { bump, alignOnly };
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(v);
  if (!m) throw new Error(`Invalid semver: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverCompare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function semverMax(a, b) {
  return semverCompare(a, b) >= 0 ? a : b;
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

function getLatestTagVersion() {
  const r = spawnSync("git", ["tag", "-l", "v*", "--sort=-v:refname"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  for (const line of r.stdout.trim().split("\n")) {
    const t = line.trim();
    if (!t.startsWith("v")) continue;
    const v = t.slice(1);
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  }
  return null;
}

function readJson(rel) {
  const path = join(root, rel);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function writeJson({ path, data }) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function writeCargoVersion(version) {
  const path = join(root, "Cargo.toml");
  const text = readFileSync(path, "utf8");
  const next = text.replace(
    /(\[workspace\.package\]\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (next === text) {
    throw new Error("Cargo.toml [workspace.package] version not found");
  }
  writeFileSync(path, next);
}

function writeVersionToAll(version) {
  for (const rel of versionPaths) {
    const j = readJson(rel);
    j.data.version = version;
    writeJson(j);
  }
  writeCargoVersion(version);
}

function githubOut(pairs) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  for (const [k, v] of pairs) {
    appendFileSync(outFile, `${k}=${v}\n`);
  }
}

const dryRun = process.argv.includes("--dry-run");
const { bump, alignOnly } = parseArgs();
const pkgVersion = readJson("packages/wavedb/package.json").data.version;
const tagVersion = getLatestTagVersion();
const released = tagVersion
  ? semverMax(pkgVersion, tagVersion)
  : pkgVersion;

if (alignOnly) {
  if (!tagVersion || semverCompare(pkgVersion, tagVersion) >= 0) {
    if (dryRun) console.log("align: already in sync");
    githubOut([
      ["aligned", "false"],
      ["version", pkgVersion],
    ]);
    process.exit(0);
  }
  if (dryRun) {
    console.log(`align: ${pkgVersion} -> ${tagVersion}`);
    process.exit(0);
  }
  writeVersionToAll(tagVersion);
  console.log(`Aligned package.json ${pkgVersion} -> ${tagVersion} (tag v${tagVersion})`);
  githubOut([
    ["aligned", "true"],
    ["version", tagVersion],
  ]);
  process.exit(0);
}

const next = nextVersion(released, bump);

if (dryRun) {
  console.log(
    `pkg=${pkgVersion} tag=${tagVersion ?? "none"} baseline=${released} -> ${next} (${bump})`,
  );
  process.exit(0);
}

writeVersionToAll(next);
console.log(
  `Bumped baseline ${released} -> ${next} (${bump}) [pkg=${pkgVersion}, tag=${tagVersion ?? "none"}]`,
);

githubOut([
  ["aligned", "false"],
  ["version", next],
]);
