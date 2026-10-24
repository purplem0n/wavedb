import { useCallback, useEffect, useState } from "react";
import { api, display, engineQueryDurationMs, quote, uiToEngineLatencyMs, type QueryResult, type TableDef } from "./api";
import { tableWhereClause, validateTableFilter } from "./tableFilter";
import { emptyRule, TableFilterUi } from "./TableFilterUi";
import { uiFiltersToWhere } from "./uiFilter";
import { DataGrid } from "./DataGrid";
import { RefreshIcon } from "./icons";
import { RowEditor } from "./RowEditor";
import { buildUpdateSql, parseCellInput } from "./rowEdit";
import { waveEngineVersionTag } from "./version";

const PAGE = 50;

export function TableView({
  table,
  tables,
  version,
  onMutate,
}: {
  table: TableDef;
  tables: TableDef[];
  version: number;
  onMutate?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [uiRulesList, setUiRulesList] = useState(() => [emptyRule(table.columns)]);
  const [advancedSql, setAdvancedSql] = useState(false);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryMs, setQueryMs] = useState<number | null>(null);
  const [uiLatencyMs, setUiLatencyMs] = useState<number | null>(null);
  const [cellEdit, setCellEdit] = useState<{ row: number; col: string; value: string } | null>(null);
  const [rowEdit, setRowEdit] = useState<{ row: number; draft: Record<string, string> } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const canEdit = table.primaryKey.length > 0;

  async function persistChanges(rowIndex: number, changes: Record<string, unknown>) {
    if (!result) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const sql = buildUpdateSql(table, result.columns, result.rows[rowIndex]!, changes);
      await api.sql(sql);
      setCellEdit(null);
      setRowEdit(null);
      onMutate?.();
      await load();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  useEffect(() => {
    setFilter("");
    setApplied("");
    setUiRulesList([emptyRule(table.columns)]);
    setAdvancedSql(false);
    setSort(null);
    setPage(0);
  }, [table.name]);

  const load = useCallback(async () => {
    setLoading(true);
    const t0 = performance.now();
    try {
      const where = tableWhereClause(applied);
      const order = sort ? ` ORDER BY ${quote(sort.column)} ${sort.desc ? "DESC" : "ASC"}` : "";
      const [rows, count] = await Promise.all([
        api.sql(`SELECT * FROM ${quote(table.name)}${where}${order} LIMIT ${PAGE} OFFSET ${page * PAGE}`),
        api.sql(`SELECT count(*) AS n FROM ${quote(table.name)}${where}`),
      ]);
      const clientMs = performance.now() - t0;
      setResult(rows);
      setTotal(Number(count.rows[0]?.[0] ?? 0));
      setQueryMs(engineQueryDurationMs(rows, count));
      setUiLatencyMs(uiToEngineLatencyMs(clientMs, rows, count));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setQueryMs(null);
      setUiLatencyMs(null);
    } finally {
      setLoading(false);
    }
  }, [table.name, applied, sort, page, version]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / PAGE));
  const pkLabel =
    table.primaryKey.length > 0
      ? `PK: ${table.primaryKey.join(", ")}${table.columns.find((c) => c.name === table.primaryKey[0]) ? ` (${table.columns.find((c) => c.name === table.primaryKey[0])!.type})` : ""}`
      : null;
  const rowFrom = total === 0 ? 0 : page * PAGE + 1;
  const rowTo = total === null ? 0 : Math.min(total, (page + 1) * PAGE);

  return (
    <section className="table-view" aria-labelledby="table-title">
      <div className="table-view-chrome">
      <div className="table-page-head">
        <div className="table-title-block">
          <h1 id="table-title">{table.name}</h1>
          <span className="pill-version">{waveEngineVersionTag()}</span>
          <div className="table-chips">
            <span className="chip">{total === null ? "…" : total.toLocaleString()} rows</span>
            <span className="chip">{table.columns.length} columns</span>
            {pkLabel && <span className="chip chip--pk">{pkLabel}</span>}
          </div>
        </div>
        <button type="button" className="btn-secondary" disabled={loading} onClick={() => void load()} title="Reload dataset">
          <RefreshIcon />
          <span>Refresh</span>
        </button>
      </div>

      <form
        className="filter-bar filter-bar--stacked"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const predicate = advancedSql ? validateTableFilter(filter) : uiFiltersToWhere(uiRulesList, table.columns);
            setPage(0);
            setApplied(predicate);
            setError(null);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        {!advancedSql ? (
          <TableFilterUi columns={table.columns} rules={uiRulesList} onChange={setUiRulesList} />
        ) : (
          <>
            <label htmlFor="where-input">Advanced SQL (WHERE predicate only)</label>
            <div className="filter-input-wrap">
              <input
                id="where-input"
                className="filter-input"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={table.columns[0] ? `id > 10 AND ${table.columns[1]?.name ?? "status"} = 'shipped'...` : ""}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="filter-sql-tag">SQL</span>
            </div>
          </>
        )}
        <div className="filter-actions">
          <button type="submit" className="btn-primary">
            Apply filters
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setAdvancedSql((a) => !a);
              setError(null);
            }}
          >
            {advancedSql ? "Simple filters" : "Advanced SQL"}
          </button>
          {(applied || uiRulesList.some((r) => r.value)) && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setFilter("");
                setApplied("");
                setUiRulesList([emptyRule(table.columns)]);
                setPage(0);
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {error && (
        <p role="alert" className="alert alert--error table-view-error">
          {error}
        </p>
      )}
      </div>

      <div className="table-view-body">
        {result && (
          <DataGrid
            caption={`Rows of ${table.name}`}
            columns={result.columns}
            rows={result.rows}
            sort={sort}
            schema={tables}
            tableDef={table}
            editable={canEdit}
            types={Object.fromEntries(table.columns.map((c) => [c.name, c.type]))}
            onSort={(c) => {
              setPage(0);
              setSort((s) => (s?.column === c ? (s.desc ? null : { column: c, desc: true }) : { column: c, desc: false }));
            }}
            onCellDoubleClick={(rowIndex, col) => {
              if (table.primaryKey.includes(col)) return;
              const j = result.columns.indexOf(col);
              const v = result.rows[rowIndex]?.[j];
              const def = table.columns.find((c) => c.name === col);
              setEditError(null);
              setCellEdit({
                row: rowIndex,
                col,
                value: v === null || v === undefined ? "" : display(v, def?.type),
              });
            }}
            onEditRow={(rowIndex) => {
              const draft: Record<string, string> = {};
              for (let j = 0; j < result.columns.length; j++) {
                const col = result.columns[j]!;
                const def = table.columns.find((c) => c.name === col);
                const v = result.rows[rowIndex]?.[j];
                draft[col] = v === null || v === undefined ? "" : display(v, def?.type);
              }
              setEditError(null);
              setRowEdit({ row: rowIndex, draft });
            }}
          />
        )}
        {cellEdit && result && (
          <div className="cell-edit-popover" role="dialog" aria-label={`Edit ${cellEdit.col}`}>
            <label className="cell-edit-label">{cellEdit.col}</label>
            <input
              value={cellEdit.value}
              autoFocus
              disabled={editBusy}
              onChange={(e) => setCellEdit({ ...cellEdit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCellEdit(null);
                if (e.key === "Enter") {
                  e.preventDefault();
                  void (async () => {
                    const def = table.columns.find((c) => c.name === cellEdit.col);
                    if (!def) return;
                    const parsed = parseCellInput(cellEdit.value, def.type, def.nullable);
                    await persistChanges(cellEdit.row, { [cellEdit.col]: parsed });
                  })();
                }
              }}
            />
            {editError && (
              <p role="alert" className="alert alert--error">
                {editError}
              </p>
            )}
            <div className="cell-edit-actions">
              <button type="button" className="btn-secondary" onClick={() => setCellEdit(null)} disabled={editBusy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-run"
                disabled={editBusy}
                onClick={() => {
                  void (async () => {
                    const def = table.columns.find((c) => c.name === cellEdit.col);
                    if (!def) return;
                    const parsed = parseCellInput(cellEdit.value, def.type, def.nullable);
                    await persistChanges(cellEdit.row, { [cellEdit.col]: parsed });
                  })();
                }}
              >
                {editBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
        {rowEdit && result && (
          <RowEditor
            table={table}
            columns={result.columns}
            row={result.rows[rowEdit.row]!}
            draft={rowEdit.draft}
            busy={editBusy}
            error={editError}
            onChange={(col, value) => setRowEdit({ ...rowEdit, draft: { ...rowEdit.draft, [col]: value } })}
            onClose={() => setRowEdit(null)}
            onSave={() => {
              void (async () => {
                const changes: Record<string, unknown> = {};
                const pk = new Set(table.primaryKey);
                for (const col of result.columns) {
                  if (pk.has(col)) continue;
                  const def = table.columns.find((c) => c.name === col);
                  if (!def) continue;
                  const j = result.columns.indexOf(col);
                  const old = result.rows[rowEdit.row]?.[j];
                  const oldDisp = old === null || old === undefined ? "" : display(old, def.type);
                  if (rowEdit.draft[col] === oldDisp) continue;
                  changes[col] = parseCellInput(rowEdit.draft[col] ?? "", def.type, def.nullable);
                }
                if (Object.keys(changes).length === 0) {
                  setRowEdit(null);
                  return;
                }
                await persistChanges(rowEdit.row, changes);
              })();
            }}
          />
        )}
      </div>

      <footer className="pager-footer">
        <div>
          {total !== null && (
            <>
              Showing {rowFrom.toLocaleString()} to {rowTo.toLocaleString()} of {total.toLocaleString()} rows
              {queryMs !== null && (
                <>
                  {" "}
                  • Query speed: <span className="accent">{queryMs.toFixed(2)}ms</span>
                </>
              )}
              {uiLatencyMs !== null && (
                <>
                  {" "}
                  • UI latency: <span className="accent">{uiLatencyMs.toFixed(2)}ms</span>
                </>
              )}
            </>
          )}
        </div>
        <nav className="pager-controls" aria-label="Pagination">
          <button type="button" className="btn-secondary" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span aria-live="polite">
            Page {page + 1} of {pages.toLocaleString()}
          </span>
          <button type="button" className="btn-secondary" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </nav>
      </footer>
    </section>
  );
}
