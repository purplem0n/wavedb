/**
 * Simulates a consumer app: npm pack @purplemon/wavedb, clean install outside the monorepo, run embed test.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = join(exampleRoot, "..", "..");
const wavedbPkg = join(monorepoRoot, "packages", "wavedb");

if (!existsSync(join(wavedbPkg, "studio", "index.html"))) {
  console.error("Run from monorepo root: bun run build (includes Wave Studio assets)");
  process.exit(1);
}

const pack = Bun.spawnSync(["npm", "pack", "--pack-destination", "/tmp"], { cwd: wavedbPkg, stdout: "pipe" });
if (pack.exitCode !== 0) {
  console.error(new TextDecoder().decode(pack.stderr));
  process.exit(1);
}
const tgz = new TextDecoder()
  .decode(pack.stdout)
  .trim()
  .split("\n")
  .pop()!;
const tgzPath = join("/tmp", tgz);

const work = mkdtempSync(join(tmpdir(), "wave-hono-e2e-"));
try {
  for (const name of ["src", "scripts", "tsconfig.json", "package.json"]) {
    const src = join(exampleRoot, name);
    if (existsSync(src)) cpSync(src, join(work, name), { recursive: true });
  }
  const pkg = JSON.parse(await Bun.file(join(work, "package.json")).text()) as {
    dependencies: Record<string, string>;
  };
  pkg.dependencies["@purplemon/wavedb"] = tgzPath;
  delete (pkg as { devDependencies?: unknown }).devDependencies;
  await Bun.write(join(work, "package.json"), JSON.stringify(pkg, null, 2));

  const install = Bun.spawnSync(["bun", "install"], { cwd: work, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);

  const trust = Bun.spawnSync(["bun", "pm", "trust", "@purplemon/wavedb"], { cwd: work, stdout: "inherit", stderr: "inherit" });
  if (trust.exitCode !== 0) process.exit(trust.exitCode ?? 1);

  Bun.spawnSync(["bun", "install"], { cwd: work, stdout: "inherit", stderr: "inherit" });

  const test = Bun.spawnSync(["bun", "run", "test:studio"], { cwd: work, stdout: "inherit", stderr: "inherit" });
  process.exit(test.exitCode ?? 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}
