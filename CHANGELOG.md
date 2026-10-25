# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Query logging runs at the in-process executor layer (`wave()` with a data path), so embedded app and cron traffic appears in Studio Logs; HTTP `/api/run` no longer records a second copy of the same query.
- Studio query log retains up to **10,000** entries across restarts (`data.wave/.wave/query-log.jsonl`); in-memory API matches the on-disk tail (replacing the old 500-entry RAM-only buffer and byte-based rotation).

