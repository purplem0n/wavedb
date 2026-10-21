// Schema diffing: compare the code-defined schema with what is stored in the catalog.

import { encodeValue } from "./expr.ts";
import { columnSpec, createTableStatement, defaultIndexName, tableMeta, type AnyTable, type ColumnKind } from "./schema.ts";

export interface TableDefJson {
  id: number;
  name: string;
  columns: { id: number; name: string; type: ColumnKind; nullable: boolean; default?: unknown }[];
  primaryKey: string[];
  autoIncrement: boolean;
  indexes: { id: number; name: string; columns: string[]; unique: boolean }[];
  version: number;
}

export type SchemaOpKind =
  | "createTable"
  | "addColumn"
  | "dropColumn"
  | "createIndex"
  | "dropIndex"
  | "dropTable"
  | "rebuildTable"
  | "conflict";

export interface SchemaOp {
  op: SchemaOpKind;
  table: string;
  description: string;
  /** Loses data (dropped columns / tables / indexes are reported as destructive only when data is lost). */
  destructive: boolean;
  /** `false` = cannot be applied automatically (e.g. changing a column type). */
  applicable: boolean;
  statement?: Record<string, unknown>;
  /** Present when `op === "rebuildTable"`. */
  rebuild?: { table: AnyTable; existing: TableDefJson };
}

const enc = (_k: ColumnKind, v: unknown) => encodeValue(v);

export function diffSchema(
  tables: AnyTable[],
  existing: TableDefJson[],
  opts: { dropMissingTables?: boolean } = {},
): SchemaOp[] {
  const creates: SchemaOp[] = [];
  const adds: SchemaOp[] = [];
  const idx: SchemaOp[] = [];
  const dropIdx: SchemaOp[] = [];
  const dropCols: SchemaOp[] = [];
  const dropTables: SchemaOp[] = [];
  const byName = new Map(existing.map((t) => [t.name, t]));
  const wantedNames = new Set<string>();

  for (const t of tables) {
    const m = tableMeta(t);
    wantedNames.add(m.name);
    const cur = byName.get(m.name);
    if (!cur) {
      creates.push({
        op: "createTable",
        table: m.name,
        description: `create table ${m.name}`,
        destructive: false,
        applicable: true,
        statement: createTableStatement(t, enc, false),
      });
      continue;
    }
    const curCols = new Map(cur.columns.map((c) => [c.name, c]));
    const wantCols = new Set(m.columns.map((c) => c.name));
    let needsRebuild =
      cur.primaryKey.join(",") !== m.primaryKey.join(",") ||
      m.columns.some((c) => {
        const have = curCols.get(c.name);
        return have !== undefined && have.type !== c.config.kind;
      });
    if (needsRebuild) {
      adds.push({
        op: "rebuildTable",
        table: m.name,
        description: `rebuild table ${m.name} (column type and/or primary key changed)`,
        destructive: true,
        applicable: true,
        rebuild: { table: t, existing: cur },
      });
    } else {
      for (const c of m.columns) {
        const have = curCols.get(c.name);
        if (!have) {
          const spec = columnSpec(c, enc);
          const ok = spec.nullable || spec.default !== undefined;
          adds.push({
            op: "addColumn",
            table: m.name,
            description: `add column ${m.name}.${c.name} (${c.config.kind})`,
            destructive: false,
            applicable: ok && !c.config.primaryKey,
            statement: { kind: "alterTable", table: m.name, action: { op: "addColumn", column: spec } },
          });
          if (!ok) {
            adds.push({
              op: "conflict",
              table: m.name,
              description: `column ${m.name}.${c.name} is NOT NULL without a default; add .default(...) or make it nullable`,
              destructive: false,
              applicable: false,
            });
          }
        }
      }
    }
    if (needsRebuild) {
      continue;
    }
    // indexes
    const wantIdx = new Map<string, { name: string; columns: string[]; unique: boolean }>();
    for (const c of m.columns) {
      if (c.config.unique && !c.config.primaryKey) {
        const def = { columns: [c.name], unique: true };
        wantIdx.set(`u:${c.name}`, { ...def, name: defaultIndexName(m.name, def) });
      }
    }
    for (const i of m.indexes) {
      wantIdx.set(`${i.unique ? "u" : "i"}:${i.columns.join(",")}`, {
        name: i.name ?? defaultIndexName(m.name, i),
        columns: i.columns,
        unique: i.unique,
      });
    }
    const haveIdx = new Map(cur.indexes.map((i) => [`${i.unique ? "u" : "i"}:${i.columns.join(",")}`, i]));
    for (const [k, w] of wantIdx) {
      if (!haveIdx.has(k)) {
        idx.push({
          op: "createIndex",
          table: m.name,
          description: `create ${w.unique ? "unique " : ""}index ${w.name} on ${m.name}(${w.columns.join(", ")})`,
          destructive: false,
          applicable: true,
          statement: { kind: "createIndex", table: m.name, name: w.name, columns: w.columns, unique: w.unique, ifNotExists: true },
        });
      }
    }
    for (const [k, h] of haveIdx) {
      if (!wantIdx.has(k)) {
        dropIdx.push({
          op: "dropIndex",
          table: m.name,
          description: `drop index ${h.name} on ${m.name}`,
          destructive: h.unique,
          applicable: true,
          statement: { kind: "dropIndex", name: h.name, table: m.name, ifExists: true },
        });
      }
    }
    for (const c of cur.columns) {
      if (needsRebuild) break;
      if (!wantCols.has(c.name)) {
        dropCols.push({
          op: "dropColumn",
          table: m.name,
          description: `drop column ${m.name}.${c.name}`,
          destructive: true,
          applicable: true,
          statement: { kind: "alterTable", table: m.name, action: { op: "dropColumn", name: c.name } },
        });
      }
    }
  }
  if (opts.dropMissingTables) {
    for (const t of existing) {
      if (!wantedNames.has(t.name) && !t.name.startsWith("_wave_")) {
        dropTables.push({
          op: "dropTable",
          table: t.name,
          description: `drop table ${t.name}`,
          destructive: true,
          applicable: true,
          statement: { kind: "dropTable", name: t.name, ifExists: true },
        });
      }
    }
  }
  return [...creates, ...adds, ...dropIdx, ...idx, ...dropCols, ...dropTables];
}
