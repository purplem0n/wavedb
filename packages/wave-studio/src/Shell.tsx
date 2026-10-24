import type { ReactNode } from "react";
import type { TableDef } from "./api";
import { Icon, RefreshIcon, TableRowIcon, WaveLogo } from "./icons";
import { waveEngineVersionTag } from "./version";

type Route = { page: "table"; name: string } | { page: "sql" } | { page: "schema" } | { page: "stats" } | { page: "logs" };

const VIEW_NAV = [
  { page: "schema" as const, label: "Schema", hash: "#/schema", icon: "schema" },
  { page: "sql" as const, label: "SQL Console", hash: "#/sql", icon: "terminal" },
  { page: "logs" as const, label: "Logs & Metrics", hash: "#/logs", icon: "monitoring" },
  { page: "stats" as const, label: "Stats", hash: "#/stats", icon: "bar_chart" },
];

function breadcrumbLabel(route: Route): string {
  if (route.page === "table") return route.name;
  if (route.page === "sql") return "SQL console";
  if (route.page === "stats") return "Stats";
  if (route.page === "logs") return "Logs & Metrics";
  return "Schema";
}

export function Shell({
  route,
  tables,
  connected,
  tablesLoading,
  reloadNotice,
  onRefresh,
  children,
}: {
  route: Route;
  tables: TableDef[];
  connected: boolean;
  tablesLoading?: boolean;
  reloadNotice?: string | null;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const crumb = breadcrumbLabel(route);

  return (
    <div className="studio-root">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Database navigation">
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <div className="brand-logo-wrap" aria-hidden="true">
              <WaveLogo className="brand-logo" />
            </div>
            <span className="brand-title">Wave Studio</span>
          </div>
          <nav className="sidebar-views" aria-label="Views">
            {VIEW_NAV.map(({ page, label, hash, icon }) => {
              const active = route.page === page;
              return (
                <a key={page} href={hash} className={`nav-view${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                  <Icon name={icon} className="icon-sm" />
                  <span>{label}</span>
                </a>
              );
            })}
          </nav>
          <div className="sidebar-tables-head">
            <span className="tables-header-label">Tables</span>
            <span className="tables-count">{tables.length}</span>
          </div>
          <div className="sidebar-tables-scroll">
            <nav className="sidebar-tables" aria-label="Tables">
              {tables.length === 0 ? (
                <p className="sidebar-empty">No tables</p>
              ) : (
                tables.map((t) => {
                  const active = route.page === "table" && route.name === t.name;
                  return (
                    <a
                      key={t.name}
                      href={`#/table/${encodeURIComponent(t.name)}`}
                      className={`nav-table${active ? " active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <TableRowIcon active={active} />
                      <span>{t.name}</span>
                    </a>
                  );
                })
              )}
            </nav>
          </div>
        </div>
        <div className="sidebar-foot">
          <button
            type="button"
            className={`btn-reload-tables${tablesLoading ? " is-loading" : ""}`}
            onClick={onRefresh}
            disabled={tablesLoading}
            aria-busy={tablesLoading}
          >
            <RefreshIcon />
            <span>{tablesLoading ? "Reloading…" : "Reload tables"}</span>
          </button>
          {reloadNotice && (
            <p role="status" className="reload-notice">
              {reloadNotice}
            </p>
          )}
        </div>
      </aside>
      <div className="studio-frame">
        <header className="top-header">
          <div className="breadcrumb mono-sm">
            <span className="crumb-muted">Wave Studio</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{crumb}</span>
          </div>
          <div className="top-header-actions">
            <div className={`conn-pill${connected ? "" : " conn-pill--off"}`}>
              <span className="conn-dot" />
              <span>{connected ? "Connected" : "Offline"}</span>
            </div>
            <div className="header-user" aria-hidden="true">
              <Icon name="person" className="icon-sm" />
            </div>
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer className="studio-footer" aria-label="Engine status">
          <div className="studio-footer-spacer" />
          <span className="studio-footer-version">{waveEngineVersionTag()}</span>
        </footer>
      </div>
    </div>
  );
}
