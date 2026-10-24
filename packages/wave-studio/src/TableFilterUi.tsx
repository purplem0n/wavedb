import type { ColumnDef } from "./api";
import { operatorsForType, type UiFilterOp, type UiFilterRule } from "./uiFilter";

const OP_LABEL: Record<UiFilterOp, string> = {
  eq: "equals",
  ne: "not equals",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  is_null: "is null",
  is_not_null: "is not null",
};

export function emptyRule(columns: ColumnDef[]): UiFilterRule {
  const col = columns[0]?.name ?? "";
  const ops = col ? operatorsForType(columns[0]!.type) : (["eq"] as UiFilterOp[]);
  return { column: col, op: ops[0]!, value: "", value2: "" };
}

export function TableFilterUi({
  columns,
  rules,
  onChange,
}: {
  columns: ColumnDef[];
  rules: UiFilterRule[];
  onChange: (rules: UiFilterRule[]) => void;
}) {
  if (columns.length === 0) return null;

  const update = (i: number, patch: Partial<UiFilterRule>) => {
    const next = rules.map((r, j) => {
      if (j !== i) return r;
      const merged = { ...r, ...patch };
      if (patch.column !== undefined) {
        const col = columns.find((c) => c.name === patch.column);
        const ops = col ? operatorsForType(col.type) : operatorsForType("text");
        if (!ops.includes(merged.op)) merged.op = ops[0]!;
      }
      return merged;
    });
    onChange(next);
  };

  return (
    <div className="ui-filter">
      <span className="ui-filter-label">Filters</span>
      <div className="ui-filter-rules">
        {rules.map((rule, i) => {
          const col = columns.find((c) => c.name === rule.column) ?? columns[0]!;
          const ops = operatorsForType(col.type);
          const needsValue = !["is_null", "is_not_null"].includes(rule.op);
          const needsSecond = rule.op === "between";
          return (
            <div key={i} className="ui-filter-row">
              <select value={rule.column} onChange={(e) => update(i, { column: e.target.value })} aria-label="Column">
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select value={rule.op} onChange={(e) => update(i, { op: e.target.value as UiFilterOp })} aria-label="Operator">
                {ops.map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op]}
                  </option>
                ))}
              </select>
              {needsValue && (
                <input
                  value={rule.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder="Value"
                  aria-label="Filter value"
                />
              )}
              {needsSecond && (
                <input
                  value={rule.value2}
                  onChange={(e) => update(i, { value2: e.target.value })}
                  placeholder="To"
                  aria-label="Filter upper bound"
                />
              )}
              <button
                type="button"
                className="btn-ghost"
                aria-label="Remove filter"
                disabled={rules.length <= 1}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn-ghost" onClick={() => onChange([...rules, emptyRule(columns)])}>
        Add filter
      </button>
    </div>
  );
}
