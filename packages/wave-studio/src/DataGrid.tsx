import { display } from "./api";

export function DataGrid({
  caption,
  columns,
  rows,
  sort,
  onSort,
  types,
}: {
  caption: string;
  columns: string[];
  rows: unknown[][];
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  types?: Record<string, string>;
}) {
  if (columns.length === 0) return null;
  return (
    <div className="grid-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="grid">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.column === c;
              return (
                <th key={c} scope="col" aria-sort={active ? (sort!.desc ? "descending" : "ascending") : undefined}>
                  {onSort ? (
                    <button type="button" className="th-btn" onClick={() => onSort(c)}>
                      {c}
                      <span aria-hidden="true">{active ? (sort!.desc ? " ▼" : " ▲") : ""}</span>
                    </button>
                  ) : (
                    c
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty">
                No rows
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={v === null ? "null" : typeof v === "number" ? "num" : undefined} title={display(v, types?.[columns[j]!])}>
                    {display(v, types?.[columns[j]!])}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
