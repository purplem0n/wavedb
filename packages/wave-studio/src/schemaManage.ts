import { quote } from "./api";

export const COLUMN_TYPES = ["text", "integer", "real", "blob", "boolean", "timestamp"] as const;

export type ColumnTypeName = (typeof COLUMN_TYPES)[number];

export function addColumnSql(table: string, name: string, type: ColumnTypeName, nullable: boolean): string {
  const n = name.trim();
  if (!n) throw new Error("Column name is required");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error("Invalid column name");
  return `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(n)} ${type.toUpperCase()}${nullable ? "" : " NOT NULL"}`;
}

export function dropColumnSql(table: string, column: string): string {
  return `ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)}`;
}

export function dropTableSql(table: string): string {
  return `DROP TABLE ${quote(table)}`;
}

export function createTableSql(table: string, column: string, type: ColumnTypeName): string {
  const t = table.trim();
  const c = column.trim();
  if (!t || !c) throw new Error("Table and column names are required");
  return `CREATE TABLE ${quote(t)} (${quote(c)} ${type.toUpperCase()} PRIMARY KEY)`;
}
