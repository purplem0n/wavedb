import { useState } from "react";
import { api, type TableDef } from "./api";
import {
  addColumnSql,
  COLUMN_TYPES,
  createTableSql,
  dropColumnSql,
  dropTableSql,
  type ColumnTypeName,
} from "./schemaManage";

export function SchemaManagePanel({
  table,
  onDone,
}: {
  table: TableDef;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<ColumnTypeName>("text");
  const [addNullable, setAddNullable] = useState(true);
  const [dropCol, setDropCol] = useState(table.columns[0]?.name ?? "");
  const [deleteConfirm, setDeleteConfirm] = useState("");

  async function run(build: () => string) {
    setBusy(true);
    setError(null);
    try {
      await api.sql(build());
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="schema-manage">
      <h3 className="schema-manage-title">Manage table</h3>
      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}
      <section className="schema-manage-block">
        <h4>Add column</h4>
        <div className="schema-manage-row">
          <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="column_name" spellCheck={false} />
          <select value={addType} onChange={(e) => setAddType(e.target.value as ColumnTypeName)}>
            {COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="schema-manage-check">
            <input type="checkbox" checked={addNullable} onChange={(e) => setAddNullable(e.target.checked)} />
            Nullable
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !addName.trim()}
            onClick={() => void run(() => addColumnSql(table.name, addName, addType, addNullable))}
          >
            Add
          </button>
        </div>
      </section>
      {table.columns.length > 0 && (
        <section className="schema-manage-block">
          <h4>Drop column</h4>
          <div className="schema-manage-row">
            <select value={dropCol} onChange={(e) => setDropCol(e.target.value)}>
              {table.columns.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !dropCol}
              onClick={() => {
                if (!window.confirm(`Drop column "${dropCol}" from ${table.name}? This cannot be undone.`)) return;
                void run(() => dropColumnSql(table.name, dropCol));
              }}
            >
              Drop column
            </button>
          </div>
        </section>
      )}
      <section className="schema-manage-block schema-manage-danger">
        <h4>Delete table</h4>
        <p className="schema-manage-warn">Permanently removes the table and all rows. Type the table name to confirm.</p>
        <div className="schema-manage-row">
          <input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={table.name}
            spellCheck={false}
          />
          <button
            type="button"
            className="btn-secondary schema-manage-delete"
            disabled={busy || deleteConfirm !== table.name}
            onClick={() => void run(() => dropTableSql(table.name))}
          >
            Delete table
          </button>
        </div>
      </section>
    </div>
  );
}

export function CreateTablePanel({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [col, setCol] = useState("id");
  const [type, setType] = useState<ColumnTypeName>("integer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="schema-manage schema-manage--create">
      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}
      <label className="schema-field-label" htmlFor="create-table-name">
        Table name
      </label>
      <input
        id="create-table-name"
        className="schema-field-input schema-field-input--full"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. orders"
        spellCheck={false}
        autoComplete="off"
      />
      <p className="schema-field-hint">Primary key column</p>
      <div className="schema-manage-row schema-manage-row--labeled">
        <label className="schema-field-label schema-field-label--inline" htmlFor="create-pk-name">
          Name
        </label>
        <input
          id="create-pk-name"
          value={col}
          onChange={(e) => setCol(e.target.value)}
          placeholder="id"
          spellCheck={false}
          autoComplete="off"
        />
        <label className="schema-field-label schema-field-label--inline" htmlFor="create-pk-type">
          Type
        </label>
        <select id="create-pk-type" value={type} onChange={(e) => setType(e.target.value as ColumnTypeName)}>
          {COLUMN_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="schema-manage-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !name.trim()}
          onClick={() => {
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await api.sql(createTableSql(name, col, type));
                onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Create table
        </button>
      </div>
    </div>
  );
}
