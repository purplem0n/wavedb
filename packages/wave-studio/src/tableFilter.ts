/** Build and validate the free-form WHERE fragment for table browsing. */

const FORBIDDEN = /\b(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)\b/i;

export function validateTableFilter(filter: string): string {
  const t = filter.trim();
  if (!t) return "";
  if (/[;]/.test(t)) throw new Error("filter must be a single predicate (semicolons are not allowed)");
  if (FORBIDDEN.test(t)) throw new Error("filter may only contain a WHERE predicate");
  return t;
}

export function tableWhereClause(applied: string): string {
  const t = validateTableFilter(applied);
  return t ? ` WHERE ${t}` : "";
}
