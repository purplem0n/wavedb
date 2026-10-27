# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Leader lease: same-host reclaim when `pid` is missing (legacy/OOM); embed/`wave serve` goes standby when renewal fails; HTTP write paths fence on lease generation before `run` / commit / vacuum / compact.
