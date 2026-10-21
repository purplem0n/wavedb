# WaveDB production & deployment

WaveDB is an **embedded native database** with a **persistent on-disk directory** (`data.wave`). Run it as a **long-lived Node or Bun process** with a **persistent volume**.

## Install

```bash
npm install @purplemon/wavedb   # Node ≥ 20 or Bun ≥ 1.1
```

Prebuilt native addons ship via optional `@purplemon/wavedb-<platform>-<arch>` packages. From source (monorepo): `bun run build:native` (Rust stable required).

## Patterns

| Pattern | Use when |
|--------|----------|
| **Embedded** | One app process owns the DB: `await wave("/data/app.wave", { schema, durability: "sync" })` |
| **Sidecar `serve`** | Multiple workers / languages: one `wave serve` opens files; others use `connect("http://127.0.0.1:4401", { token })` |
| **Remote + failover** | `connect(primaryUrl, { urls: [primary, standby], token })` probes `/api/health` |

Environment conventions:

- `WAVE_PATH` — database directory
- `WAVE_SERVE_TOKEN` — bearer token for HTTP API
- `WAVE_DURABILITY=sync|async`

## Platforms

| Host | Viable | Notes |
|------|--------|--------|
| **Fly.io** | Yes | `[mounts]` volume; scale writer to 1; health check `/api/health` |
| **VPS / Docker** | Yes | Bind-mount volume; systemd or compose; backup `data.wave` |
| **Render** | Yes | Persistent disk on a Web Service (not static site) |
| **Heroku** | Caveats | Ephemeral dyno disk is **not** suitable; use Fly/Render/VPS or mounted storage |
| **Kubernetes** | Yes | `ReadWriteOnce` PVC; **one** writer replica |

## Not compatible (serverless / edge)

| Platform | Why |
|----------|-----|
| **Vercel** / **Netlify Functions** | No durable local disk; short-lived functions |
| **Cloudflare Workers** | No Node native addons; no local LSM |
| **AWS Lambda / Cloud Functions** | Ephemeral `/tmp` only |

Use a **hosted WaveDB** (Fly, Render, VPS) and call **`connect()`** from edge frontends if needed — do not embed `wave()` inside serverless handlers.

## High availability

- Only **one process** may open `data.wave` (fjall directory lock).
- `serve(db, { dataPath, leader: true })` uses a **leader lease** at `dataPath/.wave/leader.json`.
- Standby: `serve(db, { dataPath, leader: true, standby: true })` serves `/api/health` with 503 until it becomes leader.
- Clients: `connect(url, { urls: [...] })` for simple failover.

## Backups

Stop traffic or use `flush` / quiesce, then copy the `data.wave` directory, or use `wave export`. The engine is crash-safe; backups are still required for operator error and disaster recovery.
