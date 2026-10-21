# Replication & encryption (roadmap)

## Replication (1.1+)

Planned design:

1. **Commit log** on the leader: each commit appends `{ commit_ts, batch }` to a retained log segment.
2. **Follower** applies log entries in order to a local read-only copy (separate `data.wave` path).
3. **Clients** use `connect(url, { readPreference: "replica" })` when read replicas are registered.

Not implemented in 0.1.x; use single-host `serve` + backups today.

## Encryption at rest

- **Recommended:** volume or filesystem encryption (LUKS, cloud provider disk encryption).
- **Application-level:** encrypt sensitive columns in app code before insert.
- **Future:** optional page-level encryption in the storage engine would require a format version bump.

## Sharding

Application-level sharding only: multiple `data.wave` directories and routing in app code. No automatic rebalancing in the current roadmap.
