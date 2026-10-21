// WaveDB benchmarks (WaveDB only — no comparisons). Run: `bun run bench` (add `--quick` for a fast pass).
//
// Every number is measured through the public TypeScript API (typed builders -> JSON -> N-API -> Rust core),
// on a fresh temporary database, with the runner's machine. Results depend heavily on CPU, disk and runtime.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { eq, gte, lt, and, int, inc, table, text, wave, type Database } from "../../packages/wavedb/src/index.ts";

const quick = process.argv.includes("--quick");
const scale = quick ? 0.1 : 1;
const n = (x: number) => Math.max(100, Math.round(x * scale));

const kv = table("kv", { id: int().primaryKey(), grp: int().notNull().index(), v: text().notNull() });
const counter = table("counter", { id: int().primaryKey(), n: int().notNull() });

interface Row {
  scenario: string;
  workers: number;
  durability: string;
  ops: number;
  seconds: number;
  opsPerSec: number;
  p50ms: number;
  p99ms: number;
  note?: string;
}
const rows: Row[] = [];

function pct(sorted: Float64Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function drive(
  scenario: string,
  db: Database<any>,
  workers: number,
  totalOps: number,
  durability: string,
  op: (i: number) => Promise<unknown>,
  note?: string,
) {
  const lat = new Float64Array(totalOps);
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= totalOps) return;
        const s = performance.now();
        await op(i);
        lat[i] = performance.now() - s;
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  lat.sort();
  const row: Row = {
    scenario,
    workers,
    durability,
    ops: totalOps,
    seconds: +seconds.toFixed(3),
    opsPerSec: Math.round(totalOps / seconds),
    p50ms: +pct(lat, 0.5).toFixed(3),
    p99ms: +pct(lat, 0.99).toFixed(3),
    note,
  };
  rows.push(row);
  console.log(
    `${scenario.padEnd(38)} w=${String(workers).padStart(2)} ${durability.padEnd(5)} ${String(row.opsPerSec).padStart(9)} ops/s   p50 ${row.p50ms.toFixed(2)}ms  p99 ${row.p99ms.toFixed(2)}ms${note ? "  (" + note + ")" : ""}`,
  );
}

async function fresh(durability: "sync" | "async") {
  const dir = mkdtempSync(join(os.tmpdir(), "wave-bench-"));
  const db = await wave(join(dir, "bench.wave"), { schema: { kv, counter }, durability });
  return { db, cleanup: async () => (await db.close(), rmSync(dir, { recursive: true, force: true })) };
}

async function preload(db: Database<any>, count: number) {
  for (let off = 0; off < count; off += 5000) {
    await db.insert(kv).values(
      Array.from({ length: Math.min(5000, count - off) }, (_, k) => ({ id: off + k, grp: (off + k) % 1000, v: "x".repeat(64) })),
    );
  }
}

// ---------------------------------------------------------------------------

console.log(`WaveDB bench ${quick ? "(quick) " : ""}— ${os.cpus()[0]?.model} x${os.cpus().length}, ${os.platform()}-${os.arch()}, ${typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version}\n`);

// 1. concurrent disjoint-key single-row writes (autocommit), async durability
for (const w of [1, 4, 8, 16, 32]) {
  const { db, cleanup } = await fresh("async");
  await drive("write: disjoint keys (1 row/commit)", db, w, n(60_000), "async", (i) =>
    db.insert(kv).values({ id: i, grp: i % 1000, v: "x".repeat(64) }).execute(),
  );
  const s = await db.stats();
  if (s.conflicts !== 0) throw new Error(`unexpected conflicts on disjoint keys: ${s.conflicts}`);
  await cleanup();
}

// 2. same, but with fsync-on-commit (group commit amortizes fsync across concurrent committers)
for (const w of [1, 8, 32, 64]) {
  const { db, cleanup } = await fresh("sync");
  await drive("write: disjoint keys (1 row/commit)", db, w, n(3_000), "sync", (i) =>
    db.insert(kv).values({ id: i, grp: i % 1000, v: "x".repeat(64) }).execute(),
  );
  const s = await db.stats();
  rows[rows.length - 1]!.note = `${(s.commits / Math.max(1, s.fsyncs)).toFixed(1)} commits/fsync`;
  console.log(`   -> ${rows[rows.length - 1]!.note}`);
  await cleanup();
}

// 3. batched inserts
{
  const { db, cleanup } = await fresh("async");
  const total = n(200_000);
  const batch = 1000;
  const t0 = performance.now();
  for (let off = 0; off < total; off += batch) {
    await db.tx((tx) =>
      tx.insert(kv).values(Array.from({ length: batch }, (_, k) => ({ id: off + k, grp: (off + k) % 1000, v: "x".repeat(64) }))).execute(),
    );
  }
  const secs = (performance.now() - t0) / 1000;
  rows.push({ scenario: "write: batched insert (1000 rows/tx)", workers: 1, durability: "async", ops: total, seconds: +secs.toFixed(3), opsPerSec: Math.round(total / secs), p50ms: 0, p99ms: 0, note: "rows/sec" });
  console.log(`${"write: batched insert (1000 rows/tx)".padEnd(38)} w= 1 async ${String(Math.round(total / secs)).padStart(9)} rows/s`);
  await cleanup();
}

