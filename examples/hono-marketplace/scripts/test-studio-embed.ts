/**
 * E2E: embedded Wave Studio from a clean @purplemon/wavedb install (no monorepo workspace).
 * Run: bun run test:studio
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { marketplaceWavePath } from "../src/db/paths.ts";

const port = Number(process.env.PORT ?? 3456);
const base = `http://127.0.0.1:${port}`;
const wavePath = marketplaceWavePath();
const adminFile = join(wavePath, ".wave", "admin.json");

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const pkgRoot = join(import.meta.dir, "..", "node_modules", "@purplemon", "wavedb");
if (!existsSync(join(pkgRoot, "studio", "index.html"))) {
  fail("installed @purplemon/wavedb is missing studio/index.html — repack wavedb with studio assets");
}
if (!existsSync(join(pkgRoot, "dist", "server.js"))) {
  fail("installed @purplemon/wavedb is missing dist/server.js");
}

rmSync(wavePath, { recursive: true, force: true });
if (existsSync(adminFile)) fail("expected fresh database");

const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: join(import.meta.dir, ".."),
  env: { ...process.env, PORT: String(port), SEED_PROFILE: "small" },
  stdout: "pipe",
  stderr: "pipe",
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr).text();
      fail(`server exited early: ${err}`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  fail(`server did not respond on ${base}/health within ${timeoutMs}ms`);
}

try {
  await waitForServer();

  const statusRes = await fetch(`${base}/__wave/api/auth/status`);
  if (!statusRes.ok) fail(`GET /__wave/api/auth/status → ${statusRes.status}`);
  const status = (await statusRes.json()) as { phase?: string; auth?: boolean };
  if (status.phase !== "setup") fail(`expected phase setup, got ${JSON.stringify(status)}`);
  if (status.auth !== true) fail(`expected auth enabled, got ${JSON.stringify(status)}`);

  const studioRes = await fetch(`${base}/wavedb-studio/`);
  if (!studioRes.ok) fail(`GET /wavedb-studio/ → ${studioRes.status}`);
  const html = await studioRes.text();
  if (!html.includes("__WAVE_API_PREFIX__")) fail("studio index missing injected API prefix");
  if (!html.includes("/__wave/api")) fail("studio index missing /__wave/api prefix");

  const configRes = await fetch(`${base}/wavedb-studio/config.js`);
  if (!configRes.ok) fail(`GET /wavedb-studio/config.js → ${configRes.status}`);
  const configJs = await configRes.text();
  if (!configJs.includes("/__wave/api")) fail("config.js missing /__wave/api");

  const setupRes = await fetch(`${base}/__wave/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "testpass12" }),
  });
  if (!setupRes.ok) fail(`POST /auth/setup → ${setupRes.status} ${await setupRes.text()}`);
  if (!existsSync(adminFile)) fail("admin.json not created after setup");

  const tablesRes = await fetch(`${base}/__wave/api/tables`, {
    headers: { authorization: `Bearer ${((await setupRes.json()) as { token: string }).token}` },
  });
  if (!tablesRes.ok) fail(`GET /tables after setup → ${tablesRes.status}`);

  console.log("OK: embedded Wave Studio (status setup, UI prefix, signup, tables)");
} finally {
  proc.kill();
  await proc.exited;
}
