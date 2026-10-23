import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wave, type Database, type OpenOptions, type SchemaMap } from "../src/index.ts";
import { readSetupToken } from "../src/auth.ts";
import type { WaveHandler } from "../src/server.ts";

const dirs: string[] = [];

export function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wave-test-"));
  dirs.push(d);
  return d;
}

export async function openTmp<S extends SchemaMap = {}>(opts: OpenOptions<S> = {}): Promise<{ db: Database<S>; dir: string }> {
  const dir = tmpDir();
  const db = await wave<S>(join(dir, "data.wave"), { durability: "async", ...opts });
  return { db, dir };
}

export function cleanup() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Database directory passed to `createWaveHandler({ dataPath: join(dir, "data.wave") })`. */
export function handlerDataPath(dir: string): string {
  return join(dir, "data.wave");
}

export function readSetupTokenForDataDir(dir: string): string {
  const token = readSetupToken(handlerDataPath(dir));
  if (!token) throw new Error(`missing setup token for ${handlerDataPath(dir)}`);
  return token;
}

export async function postAuthSetup(
  handler: WaveHandler,
  url: string,
  password: string,
  dataDir: string,
): Promise<Response> {
  const setupToken = readSetupTokenForDataDir(dataDir);
  return handler.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, setupToken }),
    }),
  );
}
