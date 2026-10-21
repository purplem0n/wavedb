import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { and, asc, count, desc, eq, gte, int, lt, real, sum, table, text, timestamp, uniqueIndex, wave } from "../src/index.ts";
import { cleanup, tmpDir } from "./helpers.ts";

afterAll(cleanup);

const orders = table(
  "orders",
  {
    id: int().primaryKey(),
    customer: int().notNull().index(),
    status: text().notNull(),
    amount: real().notNull(),
    placedAt: timestamp("placed_at").notNull(),
    ref: text().notNull(),
  },
  (t) => ({ indexes: [uniqueIndex().on(t.ref), ],}),
);
const customers = table("customers", { id: int().primaryKey(), name: text().notNull(), region: text().notNull().index() });

const STATUSES = ["new", "paid", "shipped", "done"];
const N_ORDERS = 100_000;
const N_CUSTOMERS = 1_000;
const dir = tmpDir();
const path = join(dir, "big.wave");

describe("large database (100k rows)", () => {
  test("bulk load, then indexed / range / aggregate / join queries are correct", async () => {
    const db = await wave(path, { schema: { orders, customers }, durability: "async" });
    const t0 = performance.now();
    await db.insert(customers).values(Array.from({ length: N_CUSTOMERS }, (_, i) => ({ id: i, name: `c${i}`, region: `r${i % 10}` })));
    const BATCH = 2000;
    for (let off = 0; off < N_ORDERS; off += BATCH) {
      await db.tx(async (tx) => {
        await tx.insert(orders).values(
          Array.from({ length: BATCH }, (_, k) => {
            const i = off + k;
            return {
              id: i,
              customer: i % N_CUSTOMERS,
              status: STATUSES[i % 4]!,
              amount: (i % 1000) / 10,
              placedAt: new Date(1_700_000_000_000 + i * 1000),
              ref: `ref-${i}`,
            };
          }),
        );
      });
    }
    console.log(`  loaded ${N_ORDERS} rows in ${((performance.now() - t0) / 1000).toFixed(2)}s`);

    expect(await db.query.orders.count()).toBe(N_ORDERS);

    // point lookup by PK + by unique index
    expect((await db.query.orders.findFirst({ where: { id: 54_321 } }))!.ref).toBe("ref-54321");
    expect((await db.query.orders.findFirst({ where: { ref: "ref-99999" } }))!.id).toBe(99_999);
    expect(await db.query.orders.findFirst({ where: { ref: "nope" } })).toBeUndefined();

    // secondary index
    const mine = await db.query.orders.findMany({ where: { customer: 7 }, orderBy: { id: "asc" } });
    expect(mine).toHaveLength(N_ORDERS / N_CUSTOMERS);
    expect(mine.every((o) => o.customer === 7)).toBe(true);

    // range scan on PK with limit/offset paging
    const page = await db.select({ id: orders.id }).from(orders).where(and(gte(orders.id, 1000), lt(orders.id, 90_000))).orderBy(asc(orders.id)).limit(5).offset(10);
    expect(page.map((r) => r.id)).toEqual([1010, 1011, 1012, 1013, 1014]);
    const last = await db.select({ id: orders.id }).from(orders).orderBy(desc(orders.id)).limit(3);
    expect(last.map((r) => r.id)).toEqual([99_999, 99_998, 99_997]);

    // aggregates (verified against closed-form values)
    const agg = await db.select({ n: count(), total: sum(orders.amount) }).from(orders);
    expect(agg[0]!.n).toBe(N_ORDERS);
    // amount cycles 0..99.9 every 1000 rows: sum per cycle = sum(i/10, i<1000) = 49950
    expect(agg[0]!.total).toBeCloseTo((N_ORDERS / 1000) * 49_950, 3);

    const byStatus = await db.select({ s: orders.status, n: count() }).from(orders).groupBy(orders.status).orderBy(asc(orders.status));
    expect(byStatus).toEqual([
      { s: "done", n: 25_000 },
      { s: "new", n: 25_000 },
      { s: "paid", n: 25_000 },
      { s: "shipped", n: 25_000 },
    ]);

    // join + group by across 100k x 1k
    const byRegion = await db
      .select({ region: customers.region, n: count(), total: sum(orders.amount) })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customer))
      .groupBy(customers.region)
      .orderBy(asc(customers.region));
    expect(byRegion).toHaveLength(10);
    expect(byRegion.reduce((s, r) => s + r.n, 0)).toBe(N_ORDERS);
    expect(byRegion.every((r) => r.n === 10_000)).toBe(true);

    // planner picked indexes (not full scans) for the selective queries
    const plan = (await db.select().from(orders).where(eq(orders.customer, 7)).explain()).join(" ");
    expect(plan).toMatch(/orders_customer_idx/);

    // selective lookups are fast on a big table (guards against accidental full scans)
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) await db.query.orders.findFirst({ where: { id: (i * 331) % N_ORDERS } });
    const perLookup = (performance.now() - t1) / 300;
    console.log(`  point lookup: ${perLookup.toFixed(3)} ms avg`);
    expect(perLookup).toBeLessThan(20);

    await db.close();
  }, 180_000);

  test("reopen: all 100k rows persisted; update-heavy workload + vacuum keeps data intact", async () => {
    const db = await wave(path, { schema: { orders, customers } });
    expect(await db.query.orders.count()).toBe(N_ORDERS);
    expect(await db.diff()).toEqual([]);

    // rewrite 20k rows 3 times -> lots of dead versions
    for (let round = 1; round <= 3; round++) {
      for (let off = 0; off < 20_000; off += 5000) {
        await db.update(orders).set({ status: `r${round}` }).where(and(gte(orders.id, off), lt(orders.id, off + 5000)));
      }
    }
    expect((await db.select({ n: count() }).from(orders).where(eq(orders.status, "r3")))[0]!.n).toBe(20_000);
    const removed = await db.vacuum();
    expect(removed).toBeGreaterThan(0);
    await db.compact();
    expect(await db.query.orders.count()).toBe(N_ORDERS);
    expect((await db.select({ n: count() }).from(orders).where(eq(orders.status, "r3")))[0]!.n).toBe(20_000);
    // old status values must be gone from the index too
    expect((await db.select({ n: count() }).from(orders).where(eq(orders.status, "new")))[0]!.n).toBe(20_000);
    await db.close();
  }, 180_000);

  test("concurrent writers on disjoint keys all commit without conflicts", async () => {
    const db = await wave(join(tmpDir(), "conc.wave"), { schema: { orders }, durability: "async" });
    const W = 8;
    const PER = 2_500;
    const results = await Promise.all(
      Array.from({ length: W }, async (_, w) => {
        for (let i = 0; i < PER; i++) {
          const id = w * PER + i;
          await db.insert(orders).values({ id, customer: w, status: "new", amount: 1, placedAt: new Date(0), ref: `w${w}-${i}` });
        }
        return w;
      }),
    );
    expect(results).toHaveLength(W);
    expect(await db.query.orders.count()).toBe(W * PER);
    const s = await db.stats();
    expect(s.conflicts).toBe(0);
    for (let w = 0; w < W; w++) expect(await db.query.orders.count({ customer: w })).toBe(PER);
    await db.close();
  }, 120_000);
});

describe("small database", () => {
  test("empty-table queries and single-row edge cases", async () => {
    const db = await wave(join(tmpDir(), "small.wave"), { schema: { customers } });
    expect(await db.select().from(customers)).toEqual([]);
    expect((await db.select({ n: count(), s: sum(customers.id) }).from(customers))[0]).toEqual({ n: 0, s: null });
    await db.insert(customers).values({ id: 1, name: "solo", region: "r" });
    expect(await db.query.customers.count()).toBe(1);
    await db.delete(customers).where(eq(customers.id, 1));
    expect(await db.query.customers.count()).toBe(0);
    await db.close();
  });
});
