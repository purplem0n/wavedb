# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- One-time web setup credential: `.wave/setup.token` on first boot (or `WAVE_SETUP_TOKEN`) required for `POST /api/auth/setup` when the admin is not pre-provisioned via `WAVE_ADMIN_PASSWORD`.

### Fixed

- Session cookies include `Secure` on HTTPS Fetch requests and direct TLS Node connections.
- Wave HTTP handler fails closed when `auth` is enabled without a resolvable database `dataPath`.
- CLI remote sessions are scoped to the full server URL; a cached token is not reused for a different host or path.
- Schema rebuild preserves rows for table names that contain dots.
- Engine: guarded integer updates (`col ± n`) re-check their `WHERE` clause at commit (including multiple updates in one transaction) and conflict if another transaction changed the row first; primary-key increments no longer overwrite other rows; self-referencing views return an error instead of looping; `BEGIN READ ONLY` is rejected; `LIKE` patterns without `%` stay linear-time.
- Wave Studio first-time setup sends the one-time setup token with the password.
- Hono marketplace example: order status changes run in one transaction with optimistic status checks; order lines reject null entries; `bun run studio` uses the same DB path as the app.

### Breaking

- `POST /api/auth/setup` requires `setupToken` in the JSON body unless the administrator was created via `WAVE_ADMIN_PASSWORD` / `bootstrapPassword` before setup.
- `createWaveHandler` with `auth: true` and no resolvable `dataPath` throws at construction time.
- Legacy CLI session cache files without a matching stored `url` are ignored.
