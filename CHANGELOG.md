# Changelog

All notable changes to `@purplemon/wavedb`, `@purplemon/wave-cli`, and the Wave engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Engine:** DDL-time foreign key validation on `CREATE TABLE`; `DROP TABLE` RESTRICT/CASCADE with dependent table and view checks; FK-aware `DROP COLUMN`, `DROP INDEX`, and `RENAME TABLE` / `RENAME COLUMN` catalog updates; `ALTER TABLE ADD/DROP CONSTRAINT` for foreign keys with named constraints.
- **@purplemon/wavedb:** Schema migrator diffs foreign keys, orders safe table drops, and blocks destructive ops when FK dependencies exist.

### Changed

- **Wave Studio:** Align Schema (and shared toolbar controls) with Stitch exported HTML—title row with engine pill, New table + filter search on one toolbar (matched height and corner radius), summary KPI cards, and entity cards/index footers.
- **Wave Studio:** Fix sidebar table list showing literal `table_chart` text by not forcing monospace on icon spans; use Stitch-style SVG table icons beside monospace table names.
- **Wave Studio:** Schema create/manage flows use modals; compact filter bar; merged table footer (pagination + engine version); improved SQL column autocomplete after `FROM`.

### Fixed

- **Engine:** `DROP TABLE` no longer leaves child tables with foreign keys pointing at removed parents (default RESTRICT; optional `CASCADE`).

