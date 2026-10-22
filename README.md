# WaveDB

Concurrent-write embedded relational database for TypeScript — MVCC + optimistic concurrency, typed schema and query builders, SQL, transactions, Studio, and HTTP `serve()` / `connect()`. One Rust core; runs on **Node ≥ 20** and **Bun ≥ 1.1**.

More detail (architecture, benchmarks, monorepo dev): [docs/overview.md](docs/overview.md).

## Read & write

```ts
import { wave, table, int, text, eq } from "@purplemon/wavedb";

const users = table("users", {
  id: int().autoIncrement(),
  email: text().notNull().unique(),
  name: text().notNull(),
});

const db = await wave("./data.wave", { schema: { users } });

// write
await db.insert(users).values({ email: "ada@example.com", name: "Ada" });

// read
const all = await db.select().from(users);
const [ada] = await db.select().from(users).where(eq(users.email, "ada@example.com"));

// update (conflicts retry automatically inside db.tx)
await db.tx(async (tx) => {
  await tx.update(users).set({ name: "Ada Lovelace" }).where(eq(users.id, ada!.id));
});

const one = await db.query.users.findFirst({ where: { email: "ada@example.com" } });
```

## Install

The npm scope is `@purplemon` (the unscoped name `wavedb` is a different package).

### npm registry

```bash
npm install @purplemon/wavedb
# bun add @purplemon/wavedb
# pnpm add @purplemon/wavedb
```

CLI (global):

```bash
npm install -g @purplemon/wave-cli
wave studio ./data.wave
```

Or without a global install: `npx @purplemon/wave-cli studio ./data.wave`

For HTTP `serve()` / `connect()` in Node, import from `@purplemon/wavedb/server`.

### Studio + API in your Hono app

One process opens the database; your routes use the in-process `db`, while Studio and the Wave HTTP API mount on the same server. Today: **Hono** via `waveHost().hono()`. More framework handlers (Express, Elysia, etc.) are coming soon.

```ts
import { Hono } from "hono";
import { wave } from "@purplemon/wavedb";
import { waveHost } from "@purplemon/wavedb/server";
import { schema } from "./schema";

const db = await wave({ schema });

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

app.use(waveHost(db).hono()); // Studio /wavedb-studio, API /__wave/api; auth + token from env (see below)

// Bun: export default { port: 3000, fetch: app.fetch }
// Node: @hono/node-server serve({ fetch: app.fetch, port: 3000 })
```

Open `http://localhost:3000/wavedb-studio` (or `host.studioPath`). Set `WAVE_ADMIN_PASSWORD` before first boot to skip the setup screen, or create a password in Studio.

**Environment variables** (all optional for local dev; set on Fly/VPS as needed):

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `WAVE_DB_PATH` | **Recommended** on deployed hosts with a volume (defaults to `./data.wave`) | Database directory (e.g. `/data/data.wave`) |
| `WAVE_DURABILITY` | Optional (`sync` if unset) | `sync` or `async` |
| `WAVE_ADMIN_PASSWORD` | Optional | Bootstrap Studio password on first boot (else use Studio setup once) |
| `WAVE_SERVE_TOKEN` | Optional for Studio in the browser; **required** for machine-only API access (`connect`, CLI `--token` without `--password`) | Static bearer for `Authorization: Bearer` |
| `WAVE_LEADER` | Optional | Set to `1` to enable leader lease (shared volume / multi-node) |
| `WAVE_STANDBY` | Optional | Set to `1` with `WAVE_LEADER` so a node serves health but not writes until it wins the lease |
| `WAVE_TRUST_PROXY` | Optional | Set to `1` when TLS terminates at a proxy and the app must honor `X-Forwarded-Proto: https` for `Secure` cookies |
| `WAVE_SESSION_SECRET` | Optional | Override session signing (default: `.wave/session.key` under the database directory) |

**Auth (Studio vs automation).** Superuser login is **cookie-based**: `POST /__wave/api/auth/login` returns `{ "ok": true }` and sets `Set-Cookie: wave_session=…` (HttpOnly, scoped to the API prefix). The browser / Studio sends that cookie on later `/__wave/api/*` calls (`credentials: "include"`). Scripts and other processes should **not** expect a `token` field in the login JSON — use **`WAVE_SERVE_TOKEN`** (or `--token`) with `Authorization: Bearer` on `/api/*`, or `wave sql --url http://localhost:3000/__wave --password …` (CLI stores the session cookie). Behind TLS on Fly/proxies, set `WAVE_TRUST_PROXY=1` when the app sees `X-Forwarded-Proto: https`.

```ts
import { connect } from "@purplemon/wavedb";

await connect("http://localhost:3000" + host.connectPath, {
  schema,
  token: process.env.WAVE_SERVE_TOKEN,
});
```

Full example: [examples/hono-marketplace](examples/hono-marketplace). Upgrading from older releases: [docs/migrations.md](docs/migrations.md).

### GitHub (no npm registry)

Install the library from this repo (compiles TypeScript on install; downloads the native `.node` from [GitHub Releases](https://github.com/purplem0n/wavedb/releases) matching the package version):

```bash
npm install 'github:purplem0n/wavedb#path:packages/wavedb'
# pin a tag: github:purplem0n/wavedb#v0.1.0&path:packages/wavedb
```

```bash
bun add 'github:purplem0n/wavedb#path:packages/wavedb'
pnpm add 'github:purplem0n/wavedb#path:packages/wavedb'
```

CLI from GitHub (the CLI lists `@purplemon/wavedb` on npm — add an **override** so it resolves to the same GitHub path):

Add to `package.json`:

```json
{
  "dependencies": {
    "@purplemon/wavedb": "github:purplem0n/wavedb#v0.1.0&path:packages/wavedb",
    "@purplemon/wave-cli": "github:purplem0n/wavedb#v0.1.0&path:packages/wave-cli"
  },
  "overrides": {
    "@purplemon/wavedb": "github:purplem0n/wavedb#v0.1.0&path:packages/wavedb"
  }
}
```

On Linux / Docker / CI, set `WAVE_NATIVE_REQUIRED=1` during install so a missing release asset fails the build (see deploy guide).

## Deploy

WaveDB is embedded: one long-lived process owns a `data.wave` directory on **persistent disk**. Use a volume on Fly, Render, VPS, or Docker; not serverless/edge.

**Sidecar HTTP** (separate from your app process):

```bash
export WAVE_SERVE_TOKEN=…          # optional; same as --token for machine clients
wave serve ./data.wave --port 4401 --host 127.0.0.1
# shared volume / failover (opt-in — leader is NOT on by default):
wave serve ./data.wave --leader --standby
```

Health checks use `GET /api/health` → `{ ok, standby, expiresAt }` (no secrets in the body). Programmatic clients use `connect(url, { token: process.env.WAVE_SERVE_TOKEN })`.

Full patterns (embedded vs `serve` + `connect`, env vars, platforms, HA, backups, native addon on Linux): **[docs/deployment.md](docs/deployment.md)**. Breaking API/auth changes: **[docs/migrations.md](docs/migrations.md)**.

## License

MIT
