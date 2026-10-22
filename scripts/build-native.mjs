// Builds the N-API addon and copies it to packages/wavedb/native/wave.<platform>-<arch>.node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Record<string, string>} */
const targetToNodeFile = {
  "aarch64-apple-darwin": "wave.darwin-arm64.node",
  "x86_64-apple-darwin": "wave.darwin-x64.node",
  "aarch64-unknown-linux-gnu": "wave.linux-arm64.node",
  "x86_64-unknown-linux-gnu": "wave.linux-x64.node",
  "x86_64-pc-windows-msvc": "wave.win32-x64.node",
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const debug = process.argv.includes("--debug");
const target = argValue("--target");
const destName = argValue("--dest") ?? (target ? targetToNodeFile[target] : undefined);

const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const cargoArgs = ["build", "-p", "wave-napi", ...(debug ? [] : ["--release"])];
if (target) cargoArgs.push("--target", target);

const r = spawnSync("cargo", cargoArgs, { cwd: root, stdio: "inherit", env });
if (r.status !== 0) process.exit(r.status ?? 1);

const profile = debug ? "debug" : "release";
const os = target?.includes("apple-darwin")
  ? "darwin"
  : target?.includes("linux-gnu")
    ? "linux"
    : target?.includes("windows-msvc")
      ? "win32"
      : process.platform;
const libName = { darwin: "libwave_napi.dylib", linux: "libwave_napi.so", win32: "wave_napi.dll" }[os];
if (!libName) throw new Error(`unsupported platform ${os} (target=${target ?? "host"})`);

const src = target
  ? join(root, "target", target, profile, libName)
  : join(root, "target", profile, libName);
if (!existsSync(src)) throw new Error(`missing build artifact ${src}`);

const outDir = join(root, "packages", "wavedb", "native");
mkdirSync(outDir, { recursive: true });
const dest = destName
  ? join(outDir, destName)
  : join(outDir, `wave.${process.platform}-${process.arch}.node`);

rmSync(dest, { force: true });
copyFileSync(src, dest);
if (process.platform === "darwin" && !target) {
  spawnSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
}
console.log(`native addon -> ${dest}`);
spawnSync("node", [join(root, "scripts", "sync-native-packages.mjs")], { cwd: root, stdio: "inherit" });
