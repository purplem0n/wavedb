import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, inc, like, lte, sql } from "@purplemon/wavedb";
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
  const pagination: { limit: number; offset: number; total?: number } = { limit, offset };
  if (c.req.query("includeTotal") === "1") {
    pagination.total = await db.query.sellers.count(where);
  }
  return c.json({ data, pagination });
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
  const data = await db
    .select({
      id: products.id,
      sellerId: products.sellerId,
      categoryId: products.categoryId,
      sku: products.sku,
      title: products.title,
      price: products.price,
      stock: products.stock,
      active: products.active,
    })
    .from(products)
    .where(and(eq(products.sellerId, sellerId), eq(products.active, 1)))
    .orderBy(asc(products.price))
    .limit(limit);
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
    .select({
      id: products.id,
      sellerId: products.sellerId,
      categoryId: products.categoryId,
      sku: products.sku,
      title: products.title,
      price: products.price,
      stock: products.stock,
      active: products.active,
    })
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
  const rows = await db.sql<{
    id: number;
    sellerId: number;
    categoryId: number;
    sku: string;
    title: string;
    price: number;
    stock: number;
    active: number;
    attrs: unknown;
    sellerName: string;
    sellerTier: string;
    categoryName: string;
  }>`
    SELECT p.id, p.seller_id AS sellerId, p.category_id AS categoryId, p.sku, p.title, p.price, p.stock, p.active, p.attrs,
           s.name AS sellerName, s.tier AS sellerTier, c.name AS categoryName
    FROM products p
    INNER JOIN sellers s ON s.id = p.seller_id
    INNER JOIN categories c ON c.id = p.category_id
    WHERE p.id = ${id}
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);

  const reviews = await db.query.productReviews.findMany({
    where: { productId: id },
    orderBy: { rating: "desc" },
    limit: 10,
  });

  return c.json({
    data: {
      id: row.id,
      sellerId: row.sellerId,
      categoryId: row.categoryId,
      sku: row.sku,
      title: row.title,
      price: row.price,
      stock: row.stock,
      active: row.active,
      attrs: row.attrs,
      sellers: { id: row.sellerId, name: row.sellerName, tier: row.sellerTier },
      categories: { id: row.categoryId, name: row.categoryName },
      productReviews: reviews,
    },
  });
});

catalog.post("/products/:id/reviews", async (c) => {
  const db = c.get("db");
  const productId = Number(c.req.param("id"));
  const body = await c.req.json<{ customerId: number; rating: number; body: string }>();
  if (!body.customerId || body.rating < 1 || body.rating > 5 || !body.body?.trim()) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const exists = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).first();
  if (!exists) return c.json({ error: "not_found" }, 404);

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

  const orderRows = await db.query.orders.findMany({
    where,
    orderBy: { placedAt: "desc" },
    limit: 50,
  });
  if (orderRows.length === 0) return c.json({ data: [] });

  const orderIds = orderRows.map((o) => o.id);
  const lines = await db.sql<{
    orderId: number;
    itemId: number;
    productId: number;
    qty: number;
    unitPrice: number;
    title: string;
  }>`
    SELECT oi.order_id AS orderId, oi.id AS itemId, oi.product_id AS productId, oi.qty, oi.unit_price AS unitPrice, p.title
    FROM order_items oi
    INNER JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id IN (${sql.join(orderIds.map((id) => sql`${id}`))})
    ORDER BY oi.order_id, oi.id
  `;

  const itemsByOrder = new Map<number, { productId: number; qty: number; unitPrice: number; products: { title: string } }[]>();
  for (const line of lines) {
    const list = itemsByOrder.get(line.orderId) ?? [];
    list.push({
      productId: line.productId,
      qty: line.qty,
      unitPrice: line.unitPrice,
      products: { title: line.title },
    });
    itemsByOrder.set(line.orderId, list);
  }

  const data = orderRows.map((o) => ({
    ...o,
    orderItems: (itemsByOrder.get(o.id) ?? []).map((item) => ({
      productId: item.productId,
      qty: item.qty,
      unitPrice: item.unitPrice,
      products: item.products,
    })),
  }));

  return c.json({ data });
});

const MAX_ORDER_QTY = 1_000_000;

function positiveOrderInt(n: unknown, max = MAX_ORDER_QTY): number | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

catalog.post("/orders", async (c) => {
  const db = c.get("db");
  const body = await c.req.json<{ customerId: number; lines: { productId: number; qty: number }[] }>();
  const customerId = positiveOrderInt(body.customerId);
  if (!customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: "invalid_body" }, 400);
  }
  for (const line of body.lines) {
    if (positiveOrderInt(line.productId) === null || positiveOrderInt(line.qty) === null) {
      return c.json({ error: "invalid_line" }, 400);
    }
  }

  const customer = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).first();
  if (!customer) return c.json({ error: "customer_not_found" }, 404);

  let created: { id: number; ref: string; total: number } | undefined;
  try {
    await db.tx(async (tx) => {
      let total = 0;
      const lineRows: { productId: number; qty: number; unitPrice: number }[] = [];
      for (const line of body.lines) {
        const p = await tx
          .select({ id: products.id, price: products.price, stock: products.stock })
          .from(products)
          .where(eq(products.id, line.productId))
          .first();
        if (!p || p.stock < line.qty) throw new Error("insufficient_stock");
        total += p.price * line.qty;
        lineRows.push({ productId: line.productId, qty: line.qty, unitPrice: p.price });
      }
      const inserted = await tx
        .insert(orders)
        .values({
          customerId,
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
        const u = await tx
          .update(products)
          .set({ stock: inc(-line.qty) })
          .where(and(eq(products.id, line.productId), gte(products.stock, line.qty)));
        if (u.rowsAffected === 0) {
          throw new Error("insufficient_stock");
        }
      }
      await tx.update(customers).set({ lifetimeValue: inc(total) }).where(eq(customers.id, customerId));
      created = { id: orderId, ref, total };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "insufficient_stock") {
      return c.json({ error: "insufficient_stock" }, 409);
    }
    throw e;
  }

  return c.json({ data: created! }, 201);
});

catalog.patch("/orders/:id/status", async (c) => {
  const db = c.get("db");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status: string }>();
  const allowed = new Set(["pending", "paid", "shipped", "delivered", "cancelled"]);
  if (!allowed.has(body.status)) return c.json({ error: "invalid_status" }, 400);

  const existing = await db.select({ id: orders.id, status: orders.status, total: orders.total, customerId: orders.customerId }).from(orders).where(eq(orders.id, id)).first();
  if (!existing) return c.json({ error: "not_found" }, 404);

  const terminal = new Set(["cancelled", "delivered"]);
  if (terminal.has(existing.status) && body.status !== existing.status) {
    return c.json({ error: "invalid_transition" }, 409);
  }

  if (body.status === "cancelled" && existing.status !== "cancelled") {
    await db.tx(async (tx) => {
      const items = await tx.select({ productId: orderItems.productId, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, id));
      for (const item of items) {
        await tx.update(products).set({ stock: inc(item.qty) }).where(eq(products.id, item.productId));
      }
      await tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, id));
      await tx.update(customers).set({ lifetimeValue: inc(-existing.total) }).where(eq(customers.id, existing.customerId));
    });
    return c.json({ ok: true });
  }

  const r = await db.update(orders).set({ status: body.status }).where(eq(orders.id, id));
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
  const since = c.req.query("since") ?? "2024-01-01";
  const rows = await db.sql<{ sellerId: number; seller: string; units: number; revenue: number }>`
    SELECT s.id AS sellerId, s.name AS seller, sum(oi.qty) AS units, sum(oi.qty * oi.unit_price) AS revenue
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN products p ON p.id = oi.product_id
    INNER JOIN sellers s ON s.id = p.seller_id
    WHERE o.placed_at >= ${new Date(since)}
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
    LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
    GROUP BY c.id, c.name
    ORDER BY products DESC
    LIMIT 20
  `;
  return c.json({ data: rows });
});
