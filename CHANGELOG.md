# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Leader lease: same-host restart (e.g. single-machine Fly deploy after SIGINT) reclaims an unexpired lease when the previous holder process is no longer running.
