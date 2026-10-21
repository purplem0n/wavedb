import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, lte, gte } from "wavedb";
import type { AppEnv } from "../db/context.ts";
import { customers, orders, orderItems, productReviews, products, regions, sellers } from "../db/schema.ts";

export const catalog = new Hono<AppEnv>();

catalog.get("/regions", async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(regions).orderBy(asc(regions.id));
  return c.json({ data: rows });
});

catalog.get("/sellers", async (c) => {
  const db = c.get("db");
  const regionId = c.req.query("regionId");
  const tier = c.req.query("tier");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  const where: Record<string, unknown> = { active: 1 };
  if (regionId !== undefined) where.regionId = Number(regionId);
  if (tier) where.tier = tier;

  const data = await db.query.sellers.findMany({
    where,
    orderBy: { rating: "desc" },
    limit,
    offset,
  });
  const total = await db.query.sellers.count(where);
  return c.json({ data, pagination: { limit, offset, total } });
});

catalog.get("/sellers/:id", async (c) => {
  const db = c.get("db");
  const id = Number(c.req.param("id"));
  const row = await db.query.sellers.findFirst({
    where: { id },
    with: { regions: true },
  });
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ data: row });
});

catalog.get("/sellers/:id/products", async (c) => {
  const db = c.get("db");
  const sellerId = Number(c.req.param("id"));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const data = await db.query.products.findMany({
    where: { sellerId, active: 1 },
    orderBy: { price: "asc" },
    limit,
  });
  return c.json({ data });
});

catalog.get("/products", async (c) => {
  const db = c.get("db");
  const categoryId = c.req.query("categoryId");
  const minPrice = c.req.query("minPrice");
  const maxPrice = c.req.query("maxPrice");
  const q = c.req.query("q");
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  const conds = [eq(products.active, 1)];
  if (categoryId !== undefined) conds.push(eq(products.categoryId, Number(categoryId)));
  if (minPrice !== undefined) conds.push(gte(products.price, Number(minPrice)));
  if (maxPrice !== undefined) conds.push(lte(products.price, Number(maxPrice)));
  if (q) conds.push(like(products.title, `%${q}%`));

  const data = await db
    .select()
    .from(products)
    .where(and(...conds))
    .orderBy(desc(products.id))
    .limit(limit)
    .offset(offset);
  return c.json({ data, pagination: { limit, offset } });
});

catalog.get("/products/:id", async (c) => {
  const db = c.get("db");
  const id = Number(c.req.param("id"));
  const data = await db.query.products.findFirst({
    where: { id },
    with: {
      sellers: true,
      categories: true,
      productReviews: { orderBy: { rating: "desc" }, limit: 10 },
    },
  });
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ data });
});

catalog.post("/products/:id/reviews", async (c) => {
  const db = c.get("db");
  const productId = Number(c.req.param("id"));
  const body = await c.req.json<{ customerId: number; rating: number; body: string }>();
  if (!body.customerId || body.rating < 1 || body.rating > 5 || !body.body?.trim()) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const product = await db.query.products.findFirst({ where: { id: productId } });
  if (!product) return c.json({ error: "not_found" }, 404);

  try {
    let reviewId = 0;
    await db.tx(async (tx) => {
      const r = await tx
        .insert(productReviews)
        .values({
          productId,
          customerId: body.customerId,
          rating: body.rating,
          body: body.body.trim(),
          createdAt: new Date(),
        })
        .returning({ id: productReviews.id });
      reviewId = r[0]!.id;
    });
    return c.json({ ok: true, id: reviewId }, 201);
  } catch {
    return c.json({ error: "duplicate_review" }, 409);
  }
});

catalog.get("/customers/:id/orders", async (c) => {
  const db = c.get("db");
  const customerId = Number(c.req.param("id"));
  const status = c.req.query("status");
  const where: Record<string, unknown> = { customerId };
  if (status) where.status = status;

  const data = await db.query.orders.findMany({
    where,
    orderBy: { placedAt: "desc" },
    limit: 50,
    with: { orderItems: { with: { products: true } } },
  });
  return c.json({ data });
});

