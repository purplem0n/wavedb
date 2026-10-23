# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- One-time web setup credential: `.wave/setup.token` on first boot (or `WAVE_SETUP_TOKEN`) required for `POST /api/auth/setup` when the admin is not pre-provisioned via `WAVE_ADMIN_PASSWORD`.

### Fixed

- Session cookies include `Secure` on HTTPS Fetch requests and direct TLS Node connections.
- Wave HTTP handler fails closed when `auth` is enabled without a resolvable database `dataPath`.
- CLI remote session cache keys use SHA-256 of the full canonical URL; cached tokens require an exact URL match.
- Schema rebuild row copy uses structured SELECT so table names with dots are not misinterpreted as SQL qualification.
- Engine: primary-key columns excluded from commutative `UPDATE` fast path; conditional increments re-check `WHERE` at commit; view expansion cycle detection; linear-time `LIKE` matching; `BEGIN READ ONLY` rejected instead of ignored.

### Breaking

- `POST /api/auth/setup` requires `setupToken` in the JSON body unless the administrator was created via `WAVE_ADMIN_PASSWORD` / `bootstrapPassword` before setup.
- `createWaveHandler` with `auth: true` and no resolvable `dataPath` throws at construction time.
- Legacy CLI session cache files without a matching stored `url` are ignored.
