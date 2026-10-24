import { quote, sqlLiteral, type ForeignKeyDef, type TableDef } from "./api";

export type RelationCardinality = "many-to-one" | "one-to-many" | "one-to-one";

export interface FkRelationPreview {
  cardinality: RelationCardinality;
  /** Short label, e.g. `customers.id` or `orders.customer_id` */
  label: string;
  targetTable: string;
  sql: string;
  countSql?: string;
}

const PREVIEW_LIMIT = 20;

function fkIsUnique(child: TableDef, fk: ForeignKeyDef): boolean {
  return child.indexes.some(
    (ix) => ix.unique && ix.columns.length === fk.columns.length && ix.columns.every((c, i) => c === fk.columns[i]),
  );
}

function rowValues(row: unknown[], columns: string[], names: string[]): unknown[] | null {
  const vals = names.map((n) => {
    const i = columns.indexOf(n);
    return i >= 0 ? row[i] : undefined;
  });
  if (vals.some((v) => v === null || v === undefined)) return null;
  return vals;
}

function whereEq(table: string, cols: string[], vals: unknown[]): string {
  const parts = cols.map((c, i) => `${quote(c)} = ${sqlLiteral(vals[i])}`);
  return `SELECT * FROM ${quote(table)} WHERE ${parts.join(" AND ")}`;
}

/** Relations navigable from a grid cell (parent row, child rows, or both). */
export function relationsForCell(
  schema: TableDef[],
  table: TableDef,
  column: string,
  row: unknown[],
  columns: string[],
): FkRelationPreview[] {
  const out: FkRelationPreview[] = [];
  const fks = table.foreignKeys ?? [];

  for (const fk of fks) {
    if (!fk.columns.includes(column)) continue;
    const vals = rowValues(row, columns, fk.columns);
    if (!vals) continue;
    const base = whereEq(fk.refTable, fk.refColumns, vals);
    out.push({
      cardinality: "many-to-one",
      label: `${fk.refTable}.${fk.refColumns.join(",")}`,
      targetTable: fk.refTable,
      sql: `${base} LIMIT 1`,
    });
  }

  if (table.primaryKey.includes(column)) {
    const pkVals = rowValues(row, columns, table.primaryKey);
    if (!pkVals) return out;

    for (const child of schema) {
      if (child.name === table.name) continue;
      for (const fk of child.foreignKeys ?? []) {
        if (fk.refTable !== table.name) continue;
        if (fk.refColumns.length !== table.primaryKey.length) continue;
        if (!fk.refColumns.every((c, i) => c === table.primaryKey[i])) continue;

        const childCols = fk.columns;
        const parts = childCols.map((c, i) => `${quote(c)} = ${sqlLiteral(pkVals[i])}`);
        const where = parts.join(" AND ");
        const cardinality: RelationCardinality = fkIsUnique(child, fk) ? "one-to-one" : "one-to-many";
        const limit = cardinality === "one-to-one" ? 1 : PREVIEW_LIMIT + 1;
        out.push({
          cardinality,
          label: `${child.name}.${childCols.join(",")}`,
          targetTable: child.name,
          sql: `SELECT * FROM ${quote(child.name)} WHERE ${where} LIMIT ${limit}`,
          countSql:
            cardinality === "one-to-many"
              ? `SELECT count(*) AS n FROM ${quote(child.name)} WHERE ${where}`
              : undefined,
        });
      }
    }
  }

  return out;
}

export function cardinalityLabel(c: RelationCardinality): string {
  if (c === "many-to-one") return "Many → one";
  if (c === "one-to-one") return "One ↔ one";
  return "One → many";
}