catalog.post("/orders", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{ customerId: number; lines: { productId: number; qty: number }[] }>();
  if (!body.customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: "invalid_body" }, 400);
  }

  const customer = await db.query.customers.findFirst({ where: { id: body.customerId } });
  if (!customer) return c.json({ error: "customer_not_found" }, 404);

  const productIds = body.lines.map((l) => l.productId);
  const stockRows = await db.select().from(products).where(inArray(products.id, productIds));
  const byId = new Map(stockRows.map((p) => [p.id, p]));

  for (const line of body.lines) {
    const p = byId.get(line.productId);
    if (!p || p.stock < line.qty) return c.json({ error: "insufficient_stock", productId: line.productId }, 409);
  }

  let created: { id: number; ref: string; total: number } | undefined;
  await db.tx(async (tx) => {
    let total = 0;
    const lineRows = body.lines.map((line) => {
      const p = byId.get(line.productId)!;
      total += p.price * line.qty;
      return { productId: line.productId, qty: line.qty, unitPrice: p.price };
    });
    const inserted = await tx
      .insert(orders)
      .values({
        customerId: body.customerId,
        status: "pending",
        total,
        placedAt: new Date(),
        ref: `ORD-LIVE-${Date.now()}`,
      })
      .returning({ id: orders.id, ref: orders.ref });
    const orderId = inserted[0]!.id;
    const ref = inserted[0]!.ref;
    await tx.insert(orderItems).values(
      lineRows.map((line) => ({
        orderId,
        productId: line.productId,
        qty: line.qty,
        unitPrice: line.unitPrice,
      })),
    );
    for (const line of body.lines) {
      const p = byId.get(line.productId)!;
      await tx.update(products).set({ stock: p.stock - line.qty }).where(eq(products.id, line.productId));
    }
    await tx.update(customers).set({ lifetimeValue: customer.lifetimeValue + total }).where(eq(customers.id, body.customerId));
    created = { id: orderId, ref, total };
  });

  return c.json({ data: created! }, 201);
});

catalog.patch("/orders/:id/status", async (c) => {
  const db = c.get("db");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status: string }>();
  const allowed = new Set(["pending", "paid", "shipped", "delivered", "cancelled"]);
  if (!allowed.has(body.status)) return c.json({ error: "invalid_status" }, 400);

  const r = await db.tx(async (tx) => tx.update(orders).set({ status: body.status }).where(eq(orders.id, id)));
  if (r.rowsAffected === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

catalog.get("/analytics/sales-by-region", async (c) => {
  const db = c.get("db");
  const since = c.req.query("since") ?? "2024-03-01";
  const rows = await db.sql<{ region: string; orders: number; revenue: number }>`
    SELECT r.name AS region, count(*) AS orders, sum(o.total) AS revenue
    FROM orders o
    INNER JOIN customers c ON c.id = o.customer_id
    INNER JOIN regions r ON r.id = c.region_id
    WHERE o.placed_at >= ${new Date(since)}
    GROUP BY r.id, r.name
    ORDER BY revenue DESC
  `;
  return c.json({ data: rows });
});

catalog.get("/analytics/top-sellers", async (c) => {
  const db = c.get("db");
  const limit = Math.min(25, Math.max(1, Number(c.req.query("limit") ?? 10)));
  const rows = await db.sql<{ sellerId: number; seller: string; units: number; revenue: number }>`
    SELECT s.id AS sellerId, s.name AS seller, sum(oi.qty) AS units, sum(oi.qty * oi.unit_price) AS revenue
    FROM order_items oi
    INNER JOIN products p ON p.id = oi.product_id
    INNER JOIN sellers s ON s.id = p.seller_id
    GROUP BY s.id, s.name
    ORDER BY revenue DESC
    LIMIT ${limit}
  `;
  return c.json({ data: rows });
});

catalog.get("/analytics/category-performance", async (c) => {
  const db = c.get("db");
  const rows = await db.sql<{ categoryId: number; category: string; products: number; avgPrice: number }>`
    SELECT c.id AS categoryId, c.name AS category, count(p.id) AS products, avg(p.price) AS avgPrice
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.name
    ORDER BY products DESC
    LIMIT 20
  `;
  return c.json({ data: rows });
});
