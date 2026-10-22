import type { ReactNode } from "react";
import type { TableDef } from "./api";
import { Icon, RefreshIcon, TableRowIcon, WaveLogo } from "./icons";

type Route = { page: "table"; name: string } | { page: "sql" } | { page: "schema" } | { page: "stats" };

const VIEW_NAV = [
  { page: "schema" as const, label: "Schema", hash: "#/schema", icon: "schema" },
  { page: "sql" as const, label: "SQL Console", hash: "#/sql", icon: "terminal" },
  { page: "stats" as const, label: "Stats", hash: "#/stats", icon: "speed" },
];

function breadcrumbLabel(route: Route): string {
  if (route.page === "table") return route.name;
  if (route.page === "sql") return "SQL console";
  if (route.page === "stats") return "Stats";
  return "Schema";
}

export function Shell({
  route,
  tables,
  connected,
  onRefresh,
  children,
}: {
  route: Route;
  tables: TableDef[];
  connected: boolean;
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
            <WaveLogo className="brand-logo" />
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
          <button type="button" className="btn-reload-tables" onClick={onRefresh}>
            <RefreshIcon />
            <span>Reload tables</span>
          </button>
        </div>
      </aside>
      <div className="studio-frame">
        <header className="top-header">
          <div className="breadcrumb mono-sm">
            <span className="crumb-muted">Wave Studio</span>
            <span className="crumb-sep">›</span>
            <span className="crumb-current">{crumb}</span>
          </div>
          <div className={`conn-pill${connected ? "" : " conn-pill--off"}`}>
            <span className="conn-dot" />
            <span>{connected ? "Connected" : "Offline"}</span>
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
