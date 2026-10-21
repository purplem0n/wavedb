import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, getToken, setToken, type TableDef } from "./api";
import { SchemaView } from "./SchemaView";
import { SqlConsole } from "./SqlConsole";
import { StatsView } from "./StatsView";
import { TableView } from "./TableView";

type Route = { page: "table"; name: string } | { page: "sql" } | { page: "schema" } | { page: "stats" };

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h.startsWith("table/")) return { page: "table", name: h.slice(6) };
  if (h === "sql" || h === "schema" || h === "stats") return { page: h };
  return { page: "schema" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [tables, setTables] = useState<TableDef[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState(getToken());

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setTables(await api.tables());
      setError(null);
      setNeedsToken(false);
      setVersion((v) => v + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsToken(true);
      else setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const go = (hash: string) => {
    location.hash = hash;
  };
  const current = useMemo(
    () => (route.page === "table" ? tables.find((t) => t.name === route.name) : undefined),
    [route, tables],
  );

  useEffect(() => {
    document.title =
      route.page === "table"
        ? `${route.name} · Wave Studio`
        : `${{ schema: "Schema", sql: "SQL console", stats: "Stats" }[route.page]} · Wave Studio`;
  }, [route]);

  if (needsToken) {
    return (
      <main className="login">
        <h1>Wave Studio</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setToken(tokenInput);
            void refresh();
          }}
        >
          <label htmlFor="token">Access token</label>
          <input id="token" type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" />
          <button type="submit">Connect</button>
        </form>
      </main>
    );
  }

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Database navigation">
        <h1 className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M2 18c4-8 8-8 12 0s8 8 12 0" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          </svg>
          Wave Studio
        </h1>
        <nav aria-label="Views">
          <ul>
            {(
              [
                ["schema", "Schema"],
                ["sql", "SQL console"],
                ["stats", "Stats"],
              ] as const
            ).map(([p, label]) => (
              <li key={p}>
                <a href={`#/${p}`} aria-current={route.page === p ? "page" : undefined}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Tables">
          <h2 className="side-title">Tables</h2>
          {tables.length === 0 ? (
            <p className="muted small">No tables</p>
          ) : (
            <ul>
              {tables.map((t) => (
                <li key={t.name}>
                  <a href={`#/table/${encodeURIComponent(t.name)}`} aria-current={route.page === "table" && route.name === t.name ? "page" : undefined}>
                    {t.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="secondary side-btn" onClick={() => void refresh()}>
            Reload
          </button>
        </nav>
      </aside>
      <main id="main" tabIndex={-1}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {route.page === "schema" && <SchemaView tables={tables} onOpen={(n) => go(`#/table/${encodeURIComponent(n)}`)} />}
        {route.page === "sql" && <SqlConsole onChanged={() => void refresh()} />}
        {route.page === "stats" && <StatsView onChanged={() => void refresh()} />}
        {route.page === "table" &&
          (current ? (
            <TableView table={current} version={version} />
          ) : (
            <p className="muted">Table “{route.name}” not found.</p>
          ))}
      </main>
    </div>
  );
}
