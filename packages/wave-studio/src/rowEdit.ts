import { quote, sqlLiteral, type TableDef } from "./api";

export function parseCellInput(raw: string, type: string, nullable: boolean): unknown {
  const s = raw.trim();
  if (s.toUpperCase() === "NULL") {
    if (!nullable) throw new Error("Column does not allow NULL");
    return null;
  }
  if (s === "" && nullable) return null;
  if (s === "" && !nullable) throw new Error("Value is required");

  if (/int/i.test(type)) {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error("Expected an integer");
    return n;
  }
  if (/real|float|double|numeric|decimal/i.test(type)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error("Expected a number");
    return n;
  }
  if (/bool/i.test(type)) {
    const low = s.toLowerCase();
    if (low === "1" || low === "true" || low === "yes") return true;
    if (low === "0" || low === "false" || low === "no") return false;
    throw new Error("Expected boolean (true/false or 1/0)");
  }
  return s;
}

export function buildUpdateSql(
  table: TableDef,
  columns: string[],
  row: unknown[],
  changes: Record<string, unknown>,
): string {
  if (table.primaryKey.length === 0) {
    throw new Error("Table has no primary key; cannot update rows safely");
  }
  const sets = Object.entries(changes);
  if (sets.length === 0) throw new Error("No changes to save");

  const colIndex = Object.fromEntries(columns.map((c, i) => [c, i]));
  for (const pk of table.primaryKey) {
    if (!(pk in colIndex)) throw new Error(`Primary key column ${pk} missing from result`);
  }

  const setClause = sets.map(([c, v]) => `${quote(c)} = ${sqlLiteral(v)}`).join(", ");
  const where = table.primaryKey
    .map((pk) => {
      const v = row[colIndex[pk]!];
      return `${quote(pk)} = ${sqlLiteral(v)}`;
    })
    .join(" AND ");

  return `UPDATE ${quote(table.name)} SET ${setClause} WHERE ${where}`;
}
