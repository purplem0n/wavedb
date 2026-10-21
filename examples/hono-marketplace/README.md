# Hono marketplace demo (WaveDB)

API-only B2B marketplace built with [Hono on Bun](https://hono.dev/docs/getting-started/bun) and [WaveDB](https://github.com/) from this monorepo. It exercises relational schemas, joins, aggregates, transactions, and concurrent reads/writes at multi-million-row scale.

## Prerequisites

From the **repo root**:

```bash
bun install
bun run build:native
```

## Run the API

```bash
cd examples/hono-marketplace
bun run dev
```

On first start, the app seeds the database under `./data/` (skipped on later runs via `seed_meta`).

### Seed profiles

| `SEED_PROFILE` | Approx. rows | Use |
|----------------|-------------|-----|
| `quick` | ~250k | CI / laptop smoke |
| `demo` | ~1.2M | Medium demo |
| `full` (default) | ~3.9M | Full stress / benchmark |

```bash
SEED_PROFILE=quick bun run dev
SEED_PROFILE=full bun run seed          # seed only
SEED_PROFILE=full bun run seed:force    # wipe data/ and re-seed
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Engine stats + memory; row counts unless `?counts=0` |
| GET | `/api/regions` | All regions |
| GET | `/api/sellers` | Filter by `regionId`, `tier`; pagination (`includeTotal=1` for total count) |
| GET | `/api/sellers/:id` | Seller + region |
| GET | `/api/sellers/:id/products` | Seller catalog |
| GET | `/api/products` | Filter `categoryId`, price range, `q` (title) |
| GET | `/api/products/:id` | Product + seller, category, reviews |
| POST | `/api/products/:id/reviews` | Add review |
| GET | `/api/customers/:id/orders` | Orders with line items + products |
| POST | `/api/orders` | Create order (transaction: lines, stock, LTV) |
| PATCH | `/api/orders/:id/status` | Update fulfillment status |
| GET | `/api/analytics/sales-by-region` | Revenue by region since date |
| GET | `/api/analytics/top-sellers` | Top sellers by revenue (`since`, default `2024-01-01`) |
| GET | `/api/analytics/category-performance` | Categories by product count |

## Stress test (2–5 minutes)

In-process (opens DB + Hono; no separate server):

```bash
STRESS_DURATION_SEC=180 STRESS_WORKERS=48 bun run stress
```

Against a running server:

```bash
bun run start &
BASE_URL=http://localhost:3000 STRESS_DURATION_SEC=300 bun run stress
```

Output: `stress-report.json` with throughput, latency percentiles, per-route breakdown, RSS/heap samples every 5s, and WaveDB `stats()`.

Quick 30s smoke:

```bash
bun run stress:quick
```

## Schema

Tables: `regions`, `sellers`, `categories` (self-referential), `products`, `customers`, `orders`, `order_items`, `product_reviews`, plus `seed_meta` for one-time init.

Relations are loaded via WaveDB `db.query.*.findMany({ with: { … } })` and complex reporting uses SQL joins/aggregates.
