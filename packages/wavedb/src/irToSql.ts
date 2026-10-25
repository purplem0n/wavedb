// Best-effort SQL text for typed query IR (Studio Logs, debugging). Not for execution.

import type { IR } from "./expr.ts";

const LOGIC_OPS = new Set(["and", "or"]);
const CMP_OPS = new Set(["=", "!=", "<>", "<", "<=", ">", ">="]);

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function formatLitValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.$int === "string" && Object.keys(o).length === 1) return o.$int;
    if (typeof o.$blob === "string" && Object.keys(o).length === 1) return "BLOB(…)";
  }
  return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function formatColumnRef(table: unknown, name: unknown): string {
  const col = quoteIdent(String(name));
  if (typeof table === "string" && table.length > 0) return `${quoteIdent(table)}.${col}`;
  return col;
}

function formatExpr(expr: unknown, depth = 0): string {
  if (!isRecord(expr)) return "?";
  const t = expr.t;
  if (t === "col") return formatColumnRef(expr.table, expr.name);
  if (t === "lit") return formatLitValue(expr.v);
  if (t === "star") return "*";
  if (t === "bin") {
    const op = String(expr.op ?? "?");
    const l = formatExpr(expr.l, depth + 1);
    const r = formatExpr(expr.r, depth + 1);
    if (LOGIC_OPS.has(op)) {
      const join = ` ${op.toUpperCase()} `;
      if (depth > 0) return `(${l}${join}${r})`;
      return `${l}${join}${r}`;
    }
    if (CMP_OPS.has(op)) return `${l} ${op === "!=" ? "<>" : op} ${r}`;
    return `${l} ${op} ${r}`;
  }
  if (t === "like") {
    const e = formatExpr(expr.e);
    const pattern = formatExpr(expr.pattern);
    const base = `${e} LIKE ${pattern}`;
    const ci = expr.ci === true ? " (ci)" : "";
    if (expr.negated === true) return `NOT (${base}${ci})`;
    return base + ci;
  }
  if (t === "between") {
    const e = formatExpr(expr.e);
    const lo = formatExpr(expr.lo);
    const hi = formatExpr(expr.hi);
    const base = `${e} BETWEEN ${lo} AND ${hi}`;
    return expr.negated === true ? `NOT (${base})` : base;
  }
  if (t === "in") {
    const e = formatExpr(expr.e);
    const list = Array.isArray(expr.list) ? expr.list.map((x) => formatExpr(x)).join(", ") : "?";
    const base = `${e} IN (${list})`;
    return expr.negated === true ? `NOT (${base})` : base;
  }
  if (t === "isNull") {
    const e = formatExpr(expr.e);
    return expr.negated === true ? `${e} IS NOT NULL` : `${e} IS NULL`;
  }
  if (t === "not") return `NOT (${formatExpr(expr.e, depth + 1)})`;
  if (t === "func") {
    const name = String(expr.name ?? "func").toUpperCase();
    if (expr.star === true && (!expr.args || (Array.isArray(expr.args) && expr.args.length === 0))) {
      return `${name}(*)`;
    }
    const args = Array.isArray(expr.args) ? expr.args.map((a) => formatExpr(a)).join(", ") : "";
    const distinct = expr.distinct === true ? "DISTINCT " : "";
    return `${name}(${distinct}${args})`;
  }
  return "…";
}

function formatTableRef(ref: unknown): string {
  if (!isRecord(ref)) return "?";
  const name = quoteIdent(String(ref.name ?? "?"));
  const alias = ref.alias;
  if (typeof alias === "string" && alias.length > 0 && alias !== ref.name) {
    return `${name} AS ${quoteIdent(alias)}`;
  }
  return name;
}

function formatSelectColumn(item: unknown): string {
  if (!isRecord(item)) return "?";
  if (item.t === "star") return "*";
  if (item.t === "expr") {
    const sql = formatExpr(item.expr);
    const alias = item.alias;
    if (typeof alias === "string" && alias.length > 0 && alias !== sql) {
      return `${sql} AS ${quoteIdent(alias)}`;
    }
    return sql;
  }
  return formatExpr(item);
}

function formatWhere(w: unknown): string {
  if (!w) return "";
  return formatExpr(w);
}

function formatOrderItem(o: unknown): string {
  if (!isRecord(o)) return "?";
  const expr = formatExpr(o.expr);
  return o.desc === true ? `${expr} DESC` : `${expr} ASC`;
}

