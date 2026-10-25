# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Query log keeps a small in-process ring (default 512 entries) when using a data path; history is read from `.wave/query-log.jsonl` on `/api/query-log` instead of loading up to 10,000 entries into memory at startup.

