# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- SQL Console **syntax highlighting** for keywords, strings, numbers, and comments (dark-theme tokens).
- SQL Console **schema autocomplete**: table/column and keyword suggestions from live schema (updates when tables reload).
- SQL Console **saved queries**: name/description bookmarks with list, load, update, and delete (stored per API prefix in browser localStorage).
- Studio **Logs & Metrics** page: live query log with read/write tags, durable read/write counters on disk (`.wave/query-metrics.json`), and JSONL log rotation under `.wave/query-log.jsonl`.
- HTTP API: `GET /api/query-log`, `GET /api/query-metrics` (recorded on each `/api/run`).

### Fixed

- Engine stats: commits, conflicts, rollbacks, and fsync batch counters persist in database meta and survive process restart; Studio labels note which stats are session-only.
