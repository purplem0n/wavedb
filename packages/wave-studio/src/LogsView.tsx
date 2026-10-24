import { useEffect, useMemo, useState } from "react";
import { api, type QueryKind, type QueryLogEntry, type QueryMetrics } from "./api";
import { Icon } from "./icons";

const KIND_LABEL: Record<QueryKind, string> = {
  read: "Read",
  write: "Write",
  other: "Other",
};

function kindClass(kind: QueryKind): string {
  if (kind === "read") return "log-tag log-tag--read";
  if (kind === "write") return "log-tag log-tag--write";
  return "log-tag log-tag--other";
}

function formatTime(at: number): string {
  const d = new Date(at);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export function LogsView() {
  const [metrics, setMetrics] = useState<QueryMetrics | null>(null);
  const [entries, setEntries] = useState<QueryLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueryKind | "all">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    let lastId: string | undefined;

    const tick = async () => {
      try {
        const [m, log] = await Promise.all([api.queryMetrics(), api.queryLog(lastId ? { since: lastId, limit: 200 } : { limit: 200 })]);
        if (!alive) return;
        setMetrics(m);
        setError(null);
        if (log.entries.length) {
          lastId = log.entries[log.entries.length - 1]!.id;
          setEntries((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const merged = [...prev];
            for (const e of log.entries) {
              if (!seen.has(e.id)) merged.push(e);
            }
            return merged.slice(-500);
          });
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== "all" && e.kind !== filter) return false;
      if (q && !e.sql.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, search]);

  return (
    <section className="view-page" aria-labelledby="logs-title">
      <div className="stats-banner">
        <div className="stats-banner-inner">
          <div>
            <div className="stats-title-row">
              <h1 id="logs-title" className="stats-title">
                Logs &amp; Metrics
              </h1>
              <span className="pill-live">LIVE</span>
            </div>
            <div className="stats-sub">
              <span>Query stream from this Wave server</span>
              <span className="dot" style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--outline)" }} />
              <span className="mono-sm">Polling every 1s</span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}

      <dl className="metric-grid metric-grid--3">
        {(
          [
            ["Total reads", metrics?.totalReads ?? "…", "SELECT / read queries"],
            ["Total writes", metrics?.totalWrites ?? "…", "INSERT, UPDATE, DELETE, DDL"],
            ["Other", metrics?.totalOther ?? "…", "Transactions and unrecognized statements"],
          ] as const
        ).map(([k, v, d]) => (
          <div key={k} className="metric-card">
            <div>
              <div className="metric-card-head">
                <span className="metric-label">{k}</span>
                <Icon name="analytics" className="icon-md" style={{ color: "var(--primary)" }} />
              </div>
              <p className="metric-value">{typeof v === "number" ? v.toLocaleString() : v}</p>
              <p className="metric-desc">{d}</p>
            </div>
          </div>
        ))}
      </dl>

      <div className="logs-toolbar">
        <label className="logs-filter">
          <span className="metric-label">Filter</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as QueryKind | "all")}>
            <option value="all">All</option>
            <option value="read">Read</option>
            <option value="write">Write</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="logs-search">
          <span className="metric-label">Search SQL</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter log text…" />
        </label>
      </div>

      <div className="logs-table-wrap">
        <table className="logs-table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Kind</th>
              <th scope="col">SQL</th>
              <th scope="col">Duration</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={5} className="logs-empty">
                  No queries yet — run SQL from the console or browse tables.
                </td>
              </tr>
            ) : (
              visible
                .slice()
                .reverse()
                .map((e) => (
                  <tr key={e.id} className={e.ok ? undefined : "logs-row--err"}>
                    <td className="mono-sm">{formatTime(e.at)}</td>
                    <td>
                      <span className={kindClass(e.kind)}>{KIND_LABEL[e.kind]}</span>
                    </td>
                    <td className="logs-sql mono-sm">{e.sql}</td>
                    <td className="mono-sm">{e.durationMs !== undefined ? `${e.durationMs.toFixed(2)}ms` : "—"}</td>
                    <td>{e.ok ? "OK" : e.error ?? "Error"}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
