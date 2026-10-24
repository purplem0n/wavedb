const KEYWORDS = new Set(
  [
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
    "WITH",
    "HAVING",
    "UNION",
    "ALL",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
  ].map((k) => k.toLowerCase()),
);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML for a syntax-highlighted SQL overlay (Studio dark theme tokens). */
export function highlightSql(sql: string): string {
  let i = 0;
  let out = "";
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      const chunk = end === -1 ? rest : rest.slice(0, end);
      out += `<span class="sql-hl-comment">${escapeHtml(chunk)}</span>`;
      i += chunk.length;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const chunk = end === -1 ? rest : rest.slice(0, end + 2);
      out += `<span class="sql-hl-comment">${escapeHtml(chunk)}</span>`;
      i += chunk.length;
      continue;
    }
    const str = /^'(?:[^']|'')*'/.exec(rest);
    if (str) {
      out += `<span class="sql-hl-string">${escapeHtml(str[0])}</span>`;
      i += str[0].length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(rest);
    if (num) {
      out += `<span class="sql-hl-number">${escapeHtml(num[0])}</span>`;
      i += num[0].length;
      continue;
    }
    const id = /^"[^"]*"|^[\w]+/.exec(rest);
    if (id) {
      const raw = id[0];
      const kw = !raw.startsWith('"') && KEYWORDS.has(raw.toLowerCase());
      out += kw
        ? `<span class="sql-hl-keyword">${escapeHtml(raw)}</span>`
        : `<span class="sql-hl-plain">${escapeHtml(raw)}</span>`;
      i += raw.length;
      continue;
    }
    out += escapeHtml(rest[0]!);
    i += 1;
  }
  return out + "\n";
}
