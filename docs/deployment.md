# WaveDB production & deployment

WaveDB is an **embedded native database** with a **persistent on-disk directory** (`data.wave`). Run it as a **long-lived Node or Bun process** with a **persistent volume**.

## Install

Node ≥ 20 or Bun ≥ 1.1. Registry and GitHub install commands: [README — Install](../README.md#install).

```bash
npm install @purplemon/wavedb
npm install -g @purplemon/wave-cli   # optional: `wave serve`, `wave studio`, …
```

Without the npm registry:

```bash
npm install 'github:purplem0n/wavedb#path:packages/wavedb'
```

Prebuilt native addons are fetched from [GitHub Releases](https://github.com/purplem0n/wavedb/releases) matching the package version (`postinstall` on `@purplemon/wavedb`). If startup fails with “native addon not found”, ensure a release tag exists with `wave.<platform>-<arch>.node` assets, set `WAVE_NATIVE_PATH`, or build from the monorepo with `bun run build:native`.

From source (monorepo): `bun run build:native` (Rust stable required). The published tarball does **not** include Rust sources—you cannot run `build:native` from `node_modules` alone.

### Native addon on Linux / CI (Fly, Docker, GitHub deploy)

Prebuilt binaries are attached to **[GitHub Releases](https://github.com/purplem0n/wavedb/releases)** on every `v*` tag (`wave.linux-x64.node`, etc.).

**Recommended (npm ≥ 0.1.1):** `@purplemon/wavedb` runs `postinstall` and downloads the matching `.node` from the release that matches the package version. In your Dockerfile or Fly build:

```dockerfile
ENV WAVE_NATIVE_REQUIRED=1
RUN bun install --frozen-lockfile   # or npm ci
```

Optional env:

| Variable | Purpose |
|----------|---------|
| `WAVE_NATIVE_REQUIRED=1` | Fail the install step if the GitHub download fails (use in production images). |
| `WAVE_SKIP_NATIVE_DOWNLOAD=1` | Skip download (monorepo dev / when optional npm native package is present). |
| `WAVE_NATIVE_VERSION` / `WAVE_NATIVE_GITHUB_REPO` | Override release tag or repo (`purplem0n/wavedb` default). |
| `WAVE_NATIVE_PATH` | Load a specific `.node` file at runtime (skip install layout). |

**Manual (works with `@purplemon/wavedb@0.1.0` today):** after `npm install`, curl the asset into the package:

```dockerfile
ARG WAVEDB_VERSION=0.1.1
RUN mkdir -p node_modules/@purplemon/wavedb/native \
  && curl -fsSL -o node_modules/@purplemon/wavedb/native/wave.linux-x64.node \
    "https://github.com/purplem0n/wavedb/releases/download/v${WAVEDB_VERSION}/wave.linux-x64.node"
```

Pin `WAVEDB_VERSION` to a tag that exists on [Releases](https://github.com/purplem0n/wavedb/releases). No npm token or Rust toolchain required.

## Patterns

| Pattern | Use when |
|--------|----------|
| **Embedded** | One app process owns the DB: `await wave("/data/app.wave", { schema, durability: "sync" })` |
| **Embedded + Studio** | Same process: `app.use(waveHost(db, { dataPath }).hono())` ([example](../examples/hono-marketplace)). Prebuilt Studio ships inside `@purplemon/wavedb` (`studio/`); no separate frontend build in your app. |
| **Sidecar `serve`** | Multiple workers / languages: one `wave serve` opens files; others use `connect("http://127.0.0.1:4401", { token })` |
| **Remote + failover** | `connect(primaryUrl, { urls: [primary, standby], token })` probes `/api/health` |

Environment conventions:

- `WAVE_PATH` — database directory
- `WAVE_URL` — HTTP base when the DB is already open (e.g. `http://127.0.0.1:3000/__wave`); used by `wave` CLI `--url`
- `WAVE_SERVE_TOKEN` — static bearer for machine clients (`connect`, `--token`)
- `WAVE_ADMIN_PASSWORD` — bootstrap superuser on first start (optional; otherwise use Studio setup)
- `WAVE_SESSION_SECRET` — override session signing (optional; default writes `data.wave/.wave/session.key`)
- `WAVE_DURABILITY=sync|async`

### Superuser auth

When `dataPath` is set on `serve()` / `createWaveHandler()`, Wave enables superuser auth for **Studio and `/api/*` only** (not your app’s in-process queries). First visit: create a password in Studio, or set `WAVE_ADMIN_PASSWORD` before boot. Sessions are httpOnly cookies; automation can use `WAVE_SERVE_TOKEN` or a session token from `POST /api/auth/login`.

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
