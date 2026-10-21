import { index, int, json, real, table, text, timestamp, uniqueIndex } from "wavedb";

export const regions = table("regions", {
  id: int().primaryKey(),
  code: text().notNull().unique(),
  name: text().notNull(),
});

export const sellers = table(
  "sellers",
  {
    id: int().primaryKey(),
    regionId: int("region_id")
      .notNull()
      .references(() => regions.id)
      .index(),
    name: text().notNull(),
    tier: text().notNull().index(),
    rating: real().notNull(),
    active: int().notNull().default(1),
  },
  (t) => ({ indexes: [index().on(t.regionId, t.tier)] }),
);

/** Category tree; parentId is a logical FK (self-reference omitted — TS circular init). */
export const categories = table("categories", {
  id: int().primaryKey(),
  parentId: int("parent_id").index(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  depth: int().notNull().default(0),
});

export const products = table(
  "products",
  {
    id: int().primaryKey(),
    sellerId: int("seller_id")
      .notNull()
      .references(() => sellers.id)
      .index(),
    categoryId: int("category_id")
      .notNull()
      .references(() => categories.id)
      .index(),
    sku: text().notNull().unique(),
    title: text().notNull(),
    price: real().notNull().index(),
    stock: int().notNull(),
    active: int().notNull().default(1),
    attrs: json<{ color?: string; size?: string }>(),
  },
  (t) => ({ indexes: [index().on(t.categoryId, t.price), uniqueIndex().on(t.sellerId, t.sku)] }),
);

export const customers = table(
  "customers",
  {
    id: int().primaryKey(),
    regionId: int("region_id")
      .notNull()
      .references(() => regions.id)
      .index(),
    email: text().notNull().unique(),
    segment: text().notNull().index(),
    lifetimeValue: real("lifetime_value").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => ({ indexes: [index().on(t.regionId, t.segment)] }),
);

export const orders = table(
  "orders",
  {
    id: int().autoIncrement(),
    customerId: int("customer_id")
      .notNull()
      .references(() => customers.id)
      .index(),
    status: text().notNull().index(),
    total: real().notNull(),
    placedAt: timestamp("placed_at").notNull().index(),
    ref: text().notNull().unique(),
  },
  (t) => ({ indexes: [index().on(t.customerId, t.placedAt), index().on(t.status, t.placedAt)] }),
);

export const orderItems = table(
  "order_items",
  {
    id: int().autoIncrement(),
    orderId: int("order_id")
      .notNull()
      .references(() => orders.id)
      .index(),
    productId: int("product_id")
      .notNull()
      .references(() => products.id)
      .index(),
    qty: int().notNull(),
    unitPrice: real("unit_price").notNull(),
  },
  (t) => ({ indexes: [uniqueIndex().on(t.orderId, t.productId), index().on(t.productId, t.orderId)] }),
);

export const productReviews = table(
  "product_reviews",
  {
    id: int().autoIncrement(),
    productId: int("product_id")
      .notNull()
      .references(() => products.id)
      .index(),
    customerId: int("customer_id")
      .notNull()
      .references(() => customers.id)
      .index(),
    rating: int().notNull(),
    body: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => ({ indexes: [index().on(t.productId, t.rating), uniqueIndex().on(t.productId, t.customerId)] }),
);

export const seedMeta = table("seed_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const schema = {
  regions,
  sellers,
  categories,
  products,
  customers,
  orders,
  orderItems,
  productReviews,
  seedMeta,
};

export type AppSchema = typeof schema;
