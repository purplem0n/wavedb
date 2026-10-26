# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Default engine block cache is **16 MiB** (was 64 MiB). Override with `wave({ cacheMb })` or `WAVE_CACHE_MB` for larger deployments.
- With a data path, query log hot ring default is **128** entries with short in-memory SQL labels; JSONL stores SQL truncated to 2,000 characters per entry.
- `waveHost({ studio: false })` skips mounting Studio static files (API-only embeds).

