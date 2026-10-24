// Schema diffing: compare the code-defined schema with what is stored in the catalog.

import { encodeValue } from "./expr.ts";
import {
  columnSpec,
  createTableStatement,
  defaultIndexName,
  tableHasAutoIncrement,
  tableMeta,
  type AnyTable,
  type ColumnKind,
} from "./schema.ts";

export interface ForeignKeyDefJson {
  name?: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface TableDefJson {
  id: number;
  name: string;
  columns: { id: number; name: string; type: ColumnKind; nullable: boolean; default?: unknown }[];
  primaryKey: string[];
  autoIncrement: boolean;
  indexes: { id: number; name: string; columns: string[]; unique: boolean }[];
  foreignKeys?: ForeignKeyDefJson[];
  version: number;
}

export type SchemaOpKind =
  | "createTable"
  | "addColumn"
  | "dropColumn"
  | "createIndex"
  | "dropIndex"
  | "dropTable"
  | "addForeignKey"
  | "dropForeignKey"
  | "rebuildTable"
  | "setAutoIncrement"
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

function normalizeFk(raw: ForeignKeyDefJson & { ref_table?: string; ref_columns?: string[] }): ForeignKeyDefJson {
  return {
    name: raw.name,
    columns: raw.columns ?? [],
    refTable: raw.refTable ?? raw.ref_table ?? "",
    refColumns: raw.refColumns ?? raw.ref_columns ?? [],
  };
}

function fkKey(fk: ForeignKeyDefJson): string {
  const n = normalizeFk(fk);
  return `${n.columns.join(",")}->${n.refTable}(${n.refColumns.join(",")})`;
}

function wantedForeignKeys(t: AnyTable): ForeignKeyDefJson[] {
  const m = tableMeta(t);
  const out: ForeignKeyDefJson[] = [];
  for (const c of m.columns) {
    const ref = c.config.references?.();
    if (ref) {
      out.push({
        columns: [c.name],
        refTable: ref.table,
        refColumns: [ref.name],
      });
    }
  }
  return out;
}

function inboundFkDependents(existing: TableDefJson[], tableName: string): string[] {
  const deps: string[] = [];
  for (const t of existing) {
    for (const fk of t.foreignKeys ?? []) {
      if (fk.refTable === tableName && !deps.includes(t.name)) deps.push(t.name);
    }
  }
  return deps;
}

/** Drop order: tables referenced by others are dropped after dependents. */
function dropTableOrder(existing: TableDefJson[], names: string[]): string[] {
  const set = new Set(names);
  const out: string[] = [];
  const pending = new Set(names);
  while (pending.size) {
    let progressed = false;
    for (const name of [...pending]) {
      const deps = inboundFkDependents(existing, name).filter((d) => set.has(d) && pending.has(d));
      if (deps.length === 0) {
        out.push(name);
        pending.delete(name);
        progressed = true;
      }
    }
    if (!progressed) {
      out.push(...pending);
      break;
    }
  }
  return out;
}

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
  const addFks: SchemaOp[] = [];
  const dropFks: SchemaOp[] = [];
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
    const wantAi = tableHasAutoIncrement(t);
    if (!needsRebuild && cur.autoIncrement !== wantAi) {
      adds.push({
        op: "setAutoIncrement",
        table: m.name,
        description: `${wantAi ? "enable" : "disable"} autoIncrement on ${m.name}`,
        destructive: false,
        applicable: true,
        statement: {
          kind: "alterTable",
          table: m.name,
          action: { op: "setAutoIncrement", enabled: wantAi },
        },
      });
    }
    const stillWantedFk = new Set(tables.flatMap((tt) => wantedForeignKeys(tt).map(fkKey)));
    for (const c of cur.columns) {
      if (needsRebuild) break;
      if (!wantCols.has(c.name)) {
        const outboundBlocked = (cur.foreignKeys ?? []).some((fk) => fk.columns.includes(c.name) && !fk.name);
        const usedByInboundFk =
          outboundBlocked ||
          existing.some((t) =>
            (t.foreignKeys ?? []).some(
              (fk) =>
                fk.refTable === m.name && fk.refColumns.includes(c.name) && stillWantedFk.has(fkKey(fk)),
            ),
          );
        dropCols.push({
          op: "dropColumn",
          table: m.name,
          description: `drop column ${m.name}.${c.name}`,
          destructive: true,
          applicable: !usedByInboundFk,
          statement: { kind: "alterTable", table: m.name, action: { op: "dropColumn", name: c.name } },
        });
        if (usedByInboundFk) {
          adds.push({
            op: "conflict",
            table: m.name,
            description: `cannot drop column ${m.name}.${c.name}: foreign key constraints depend on it`,
            destructive: false,
            applicable: false,
          });
        }
      }
    }
    const wantFk = wantedForeignKeys(t);
    const haveFk = new Map((cur.foreignKeys ?? []).map((fk) => [fkKey(fk), normalizeFk(fk)]));
    const wantFkMap = new Map(wantFk.map((fk) => [fkKey(fk), fk]));
    for (const [k, w] of wantFkMap) {
      if (!haveFk.has(k)) {
        addFks.push({
          op: "addForeignKey",
          table: m.name,
          description: `add foreign key on ${m.name}(${w.columns.join(", ")}) references ${w.refTable}(${w.refColumns.join(", ")})`,
          destructive: false,
          applicable: byName.has(w.refTable) || wantedNames.has(w.refTable),
          statement: {
            kind: "alterTable",
            table: m.name,
            action: { op: "addForeignKey", fk: w },
          },
        });
        if (!byName.has(w.refTable) && !wantedNames.has(w.refTable)) {
          adds.push({
            op: "conflict",
            table: m.name,
            description: `foreign key on ${m.name} references missing table ${w.refTable}`,
            destructive: false,
            applicable: false,
          });
        }
      }
    }
    for (const [k, h] of haveFk) {
      if (!wantFkMap.has(k)) {
        const cname = h.name ?? `${m.name}_${h.columns.join("_")}_fkey`;
        dropFks.push({
          op: "dropForeignKey",
          table: m.name,
          description: `drop foreign key ${cname} on ${m.name}`,
          destructive: false,
          applicable: Boolean(h.name),
          statement: {
            kind: "alterTable",
            table: m.name,
            action: { op: "dropConstraint", name: cname, ifExists: true },
          },
        });
        if (!h.name) {
          adds.push({
            op: "conflict",
            table: m.name,
            description: `unnamed foreign key on ${m.name} cannot be dropped automatically`,
            destructive: false,
            applicable: false,
          });
        }
      }
    }
  }
  if (opts.dropMissingTables) {
    const toDrop = existing.filter((t) => !wantedNames.has(t.name) && !t.name.startsWith("_wave_")).map((t) => t.name);
    const dropOrder = dropTableOrder(existing, toDrop);
    const orderIndex = new Map(dropOrder.map((n, i) => [n, i]));
    for (const name of dropOrder) {
      const deps = inboundFkDependents(existing, name).filter((d) => toDrop.includes(d));
      const blocked = deps.some((d) => (orderIndex.get(d) ?? 0) >= (orderIndex.get(name) ?? 0));
      dropTables.push({
        op: "dropTable",
        table: name,
        description: deps.length
          ? `drop table ${name} (with ${deps.length} dependent table(s) in this batch)`
          : `drop table ${name}`,
        destructive: true,
        applicable: !blocked,
        statement: { kind: "dropTable", name, ifExists: true, cascade: deps.length > 0 },
      });
    }
  }
  return [...creates, ...adds, ...dropIdx, ...idx, ...addFks, ...dropFks, ...dropCols, ...dropTables];
}
