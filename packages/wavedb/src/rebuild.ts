// Table rebuild for destructive schema changes (column type / primary key).

import type { Executor } from "./query.ts";
import { createTableStatement, tableMeta, type AnyTable, type ColumnKind } from "./schema.ts";
import type { TableDefJson } from "./migrate.ts";
import { encodeValue } from "./expr.ts";

const enc = (_k: ColumnKind, v: unknown) => encodeValue(v);

function coerceValue(from: ColumnKind, to: ColumnKind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (from === to) return v;
  if (from === "int" && to === "real") return Number(v);
  if (from === "real" && to === "int") return Math.trunc(Number(v));
  if (from === "text" && to === "json") return JSON.parse(String(v));
  if (from === "json" && to === "text") return typeof v === "string" ? v : JSON.stringify(v);
  if (to === "text") return String(v);
  if (to === "int") return Math.trunc(Number(v));
  if (to === "real") return Number(v);
  throw new Error(`unsupported cast ${from} -> ${to}`);
}

function lit(v: unknown) {
  return { t: "lit", v: encodeValue(v) };
}

async function copyRows(
  exec: Executor,
  fromTable: string,
  toTable: string,
  table: AnyTable,
  existing: TableDefJson,
): Promise<void> {
  const m = tableMeta(table);
  const haveByName = new Map(existing.columns.map((c) => [c.name, c]));
  const sel = await exec.run({
    kind: "select",
    columns: [{ t: "star" }],
    from: { name: fromTable },
  });
  const colIndex = new Map(sel.columns.map((c, i) => [c, i]));
  for (const row of sel.rows) {
    const values = m.columns.map((c) => {
      const i = colIndex.get(c.name);
      if (i === undefined) return lit(null);
      const have = haveByName.get(c.name);
      const raw = row[i];
      const coerced = have ? coerceValue(have.type, c.config.kind, raw) : null;
      return lit(coerced);
    });
    await exec.run({
      kind: "insert",
      table: toTable,
      columns: m.columns.map((c) => c.name),
      rows: [values],
    });
  }
}

/** Copy rows from `existing` layout into `table` schema inside one transaction. */
export async function rebuildTable(exec: Executor, table: AnyTable, existing: TableDefJson): Promise<void> {
  const m = tableMeta(table);
  const tmp = `_wave_rebuild_${m.name}`;
  const spec = createTableStatement(table, enc, false);
  await exec.run({ ...spec, name: tmp, ifNotExists: false });
  await copyRows(exec, m.name, tmp, table, existing);
  await exec.run({ kind: "dropTable", name: m.name, ifExists: true });
  await exec.run(spec);
  await copyRows(exec, tmp, m.name, table, existing);
  await exec.run({ kind: "dropTable", name: tmp, ifExists: true });
}
