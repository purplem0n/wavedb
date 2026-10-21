// Builds the N-API addon and copies it to packages/wavedb/native/wave.<platform>-<arch>.node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
const args = ["build", "-p", "wave-napi", ...(debug ? [] : ["--release"])];
const r = spawnSync("cargo", args, { cwd: root, stdio: "inherit", env });
if (r.status !== 0) process.exit(r.status ?? 1);

const profile = debug ? "debug" : "release";
const libName = { darwin: "libwave_napi.dylib", linux: "libwave_napi.so", win32: "wave_napi.dll" }[process.platform];
if (!libName) throw new Error(`unsupported platform ${process.platform}`);
const src = join(root, "target", profile, libName);
if (!existsSync(src)) throw new Error(`missing build artifact ${src}`);
const outDir = join(root, "packages", "wavedb", "native");
mkdirSync(outDir, { recursive: true });
const dest = join(outDir, `wave.${process.platform}-${process.arch}.node`);
// Replace (don't overwrite in place): macOS caches code signatures per inode and SIGKILLs a modified binary.
rmSync(dest, { force: true });
copyFileSync(src, dest);
if (process.platform === "darwin") spawnSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
console.log(`native addon -> ${dest}`);
