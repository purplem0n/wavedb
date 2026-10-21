import { useCallback, useEffect, useState } from "react";
import { api, quote, type QueryResult, type TableDef } from "./api";
import { DataGrid } from "./DataGrid";

const PAGE = 50;

export function TableView({ table, version }: { table: TableDef; version: number }) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [table.name, applied, sort, page, version]);

  useEffect(() => {
    void load();
  }, [load]);

  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / PAGE));

  return (
    <section aria-labelledby="table-title">
      <header className="view-head">
        <h2 id="table-title">{table.name}</h2>
        <p className="muted">
          {total === null ? "…" : total.toLocaleString()} row{total === 1 ? "" : "s"} · {table.columns.length} columns
          {table.primaryKey.length ? ` · PK (${table.primaryKey.join(", ")})` : ""}
        </p>
      </header>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setApplied(filter);
        }}
      >
        <label htmlFor="where-input">Filter (SQL WHERE)</label>
        <input
          id="where-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={table.columns[0] ? `${table.columns[0].name} > 10 AND …` : ""}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit">Apply</button>
        {applied && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setFilter("");
              setApplied("");
              setPage(0);
            }}
          >
            Clear
          </button>
        )}
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <DataGrid
          caption={`Rows of ${table.name}`}
          columns={result.columns}
          rows={result.rows}
          sort={sort}
          types={Object.fromEntries(table.columns.map((c) => [c.name, c.type]))}
          onSort={(c) => {
            setPage(0);
            setSort((s) => (s?.column === c ? (s.desc ? null : { column: c, desc: true }) : { column: c, desc: false }));
          }}
        />
      )}
      <nav className="pager" aria-label="Pagination">
        <button type="button" className="secondary" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span aria-live="polite">
          Page {page + 1} of {pages.toLocaleString()}
        </span>
        <button type="button" className="secondary" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </nav>
    </section>
  );
}
