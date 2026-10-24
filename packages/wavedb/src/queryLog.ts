// Query log + durable read/write counters for Studio Logs & Metrics.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
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
  /** Max entries kept in memory (default 500). */
  memoryLimit?: number;
  /** Max JSONL log file size before rotation (default 4 MiB). */
  maxLogBytes?: number;
}

const DEFAULT_MEMORY = 500;
const DEFAULT_MAX_LOG = 4 * 1024 * 1024;

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

function rotateLogIfNeeded(path: string, maxBytes: number): void {
  if (!existsSync(path)) return;
  try {
    if (statSync(path).size <= maxBytes) return;
    const rotated = `${path}.1`;
    if (existsSync(rotated)) {
      try {
        unlinkSync(rotated);
      } catch {
        /* keep one generation */
      }
    }
    renameSync(path, rotated);
  } catch {
    /* ignore rotation errors */
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
  private readonly maxLogBytes: number;
  private readonly metricsFile?: string;
  private readonly logFile?: string;
  private listeners = new Set<(entry: QueryLogEntry) => void>();

  constructor(opts: QueryLogOptions = {}) {
    this.memoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY;
    this.maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG;
    if (opts.dataPath) {
      const dir = waveDir(opts.dataPath);
      mkdirSync(dir, { recursive: true });
      this.metricsFile = metricsPath(opts.dataPath);
      this.logFile = logPath(opts.dataPath);
      this.metrics = readMetrics(this.metricsFile);
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
    if (this.entries.length > this.memoryLimit) {
      this.entries.splice(0, this.entries.length - this.memoryLimit);
    }

    if (this.metricsFile) {
      try {
        writeMetricsAtomic(this.metricsFile, this.metrics);
      } catch {
        /* metrics must not break queries */
      }
    }
    if (this.logFile) {
      try {
        rotateLogIfNeeded(this.logFile, this.maxLogBytes);
        appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch {
        /* logging must not break queries */
      }
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
