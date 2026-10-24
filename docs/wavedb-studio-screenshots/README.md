# Wave Studio UI screenshots

Canonical PNGs for the Wave Studio dashboard. Refresh when Studio UI or its API/embed changes (see `.cursor/rules/wave-studio-ui.mdc`).

## Rules (no duplicates)

1. **Only** files listed in [`manifest.json`](./manifest.json) (plus this README).
2. **Never** add dated files or `-2` suffixes — update the canonical filename in place.
3. **1280×800** viewport unless a manifest entry sets `viewport`.
4. **Empty vs populated** views use **different manifest filenames** (e.g. `shell-logs-empty.png` vs `shell-logs-with-queries.png`), not two copies of the same name.

## Capture order (one server, one browser tab)

Use **one** embedded host for almost everything. Do **not** run several `wave studio` processes and many browser tabs in parallel.

```bash
bun run test:studio
cd examples/hono-marketplace && bun run seed:small:force && bun run dev
# → http://localhost:3000/wavedb-studio  (sign in if prompted; WAVE_ADMIN_PASSWORD or setup once)
```

**Browser:** `cursor-ide-browser` — **one tab**, `browser_lock`, set viewport 1280×800, then **strictly sequential** steps: navigate → `browser_snapshot` (confirm UI) → `browser_take_screenshot` → copy PNG from Cursor temp into this folder. Never screenshot in the same turn as a navigation/click you have not confirmed with a snapshot.

Suggested order in the **same session**:

| Step | Action | File |
|------|--------|------|
| 1 | `#/logs` immediately after server start (or restart dev once) | `shell-logs-empty.png` |
| 2 | `#/sql` → Clear → capture | `shell-sql-console-empty.png` |
| 3 | Run `SELECT id, sku, title FROM products LIMIT 5;` → Run → capture | `shell-sql-console-with-results.png` |
| 4 | `#/logs` (after step 3) → wait ~1s for poll → capture | `shell-logs-with-queries.png` |
| 5 | `#/schema`, `#/stats`, `#/table/products`, manage/edit flows, etc. | remaining `shell-*`, `table-*`, `schema-*`, `state-*`, `embed-*` |

**Auth gates** (`auth-*.png`): only when auth UI changes. Run **one** CLI at a time on port 4400 with a temp DB, capture, **stop the CLI**, then the next auth scene. Do not leave background studio servers running.

**Cleanup:** when finished, stop any extra `wave studio` processes you started for auth (`pkill -f "wave-cli/src/main.ts studio"` if needed). It is fine to stop `bun run dev` when done.

## Filename convention

| Pattern | Meaning |
|--------|---------|
| `auth-*.png` | Pre-shell gates |
| `shell-*-empty.png` / `shell-*-with-*.png` | Main views — empty vs populated |
| `table-<table>-*.png` | Table browser |
| `schema-*.png` | Schema overlays |
| `state-*.png` | Error/empty cross-cutting UI |
| `embed-*.png` | Embedded host path |
