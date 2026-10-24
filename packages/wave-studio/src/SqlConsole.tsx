import { useEffect, useMemo, useRef, useState } from "react";
import { api, uiToEngineLatencyMs, type QueryResult, type TableDef } from "./api";
import { applyCompletion, sqlCompletions, tokenBeforeCursor, type CompletionItem } from "./sqlComplete";
import { highlightSql } from "./sqlHighlight";
import { DataGrid } from "./DataGrid";
import { Icon } from "./icons";
import { waveEngineVersionTag } from "./version";
import {
  deleteSavedQuery,
  loadSavedQueries,
  upsertSavedQuery,
  type SavedQuery,
} from "./sqlBookmarks";

const HISTORY_KEY = "wave-studio-history";

function lineNumbers(text: string): number {
  return Math.max(1, text.split("\n").length);
}

export function SqlConsole({
  onChanged,
  initial,
  tables,
}: {
  onChanged: () => void;
  initial?: string;
  tables: TableDef[];
}) {
  const [text, setText] = useState(initial ?? "SELECT 1 AS hello;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engineMs, setEngineMs] = useState<number | null>(null);
  const [uiLatencyMs, setUiLatencyMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState<SavedQuery[]>(() => loadSavedQueries());
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const highlighted = useMemo(() => highlightSql(text), [text]);
  const historyRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  const [completionIdx, setCompletionIdx] = useState(0);
  const [completionOpen, setCompletionOpen] = useState(false);

  function refreshCompletions(nextText: string, cursor: number, force = false) {
    if (!force && tokenBeforeCursor(nextText, cursor).prefix === "") {
      setCompletionOpen(false);
      return;
    }
    const items = sqlCompletions(nextText, cursor, tables);
    setCompletions(items);
    setCompletionIdx(0);
    setCompletionOpen(items.length > 0);
  }

  function pickCompletion(item: CompletionItem) {
    const el = ref.current;
    if (!el) return;
    const r = applyCompletion(text, el.selectionStart ?? text.length, item);
    setText(r.text);
    setCompletionOpen(false);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.cursor, r.cursor);
    });
  }

  useEffect(() => {
    if (initial !== undefined) setText(initial);
  }, [initial]);

  useEffect(() => {
    if (!historyOpen && !savedOpen && !saveOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (historyOpen && historyRef.current && !historyRef.current.contains(t)) setHistoryOpen(false);
      if (savedOpen && savedRef.current && !savedRef.current.contains(t)) setSavedOpen(false);
      if (saveOpen && saveRef.current && !saveRef.current.contains(t)) setSaveOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [historyOpen, savedOpen, saveOpen]);

  function openSaveDialog(existing?: SavedQuery) {
    setSaveName(existing?.name ?? "");
    setSaveDescription(existing?.description ?? "");
    setActiveSavedId(existing?.id ?? activeSavedId);
    setSaveOpen(true);
    setSavedOpen(false);
  }

  function commitSave() {
    const sql = text.trim();
    if (!sql) return;
    try {
      const row = upsertSavedQuery({
        id: activeSavedId ?? undefined,
        name: saveName,
        description: saveDescription,
        sql,
      });
      setSaved(loadSavedQueries());
      setActiveSavedId(row.id);
      setSaveOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const lines = useMemo(() => lineNumbers(text), [text]);

  async function run() {
    const sql = text.trim();
    if (!sql) return;
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await api.sql(sql);
      const clientMs = performance.now() - t0;
      setResult(r);
      setError(null);
      setEngineMs(r.durationMs ?? null);
      setUiLatencyMs(uiToEngineLatencyMs(clientMs, r));
      const next = [sql, ...history.filter((h) => h !== sql)].slice(0, 30);
      setHistory(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      if (!/^\s*(select|explain)/i.test(sql)) onChanged();
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
      setEngineMs(null);
      setUiLatencyMs(null);
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
    <section className="view-page sql-page" aria-labelledby="sql-title">
      <div className="sql-page-head">
        <div>
          <div className="sql-kicker">
            <span>Console</span>
            <span className="dot" />
            <span className="ver">{waveEngineVersionTag("-embedded")}</span>
          </div>
          <h1 id="sql-title" className="page-title">
            SQL console
          </h1>
          <p className="page-sub">One statement at a time.</p>
        </div>
        <div className="sql-toolbar-top">
          <div className="history-menu-wrap" ref={savedRef}>
            <button
              type="button"
              className="btn-secondary"
              onClick={(e) => (e.stopPropagation(), setSavedOpen((o) => !o), setSaveOpen(false))}
            >
              <Icon name="bookmark" className="icon-sm" />
              <span>Saved ({saved.length})</span>
              <Icon name="expand_more" className="icon-sm" />
            </button>
            {savedOpen && (
              <div className="history-menu history-menu--wide" role="menu">
                <div className="history-menu-label">Saved queries (this database)</div>
                {saved.length === 0 ? (
                  <p className="history-menu-empty">No bookmarks yet.</p>
                ) : (
                  saved.map((q) => (
                    <div key={q.id} className="saved-row">
                      <button
                        type="button"
                        className="history-item saved-row-main"
                        role="menuitem"
                        onClick={() => {
                          setText(q.sql);
                          setActiveSavedId(q.id);
                          setSavedOpen(false);
                          ref.current?.focus();
                        }}
                      >
                        <span className="saved-name">{q.name}</span>
                        {q.description && <span className="saved-desc">{q.description}</span>}
                      </button>
                      <div className="saved-row-actions">
                        <button
                          type="button"
                          className="btn-icon"
                          title="Edit bookmark"
                          onClick={() => {
                            setText(q.sql);
                            openSaveDialog(q);
                          }}
                        >
                          <Icon name="edit" className="icon-sm" />
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          title="Delete bookmark"
                          onClick={() => {
                            try {
                              deleteSavedQuery(q.id);
                              setSaved(loadSavedQueries());
                              if (activeSavedId === q.id) setActiveSavedId(null);
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          <Icon name="delete" className="icon-sm" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="history-menu-wrap" ref={saveRef}>
            <button
              type="button"
              className="btn-secondary"
              disabled={!text.trim()}
              onClick={(e) => (e.stopPropagation(), openSaveDialog(saved.find((q) => q.id === activeSavedId)))}
            >
              <Icon name="save" className="icon-sm" />
              <span>{activeSavedId ? "Update saved" : "Save query"}</span>
            </button>
            {saveOpen && (
              <div className="history-menu history-menu--wide save-form" role="dialog" aria-label="Save SQL query">
                <div className="history-menu-label">{activeSavedId ? "Update bookmark" : "New bookmark"}</div>
                <label className="save-field">
                  <span>Name</span>
                  <input value={saveName} onChange={(e) => setSaveName(e.target.value)} required placeholder="Required" />
                </label>
                <label className="save-field">
                  <span>Description</span>
                  <input
                    value={saveDescription}
                    onChange={(e) => setSaveDescription(e.target.value)}
                    placeholder="Optional"
                  />
                </label>
                <div className="save-form-actions">
                  <button type="button" className="btn-secondary" onClick={() => setSaveOpen(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-run" onClick={commitSave} disabled={!saveName.trim()}>
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
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
            {completionOpen && completions.length > 0 && (
              <ul className="sql-complete" role="listbox" aria-label="SQL suggestions">
                {completions.map((c, i) => (
                  <li key={`${c.label}-${i}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === completionIdx}
                      className={`sql-complete-item${i === completionIdx ? " active" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickCompletion(c);
                      }}
                    >
                      <span className={`sql-complete-kind sql-complete-kind--${c.kind}`}>{c.kind}</span>
                      <span className="sql-complete-label">{c.label}</span>
                      {c.detail && <span className="sql-complete-detail">{c.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="sql-editor-stack">
              <pre
                ref={highlightRef}
                className="sql-editor sql-editor-highlight"
                aria-hidden
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
              <textarea
                id="sql-input"
                ref={ref}
                className="sql-editor sql-editor-input"
                value={text}
                spellCheck={false}
                rows={Math.max(5, lines)}
                onScroll={(e) => {
                  const h = highlightRef.current;
                  if (h) {
                    h.scrollTop = e.currentTarget.scrollTop;
                    h.scrollLeft = e.currentTarget.scrollLeft;
                  }
                }}
                onChange={(e) => {
                setText(e.target.value);
                refreshCompletions(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onClick={() => setCompletionOpen(false)}
              onKeyUp={(e) => {
                if (e.ctrlKey || e.metaKey) return;
                if (
                  ["ArrowUp", "ArrowDown", "Escape", "Tab", "Enter", "Shift", "Control", "Meta", "Alt"].includes(e.key)
                ) {
                  return;
                }
                refreshCompletions(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
              }}
              onKeyDown={(e) => {
                if (completionOpen && completions.length > 0) {
                  if (e.key === "Tab" || (e.key === "Enter" && e.shiftKey === false && !(e.metaKey || e.ctrlKey))) {
                    e.preventDefault();
                    pickCompletion(completions[completionIdx]!);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCompletionOpen(false);
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCompletionIdx((i) => (i + 1) % completions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCompletionIdx((i) => (i - 1 + completions.length) % completions.length);
                    return;
                  }
                }
                if ((e.metaKey || e.ctrlKey) && e.key === " ") {
                  e.preventDefault();
                  refreshCompletions(e.currentTarget.value, e.currentTarget.selectionStart ?? 0, true);
                  return;
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
              />
            </div>
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
            {engineMs !== null && result && (
              <>
                <span className="run-meta-dot" />
                <span>
                  Query speed {engineMs.toFixed(2)}ms
                  {uiLatencyMs !== null && <> • UI latency {uiLatencyMs.toFixed(2)}ms</>} • {result.rows.length} row
                  {result.rows.length === 1 ? "" : "s"} returned
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
          <span style={{ fontSize: "11px", opacity: 0.7 }}>
            Tab to accept suggestion · ⌃Space to open · schema from live tables
          </span>
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
