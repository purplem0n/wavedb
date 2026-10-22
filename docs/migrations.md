# Upgrading WaveDB

This note covers **behavior and API changes** from the security and correctness hardening pass (leader lease, auth, HTTP health, SQL execution, and related tooling). Patch versions are published by CI; compare your installed `@purplemon/wavedb` / `@purplemon/wave-cli` version to the release notes on GitHub when you upgrade.

## Summary

| Area | Breaking? | Action |
|------|-----------|--------|
| Superuser session cookies | **Yes** | Users sign in again after deploy |
| `POST /api/auth/login` and `/setup` JSON | **Yes** | Read session from `Set-Cookie`, not `token` in body |
| `GET /api/health` JSON | **Yes** | Stop reading `leader`; use `expiresAt` |
| `wave serve` leader election | **Yes** | Pass `--leader` (and `--standby` if needed) explicitly |
| Multi-statement SQL on `/api/run` | **Yes** | One statement per request, or one `BEGIN … COMMIT/ROLLBACK` block |
| SQL `BEGIN` across multiple calls | **Yes** | Use `/api/tx/*` or a single script string |
| `!=` across incomparable types | **Yes** (bugfix) | Queries that relied on “match all” need fixing |
| Studio table filter | **Stricter** | Semicolons and DDL keywords rejected in the WHERE box |
| `leader.json` on disk | **Minor** | No `token` field; may include `generation` |
| `WAVE_SERVE_TOKEN` on `wave serve` | **No** (fix) | Env var now works without `--token` |
| `sql`…`IN (${array})` | **No** (fix) | Arrays expand to multiple bind parameters |

## Authentication and Studio

**Session format.** Session tokens are signed with **HMAC-SHA256**. Existing `wave_session` cookies and bearer tokens from before the upgrade are **invalid**. Plan for a one-time re-login (or re-setup only on fresh databases).

**Login/setup response.** Successful `POST /api/auth/login` and `POST /api/auth/setup` return `{ "ok": true }` only. The session value is in **`Set-Cookie: wave_session=…`**, not in the JSON body.

- **CLI:** `wave --url … --password` already follows `Set-Cookie` and caches under `.wave/cli-*.json`.
- **Custom clients:** Parse `Set-Cookie`, or continue using **`Authorization: Bearer`** with `WAVE_SERVE_TOKEN` / machine token for automation.

**Cookie path.** The session cookie `Path` matches the Wave API prefix (e.g. `/wave/api` when embedded), not always `/`. Browsers only send the cookie to that prefix. Host apps that relied on the cookie being visible on non-API routes need to call the API under the configured prefix or use bearer auth.

**Trusted proxy.** Set `WAVE_TRUST_PROXY=1` only when a trusted reverse proxy sets `X-Forwarded-Proto: https`. Without it, `Secure` cookies follow the direct connection scheme.

**Setup race.** Concurrent `POST /api/auth/setup` requests: one succeeds, others receive 400. Only the winning password works for login.

## HTTP health and leader lease

**Health payload.** Public `GET /api/health` returns:

```json
{ "ok": true, "standby": false, "expiresAt": 1730000000000 }
```

It does **not** return the full lease object or any serve bearer. Clients that parsed `leader.token` or similar must stop doing so.

**Leader on by default.** `wave serve` **does not** acquire a leader lease unless you pass **`--leader`**. Previously, leader was on by default. For single-writer failover on a shared volume, update process managers:

```bash
wave serve ./data.wave --leader --standby   # secondary nodes: --standby without holding writer
```

**Lease file.** `{dataPath}/.wave/leader.json` is written mode `0600`, stores holder/host/expiry/generation, and **never** stores the serve token. Delete stale `leader.json` after upgrade if a node refuses to start leader (expired lease is replaced on successful acquire).

## SQL and `/api/run`

**One statement per request.** `execute_sql` / `POST /api/run` reject strings with multiple statements unless the entire string is a single transaction script:

- Allowed: `BEGIN; INSERT …; COMMIT` or `BEGIN; …; ROLLBACK` in **one** request.
- Rejected: `INSERT …; DELETE …`, or any second statement that is not part of that pattern.

**No session `BEGIN` across calls.** `BEGIN` on one request and `INSERT` on the next are **not** one transaction. Use:

- HTTP interactive transactions: `POST /api/tx/begin`, then `/api/run` with `"tx": "<id>"`, then commit/rollback, or
- Application `db.tx()` / `NativeTx` in-process.

**Comparisons.** `WHERE int_col != 'text literal'` no longer matches every row; incomparable `!=` evaluates to false (unknown/false in filters). Fix filters that depended on the old behavior.

**Integer edge cases.** `abs(i64::MIN)`, `-9223372036854775808`, and `i64::MIN / -1` return SQL errors instead of wrapping or panicking.

## TypeScript client library

**Relational `with` + `limit`.** Per-parent limits on to-many relations are enforced with **bounded queries** (behavior unchanged for callers; performance improves).

**Tagged SQL `IN (${ids})`.** Interpolating a **number array** expands to `($1, $2, …)`. Code that accidentally relied on a single JSON parameter may start returning correct rows; no migration needed unless you depended on the bug.

**Query builder.** Invalid `limit` / `offset` (`NaN`, negative) throw before execution.

## Native install (optional)

`postinstall` can verify **`WAVE_NATIVE_SHA256`** or entries in `native/checksums.json` when present. Existing installs without checksums behave as before; production images may pin `WAVE_NATIVE_SHA256` for supply-chain control.

## Marketplace example only

The Hono marketplace demo changes checkout pricing, cancel/restock, CORS scope, and health detail. These do not affect `@purplemon/wavedb` consumers unless you copied that example verbatim.

## Suggested upgrade checklist

1. Deploy new `@purplemon/wavedb` native addon and JS packages together (same release tag).
2. Update `wave serve` units to pass **`--leader`** where you need election; set **`WAVE_SERVE_TOKEN`** if you use machine auth.
3. Update monitors and failover logic to the new **`/api/health`** shape.
4. Update any script that read **`token`** from login JSON to use **cookies** or **bearer** token.
5. Expect **Studio re-login** once per browser session store.
6. Audit SQL or Studio filters that used **semicolons** or multi-statement scripts; split into separate calls or use explicit transactions.
7. Re-run integration tests against **`!=`** and multi-statement paths.

For deployment topology and env vars, see [deployment.md](./deployment.md).
