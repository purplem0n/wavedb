import { join } from "node:path";
import { wave, type Database } from "wavedb";
import { type AppSchema, schema } from "./schema.ts";
import { resolveSeedProfile, type SeedProfile } from "./seed-profile.ts";

const BATCH = 5_000;
const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"] as const;
const SEGMENTS = ["consumer", "pro", "enterprise"] as const;
const TIERS = ["standard", "premium", "enterprise"] as const;

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

async function insertBatches<T extends Record<string, unknown>>(
  label: string,
  total: number,
  build: (offset: number, size: number) => T[],
  insert: (rows: T[]) => Promise<unknown>,
) {
  const t0 = performance.now();
  for (let off = 0; off < total; off += BATCH) {
    const size = Math.min(BATCH, total - off);
    await insert(build(off, size));
    if (off === 0 || off + size >= total || (off / BATCH) % 20 === 0) {
      process.stdout.write(`\r  ${label}: ${fmt(Math.min(off + size, total))} / ${fmt(total)}`);
    }
  }
  console.log(` — ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

export async function openMarketplaceDb(dataDir: string, seedIfNeeded: boolean) {
  const path = join(dataDir, "marketplace.wave");
  const db = await wave(path, { schema, durability: seedIfNeeded ? "async" : "sync" });
  if (seedIfNeeded) await ensureSeeded(db);
  return db;
}

async function ensureSeeded(db: Database<AppSchema>) {
  const done = await db.query.seedMeta.findFirst({ where: { key: "seed_v1" } }).catch(() => undefined);
  if (done?.value === "ok") {
    console.log("Database already seeded (seed_meta.seed_v1=ok). Skipping load.");
    return;
  }
  const profile = resolveSeedProfile();
  console.log(`Seeding WaveDB (${profile.name} profile)…`);
  await runSeed(db, profile);
  await db
    .insert(schema.seedMeta)
    .values({ key: "seed_v1", value: "ok" })
    .onConflictDoUpdate({ target: schema.seedMeta.key, set: { value: "ok" } });
  console.log("Seed complete.");
}

export async function runSeed(db: Database<AppSchema>, profile: SeedProfile) {
  const { regions, sellers, categories, products, customers, orders, itemsPerOrder } = profile;

  await insertBatches("regions", regions, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      return { id, code: `R${id.toString().padStart(2, "0")}`, name: `Region ${id}` };
    }),
  (rows) => db.insert(schema.regions).values(rows).execute());

  // roots + two-level tree
  const roots = Math.max(5, Math.floor(categories / 10));
  await insertBatches("categories", categories, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      const parentId = id < roots ? null : id % roots;
      const depth = parentId === null ? 0 : 1;
      return {
        id,
        parentId,
        slug: `cat-${id}`,
        name: `Category ${id}`,
        depth,
      };
    }),
  (rows) => db.insert(schema.categories).values(rows).execute());

  await insertBatches("sellers", sellers, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      return {
        id,
        regionId: id % regions,
        name: `Seller ${id}`,
        tier: TIERS[id % TIERS.length]!,
        rating: 3 + (id % 20) / 10,
        active: 1,
      };
    }),
  (rows) => db.insert(schema.sellers).values(rows).execute());

  await insertBatches("customers", customers, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      return {
        id,
        regionId: id % regions,
        email: `user${id}@market.example`,
        segment: SEGMENTS[id % SEGMENTS.length]!,
        lifetimeValue: (id % 500) * 4.5,
        createdAt: new Date(1_700_000_000_000 + id * 1_000),
      };
    }),
  (rows) => db.insert(schema.customers).values(rows).execute());

  await insertBatches("products", products, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      const sellerId = id % sellers;
      return {
        id,
        sellerId,
        categoryId: id % categories,
        sku: `SKU-${id}`,
        title: `Product ${id} — ${["Widget", "Gadget", "Part"][id % 3]}`,
        price: 5 + (id % 200) + (id % 7) / 10,
        stock: 50 + (id % 500),
        active: id % 17 === 0 ? 0 : 1,
        attrs: { color: ["red", "blue", "green"][id % 3], size: ["S", "M", "L"][id % 3] },
      };
    }),
  (rows) => db.tx(async (tx) => tx.insert(schema.products).values(rows).execute()));

  await insertBatches("orders", orders, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      let total = 0;
      for (let line = 0; line < itemsPerOrder; line++) {
        const itemId = id * itemsPerOrder + line;
        const productId = (id * 11 + line * 17) % products;
        const qty = 1 + (itemId % 4);
        const unitPrice = 5 + (productId % 100);
        total += qty * unitPrice;
      }
      return {
        id,
        customerId: id % customers,
        status: ORDER_STATUSES[id % ORDER_STATUSES.length]!,
        total,
        placedAt: new Date(1_710_000_000_000 + id * 2_000),
        ref: `ORD-${id}`,
      };
    }),
  (rows) => db.tx(async (tx) => tx.insert(schema.orders).values(rows).execute()));

  const totalItems = orders * itemsPerOrder;
  await insertBatches("order_items", totalItems, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      const orderId = Math.floor(id / itemsPerOrder);
      const line = id % itemsPerOrder;
      const productId = (orderId * 11 + line * 17) % products;
      const qty = 1 + (id % 4);
      const unitPrice = 5 + (productId % 100);
      return { id, orderId, productId, qty, unitPrice };
    }),
  (rows) => db.tx(async (tx) => tx.insert(schema.orderItems).values(rows).execute()));

  // sparse reviews (~10% of products, one per customer-product pair in sample)
  const reviewTarget = Math.min(products, Math.floor(products / 10));
  await insertBatches("reviews", reviewTarget, (off, size) =>
    Array.from({ length: size }, (_, k) => {
      const id = off + k;
      return {
        id,
        productId: id,
        customerId: id % customers,
        rating: 1 + (id % 5),
        body: `Review ${id}: solid product.`,
        createdAt: new Date(1_720_000_000_000 + id * 500),
      };
    }),
  (rows) => db.insert(schema.productReviews).values(rows).execute());
}

/** Force re-seed (destructive): only for `bun run seed -- --force` */
export async function seedOnly(dataDir: string, force: boolean) {
  if (force) {
    const { rmSync } = await import("node:fs");
    rmSync(join(dataDir, "marketplace.wave"), { recursive: true, force: true });
  }
  const db = await openMarketplaceDb(dataDir, true);
  await db.close();
}
