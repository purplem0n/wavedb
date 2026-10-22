# WaveDB production & deployment

WaveDB is an **embedded native database** with a **persistent on-disk directory** (`data.wave`). Run it as a **long-lived Node or Bun process** with a **persistent volume**.

## Install

Node ≥ 20 or Bun ≥ 1.1.

```bash
npm install @purplemon/wavedb
npm install -g @purplemon/wave-cli   # optional: `wave serve`, `wave studio`, …
```

Prebuilt native addons ship via optional `@purplemon/wavedb-<platform>-<arch>` packages (for example `@purplemon/wavedb-linux-x64` on Fly/Linux amd64). After `npm install @purplemon/wavedb`, your lockfile should list the matching optional package; if startup fails with “native addon not found”, install it explicitly:

```bash
npm install @purplemon/wavedb-linux-x64   # linux x64 (Fly, Render, Docker amd64)
```

From source (monorepo): `bun run build:native` (Rust stable required). The npm tarball does **not** include Rust sources—you cannot run `build:native` from `node_modules` alone. See the [README](../README.md#install) for `bun`/`pnpm` and `npx` usage.

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
