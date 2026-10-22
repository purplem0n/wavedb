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

const dataPath = "./data.wave";
const db = await wave(dataPath, { schema });

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

const wave = waveHost(db, { dataPath }); // Studio at /wavedb-studio, API at /__wave/api (UI bundled in the package)
app.use(wave.hono());

// Bun: export default { port: 3000, fetch: app.fetch }
// Node: @hono/node-server serve({ fetch: app.fetch, port: 3000 })
```

Open `http://localhost:3000/wavedb-studio` (or `wave.studioPath`). Set `WAVE_ADMIN_PASSWORD` on first boot to skip the setup screen, or create a password in Studio. Remote clients: `connect("http://localhost:3000" + host.connectPath, { schema, token })`.

Full example: [examples/hono-marketplace](examples/hono-marketplace).

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

Full patterns (embedded vs `serve` + `connect`, auth env vars, platforms, HA, backups, native addon on Linux): **[docs/deployment.md](docs/deployment.md)**.

## License

MIT
