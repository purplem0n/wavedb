# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Studio **Logs & Metrics** page: live query log with read/write tags, durable read/write counters on disk (`.wave/query-metrics.json`), and JSONL log rotation under `.wave/query-log.jsonl`.
- HTTP API: `GET /api/query-log`, `GET /api/query-metrics` (recorded on each `/api/run`).
