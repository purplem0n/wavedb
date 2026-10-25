// Query log + durable read/write counters for Studio Logs & Metrics.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type QueryKind = "read" | "write" | "other";

export interface QueryLogEntry {
  id: string;
  at: number;
  kind: QueryKind;
  sql: string;
  durationMs?: number;
  rowsAffected?: number;
  ok: boolean;
  error?: string;
}

export interface QueryMetrics {
  totalReads: number;
  totalWrites: number;
  totalOther: number;
}

export interface QueryLogOptions {
  dataPath?: string;
  /** Max entries retained in memory and on disk (default 10_000; hard cap 10_000). */
  memoryLimit?: number;
}

const DEFAULT_MEMORY = 10_000;
const MAX_MEMORY = 10_000;
/** Append batch size before syncing JSONL to disk. */
const LOG_FLUSH_BATCH = 256;
/** Debounced metrics + log flush interval (ms). */
const LOG_FLUSH_MS = 250;

function waveDir(dataPath: string): string {
  return join(dataPath, ".wave");
}

function metricsPath(dataPath: string): string {
  return join(waveDir(dataPath), "query-metrics.json");
}

function logPath(dataPath: string): string {
  return join(waveDir(dataPath), "query-log.jsonl");
}

/** Classify SQL for aggregate counters (best-effort; not a full parser). */
export function classifySql(sql: string): QueryKind {
  const head = sql.trim().replace(/^\/\*[\s\S]*?\*\//, "").replace(/^--[^\n]*/, "").trim();
  const m = /^([a-z]+)/i.exec(head);
  if (!m) return "other";
  const kw = m[1]!.toUpperCase();
  if (kw === "SELECT" || kw === "WITH" || kw === "EXPLAIN" || kw === "PRAGMA") return "read";
  if (
    kw === "INSERT" ||
    kw === "UPDATE" ||
    kw === "DELETE" ||
    kw === "REPLACE" ||
    kw === "CREATE" ||
    kw === "DROP" ||
    kw === "ALTER" ||
    kw === "TRUNCATE" ||
    kw === "VACUUM" ||
    kw === "BEGIN" ||
    kw === "COMMIT" ||
    kw === "ROLLBACK"
  ) {
    return kw === "BEGIN" || kw === "COMMIT" || kw === "ROLLBACK" ? "other" : "write";
  }
  return "other";
}

/** Classify typed IR statements from `/api/run` (when `sql` is omitted). */
export function classifyStmt(stmt: Record<string, unknown>): QueryKind {
  const kind = stmt.kind;
  if (typeof kind !== "string") return "other";
  const k = kind.toLowerCase();
  if (k === "select" || k === "explain") return "read";
  if (
    k === "insert" ||
    k === "update" ||
    k === "delete" ||
    k === "createtable" ||
    k === "droptable" ||
    k === "createindex" ||
    k === "dropindex" ||
    k === "altertable"
  ) {
    return "write";
  }
  return "other";
}

function readMetrics(path: string): QueryMetrics {
  if (!existsSync(path)) return { totalReads: 0, totalWrites: 0, totalOther: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<QueryMetrics>;
    return {
      totalReads: typeof raw.totalReads === "number" ? raw.totalReads : 0,
      totalWrites: typeof raw.totalWrites === "number" ? raw.totalWrites : 0,
      totalOther: typeof raw.totalOther === "number" ? raw.totalOther : 0,
    };
  } catch {
    return { totalReads: 0, totalWrites: 0, totalOther: 0 };
  }
}

function writeMetricsAtomic(path: string, metrics: QueryMetrics): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(metrics, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function isQueryLogEntry(raw: unknown): raw is QueryLogEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as QueryLogEntry;
  return (
    typeof e.id === "string" &&
    typeof e.at === "number" &&
    (e.kind === "read" || e.kind === "write" || e.kind === "other") &&
    typeof e.sql === "string" &&
    typeof e.ok === "boolean"
  );
}

/** Load persisted JSONL (and legacy `.1` rotation) newest-last, capped at `limit`. */
function loadPersistedEntries(logFile: string, limit: number): QueryLogEntry[] {
  const paths = [`${logFile}.1`, logFile].filter((p) => existsSync(p));
  if (paths.length === 0) return [];
  const parsed: QueryLogEntry[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const e = JSON.parse(trimmed) as unknown;
        if (isQueryLogEntry(e)) parsed.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  parsed.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  if (parsed.length <= limit) return parsed;
  const out = parsed.slice(-limit);
  try {
    writeLogAtomic(logFile, out);
  } catch {
    /* keep in-memory tail even if compact fails */
  }
  return out;
}

function writeLogAtomic(logFile: string, entries: QueryLogEntry[]): void {
  mkdirSync(dirname(logFile), { recursive: true });
  const tmp = `${logFile}.${process.pid}.tmp`;
  const body = entries.length ? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n` : "";
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, logFile);
  const rotated = `${logFile}.1`;
  if (existsSync(rotated)) {
    try {
      unlinkSync(rotated);
    } catch {
      /* drop legacy rotation */
    }
  }
}

function truncateSql(sql: string, max = 2000): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export class QueryLog {
  private entries: QueryLogEntry[] = [];
  private metrics: QueryMetrics;
  private readonly memoryLimit: number;
  private readonly metricsFile?: string;
  private readonly logFile?: string;
  private listeners = new Set<(entry: QueryLogEntry) => void>();
  private pendingLogLines: string[] = [];
  private metricsDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: QueryLogOptions = {}) {
    const requested = opts.memoryLimit ?? DEFAULT_MEMORY;
    this.memoryLimit = Math.max(1, Math.min(requested, MAX_MEMORY));
    if (opts.dataPath) {
      const dir = waveDir(opts.dataPath);
      mkdirSync(dir, { recursive: true });
      this.metricsFile = metricsPath(opts.dataPath);
      this.logFile = logPath(opts.dataPath);
      this.metrics = readMetrics(this.metricsFile);
      this.entries = loadPersistedEntries(this.logFile, this.memoryLimit);
    } else {
      this.metrics = { totalReads: 0, totalWrites: 0, totalOther: 0 };
    }
  }

  getMetrics(): QueryMetrics {
    return { ...this.metrics };
  }

  recent(limit = 100, sinceId?: string): QueryLogEntry[] {
    const cap = Math.max(1, Math.min(limit, this.memoryLimit));
    if (sinceId) {
      const idx = this.entries.findIndex((e) => e.id === sinceId);
      if (idx >= 0) {
        return this.entries.slice(idx + 1, idx + 1 + cap);
      }
    }
    return this.entries.slice(-cap);
  }

  subscribe(fn: (entry: QueryLogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sync batched log lines and metrics to disk (call before reading the log file from another process). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.metricsDirty && this.metricsFile) {
      try {
        writeMetricsAtomic(this.metricsFile, this.metrics);
        this.metricsDirty = false;
      } catch {
        /* metrics must not break queries */
      }
    }
    if (this.logFile && this.pendingLogLines.length > 0) {
      try {
        appendFileSync(this.logFile, this.pendingLogLines.join(""), { mode: 0o600 });
        this.pendingLogLines = [];
      } catch {
        /* logging must not break queries */
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, LOG_FLUSH_MS);
    (this.flushTimer as any).unref?.();
  }

  record(input: {
    sql: string;
    kind?: QueryKind;
    durationMs?: number;
    rowsAffected?: number;
    ok: boolean;
    error?: string;
  }): QueryLogEntry {
    const kind = input.kind ?? classifySql(input.sql);
    const entry: QueryLogEntry = {
      id: randomUUID(),
      at: Date.now(),
      kind,
      sql: truncateSql(input.sql),
      durationMs: input.durationMs,
      rowsAffected: input.rowsAffected,
      ok: input.ok,
      error: input.error,
    };

    if (kind === "read") this.metrics.totalReads += 1;
    else if (kind === "write") this.metrics.totalWrites += 1;
    else this.metrics.totalOther += 1;

    this.entries.push(entry);
    let trimmed = false;
    if (this.entries.length > this.memoryLimit) {
      this.entries.splice(0, this.entries.length - this.memoryLimit);
      trimmed = true;
    }

    if (this.metricsFile) this.metricsDirty = true;

    if (this.logFile) {
      try {
        if (trimmed) {
          this.pendingLogLines = [];
          writeLogAtomic(this.logFile, this.entries);
          this.metricsDirty = false;
          if (this.metricsFile) writeMetricsAtomic(this.metricsFile, this.metrics);
        } else {
          this.pendingLogLines.push(`${JSON.stringify(entry)}\n`);
          if (this.pendingLogLines.length >= LOG_FLUSH_BATCH) {
            this.flush();
          } else {
            this.scheduleFlush();
          }
        }
      } catch {
        /* logging must not break queries */
      }
    } else if (this.metricsDirty && this.metricsFile) {
      this.scheduleFlush();
    }

    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }
}
