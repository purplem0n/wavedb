import { useEffect, useMemo, useRef, useState } from "react";
import { display, type TableDef } from "./api";
import { clearFkPreviewCache, FkPreviewLayer } from "./FkPreview";
import { relationsForCell } from "./fkRelations";
import { Icon } from "./icons";

function sortIcon(active: boolean, desc: boolean) {
  if (!active) return "unfold_more";
  return desc ? "south" : "north";
}

export function DataGrid({
  caption,
  columns,
  rows,
  sort,
  onSort,
  types,
  embedded,
  schema,
  tableDef,
  editable,
  editingCell,
  onCellDoubleClick,
  onEditRow,
}: {
  caption: string;
  columns: string[];
  rows: unknown[][];
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  types?: Record<string, string>;
  /** When true, omits outer panel wrapper (parent provides container). */
  embedded?: boolean;
  /** Full catalog — enables FK hover previews when `tableDef` is set. */
  schema?: TableDef[];
  tableDef?: TableDef;
  /** When set with a primary key on `tableDef`, enables row/cell editing affordances. */
  editable?: boolean;
  /** Highlights the in-grid cell while an inline edit popover is open. */
  editingCell?: { row: number; col: string } | null;
  onCellDoubleClick?: (rowIndex: number, column: string) => void;
  onEditRow?: (rowIndex: number) => void;
}) {
  const fkEnabled = !!(schema?.length && tableDef);
  const [fkPreview, setFkPreview] = useState<{ rect: DOMRect; relations: ReturnType<typeof relationsForCell> } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearTimers = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const schedulePreview = (el: HTMLElement, relations: ReturnType<typeof relationsForCell>) => {
    clearTimers();
    if (!relations.length) return;
    hoverTimer.current = window.setTimeout(() => {
      setFkPreview({ rect: el.getBoundingClientRect(), relations });
    }, 280);
  };

  const scheduleClose = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setFkPreview(null), 160);
  };

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const schemaKey = useMemo(() => (schema ? schema.map((t) => `${t.name}:${t.version}`).join("|") : ""), [schema]);

  useEffect(() => {
    clearFkPreviewCache();
    setFkPreview(null);
  }, [schemaKey]);

  if (columns.length === 0) return null;

  const table = (
    <>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {editable && onEditRow && (
              <th scope="col" className="cell-actions">
                <span className="sr-only">Actions</span>
              </th>
            )}
            {columns.map((c) => {
              const active = sort?.column === c;
              const typeHint = types?.[c];
              const numeric = typeHint && /int|real|float|numeric|decimal/i.test(typeHint);
              return (
                <th key={c} scope="col">
                  {onSort ? (
                    <button type="button" className="th-sort" onClick={() => onSort(c)} aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}>
                      <span>{c}</span>
                      {typeHint && <span className="type-hint">{typeHint}</span>}
                      <Icon name={sortIcon(!!active, !!sort?.desc && active)} className={`icon-sm${active ? "" : " sort-idle"}`} />
                    </button>
                  ) : (
                    <div className="th-sort">
                      <span>{c}</span>
                      {typeHint && <span className="type-hint">{typeHint}</span>}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (editable && onEditRow ? 1 : 0)} className="empty">
                No rows
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {editable && onEditRow && (
                  <td className="cell-actions">
                    <button type="button" className="btn-icon" title="Edit row" onClick={() => onEditRow(i)}>
                      <Icon name="edit" className="icon-sm" />
                    </button>
                  </td>
                )}
                {r.map((v, j) => {
                  const col = columns[j]!;
                  const typeHint = types?.[col];
                  const numeric = typeof v === "number" || (typeHint && /int|real|float|numeric|decimal/i.test(typeHint));
                  const relations =
                    fkEnabled && v !== null && v !== undefined
                      ? relationsForCell(schema!, tableDef!, col, r, columns)
                      : [];
                  const fkCell = relations.length > 0;
                  const isEditing = editingCell?.row === i && editingCell.col === col;
                  return (
                    <td
                      key={j}
                      className={[
                        v === null ? "null" : undefined,
                        numeric ? "cell-num" : j === 0 ? "cell-id" : undefined,
                        fkCell ? "fk-cell" : undefined,
                        isEditing ? "cell-editing" : undefined,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-selected={isEditing || undefined}
                      title={fkCell ? undefined : editable ? "Double-click to edit" : display(v, typeHint)}
                      onDoubleClick={
                        editable && onCellDoubleClick && !fkCell
                          ? () => onCellDoubleClick(i, col)
                          : undefined
                      }
                      onMouseEnter={
                        fkCell
                          ? (e) => {
                              cancelClose();
                              schedulePreview(e.currentTarget, relations);
                            }
                          : undefined
                      }
                      onMouseLeave={fkCell ? scheduleClose : undefined}
                    >
                      {display(v, typeHint)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {fkPreview && (
        <FkPreviewLayer
          anchor={fkPreview.rect}
          relations={fkPreview.relations}
          onClose={() => {
            clearTimers();
            setFkPreview(null);
          }}
        />
      )}
    </>
  );

  if (embedded) return table;

  return (
    <div className="data-panel" role="region" aria-label={caption} tabIndex={0}>
      {table}
    </div>
  );
}
