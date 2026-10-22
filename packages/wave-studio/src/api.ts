export interface ColumnDef {
  id: number;
  name: string;
  type: string;
  nullable: boolean;
  default?: unknown;
}
export interface IndexDef {
  id: number;
  name: string;
  columns: string[];
  unique: boolean;
}
/** Matches catalog JSON (`ref_table` / `ref_columns` are snake_case). */
export interface ForeignKeyDef {
  columns: string[];
  ref_table: string;
  ref_columns: string[];
}
export interface TableDef {
  id: number;
  name: string;
  columns: ColumnDef[];
  primaryKey: string[];
  autoIncrement: boolean;
  indexes: IndexDef[];
  foreignKeys?: ForeignKeyDef[];
  version: number;
}
export interface Stats {
  visibleTs: number;
  commits: number;
  conflicts: number;
  rollbacks: number;
  fsyncs: number;
  activeTxns: number;
  trackedWrites: number;
  diskBytes: number;
}
export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertId?: unknown;
  /** Engine execution time (ms), from `/api/run`. */
  durationMs?: number;
}

/** Longest engine time when multiple queries ran in parallel (e.g. page + count). */
export function engineQueryDurationMs(...results: Array<Pick<QueryResult, "durationMs"> | undefined>): number | null {
  const ms = results
    .map((r) => r?.durationMs)
    .filter((n): n is number => n !== undefined && Number.isFinite(n));
  if (ms.length === 0) return null;
  return Math.max(...ms);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

declare global {
  interface Window {
    __WAVE_API_PREFIX__?: string;
  }
}

/** Wave HTTP API prefix (includes `/api` segment), e.g. `/api` or `/__wave/api`. */
export function getApiPrefix(): string {
  if (typeof window !== "undefined" && window.__WAVE_API_PREFIX__) return window.__WAVE_API_PREFIX__;
  const fromEnv = import.meta.env.VITE_WAVE_API_PREFIX;
  return typeof fromEnv === "string" && fromEnv ? fromEnv : "/api";
}

function apiPath(sub: string): string {
  const base = getApiPrefix().replace(/\/$/, "");
  const tail = sub.startsWith("/") ? sub : `/${sub}`;
  return `${base}${tail}`;
}

const TOKEN_KEY = "wave-studio-token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function call<T>(method: "GET" | "POST", subPath: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(apiPath(subPath), {
    method,
    credentials: "include",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = data?.error;
    const e = typeof raw === "string" ? { message: raw } : (raw ?? {});
    throw new ApiError(e.message ?? `HTTP ${res.status}`, e.code ?? "WAVE_UNKNOWN", res.status);
  }
  return data as T;
}

export type AuthPhase = "setup" | "login" | "ready";

export const authApi = {
  status: () => call<{ phase: AuthPhase; auth?: boolean }>("GET", "/auth/status"),
  setup: (password: string) => call<{ ok: boolean }>("POST", "/auth/setup", { password }),
  login: (password: string) => call<{ ok: boolean }>("POST", "/auth/login", { password }),
  logout: () => call<{ ok: boolean }>("POST", "/auth/logout", {}),
};

export const api = {
  tables: () => call<TableDef[]>("GET", "/tables"),
  stats: () => call<Stats>("GET", "/stats"),
  sql: (sql: string, params: unknown[] = []) => call<QueryResult>("POST", "/run", { sql, params }),
  vacuum: () => call<{ removed: number }>("POST", "/vacuum", {}),
  compact: () => call<{ ok: boolean }>("POST", "/compact", {}),
};

export const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Escape a value for inline SQL (studio previews only). */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "bigint") return String(v);
  return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
}

/** Render a cell value (blobs and JSON included) for display. */
export function display(v: unknown, type?: string): string {
  if (v === null || v === undefined) return "NULL";
  if (type === "timestamp" && typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().replace("T", " ").replace("Z", "");
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$blob === "string" && Object.keys(o).length === 1) return `<blob ${Math.floor((o.$blob.length * 3) / 4)} bytes>`;
    return JSON.stringify(v);
  }
  return String(v);
}

/** Human-readable column default. */
export function describeDefault(d: unknown): string {
  const o = d as { kind?: string; v?: unknown } | undefined;
  if (!o?.kind) return "";
  if (o.kind === "value") return `default ${JSON.stringify(o.v)}`;
  return `default ${o.kind}()`;
}
