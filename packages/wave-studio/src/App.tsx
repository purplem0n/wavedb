import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, getToken, setToken, type TableDef } from "./api";
import { SchemaView } from "./SchemaView";
import { Shell } from "./Shell";
import { SqlConsole } from "./SqlConsole";
import { StatsView } from "./StatsView";
import { TableView } from "./TableView";
import { Icon, WaveLogo } from "./icons";

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
        <div className="login-card">
          <h1>
            <WaveLogo className="brand-logo" />
            Wave Studio
          </h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToken(tokenInput);
              void refresh();
            }}
          >
            <label htmlFor="token">Access token</label>
            <input id="token" type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" />
            <button type="submit" className="btn-run">
              Connect
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <Shell route={route} tables={tables} connected={!error && !needsToken} onRefresh={() => void refresh()}>
      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}
      {route.page === "schema" && <SchemaView tables={tables} onOpen={(n) => go(`#/table/${encodeURIComponent(n)}`)} />}
      {route.page === "sql" && <SqlConsole onChanged={() => void refresh()} />}
      {route.page === "stats" && <StatsView onChanged={() => void refresh()} />}
      {route.page === "table" &&
        (current ? (
          <TableView table={current} tables={tables} version={version} />
        ) : (
          <div className="empty-state">
            <Icon name="table_rows" className="icon-lg" />
            <p>
              Table “{route.name}” not found.
            </p>
          </div>
        ))}
    </Shell>
  );
}