function formatJoins(joins: unknown): string {
  if (!Array.isArray(joins) || joins.length === 0) return "";
  let out = "";
  for (const j of joins) {
    if (!isRecord(j)) continue;
    const kind = j.kind === "left" ? "LEFT JOIN" : "INNER JOIN";
    out += ` ${kind} ${formatTableRef(j.table)} ON ${formatWhere(j.on)}`;
  }
  return out;
}

function formatReturning(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  return ` RETURNING ${items.map(formatSelectColumn).join(", ")}`;
}

function formatOnConflict(c: unknown): string {
  if (!isRecord(c)) return "";
  const target = Array.isArray(c.target) && c.target.length > 0 ? ` (${c.target.map((x) => quoteIdent(String(x))).join(", ")})` : "";
  if (c.kind === "doNothing") return ` ON CONFLICT${target} DO NOTHING`;
  if (c.kind === "doUpdate") {
    const set = Array.isArray(c.set)
      ? c.set
          .map((a) => {
            if (!isRecord(a)) return null;
            return `${quoteIdent(String(a.column ?? "?"))} = ${formatExpr(a.expr)}`;
          })
          .filter(Boolean)
          .join(", ")
      : "";
    return ` ON CONFLICT${target} DO UPDATE SET ${set}`;
  }
  return "";
}

function formatColumnDef(c: unknown): string {
  if (!isRecord(c)) return "?";
  const parts = [quoteIdent(String(c.name ?? "?")), String(c.type ?? "text").toUpperCase()];
  if (c.primaryKey === true) parts.push("PRIMARY KEY");
  if (c.autoIncrement === true) parts.push("AUTOINCREMENT");
  if (c.unique === true) parts.push("UNIQUE");
  if (c.nullable === false) parts.push("NOT NULL");
  if (c.references && isRecord(c.references)) {
    const refTable = quoteIdent(String(c.references.table ?? "?"));
    const refCols = Array.isArray(c.references.columns)
      ? c.references.columns.map((x) => quoteIdent(String(x))).join(", ")
      : "?";
    parts.push(`REFERENCES ${refTable} (${refCols})`);
  }
  if (c.default !== undefined) {
    const d = c.default;
    if (isRecord(d)) {
      if (d.kind === "now") parts.push("DEFAULT NOW");
      else if (d.kind === "uuid7") parts.push("DEFAULT UUID7");
      else if (d.kind === "uuid4") parts.push("DEFAULT UUID4");
      else if (d.kind === "value") parts.push(`DEFAULT ${formatLitValue(d.v)}`);
    }
  }
  return parts.join(" ");
}

function formatCreateTable(stmt: IR): string {
  const name = quoteIdent(String(stmt.name ?? "?"));
  const ifNot = stmt.ifNotExists === true ? "IF NOT EXISTS " : "";
  const cols = Array.isArray(stmt.columns) ? stmt.columns.map(formatColumnDef).join(", ") : "";
  const pk =
    Array.isArray(stmt.primaryKey) && stmt.primaryKey.length > 0
      ? `, PRIMARY KEY (${stmt.primaryKey.map((x) => quoteIdent(String(x))).join(", ")})`
      : "";
  return `CREATE TABLE ${ifNot}${name} (${cols}${pk})`;
}

function formatAlterTable(stmt: IR): string {
  const table = quoteIdent(String(stmt.table ?? "?"));
  const action = stmt.action;
  if (!isRecord(action)) return `ALTER TABLE ${table} …`;
  const op = action.op;
  if (op === "addColumn" && isRecord(action.column)) {
    return `ALTER TABLE ${table} ADD COLUMN ${formatColumnDef(action.column)}`;
  }
  if (op === "dropColumn") return `ALTER TABLE ${table} DROP COLUMN ${quoteIdent(String(action.name ?? "?"))}`;
  if (op === "setAutoIncrement") {
    return `ALTER TABLE ${table} SET AUTOINCREMENT ${action.enabled === true ? "ON" : "OFF"}`;
  }
  return `ALTER TABLE ${table} …`;
}

