import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { int, table, text, wave } from "../src/index.ts";
import { cleanup, tmpDir } from "./helpers.ts";

afterAll(cleanup);

const a = table("a", { id: int().primaryKey(), v: text().notNull() });
const b = table("b", { id: int().primaryKey(), v: text().notNull() });

async function runAndKill(path: string, start: number, ackTarget: number): Promise<number> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/crash-writer.ts"), path, String(start)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  let acked = start - 1;
  const decoder = new TextDecoder();
  let buf = "";
  const reader = child.stdout.getReader();
  while (acked < start + ackTarget) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) if (l.startsWith("ACK ")) acked = Number(l.slice(4));
  }
  child.kill("SIGKILL"); // no chance to flush or clean up
  await child.exited;
  return acked;
}

test("kill -9 mid-write: every acknowledged commit survives and commits are atomic", async () => {
  const path = join(tmpDir(), "crash.wave");
  let acked = await runAndKill(path, 0, 150);
  expect(acked).toBeGreaterThanOrEqual(150);

  let db = await wave(path, { schema: { a, b } });
  let ca = (await db.sql`SELECT count(*) AS n FROM a`)[0]!.n as number;
  let cb = (await db.sql`SELECT count(*) AS n FROM b`)[0]!.n as number;
  expect(ca).toBeGreaterThanOrEqual(acked + 1);
  expect(ca).toBe(cb); // atomicity: both rows of a transaction or neither
  // contiguous ids, nothing torn
  const missing = await db.sql`SELECT a.id FROM a LEFT JOIN b ON a.id = b.id WHERE b.id IS NULL`;
  expect(missing.length).toBe(0);
  const maxId = (await db.sql`SELECT max(id) AS m FROM a`)[0]!.m as number;
  expect(maxId).toBe(ca - 1);
  await db.close();

  // second crash on the recovered database continues cleanly
  acked = await runAndKill(path, ca, 50);
  db = await wave(path, { schema: { a, b } });
  ca = (await db.sql`SELECT count(*) AS n FROM a`)[0]!.n as number;
  cb = (await db.sql`SELECT count(*) AS n FROM b`)[0]!.n as number;
  expect(ca).toBe(cb);
  expect(ca).toBeGreaterThanOrEqual(acked + 1);
  await db.close();
}, 60_000);
