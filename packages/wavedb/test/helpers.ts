import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wave, type Database, type OpenOptions, type SchemaMap } from "../src/index.ts";

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
