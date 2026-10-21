import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, MarketplaceDb } from "./db/context.ts";
import { catalog } from "./routes/catalog.ts";

export function createApp(db: MarketplaceDb) {
  const app = new Hono<AppEnv>();

  app.use("*", cors());
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/", (c) =>
    c.json({
      name: "WaveDB marketplace demo",
      docs: "/api/regions",
      health: "/health",
    }),
  );

  app.get("/health", async (c) => {
    const stats = await db.stats();
    const detail = c.req.query("counts") !== "0";
    const counts = detail
      ? await (async () => {
          const [products, orders] = await Promise.all([db.query.products.count(), db.query.orders.count()]);
          return { products, orders };
        })()
      : undefined;
    return c.json({
      ok: true,
      ...(counts ? { counts } : {}),
      engine: stats,
      memory: process.memoryUsage(),
    });
  });

  app.route("/api", catalog);

  return app;
}
