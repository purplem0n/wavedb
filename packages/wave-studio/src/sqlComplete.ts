import type { TableDef } from "./api";

export interface CompletionItem {
  label: string;
  insert: string;
  detail?: string;
  kind: "keyword" | "table" | "column";
}

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "ON",
  "GROUP",
  "BY",
  "ORDER",
  "ASC",
  "DESC",
  "LIMIT",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "INDEX",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS",
  "IN",
  "AS",
  "DISTINCT",
  "COUNT",
  "EXPLAIN",
];

/** Word being typed immediately before `cursor` (inclusive of partial word). */
export function tokenBeforeCursor(text: string, cursor: number): { prefix: string; start: number } {
  const head = text.slice(0, cursor);
  const m = /[\w".]*$/.exec(head);
  const prefix = m?.[0] ?? "";
  return { prefix, start: cursor - prefix.length };
}

function tableNamesInQuery(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"?([\w]+)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    names.add(m[1]!);
  }
  return names;
}

export function sqlCompletions(text: string, cursor: number, tables: TableDef[], limit = 12): CompletionItem[] {
  const { prefix, start: _start } = tokenBeforeCursor(text, cursor);
  const needle = prefix.replace(/"/g, "").toLowerCase();
  if (!needle && prefix !== "" && prefix !== ".") return [];

  const out: CompletionItem[] = [];
  const push = (item: CompletionItem) => {
    if (out.length >= limit) return;
    if (item.label.toLowerCase().startsWith(needle) || (needle === "" && prefix.endsWith("."))) {
      out.push(item);
    }
  };

  const dot = prefix.lastIndexOf(".");
  if (dot > 0) {
    const tablePart = prefix.slice(0, dot).replace(/"/g, "");
    const colNeedle = prefix.slice(dot + 1).toLowerCase();
    const t = tables.find((x) => x.name.toLowerCase() === tablePart.toLowerCase());
    if (t) {
      for (const c of t.columns) {
        if (!colNeedle || c.name.toLowerCase().startsWith(colNeedle)) {
          if (out.length >= limit) break;
          out.push({
            label: c.name,
            insert: `${prefix.slice(0, dot + 1)}${c.name}`,
            detail: c.type,
            kind: "column",
          });
        }
      }
      return out;
    }
  }

  const inFrom = /\b(FROM|JOIN|INTO|UPDATE)\s+[\w".]*$/i.test(text.slice(0, cursor));
  const inSelectList = /\bSELECT\s+[\w",.\s]*$/i.test(text.slice(0, cursor)) && !/\bFROM\b/i.test(text.slice(0, cursor));

  if (inFrom || needle.length > 0) {
    for (const t of tables) {
      push({
        label: t.name,
        insert: `"${t.name.replace(/"/g, '""')}"`,
        detail: `${t.columns.length} columns`,
        kind: "table",
      });
    }
  }

  if (inSelectList || (!inFrom && needle.length > 0)) {
    const scoped = tableNamesInQuery(text);
    const scopedTables = scoped.size ? tables.filter((t) => scoped.has(t.name)) : tables;
    for (const t of scopedTables) {
      for (const c of t.columns) {
        push({
          label: `${t.name}.${c.name}`,
          insert: `"${t.name.replace(/"/g, '""')}"."${c.name.replace(/"/g, '""')}"`,
          detail: c.type,
          kind: "column",
        });
      }
    }
  }

  for (const kw of SQL_KEYWORDS) {
    if (kw.toLowerCase().startsWith(needle)) {
      push({ label: kw, insert: kw, kind: "keyword" });
    }
  }

  return out.slice(0, limit);
}

export function applyCompletion(text: string, cursor: number, item: CompletionItem): { text: string; cursor: number } {
  const { prefix, start } = tokenBeforeCursor(text, cursor);
  const before = text.slice(0, start);
  const after = text.slice(cursor);
  const insert = item.insert;
  const next = before + insert + after;
  const pos = start + insert.length;
  return { text: next, cursor: pos };
}