function formatStmt(stmt: IR): string {
  const kind = String(stmt.kind ?? "").toLowerCase();
  if (kind === "explain") {
    const inner = isRecord(stmt.stmt) ? formatStmt(stmt.stmt as IR) : "…";
    return `EXPLAIN ${inner}`;
  }
  if (kind === "select") {
    const distinct = stmt.distinct === true ? "DISTINCT " : "";
    const cols = Array.isArray(stmt.columns) ? stmt.columns.map(formatSelectColumn).join(", ") : "*";
    let sql = `SELECT ${distinct}${cols || "*"}`;
    if (stmt.from) sql += ` FROM ${formatTableRef(stmt.from)}`;
    sql += formatJoins(stmt.joins);
    const where = formatWhere(stmt.where);
    if (where) sql += ` WHERE ${where}`;
    if (Array.isArray(stmt.groupBy) && stmt.groupBy.length > 0) {
      sql += ` GROUP BY ${stmt.groupBy.map((g) => formatExpr(g)).join(", ")}`;
    }
    const having = formatWhere(stmt.having);
    if (having) sql += ` HAVING ${having}`;
    if (Array.isArray(stmt.orderBy) && stmt.orderBy.length > 0) {
      sql += ` ORDER BY ${stmt.orderBy.map(formatOrderItem).join(", ")}`;
    }
    if (stmt.limit !== undefined) sql += ` LIMIT ${stmt.limit}`;
    if (stmt.offset !== undefined) sql += ` OFFSET ${stmt.offset}`;
    return sql;
  }
  if (kind === "insert") {
    const table = quoteIdent(String(stmt.table ?? "?"));
    const columns = Array.isArray(stmt.columns) ? stmt.columns.map((c) => quoteIdent(String(c))).join(", ") : "";
    const rows = Array.isArray(stmt.rows) ? stmt.rows : [];
    const valueRows = rows
      .map((row) => {
        if (!Array.isArray(row)) return "(?)";
        return `(${row.map((cell) => formatExpr(cell)).join(", ")})`;
      })
      .join(", ");
    let sql = `INSERT INTO ${table}${columns ? ` (${columns})` : ""} VALUES ${valueRows || "(DEFAULT)"}`;
    sql += formatOnConflict(stmt.onConflict);
    sql += formatReturning(stmt.returning);
    return sql;
  }
  if (kind === "update") {
    const table = quoteIdent(String(stmt.table ?? "?"));
    const set = Array.isArray(stmt.set)
      ? stmt.set
          .map((a) => {
            if (!isRecord(a)) return null;
            return `${quoteIdent(String(a.column ?? "?"))} = ${formatExpr(a.expr)}`;
          })
          .filter(Boolean)
          .join(", ")
      : "";
    let sql = `UPDATE ${table} SET ${set || "…"}`;
    const where = formatWhere(stmt.where);
    if (where) sql += ` WHERE ${where}`;
    sql += formatReturning(stmt.returning);
    return sql;
  }
  if (kind === "delete") {
    const table = quoteIdent(String(stmt.table ?? "?"));
    let sql = `DELETE FROM ${table}`;
    const where = formatWhere(stmt.where);
    if (where) sql += where ? ` WHERE ${where}` : "";
    sql += formatReturning(stmt.returning);
    return sql;
  }
  if (kind === "createtable") return formatCreateTable(stmt);
  if (kind === "droptable") {
    const ifExists = stmt.ifExists === true ? "IF EXISTS " : "";
    const cascade = stmt.cascade === true ? " CASCADE" : "";
    return `DROP TABLE ${ifExists}${quoteIdent(String(stmt.name ?? "?"))}${cascade}`;
  }
  if (kind === "createindex") {
    const unique = stmt.unique === true ? "UNIQUE " : "";
    const ifNot = stmt.ifNotExists === true ? "IF NOT EXISTS " : "";
    const cols = Array.isArray(stmt.columns) ? stmt.columns.map((c) => quoteIdent(String(c))).join(", ") : "";
    return `CREATE ${unique}INDEX ${ifNot}${quoteIdent(String(stmt.name ?? "?"))} ON ${quoteIdent(String(stmt.table ?? "?"))} (${cols})`;
  }
  if (kind === "dropindex") {
    const ifExists = stmt.ifExists === true ? "IF EXISTS " : "";
    return `DROP INDEX ${ifExists}${quoteIdent(String(stmt.name ?? "?"))}`;
  }
  if (kind === "altertable") return formatAlterTable(stmt);
  return `/* ${kind || "stmt"} */ ${JSON.stringify(stmt)}`;
}

/** Human-readable SQL for a typed IR statement (query log display). */
export function formatIrForLog(stmt: unknown): string {
  if (!isRecord(stmt)) return String(stmt ?? "");
  if (typeof stmt.kind !== "string") {
    return String(JSON.stringify(stmt)).slice(0, 500);
  }
  return formatStmt(stmt as IR);
}
