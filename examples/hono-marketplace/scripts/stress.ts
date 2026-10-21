/**
 * Concurrent read/write stress test against the marketplace API.
 *
 * In-process (default): opens DB + Hono app directly (no HTTP).
 * HTTP mode: set BASE_URL=http://localhost:3000 (server must already be running).
 *
 * Env:
 *   STRESS_DURATION_SEC — default 180 (3 minutes)
 *   STRESS_WORKERS      — default 48 concurrent workers
 *   SEED_PROFILE        — passed through when opening DB in-process
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createApp } from "../src/app.ts";
import { openMarketplaceDb } from "../src/db/seed.ts";
import { ConflictError } from "wavedb";
import type { MarketplaceDb } from "../src/db/context.ts";

const durationSec = Number(process.env.STRESS_DURATION_SEC ?? 180);
const workers = Number(process.env.STRESS_WORKERS ?? 48);
const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");

type Sample = { ok: boolean; ms: number; route: string };

function mem() {
  const m = process.memoryUsage();
  return {
    rssMb: +(m.rss / 1024 / 1024).toFixed(1),
    heapUsedMb: +(m.heapUsed / 1024 / 1024).toFixed(1),
    externalMb: +(m.external / 1024 / 1024).toFixed(1),
  };
}

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function pickIds(db: MarketplaceDb) {
  const [p, c, s] = await Promise.all([
    db.query.products.count(),
    db.query.customers.count(),
    db.query.orders.count(),
  ]);
  return {
    products: p,
    customers: c,
    orders: s,
  };
}

function rand(max: number) {
  return Math.floor(Math.random() * max);
}

async function runInProcess(app: ReturnType<typeof createApp>, db: MarketplaceDb) {
  const ids = await pickIds(db);
  const deadline = Date.now() + durationSec * 1000;
  const samples: Sample[] = [];
  const memSeries: { t: number; mem: ReturnType<typeof mem>; diskBytes?: number }[] = [];

  const memTimer = setInterval(async () => {
    const stats = await db.stats();
    memSeries.push({ t: Date.now(), mem: mem(), diskBytes: stats.diskBytes });
  }, 5_000);

  const worker = async (wid: number) => {
    while (Date.now() < deadline) {
      const roll = Math.random();
      const t0 = performance.now();
      let route = "unknown";
      let ok = false;
      try {
        if (roll < 0.22) {
          route = "GET /api/products";
          const r = await app.request(`/api/products?limit=25&categoryId=${rand(50)}&minPrice=10&maxPrice=200`);
          ok = r.status === 200;
        } else if (roll < 0.38) {
          const id = rand(ids.products);
          route = "GET /api/products/:id";
          const r = await app.request(`/api/products/${id}`);
          ok = r.status === 200 || r.status === 404;
        } else if (roll < 0.5) {
          route = "GET /api/sellers";
          const r = await app.request(`/api/sellers?limit=25&regionId=${rand(10)}`);
          ok = r.status === 200;
        } else if (roll < 0.6) {
          route = "GET /api/analytics/sales-by-region";
          const r = await app.request("/api/analytics/sales-by-region?since=2024-01-01");
          ok = r.status === 200;
        } else if (roll < 0.68) {
          route = "GET /api/analytics/top-sellers";
          const r = await app.request("/api/analytics/top-sellers?limit=10");
          ok = r.status === 200;
        } else if (roll < 0.76) {
          const cid = rand(ids.customers);
          route = "GET /api/customers/:id/orders";
          const r = await app.request(`/api/customers/${cid}/orders`);
          ok = r.status === 200;
        } else if (roll < 0.84) {
          const oid = rand(ids.orders);
          route = "PATCH /api/orders/:id/status";
          const r = await app.request(`/api/orders/${oid}/status`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: ["paid", "shipped", "delivered"][rand(3)] }),
          });
          ok = r.status === 200 || r.status === 404;
        } else if (roll < 0.92) {
          const pid = rand(ids.products);
          const cid = rand(ids.customers);
          route = "POST /api/products/:id/reviews";
          const r = await app.request(`/api/products/${pid}/reviews`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerId: cid, rating: 3 + rand(3), body: `stress w${wid}` }),
          });
          ok = r.status === 201 || r.status === 409 || r.status === 404;
        } else {
          const pid = rand(Math.min(ids.products, 50_000));
          const cid = rand(ids.customers);
          route = "POST /api/orders";
          const r = await app.request("/api/orders", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ customerId: cid, lines: [{ productId: pid, qty: 1 }] }),
          });
          ok = r.status === 201 || r.status === 409 || r.status === 404;
        }
      } catch (e) {
        ok = e instanceof ConflictError;
      }
      samples.push({ ok, ms: performance.now() - t0, route });
    }
  };

  console.log(`Stress ${durationSec}s — ${workers} workers (in-process)…`);
  const tStart = performance.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  clearInterval(memTimer);

  return finalize(samples, memSeries, db, tStart);
}

async function runHttp() {
  const deadline = Date.now() + durationSec * 1000;
  const samples: Sample[] = [];
  const memSeries: { t: number; mem: ReturnType<typeof mem> }[] = [];
  const memTimer = setInterval(() => memSeries.push({ t: Date.now(), mem: mem() }), 5_000);

  const worker = async (wid: number) => {
    while (Date.now() < deadline) {
      const roll = Math.random();
      const t0 = performance.now();
      let route = "GET /health";
      let ok = false;
      try {
        if (roll < 0.5) {
          route = "GET /api/products";
          const r = await fetch(`${baseUrl}/api/products?limit=25`);
          ok = r.ok;
        } else if (roll < 0.75) {
          route = "GET /api/analytics/top-sellers";
          const r = await fetch(`${baseUrl}/api/analytics/top-sellers`);
          ok = r.ok;
        } else {
          route = "PATCH /api/orders/:id/status";
          const r = await fetch(`${baseUrl}/api/orders/${wid * 1000}/status`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "shipped" }),
          });
          ok = r.status === 200 || r.status === 404;
        }
      } catch (e) {
        ok = e instanceof ConflictError;
      }
      samples.push({ ok, ms: performance.now() - t0, route });
    }
  };

  console.log(`Stress ${durationSec}s — ${workers} workers → ${baseUrl}`);
  const tStart = performance.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  clearInterval(memTimer);
  return finalize(samples, memSeries, null, tStart);
}

async function finalize(
  samples: Sample[],
  memSeries: { t: number; mem: ReturnType<typeof mem>; diskBytes?: number }[],
  db: MarketplaceDb | null,
  tStart: number,
) {
  const elapsed = (performance.now() - tStart) / 1000;
  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byRoute = new Map<string, { n: number; ok: number; ms: number[] }>();
  for (const s of samples) {
    let b = byRoute.get(s.route);
    if (!b) byRoute.set(s.route, (b = { n: 0, ok: 0, ms: [] }));
    b.n++;
    if (s.ok) b.ok++;
    b.ms.push(s.ms);
  }

  const engine = db ? await db.stats() : undefined;
  const report = {
    mode: baseUrl ? "http" : "in-process",
    durationSec,
    workers,
    totalRequests: samples.length,
    throughputRps: +(samples.length / elapsed).toFixed(1),
    successRate: +((samples.filter((s) => s.ok).length / samples.length) * 100).toFixed(2),
    latencyMs: {
      p50: +pct(lat, 0.5).toFixed(2),
      p95: +pct(lat, 0.95).toFixed(2),
      p99: +pct(lat, 0.99).toFixed(2),
    },
    memory: {
      start: memSeries[0]?.mem ?? mem(),
      peakRssMb: Math.max(...memSeries.map((m) => m.mem.rssMb), mem().rssMb),
      peakHeapMb: Math.max(...memSeries.map((m) => m.mem.heapUsedMb), mem().heapUsedMb),
      samples: memSeries,
    },
    engine,
    routes: [...byRoute.entries()].map(([route, v]) => ({
      route,
      requests: v.n,
      successRate: +((v.ok / v.n) * 100).toFixed(1),
      p50ms: +pct(v.ms.sort((a, b) => a - b), 0.5).toFixed(2),
    })),
  };

  const out = join(import.meta.dir, "..", "stress-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("\n--- stress summary ---");
  console.log(`requests: ${report.totalRequests} (${report.throughputRps} req/s)`);
  console.log(`success: ${report.successRate}%  p50=${report.latencyMs.p50}ms p99=${report.latencyMs.p99}ms`);
  console.log(`peak RSS: ${report.memory.peakRssMb} MB  heap: ${report.memory.peakHeapMb} MB`);
  if (engine) {
    console.log(`engine commits=${engine.commits} conflicts=${engine.conflicts} disk=${(engine.diskBytes / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(`report: ${out}`);
  if (db) await db.close();
}

if (baseUrl) {
  await runHttp();
} else {
  const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
  const db = await openMarketplaceDb(dataDir, true);
  const app = createApp(db);
  await runInProcess(app, db);
}
