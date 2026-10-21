import { useEffect, useRef, useState } from "react";
import { api, type QueryResult } from "./api";
import { DataGrid } from "./DataGrid";

const HISTORY_KEY = "wave-studio-history";

export function SqlConsole({ onChanged, initial }: { onChanged: () => void; initial?: string }) {
  const [text, setText] = useState(initial ?? "SELECT 1 AS hello;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initial !== undefined) setText(initial);
  }, [initial]);

  async function run() {
    const sql = text.trim();
    if (!sql) return;
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await api.sql(sql);
      setResult(r);
      setError(null);
      setMs(performance.now() - t0);
      const next = [sql, ...history.filter((h) => h !== sql)].slice(0, 30);
      setHistory(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      if (!/^\s*(select|explain)/i.test(sql)) onChanged();
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
      setMs(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="sql-title">
      <header className="view-head">
        <h2 id="sql-title">SQL console</h2>
        <p className="muted">Ctrl/⌘ + Enter to run. One statement at a time.</p>
      </header>
      <label htmlFor="sql-input" className="sr-only">
        SQL statement
      </label>
      <textarea
        id="sql-input"
        ref={ref}
        className="editor"
        value={text}
        spellCheck={false}
        rows={7}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div className="toolbar">
        <button type="button" onClick={() => void run()} disabled={running}>
          {running ? "Running…" : "Run"}
        </button>
        {ms !== null && <span className="muted">{ms.toFixed(1)} ms</span>}
        {history.length > 0 && (
          <>
            <label htmlFor="history">History</label>
            <select
              id="history"
              value=""
              onChange={(e) => {
                if (e.target.value) setText(e.target.value);
                ref.current?.focus();
              }}
            >
              <option value="">Recent statements…</option>
              {history.map((h, i) => (
                <option key={i} value={h}>
                  {h.replace(/\s+/g, " ").slice(0, 80)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && result.columns.length > 0 && (
        <>
          <p className="muted" aria-live="polite">
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
          </p>
          <DataGrid caption="Query results" columns={result.columns} rows={result.rows} />
        </>
      )}
      {result && result.columns.length === 0 && (
        <p className="ok" role="status">
          OK — {result.rowsAffected} row{result.rowsAffected === 1 ? "" : "s"} affected
          {result.lastInsertId !== undefined && result.lastInsertId !== null ? ` · last insert id ${String(result.lastInsertId)}` : ""}
        </p>
      )}
    </section>
  );
}
