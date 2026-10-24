import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, authApi, getToken, setToken, type AuthPhase, type TableDef } from "./api";
import { SchemaManagePanel } from "./SchemaManagePanel";
import { SchemaView } from "./SchemaView";
import { Shell } from "./Shell";
import { StudioModal } from "./StudioModal";
import { SqlConsole } from "./SqlConsole";
import { LogsView } from "./LogsView";
import { StatsView } from "./StatsView";
import { TableView } from "./TableView";
import { Icon, WaveLogo } from "./icons";

type Route = { page: "table"; name: string } | { page: "sql" } | { page: "schema" } | { page: "stats" } | { page: "logs" };

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h.startsWith("table/")) return { page: "table", name: h.slice(6) };
  if (h === "sql" || h === "schema" || h === "stats" || h === "logs") return { page: h };
  return { page: "schema" };
}

type Gate = "loading" | "setup" | "login" | "token" | "ok";

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [tables, setTables] = useState<TableDef[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [tokenInput, setTokenInput] = useState(getToken());
  const [tablesLoading, setTablesLoading] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [editTable, setEditTable] = useState<string | null>(null);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const resolveGate = useCallback(async (): Promise<Gate> => {
    const st = await authApi.status();
    if (st.auth === false) return "ok";
    if (st.phase === "ready") return "ok";
    if (st.phase === "setup") return "setup";
    return "login";
  }, []);

  const refresh = useCallback(async () => {
    setTablesLoading(true);
    setReloadNotice(null);
    try {
      setTables(await api.tables());
      setError(null);
      setGate("ok");
      setVersion((v) => v + 1);
      setReloadNotice("Tables updated");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          const st = await authApi.status();
          if (st.auth === false) setGate("token");
          else if (st.phase === "setup") setGate("setup");
          else setGate("login");
        } catch (err) {
          setError((err as Error).message);
          setGate("setup");
        }
      } else {
        setError((e as Error).message);
        setReloadNotice("Reload failed");
      }
    } finally {
      setTablesLoading(false);
    }
  }, [resolveGate]);

  useEffect(() => {
    if (!reloadNotice) return;
    const id = window.setTimeout(() => setReloadNotice(null), 3000);
    return () => window.clearTimeout(id);
  }, [reloadNotice]);

  useEffect(() => {
    void (async () => {
      try {
        const g = await resolveGate();
        setGate(g);
        if (g === "ok") void refresh();
      } catch (err) {
        setError((err as Error).message);
        setGate("setup");
      }
    })();
  }, [resolveGate, refresh]);

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
        : `${{ schema: "Schema", sql: "SQL console", stats: "Stats", logs: "Logs" }[route.page]} · Wave Studio`;
  }, [route]);

  const submitAuth = async (phase: AuthPhase) => {
    setError(null);
    try {
      if (phase === "setup") {
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          return;
        }
        if (password !== confirm) {
          setError("Passwords do not match.");
          return;
        }
        if (!setupToken.trim()) {
          setError("Enter the one-time setup token from the server (.wave/setup.token or WAVE_SETUP_TOKEN).");
          return;
        }
        await authApi.setup(password, setupToken.trim());
      } else {
        await authApi.login(password);
      }
      setPassword("");
      setConfirm("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (gate === "loading") {
    return (
      <main className="login">
        <div className="login-card login-card--loading">
          <WaveLogo className="brand-logo brand-logo--pulse" />
          <p className="login-loading-text">Loading…</p>
        </div>
      </main>
    );
  }

  if (gate === "setup" || gate === "login") {
    return (
      <main className="login">
        <div className={`login-card${gate === "setup" ? " login-card--setup" : ""}`}>
          <div className="login-card-header">
            <WaveLogo className="brand-logo" />
            <h1>Wave Studio</h1>
          </div>
          <p>
            {gate === "setup"
              ? "Create the superuser password. Use the one-time setup token from the server log or .wave/setup.token."
              : "Sign in to continue."}
          </p>
          {error && (
            <p role="alert" className="alert alert--error">
              {error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitAuth(gate);
            }}
          >
            <label htmlFor="password">{gate === "setup" ? "Superuser password" : "Password"}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={gate === "setup" ? "new-password" : "current-password"}
            />
            {gate === "setup" && (
              <>
                <label htmlFor="setupToken">Setup token</label>
                <input
                  id="setupToken"
                  type="password"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  autoComplete="off"
                />
                <label htmlFor="confirm">Confirm password</label>
                <input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              </>
            )}
            <button type="submit" className="btn-run">
              {gate === "setup" ? "Create superuser" : "Sign in"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (gate === "token") {
    return (
      <main className="login">
        <div className="login-card">
          <div className="login-card-header">
            <WaveLogo className="brand-logo" />
            <h1>Wave Studio</h1>
          </div>
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

  const editTableDef = editTable ? tables.find((t) => t.name === editTable) : undefined;

  return (
    <>
    <Shell
      route={route}
      tables={tables}
      connected={!error && gate === "ok"}
      tablesLoading={tablesLoading}
      reloadNotice={reloadNotice}
      onRefresh={() => void refresh()}
      onEditTable={setEditTable}
    >
      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}
      {route.page === "schema" && (
        <SchemaView
          tables={tables}
          onOpen={(n) => go(`#/table/${encodeURIComponent(n)}`)}
          onEditTable={setEditTable}
          onSchemaChange={() => void refresh()}
        />
      )}
      {route.page === "sql" && <SqlConsole tables={tables} onChanged={() => void refresh()} />}
      {route.page === "stats" && <StatsView onChanged={() => void refresh()} />}
      {route.page === "logs" && <LogsView />}
      {route.page === "table" &&
        (current ? (
          <TableView table={current} tables={tables} version={version} onMutate={() => void refresh()} />
        ) : (
          <div className="empty-state empty-state--table-missing">
            <div className="empty-state-icon" aria-hidden="true">
              <Icon name="table_chart_view" className="icon-lg" />
            </div>
            <p>
              Table <span className="empty-state-name">“{route.name}”</span> not found.
            </p>
            <p className="empty-state-code">ERR_TABLE_NOT_DEFINED</p>
          </div>
        ))}
    </Shell>
    {editTableDef && (
      <StudioModal title={`Edit ${editTableDef.name}`} onClose={() => setEditTable(null)} wide>
        <SchemaManagePanel
          table={editTableDef}
          onDone={() => {
            setEditTable(null);
            void refresh();
          }}
        />
      </StudioModal>
    )}
    </>
  );
}
