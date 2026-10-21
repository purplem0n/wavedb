// Publish @purplemon/wavedb, optional native packages, and @purplemon/wave-cli to npm.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const otpArg = process.argv.find((a) => a.startsWith("--otp"));
const access = ["--access", "public", ...(otpArg ? [otpArg] : [])];

const nativeFolders = [
  "wavedb-darwin-arm64",
  "wavedb-darwin-x64",
  "wavedb-linux-arm64",
  "wavedb-linux-x64",
  "wavedb-win32-x64",
];

function readJson(rel) {
  const path = join(root, rel);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function writeJson({ path, data }) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function npmPublish(cwd) {
  const args = ["publish", ...access];
  if (dryRun) args.push("--dry-run");
  const r = spawnSync("npm", args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function hasNativeBinary(folder) {
  const dir = join(root, "packages", folder);
  return readdirSync(dir).some((f) => f.endsWith(".node"));
}

const wavedbPkg = readJson("packages/wavedb/package.json");
const version = wavedbPkg.data.version;

for (const folder of nativeFolders) {
  const j = readJson(join("packages", folder, "package.json"));
  if (j.data.version !== version) {
    console.error(`${folder} version ${j.data.version} != wavedb ${version}`);
    process.exit(1);
  }
}

console.log(`Publishing @purplemon/* @ ${version}${dryRun ? " (dry-run)" : ""}`);

const publishedNative = [];
for (const folder of nativeFolders) {
  if (!hasNativeBinary(folder)) {
    console.log(`skip ${folder} (no .node built)`);
    continue;
  }
  console.log(`\n==> ${folder}`);
  npmPublish(join(root, "packages", folder));
  publishedNative.push(readJson(join("packages", folder, "package.json")).data.name);
}

const wavedbPath = wavedbPkg.path;
const wavedbOrig = structuredClone(wavedbPkg.data);
wavedbPkg.data.optionalDependencies = Object.fromEntries(
  publishedNative.map((name) => [name, version]),
);
writeJson(wavedbPkg);
try {
  console.log("\n==> @purplemon/wavedb");
  npmPublish(join(root, "packages", "wavedb"));
} finally {
  writeJson({ path: wavedbPath, data: wavedbOrig });
}

const cliPkg = readJson("packages/wave-cli/package.json");
const cliPath = cliPkg.path;
const cliOrig = structuredClone(cliPkg.data);
cliPkg.data.dependencies = { "@purplemon/wavedb": version };
writeJson(cliPkg);
try {
  console.log("\n==> @purplemon/wave-cli");
  npmPublish(join(root, "packages", "wave-cli"));
} finally {
  writeJson({ path: cliPath, data: cliOrig });
}

console.log(dryRun ? "\nDry-run complete." : "\nPublished to npm.");
