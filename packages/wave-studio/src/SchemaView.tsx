import { useEffect, useMemo, useState } from "react";
import { api, describeDefault, type TableDef } from "./api";
import { Icon } from "./icons";
import { waveEngineVersionTag } from "./version";
import { CreateTablePanel, SchemaManagePanel } from "./SchemaManagePanel";

function bytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return i === 0 ? `${n.toFixed(0)} ${u[i]}` : `${n.toFixed(1)} ${u[i]}`;
}

export function SchemaView({
  tables,
  onOpen,
  onSchemaChange,
}: {
  tables: TableDef[];
  onOpen: (name: string) => void;
  onSchemaChange?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [manageTable, setManageTable] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [diskBytes, setDiskBytes] = useState<number | null>(null);

  useEffect(() => {
    void api.stats().then((s) => setDiskBytes(s.diskBytes)).catch(() => setDiskBytes(null));
  }, [tables.length]);
  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => (q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables), [tables, q]);
  const indexCount = tables.reduce((n, t) => n + t.indexes.length, 0);

  return (
    <div className="page-pad">
      <header className="page-head">
        <div>
          <div className="page-title-row">
            <h1 className="page-title">Schema</h1>
            <span className="pill-version">{waveEngineVersionTag(" engine")}</span>
          </div>
          <p className="page-sub">
            {tables.length} table{tables.length === 1 ? "" : "s"} defined in embedded engine
          </p>
        </div>
        <div className="schema-head-actions">
          <button type="button" className="btn-primary" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Cancel" : "New table"}
          </button>
        </div>
        <div className="search-wrap">
          <Icon name="search" />
          <input
            className="search-input"
            type="search"
            placeholder="Filter tables by name..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="search-kbd">⌘K</kbd>
        </div>
      </header>

      <div className="summary-grid">
        <div className="summary-card">
          <div>
            <span className="summary-label">Table Count</span>
            <div>
              <span className="summary-value">{tables.length}</span>
              <span className="summary-unit">Tables</span>
            </div>
          </div>
          <div className="summary-icon">
            <Icon name="dataset" className="icon-lg" />
          </div>
        </div>
        <div className="summary-card">
          <div>
            <span className="summary-label">Total Indexes</span>
            <div>
              <span className="summary-value summary-value--primary">{indexCount}</span>
              <span className="summary-unit">Indexes</span>
            </div>
          </div>
          <div className="summary-icon summary-icon--secondary">
            <Icon name="account_tree" className="icon-lg" />
          </div>
        </div>
        <div className="summary-card">
          <div>
            <span className="summary-label">On-disk Size</span>
            <div>
              <span className="summary-value summary-value--tertiary">
                {diskBytes === null ? "…" : bytesShort(diskBytes).split(" ")[0]}
              </span>
              <span className="summary-unit">{diskBytes === null ? "" : bytesShort(diskBytes).split(" ")[1] ?? "B"}</span>
            </div>
          </div>
          <div className="summary-icon summary-icon--tertiary">
            <Icon name="hard_drive" className="icon-lg" />
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateTablePanel
          onDone={() => {
            setShowCreate(false);
            onSchemaChange?.();
          }}
        />
      )}

      <div className="section-meta">
        <span>Active Engine Entities</span>
        <span className="crumb-sep">•</span>
        <span>
          Showing <strong>{visible.length}</strong> of {tables.length} tables
        </span>
      </div>

      {tables.length === 0 && (
        <p className="empty-state">No tables yet. Create one in the SQL console or push a schema with <code>wave push</code>.</p>
      )}

      {tables.length > 0 && visible.length === 0 && <p className="empty-state">No matching schema tables.</p>}

      <div className="schema-grid">
        {visible.map((t) => (
          <article key={t.name} className="schema-card schema-table-card" aria-labelledby={`t-${t.name}`}>
            <div className="schema-card-head">
              <h2 className="schema-card-title" id={`t-${t.name}`}>
                <button type="button" onClick={() => onOpen(t.name)}>
                  {t.name}
                </button>
              </h2>
              <div className="schema-card-actions">
                <span className="schema-card-meta">
                  {t.columns.length} cols · {t.indexes.length} idx
                </span>
                <button type="button" className="btn-ghost" onClick={() => setManageTable(manageTable === t.name ? null : t.name)}>
                  {manageTable === t.name ? "Close" : "Manage"}
                </button>
              </div>
            </div>
            {manageTable === t.name && (
              <SchemaManagePanel
                table={t}
                onDone={() => {
                  setManageTable(null);
                  onSchemaChange?.();
                }}
              />
            )}
            <table>
              <caption className="sr-only">Columns of {t.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">Type</th>
                  <th scope="col">Constraints</th>
                </tr>
              </thead>
              <tbody>
                {t.columns.map((c) => {
                  const isPk = t.primaryKey.includes(c.name);
                  const constraints: string[] = [];
                  if (!c.nullable) constraints.push("NOT NULL");
                  const def = describeDefault(c.default);
                  if (def) constraints.push(def);
                  return (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.type}</td>
                      <td>
                        {isPk && (
                          <span className="badge-pk">
                            {t.autoIncrement && t.primaryKey[0] === c.name ? "PK autoincrement" : "PK"}
                          </span>
                        )}
                        {constraints.map((x) => (
                          <span key={x} className="badge-constraint">
                            {x}
                          </span>
                        ))}
                        {!isPk && constraints.length === 0 && "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {t.indexes.length > 0 && (
              <div className="schema-indexes">
                <h4>Indexes</h4>
                <ul>
                  {t.indexes.map((i) => (
                    <li key={i.id}>
                      <code>{i.name}</code> ({i.columns.join(", ")}){i.unique ? " · unique" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
