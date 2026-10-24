import { useEffect, useMemo, useState } from "react";
import { api, describeDefault, type TableDef } from "./api";
import { Icon } from "./icons";
import { waveEngineVersionTag } from "./version";
import { CreateTablePanel } from "./SchemaManagePanel";
import { StudioModal } from "./StudioModal";

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
  onEditTable,
  onSchemaChange,
}: {
  tables: TableDef[];
  onOpen: (name: string) => void;
  onEditTable: (name: string) => void;
  onSchemaChange?: () => void;
}) {
  const [filter, setFilter] = useState("");
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
      <header className="page-head page-head--schema">
        <div>
          <div className="page-title-row">
            <h1 className="page-title">Schema</h1>
            <span className="pill-version">{waveEngineVersionTag(" engine")}</span>
          </div>
        </div>
        <div className="page-head-toolbar">
          <button type="button" className="btn-stitch-primary" onClick={() => setShowCreate((s) => !s)}>
            {!showCreate && <Icon name="add" className="icon-sm" />}
            {showCreate ? "Cancel" : "New table"}
          </button>
          <div className="search-wrap search-wrap--toolbar">
            <Icon name="search" className="search-icon" />
            <input
              className="search-input search-input--toolbar"
              type="search"
              placeholder="Filter tables by name..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="search-kbd search-kbd--hint">⌘K</kbd>
          </div>
        </div>
      </header>

      <div className="schema-stats-bar" aria-label="Schema summary">
        <div className="schema-stats-bar-metrics">
          <span className="schema-stat">
            <Icon name="dataset" className="icon-sm" />
            <strong>{tables.length}</strong>
            <span className="schema-stat-label">tables</span>
          </span>
          <span className="schema-stat-sep" aria-hidden="true" />
          <span className="schema-stat">
            <Icon name="account_tree" className="icon-sm" />
            <strong>{indexCount}</strong>
            <span className="schema-stat-label">indexes</span>
          </span>
          <span className="schema-stat-sep" aria-hidden="true" />
          <span className="schema-stat">
            <Icon name="hard_drive" className="icon-sm" />
            <strong>{diskBytes === null ? "…" : bytesShort(diskBytes)}</strong>
            {diskBytes !== null && <span className="schema-stat-label">on disk</span>}
          </span>
        </div>
        <span className="schema-stats-showing">
          Showing <strong>{visible.length}</strong> of {tables.length} tables
        </span>
      </div>

      {showCreate && (
        <StudioModal title="Create table" onClose={() => setShowCreate(false)}>
          <CreateTablePanel
            onDone={() => {
              setShowCreate(false);
              onSchemaChange?.();
            }}
          />
        </StudioModal>
      )}

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
                <button type="button" className="btn-schema-edit" onClick={() => onEditTable(t.name)}>
                  <Icon name="edit" className="icon-sm" />
                  Edit
                </button>
              </div>
            </div>
            <div className="schema-card-body">
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
            </div>
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