// 4. read-heavy / mixed on a preloaded table
const ROWS = n(100_000);
{
  const { db, cleanup } = await fresh("async");
  await preload(db, ROWS);
  const rng = (() => {
    let s = 123456789;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  })();
  for (const w of [1, 8, 32]) {
    await drive("read: point lookup by PK", db, w, n(100_000), "async", () =>
      db.select().from(kv).where(eq(kv.id, Math.floor(rng() * ROWS))).first(),
    );
  }
  for (const w of [8]) {
    await drive("read: secondary-index lookup (~100 rows)", db, w, n(5_000), "async", () =>
      db.select().from(kv).where(eq(kv.grp, Math.floor(rng() * 1000))).execute(),
    );
    await drive("read: range scan (100 rows by PK)", db, w, n(10_000), "async", () => {
      const lo = Math.floor(rng() * (ROWS - 100));
      return db.select().from(kv).where(and(gte(kv.id, lo), lt(kv.id, lo + 100))).execute();
    });
  }
  let nextId = ROWS;
  for (const w of [8, 32]) {
    await drive("mixed: 90% read / 10% write", db, w, n(100_000), "async", (i) =>
      i % 10 === 0
        ? db.insert(kv).values({ id: nextId++, grp: 0, v: "y" }).execute()
        : db.select().from(kv).where(eq(kv.id, Math.floor(rng() * ROWS))).first(),
    );
  }
  for (const w of [8, 32]) {
    await drive("mixed: 50% read / 50% write", db, w, n(100_000), "async", (i) =>
      i % 2 === 0
        ? db.insert(kv).values({ id: nextId++, grp: 0, v: "y" }).execute()
        : db.select().from(kv).where(eq(kv.id, Math.floor(rng() * ROWS))).first(),
    );
  }
  for (const w of [8]) {
    await drive("write: update disjoint existing rows", db, w, n(50_000), "async", (i) =>
      db.update(kv).set({ v: `u${i}` }).where(eq(kv.id, i % ROWS)).execute(),
    );
  }
  await cleanup();
}

// 5. contention: hot-row increments with automatic conflict retry
{
  const { db, cleanup } = await fresh("async");
  await db.insert(counter).values({ id: 1, n: 0 });
  for (const w of [1, 4, 16]) {
    const before = (await db.stats()).conflicts;
    await drive("contended: read-modify-write on 1 row", db, w, n(5_000), "async", () =>
      db.tx(
        async (tx) => {
          const r = (await tx.select().from(counter).where(eq(counter.id, 1)).first())!;
          await tx.update(counter).set({ n: r.n + 1 }).where(eq(counter.id, 1));
        },
        { retries: 10_000 },
      ),
    );
    const c = (await db.stats()).conflicts - before;
    rows[rows.length - 1]!.note = `${c} conflicts retried`;
    console.log(`   -> ${c} conflicts retried`);
  }
  const final = (await db.select().from(counter).first())!.n;
  if (final !== n(5_000) * 3) throw new Error(`lost updates! ${final}`);
  console.log(`   -> counter exact: ${final}`);
  // single-statement atomic increments retry inside the Rust core (no JS round trips on conflict)
  for (const w of [1, 4, 16]) {
    await drive("contended: atomic UPDATE n = n + 1 (1 row)", db, w, n(20_000), "async", () =>
      db.update(counter).set({ n: inc(1) }).where(eq(counter.id, 1)).execute(),
    );
  }
  const final2 = (await db.select().from(counter).first())!.n;
  if (final2 !== final + n(20_000) * 3) throw new Error(`lost updates in atomic increments! ${final2}`);
  console.log(`   -> counter exact: ${final2}`);
  await cleanup();
}

// ---------------------------------------------------------------------------
const machine = {
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  platform: `${os.platform()}-${os.arch()}`,
  memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  runtime: typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`,
  date: new Date().toISOString().slice(0, 10),
  quick,
};
const out = join(import.meta.dir, quick ? "results.quick.json" : "results.json");
writeFileSync(out, JSON.stringify({ machine, rows }, null, 2));

console.log("\n| Scenario | Workers | Durability | ops/sec | p50 | p99 |\n|---|---:|---|---:|---:|---:|");
for (const r of rows) {
  console.log(`| ${r.scenario} | ${r.workers} | ${r.durability} | ${r.opsPerSec.toLocaleString("en-US")}${r.note === "rows/sec" ? " rows" : ""} | ${r.p50ms ? r.p50ms + " ms" : "–"} | ${r.p99ms ? r.p99ms + " ms" : "–"} |`);
}
console.log(`\nwritten ${out}`);
