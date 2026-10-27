# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Leader lease: same-host reclaim when `pid` is missing (legacy/OOM), and embed/`wave serve` retries acquire for up to ~20s (`WAVE_LEADER_WAIT_MS`) before error or standby — avoids Fly restart crash loops after hard kills.
