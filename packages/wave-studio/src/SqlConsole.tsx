import { useEffect, useMemo, useRef, useState } from "react";
import { api, type QueryResult } from "./api";
import { DataGrid } from "./DataGrid";
import { Icon } from "./icons";

const HISTORY_KEY = "wave-studio-history";

function lineNumbers(text: string): number {
  return Math.max(1, text.split("\n").length);
}

export function SqlConsole({ onChanged, initial }: { onChanged: () => void; initial?: string }) {
  const [text, setText] = useState(initial ?? "SELECT 1 AS hello;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initial !== undefined) setText(initial);
  }, [initial]);

  useEffect(() => {
    if (!historyOpen) return;
    const close = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [historyOpen]);

  const lines = useMemo(() => lineNumbers(text), [text]);

  async function run() {
    const sql = text.trim();
    if (!sql) return;
    setRunning(true);
    try {
      const r = await api.sql(sql);
      setResult(r);
      setError(null);
      setMs(r.durationMs ?? null);
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

  async function copyResults() {
    if (!result || result.columns.length === 0) return;
    const header = result.columns.join("\t");
    const body = result.rows.map((r) => r.map((v) => (v === null ? "" : String(v))).join("\t")).join("\n");
    await navigator.clipboard.writeText(`${header}\n${body}`);
  }

  return (
    <section aria-labelledby="sql-title">
      <div className="sql-page-head">
        <div>
          <div className="sql-kicker">
            <span>Console</span>
            <span className="dot" />
            <span className="ver">v0.1-embedded</span>
          </div>
          <h1 id="sql-title" className="page-title">
            SQL console
          </h1>
          <p className="page-sub">One statement at a time.</p>
        </div>
        <div className="sql-toolbar-top">
          <div className="history-menu-wrap" ref={historyRef}>
            <button type="button" className="btn-secondary" onClick={(e) => (e.stopPropagation(), setHistoryOpen((o) => !o))} disabled={history.length === 0}>
              <Icon name="history" className="icon-sm" />
              <span>Recent ({history.length})</span>
              <Icon name="expand_more" className="icon-sm" />
            </button>
            {historyOpen && history.length > 0 && (
              <div className="history-menu" role="menu">
                <div className="history-menu-label">localStorage statements</div>
                {history.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    className="history-item"
                    role="menuitem"
                    onClick={() => {
                      setText(h);
                      setHistoryOpen(false);
                      ref.current?.focus();
                    }}
                  >
                    {h.replace(/\s+/g, " ").slice(0, 120)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setText("");
              ref.current?.focus();
            }}
          >
            <Icon name="backspace" className="icon-sm" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      <div className="sql-editor-shell">
        <div className="sql-editor-body">
          <div className="sql-linenum" aria-hidden="true">
            {Array.from({ length: lines }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <div className="sql-editor-wrap">
            <label htmlFor="sql-input" className="sr-only">
              SQL statement
            </label>
            <textarea
              id="sql-input"
              ref={ref}
              className="sql-editor"
              value={text}
              spellCheck={false}
              rows={Math.max(5, lines)}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
            />
          </div>
        </div>
        <div className="sql-run-bar">
          <div className="run-meta">
            <button type="button" className="btn-run" onClick={() => void run()} disabled={running}>
              <Icon name="play_arrow" className="icon-md" />
              <span>{running ? "Running…" : "Run"}</span>
              <span className="mono-sm" style={{ opacity: 0.75, fontWeight: 400 }}>
                ⌘↵
              </span>
            </button>
            {ms !== null && result && (
              <>
                <span className="run-meta-dot" />
                <span>
                  Engine query {ms.toFixed(2)}ms • {result.rows.length} row{result.rows.length === 1 ? "" : "s"} returned
                </span>
              </>
            )}
          </div>
          {result && result.columns.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => void copyResults()}>
              <Icon name="content_copy" className="icon-sm" />
              <span>Copy results</span>
            </button>
          )}
        </div>
      </div>

      <div className="sql-hint-bar">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
          <Icon name="info" className="icon-sm" style={{ color: "var(--tertiary)" }} />
          <span>
            For writes: <strong style={{ color: "var(--on-surface)" }}>&quot;1 row affected • lastInsertId: …&quot;</strong>
          </span>
        </div>
        <span style={{ fontSize: "11px", opacity: 0.7 }}>Read-committed snapshot isolation</span>
      </div>

      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}

      {result && result.columns.length > 0 && (
        <div className="sql-results-wrap">
          <DataGrid caption="Query results" columns={result.columns} rows={result.rows} embedded />
        </div>
      )}

      {result && result.columns.length === 0 && (
        <p className="alert alert--ok" role="status" style={{ margin: "var(--space-md) var(--space-lg)" }}>
          OK — {result.rowsAffected} row{result.rowsAffected === 1 ? "" : "s"} affected
          {result.lastInsertId !== undefined && result.lastInsertId !== null ? ` · last insert id ${String(result.lastInsertId)}` : ""}
        </p>
      )}
    </section>
  );
}
