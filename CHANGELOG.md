# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Query log keeps a small in-process ring (default 512 entries) when using a data path; `/api/query-log` tails `.wave/query-log.jsonl` on demand (bounded reads) instead of loading up to 10,000 entries into memory at startup.

