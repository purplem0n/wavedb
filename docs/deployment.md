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
| **Embedded + Studio** | Same process: `app.use(waveHost(db).hono())` ([example](../examples/hono-marketplace)). Prebuilt Studio ships inside `@purplemon/wavedb` (`studio/`); no separate frontend build in your app. |
| **Sidecar `serve`** | Multiple workers / languages: one `wave serve` opens files; others use `connect("http://127.0.0.1:4401", { token })` |
| **Remote + failover** | `connect(primaryUrl, { urls: [primary, standby], token })` probes `/api/health` |

Environment variables (embedded `wave({ schema })` + `waveHost(db)`):

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `WAVE_DB_PATH` | **Recommended** on production hosts with a persistent volume (default `./data.wave`) | Database directory for `wave()` / auth / leader files |
| `WAVE_DURABILITY` | Optional (default `sync`) | `sync` or `async` |
| `WAVE_ADMIN_PASSWORD` | Optional | Bootstrap superuser before first HTTP request (else Studio setup) |
| `WAVE_SERVE_TOKEN` | Optional for browser Studio; **required** for token-only automation (`connect`, `wave --url --token`) | Bearer for `/api/*` |
| `WAVE_LEADER` | Optional | `1` enables leader lease on `waveHost()` / `wave serve --leader` |
| `WAVE_STANDBY` | Optional | `1` with leader: standby until lease acquired |
| `WAVE_TRUST_PROXY` | Optional | `1` when a trusted proxy sets `X-Forwarded-Proto: https` |
| `WAVE_SESSION_SECRET` | Optional | Fixed session signing secret (default: file under `.wave/`) |
| `WAVE_URL` | Optional (CLI remote mode) | Base URL when the DB is already served (e.g. `http://127.0.0.1:3000/__wave`) |
| `WAVE_STUDIO_DIR` | Optional | Path to built Studio static files if not bundled in the package |

Install / native addon (see table above in this doc): `WAVE_NATIVE_REQUIRED`, `WAVE_SKIP_NATIVE_DOWNLOAD`, `WAVE_NATIVE_VERSION`, `WAVE_NATIVE_GITHUB_REPO`, `WAVE_NATIVE_PATH`, `WAVE_NATIVE_SHA256` — all optional unless you enforce verified downloads in CI.

### Superuser auth

When `dataPath` is set on `serve()` / `createWaveHandler()`, Wave enables superuser auth for **Studio and `/api/*` only** (not your app’s in-process queries). First visit: create a password in Studio, or set `WAVE_ADMIN_PASSWORD` before boot. Browser / Studio sessions use an **HttpOnly cookie** (`wave_session`, `Path` = your API prefix, e.g. `/__wave/api`). `POST /api/auth/login` returns `{ "ok": true }` only — the session is in `Set-Cookie`, not JSON. Automation: set **`WAVE_SERVE_TOKEN`** (or `--token` on `wave serve` / `connect`) for `Authorization: Bearer`. CLI: `wave sql --url … --password` caches the cookie under `.wave/`. Optional: `WAVE_TRUST_PROXY=1` for `Secure` cookies behind TLS-terminating proxies.

## Platforms

| Host | Viable | Notes |
|------|--------|--------|
| **Fly.io** | Yes | `[mounts]` volume; scale writer to 1; health check `GET /__wave/api/health` (embedded) or `/api/health` (`wave serve`); expect `{ ok, standby, expiresAt }` |
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
- **`wave serve` does not enable leader election unless you pass `--leader`** (or `serve(..., { leader: true })`). Use that when multiple nodes share a volume.
- Leader lease file: `dataPath/.wave/leader.json` (mode `0600`, no bearer token stored).
- Standby: `--leader --standby` (or `standby: true`) — `/api/health` returns 503 on `/api/run` until this node holds the lease.
- Clients: `connect(url, { urls: [...], token: process.env.WAVE_SERVE_TOKEN })` for simple failover.

## Backups

Stop traffic or use `flush` / quiesce, then copy the `data.wave` directory, or use `wave export`. The engine is crash-safe; backups are still required for operator error and disaster recovery.
