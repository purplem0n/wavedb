import { quote, sqlLiteral, type ColumnDef } from "./api";
import { validateTableFilter } from "./tableFilter";

export type UiFilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_null"
  | "is_not_null";

export interface UiFilterRule {
  column: string;
  op: UiFilterOp;
  value: string;
  value2: string;
}

export function operatorsForType(type: string): UiFilterOp[] {
  if (/bool/i.test(type)) return ["eq", "is_null", "is_not_null"];
  if (/int|real|float|numeric|decimal/i.test(type)) {
    return ["eq", "ne", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"];
  }
  return ["eq", "ne", "contains", "is_null", "is_not_null"];
}

function parseValue(raw: string, col: ColumnDef): unknown {
  const s = raw.trim();
  if (/int/i.test(col.type)) {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`${col.name}: expected integer`);
    return n;
  }
  if (/real|float|double|numeric|decimal/i.test(col.type)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`${col.name}: expected number`);
    return n;
  }
  if (/bool/i.test(col.type)) {
    const low = s.toLowerCase();
    if (low === "1" || low === "true") return true;
    if (low === "0" || low === "false") return false;
    throw new Error(`${col.name}: expected true/false`);
  }
  return s;
}

function likeEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/'/g, "''");
}

export function uiFiltersToWhere(rules: UiFilterRule[], columns: ColumnDef[]): string {
  const colMap = Object.fromEntries(columns.map((c) => [c.name, c]));
  const parts: string[] = [];
  for (const rule of rules) {
    if (!rule.column) continue;
    const col = colMap[rule.column];
    if (!col) throw new Error(`Unknown column ${rule.column}`);
    const q = quote(rule.column);
    switch (rule.op) {
      case "is_null":
        parts.push(`${q} IS NULL`);
        break;
      case "is_not_null":
        parts.push(`${q} IS NOT NULL`);
        break;
      case "contains": {
        if (!rule.value.trim()) throw new Error(`${col.name}: value required`);
        parts.push(`${q} LIKE '%${likeEscape(rule.value.trim())}%' ESCAPE '\\'`);
        break;
      }
      case "between": {
        const a = parseValue(rule.value, col);
        const b = parseValue(rule.value2, col);
        parts.push(`${q} BETWEEN ${sqlLiteral(a)} AND ${sqlLiteral(b)}`);
        break;
      }
      case "eq":
      case "ne":
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (!rule.value.trim() && !/null/i.test(col.type)) throw new Error(`${col.name}: value required`);
        const v = parseValue(rule.value, col);
        const sym = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[rule.op];
        parts.push(`${q} ${sym} ${sqlLiteral(v)}`);
        break;
      }
      default:
        break;
    }
  }
  const joined = parts.join(" AND ");
  return validateTableFilter(joined);
}
