# Wave Studio UI screenshots

Canonical PNGs for the Wave Studio dashboard. Agents and contributors refresh these when Studio UI or its API/embed changes (see `.cursor/rules/wave-studio-ui.mdc`).

## Rules (no duplicates)

1. **Only** files listed in [`manifest.json`](./manifest.json) may live in this directory (plus this README).
2. **Never** add dated files, `-2` suffixes, or “before/after” pairs — update the canonical file in place.
3. **1280×800** viewport unless a manifest entry sets `viewport`.
4. Prefer **`examples/hono-marketplace`** with `bun run seed:small:force` for table data (`products`, etc.). Use **`--no-auth`** CLI studio only for `auth-token` and quick nav shots when auth gates are unchanged.

## Capture workflow

```bash
bun run test:studio
# Option A — CLI (token gate)
bun packages/wave-cli/src/main.ts studio /tmp/wave-studio-ui.wave --port 4400 --no-open --no-auth
# Option B — embed
cd examples/hono-marketplace && bun run seed:small:force && bun run dev
```

Navigate with hash routes (`#/schema`, `#/sql`, …). Save screenshots using the exact filenames from the manifest.

## Filename convention

| Pattern | Meaning |
|--------|---------|
| `auth-*.png` | Pre-shell gates (loading, setup, login, token) |
| `shell-*.png` | Main app: sidebar + primary view, default state |
| `table-<table>-*.png` | Table browser sub-states |
| `schema-*.png` | Schema page overlays/panels |
| `state-*.png` | Cross-cutting empty/error UI |
| `embed-*.png` | Studio mounted under an app prefix (e.g. hono marketplace) |
