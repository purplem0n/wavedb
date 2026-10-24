# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Wave Studio table browser no longer crashes on tables with foreign keys (FK catalog JSON uses `refTable` / `refColumns`; FK hover preview now matches the engine).

### Changed

- Create table modal: labeled fields (table name, then primary key name and type), single title in the modal header.

