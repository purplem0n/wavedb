import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, display, type QueryResult } from "./api";
import { cardinalityLabel, type FkRelationPreview } from "./fkRelations";
import { Icon } from "./icons";

type SectionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; result: QueryResult; total?: number }
  | { status: "error"; message: string };

const cache = new Map<string, SectionState>();

export function clearFkPreviewCache() {
  cache.clear();
}

function cacheKey(rel: FkRelationPreview): string {
  return `${rel.sql}|${rel.countSql ?? ""}`;
}

async function loadSection(rel: FkRelationPreview): Promise<SectionState> {
  const key = cacheKey(rel);
  const hit = cache.get(key);
  if (hit && hit.status !== "loading") return hit;

  try {
    const result = await api.sql(rel.sql);
    let total: number | undefined;
    if (rel.countSql) {
      const c = await api.sql(rel.countSql);
      total = Number(c.rows[0]?.[0] ?? result.rows.length);
    }
    const state: SectionState = { status: "ok", result, total };
    cache.set(key, state);
    return state;
  } catch (e) {
    const state: SectionState = { status: "error", message: (e as Error).message };
    cache.set(key, state);
    return state;
  }
}

export function FkPreviewLayer({
  anchor,
  relations,
  onClose,
}: {
  anchor: DOMRect;
  relations: FkRelationPreview[];
  onClose: () => void;
}) {
  const [sections, setSections] = useState<Record<number, SectionState>>({});
  const ref = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    relations.forEach((rel, i) => {
      const key = cacheKey(rel);
      const cached = cache.get(key);
      if (cached && cached.status !== "loading") {
        setSections((s) => ({ ...s, [i]: cached }));
        return;
      }
      setSections((s) => ({ ...s, [i]: { status: "loading" } }));
      void loadSection(rel).then((st) => {
        if (!cancelled) setSections((s) => ({ ...s, [i]: st }));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [relations]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pad = 8;
  const maxW = Math.min(480, window.innerWidth - pad * 2);
  let left = anchor.left;
  let top = anchor.bottom + 6;
  if (left + maxW > window.innerWidth - pad) left = window.innerWidth - maxW - pad;
  if (top + 280 > window.innerHeight - pad) top = Math.max(pad, anchor.top - 280);

  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(onClose, 180);
  };

  return createPortal(
    <div
      ref={ref}
      className="fk-preview"
      style={{ left, top, maxWidth: maxW }}
      role="dialog"
      aria-label="Foreign key preview"
      onMouseEnter={cancelLeave}
      onMouseLeave={scheduleClose}
    >
      {relations.map((rel, i) => {
        const st = sections[i] ?? { status: "loading" };
        return (
          <div key={`${rel.label}-${i}`} className="fk-preview-section">
            <div className="fk-preview-head">
              <span className="fk-preview-badge">{cardinalityLabel(rel.cardinality)}</span>
              <span className="fk-preview-title mono-sm">{rel.label}</span>
              <Icon name="link" className="icon-sm" />
            </div>
            {st.status === "loading" && <p className="fk-preview-muted">Loading…</p>}
            {st.status === "error" && <p className="fk-preview-error">{st.message}</p>}
            {st.status === "ok" && (
              <>
                {st.result.rows.length === 0 ? (
                  <p className="fk-preview-muted">No matching row</p>
                ) : (
                  <div className="fk-preview-table-wrap">
                    <table className="fk-preview-table">
                      <thead>
                        <tr>
                          {st.result.columns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {st.result.rows.slice(0, rel.cardinality === "one-to-one" ? 1 : 20).map((r, ri) => (
                          <tr key={ri}>
                            {r.map((v, ci) => (
                              <td key={ci} title={display(v)}>
                                {display(v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {st.total !== undefined && st.total > 20 && (
                  <p className="fk-preview-more mono-sm">+ {(st.total - 20).toLocaleString()} more row{st.total - 20 === 1 ? "" : "s"}</p>
                )}
                {rel.cardinality === "one-to-many" && st.result.rows.length > 20 && (
                  <p className="fk-preview-more mono-sm">Showing first 20 rows</p>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
