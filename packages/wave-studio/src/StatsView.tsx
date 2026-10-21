import { useEffect, useState } from "react";
import { api, type Stats } from "./api";

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

export function StatsView({ onChanged }: { onChanged: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState<string | null>(null);

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
        ["Commits", stats.commits.toLocaleString(), "Transactions committed since the database opened"],
        ["Conflicts", stats.conflicts.toLocaleString(), "Commits rejected by optimistic validation (clients retry)"],
        ["Rollbacks", stats.rollbacks.toLocaleString(), "Transactions rolled back"],
        ["Active transactions", stats.activeTxns.toLocaleString(), "Open snapshots"],
        ["fsync batches", stats.fsyncs.toLocaleString(), "Group-commit durability syncs"],
        ["Commit clock", stats.visibleTs.toLocaleString(), "Latest visible commit timestamp"],
        ["Tracked writes", stats.trackedWrites.toLocaleString(), "Keys held for conflict validation"],
        ["On disk", bytes(stats.diskBytes), "LSM data size"],
      ]
    : [];

  return (
    <section aria-labelledby="stats-title">
      <header className="view-head">
        <h2 id="stats-title">Engine stats</h2>
        <p className="muted">Refreshes every 2 seconds</p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <dl className="stats">
        {items.map(([k, v, d]) => (
          <div key={k} className="stat">
            <dt>{k}</dt>
            <dd>{v}</dd>
            <dd className="muted small">{d}</dd>
          </div>
        ))}
      </dl>
      <div className="toolbar">
        <button
          type="button"
          onClick={async () => {
            const r = await api.vacuum();
            setMsg(`Vacuum removed ${r.removed.toLocaleString()} dead version(s)`);
            onChanged();
          }}
        >
          Vacuum
        </button>
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            await api.compact();
            setMsg("Compaction complete");
          }}
        >
          Compact
        </button>
        <span role="status" className="muted">
          {msg}
        </span>
      </div>
    </section>
  );
}
