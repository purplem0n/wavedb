import type { TableDef } from "./api";
import { display } from "./api";
import { Icon } from "./icons";

export function RowEditor({
  table,
  columns,
  row,
  draft,
  onChange,
  onSave,
  onClose,
  busy,
  error,
}: {
  table: TableDef;
  columns: string[];
  row: unknown[];
  draft: Record<string, string>;
  onChange: (col: string, value: string) => void;
  onSave: () => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
}) {
  const pk = new Set(table.primaryKey);

  return (
    <div className="row-editor-backdrop" role="presentation" onClick={onClose}>
      <div
        className="row-editor-panel"
        role="dialog"
        aria-labelledby="row-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="row-editor-head">
          <h2 id="row-editor-title">
            Edit row · {table.name}
          </h2>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" className="icon-sm" />
          </button>
        </header>
        {error && (
          <p role="alert" className="alert alert--error">
            {error}
          </p>
        )}
        <div className="row-editor-fields">
          {columns.map((col, i) => {
            const def = table.columns.find((c) => c.name === col);
            const readOnly = pk.has(col);
            return (
              <label key={col} className="row-editor-field">
                <span className="row-editor-label">
                  {col}
                  {def && <span className="type-hint">{def.type}</span>}
                  {readOnly && <span className="row-editor-pk">PK</span>}
                </span>
                {readOnly ? (
                  <div className="row-editor-readonly mono-sm">{display(row[i], def?.type)}</div>
                ) : (
                  <input
                    value={draft[col] ?? ""}
                    onChange={(e) => onChange(col, e.target.value)}
                    spellCheck={false}
                  />
                )}
              </label>
            );
          })}
        </div>
        <footer className="row-editor-foot">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-run" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save row"}
          </button>
        </footer>
      </div>
    </div>
  );
}
