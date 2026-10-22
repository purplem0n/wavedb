import { useCallback, useEffect, useState } from "react";
import { api, engineQueryDurationMs, quote, type QueryResult, type TableDef } from "./api";
import { DataGrid } from "./DataGrid";
import { RefreshIcon } from "./icons";

const PAGE = 50;

export function TableView({ table, tables, version }: { table: TableDef; tables: TableDef[]; version: number }) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryMs, setQueryMs] = useState<number | null>(null);

  useEffect(() => {
    setFilter("");
    setApplied("");
    setSort(null);
    setPage(0);
  }, [table.name]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const where = applied.trim() ? ` WHERE ${applied}` : "";
      const order = sort ? ` ORDER BY ${quote(sort.column)} ${sort.desc ? "DESC" : "ASC"}` : "";
      const [rows, count] = await Promise.all([
        api.sql(`SELECT * FROM ${quote(table.name)}${where}${order} LIMIT ${PAGE} OFFSET ${page * PAGE}`),
        api.sql(`SELECT count(*) AS n FROM ${quote(table.name)}${where}`),
      ]);
      setResult(rows);
      setTotal(Number(count.rows[0]?.[0] ?? 0));
      setQueryMs(engineQueryDurationMs(rows, count));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setQueryMs(null);
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
          <span className="pill-version">v0.1</span>
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
        className="filter-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setApplied(filter);
        }}
      >
        <label htmlFor="where-input">Filter (SQL WHERE):</label>
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
        <div className="filter-actions">
          <button type="submit" className="btn-primary">
            Apply
          </button>
          {applied && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setFilter("");
                setApplied("");
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
            types={Object.fromEntries(table.columns.map((c) => [c.name, c.type]))}
            onSort={(c) => {
              setPage(0);
              setSort((s) => (s?.column === c ? (s.desc ? null : { column: c, desc: true }) : { column: c, desc: false }));
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
                  • Engine query: <span className="accent">{queryMs.toFixed(2)}ms</span>
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
