import { useEffect, useState } from "react";
import { api, type Stats } from "./api";
import { Icon } from "./icons";
import { waveEngineVersionTag } from "./version";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}

const METRIC_ICONS: Record<string, string> = {
  Commits: "done_all",
  Conflicts: "sync_problem",
  Rollbacks: "undo",
  "Active transactions": "bolt",
  "fsync batches": "save",
  "Commit clock": "schedule",
  "Tracked writes": "edit_note",
  "On disk": "hard_drive",
};

export function StatsView({ onChanged }: { onChanged: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"vacuum" | "compact" | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .stats()
        .then((s) => alive && (setStats(s), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const items: [string, string, string][] = stats
    ? [
        ["Commits", stats.commits.toLocaleString(), "Total committed transactions (persists across restart)"],
        ["Conflicts", stats.conflicts.toLocaleString(), "Transaction retry / write conflicts (persists across restart)"],
        ["Rollbacks", stats.rollbacks.toLocaleString(), "Aborted transactions (persists across restart)"],
        ["Active transactions", stats.activeTxns.toLocaleString(), "In-flight txns (resets when process restarts)"],
        ["fsync batches", stats.fsyncs.toLocaleString(), "WAL disk sync operations (persists across restart)"],
        ["Commit clock", stats.visibleTs.toLocaleString(), "Latest visible commit timestamp (from storage)"],
        ["Tracked writes", stats.trackedWrites.toLocaleString(), "Keys held for conflict validation (in-memory)"],
        ["On disk", bytes(stats.diskBytes), `${stats.diskBytes.toLocaleString()} bytes on disk now`],
      ]
    : [];

  return (
    <section aria-labelledby="stats-title">
      <div className="stats-banner">
        <div className="stats-banner-inner">
          <div>
            <div className="stats-title-row">
              <h1 id="stats-title" className="stats-title">
                Engine Stats
              </h1>
              <span className="pill-version">live</span>
            </div>
            <div className="stats-sub">
              <span>WaveDB Storage &amp; Transaction Engine</span>
              <span className="dot" style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--outline)" }} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className="conn-dot" style={{ width: 8, height: 8 }} />
                <span className="mono-sm">Auto-refreshing every 2s</span>
              </span>
            </div>
          </div>
          <div className="stats-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("vacuum");
                try {
                  const r = await api.vacuum();
                  setMsg(`Vacuum removed ${r.removed.toLocaleString()} dead version(s)`);
                  onChanged();
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Icon name="cleaning_services" className="icon-sm" />
              <span>{busy === "vacuum" ? "Vacuuming…" : "Vacuum"}</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("compact");
                try {
                  await api.compact();
                  setMsg("Compaction complete");
                } finally {
                  setBusy(null);
                }
              }}
            >
              <Icon name="compress" className="icon-sm" />
              <span>{busy === "compact" ? "Compacting…" : "Compact"}</span>
            </button>
            {msg && (
              <span role="status" className="status-msg">
                {msg}
              </span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}

      <dl className="metric-grid">
        {items.map(([k, v, d]) => (
          <div key={k} className="metric-card">
            <div>
              <div className="metric-card-head">
                <span className="metric-label">{k}</span>
                <Icon name={METRIC_ICONS[k] ?? "analytics"} className="icon-md" style={{ color: k === "Conflicts" || k === "Rollbacks" ? "var(--error)" : "var(--primary)" }} />
              </div>
              <p className={`metric-value${k === "Active transactions" ? " metric-value--live" : ""}`}>{v}</p>
              <p className="metric-desc">{d}</p>
            </div>
          </div>
        ))}
      </dl>

      <div className="stats-panels">
        <div className="stats-panel stats-panel--wide">
          <div className="stats-panel-head">
            <div className="stats-panel-title">
              <Icon name="tune" className="icon-md" style={{ color: "var(--primary)" }} />
              <span>Engine Configuration &amp; Runtime Details</span>
            </div>
            <span className="stats-panel-tag">NODE #0 (STANDALONE)</span>
          </div>
          <div className="stats-config-grid">
            <div className="stats-config-card">
              <div className="stats-config-top">
                <span className="metric-label">Engine Version</span>
                <Icon name="verified" className="icon-sm" style={{ color: "var(--primary)" }} />
              </div>
              <div className="mono-md">WaveDB {waveEngineVersionTag()} (embedded)</div>
              <span className="stats-config-sub">Rust core · MVCC + optimistic concurrency</span>
            </div>
            <div className="stats-config-card">
              <div className="stats-config-top">
                <span className="metric-label">Page Size</span>
                <Icon name="memory" className="icon-sm" style={{ color: "var(--tertiary)" }} />
              </div>
              <div className="mono-md">4096 bytes</div>
              <span className="stats-config-sub">LSM-aligned pages</span>
            </div>
            <div className="stats-config-card">
              <div className="stats-config-top">
                <span className="metric-label">Isolation</span>
                <Icon name="bolt" className="icon-sm" style={{ color: "var(--primary)" }} />
              </div>
              <div className="mono-md">Snapshot (RC default)</div>
              <span className="stats-config-sub">Serializable optional per transaction</span>
            </div>
            <div className="stats-config-card">
              <div className="stats-config-top">
                <span className="metric-label">Durability</span>
                <Icon name="save" className="icon-sm" style={{ color: "var(--tertiary)" }} />
              </div>
              <div className="mono-md">Group-commit fsync</div>
              <span className="stats-config-sub">Crash-safe WAL + LSM</span>
            </div>
          </div>
        </div>

        <div className="stats-panel">
          <div className="stats-panel-head">
            <span className="stats-panel-title">Storage Distribution</span>
            <Icon name="pie_chart" className="icon-md" style={{ color: "var(--on-surface-variant)" }} />
          </div>
          <p className="metric-desc" style={{ marginTop: 0 }}>
            On-disk footprint from engine stats.
          </p>
          <div className="storage-bar-block">
            <div className="storage-bar-label">
              <span>Total LSM data</span>
              <span>{stats ? bytes(stats.diskBytes) : "…"}</span>
            </div>
            <div className="storage-bar-track">
              <div className="storage-bar-fill storage-bar-fill--primary" style={{ width: "100%" }} />
            </div>
          </div>
          <div className="storage-bar-block">
            <div className="storage-bar-label">
              <span>Tracked writes (validation)</span>
              <span>{stats ? stats.trackedWrites.toLocaleString() : "…"}</span>
            </div>
            <div className="storage-bar-track">
              <div
                className="storage-bar-fill storage-bar-fill--tertiary"
                style={{ width: stats ? `${Math.min(100, (stats.trackedWrites / Math.max(stats.trackedWrites, 1)) * 100)}%` : "0%" }}
              />
            </div>
          </div>
          <div className="storage-foot">
            <Icon name="swap_horiz" className="icon-sm" style={{ color: "var(--primary)" }} />
            <span className="mono-sm">Visible commit clock</span>
            <span className="mono-sm" style={{ color: "var(--primary)", fontWeight: 500 }}>
              {stats ? stats.visibleTs.toLocaleString() : "…"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
