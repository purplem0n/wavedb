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

  const readCount = metrics?.totalReads;
  const writeCount = metrics?.totalWrites;
  const otherCount = metrics?.totalOther;

  return (
    <div className="logs-page" aria-labelledby="logs-title">
      <div className="logs-page-chrome">
        <header className="page-head page-head--schema">
          <div>
            <div className="page-title-row">
              <h1 id="logs-title" className="page-title">
                Logs
              </h1>
              <span className="pill-live">LIVE</span>
            </div>
          </div>
          <div className="page-head-toolbar logs-head-toolbar">
            <label className="logs-kind-select">
              <span className="sr-only">Filter by query kind</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value as QueryKind | "all")} aria-label="Filter by query kind">
                <option value="all">All kinds</option>
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="other">Other</option>
              </select>
            </label>
            <div className="search-wrap search-wrap--toolbar">
              <Icon name="search" className="search-icon" />
              <input
                className="search-input search-input--toolbar"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SQL…"
                spellCheck={false}
                autoComplete="off"
                aria-label="Search SQL in log"
              />
            </div>
          </div>
        </header>

        {error && (
          <p role="alert" className="alert alert--error logs-page-error">
            {error}
          </p>
        )}

        <div className="schema-stats-bar logs-page-stats" aria-label="Query metrics">
          <div className="schema-stats-bar-metrics">
            <span className="schema-stat">
              <Icon name="menu_book" className="icon-sm" />
              <strong>{readCount === undefined ? "…" : readCount.toLocaleString()}</strong>
              <span className="schema-stat-label">reads</span>
            </span>
            <span className="schema-stat-sep" aria-hidden="true" />
            <span className="schema-stat">
              <Icon name="edit_note" className="icon-sm" />
              <strong>{writeCount === undefined ? "…" : writeCount.toLocaleString()}</strong>
              <span className="schema-stat-label">writes</span>
            </span>
            <span className="schema-stat-sep" aria-hidden="true" />
            <span className="schema-stat">
              <Icon name="more_horiz" className="icon-sm" />
              <strong>{otherCount === undefined ? "…" : otherCount.toLocaleString()}</strong>
              <span className="schema-stat-label">other</span>
            </span>
          </div>
          <span className="schema-stats-showing">
            Showing <strong>{visible.length}</strong> of {entries.length} entries
          </span>
        </div>
      </div>

      <div className="logs-page-body">
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
      </div>
    </div>
  );
}
