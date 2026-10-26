// Query log + durable read/write counters for Studio Logs & Metrics.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

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
  /**
   * With `dataPath`: in-process ring buffer for live tail / `since` polling (default 512).
   * Without `dataPath`: max entries kept entirely in RAM (default 10_000).
   */
  memoryLimit?: number;
}

/** Hot ring when persisting to disk (Studio poll + unflushed tail). */
const DEFAULT_HOT_BUFFER = 512;
const MAX_HOT_BUFFER = 2_000;
/** Ephemeral in-memory-only log (no data path). */
const DEFAULT_EPHEMERAL_MEMORY = 10_000;
const MAX_EPHEMERAL_MEMORY = 10_000;
/** Max JSONL lines retained on disk. */
const DEFAULT_DISK_RETENTION = 10_000;
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

function parseLogLine(line: string): QueryLogEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const e = JSON.parse(trimmed) as unknown;
    return isQueryLogEntry(e) ? e : undefined;
  } catch {
    return undefined;
  }
}

function parseLogText(text: string): QueryLogEntry[] {
  const parsed: QueryLogEntry[] = [];
  for (const line of text.split("\n")) {
    const e = parseLogLine(line);
    if (e) parsed.push(e);
  }
  return parsed;
}

/** Read up to `maxLines` complete lines from the end of a file (no full-file string). */
function readLastLines(path: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const fd = openSync(path, "r");
  try {
    const { size } = statSync(path);
    if (size === 0) return [];
    const chunkSize = 64 * 1024;
    let position = size;
    let buffer = Buffer.alloc(0);
    const lines: string[] = [];
    while (position > 0 && lines.length < maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      readSync(fd, chunk, 0, readSize, position);
      buffer = Buffer.concat([chunk, buffer]);
      while (lines.length < maxLines) {
        const lastNl = buffer.lastIndexOf(0x0a);
        if (lastNl < 0) break;
        const lineBuf = buffer.subarray(lastNl + 1);
        buffer = buffer.subarray(0, lastNl);
        const line = lineBuf.toString("utf8").trim();
        if (line) lines.unshift(line);
      }
    }
    if (buffer.length > 0 && lines.length < maxLines) {
      const line = buffer.toString("utf8").trim();
      if (line) lines.unshift(line);
    }
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

function logFilePaths(logFile: string): string[] {
  return [`${logFile}.1`, logFile].filter((p) => existsSync(p));
}

/** Newest-last tail of persisted JSONL without loading the full file. */
function readLogTail(logFile: string, limit: number): QueryLogEntry[] {
  const paths = logFilePaths(logFile);
  if (paths.length === 0 || limit <= 0) return [];
  const entries: QueryLogEntry[] = [];
  for (const path of paths) {
    for (const line of readLastLines(path, limit)) {
      const e = parseLogLine(line);
      if (e) entries.push(e);
    }
  }
  entries.sort((a, b) => a.at - b.at);
  return entries.slice(-limit);
}

/** Scan JSONL in file order for `sinceId`; collect up to `limit` entries after it (chunked reads). */
function readLogSince(
  logFile: string,
  sinceId: string,
  limit: number,
): { found: false } | { found: true; sinceAt: number; after: QueryLogEntry[] } {
  const paths = logFilePaths(logFile);
  if (paths.length === 0) return { found: false };
  let matched = false;
  let sinceAt = 0;
  const after: QueryLogEntry[] = [];
  const bufSize = 256 * 1024;

  for (const path of paths) {
    const fd = openSync(path, "r");
    try {
      const { size } = statSync(path);
      let position = 0;
      let carry = "";
      const buf = Buffer.alloc(bufSize);
      const decoder = new StringDecoder("utf8");
      while (position < size) {
        const n = readSync(fd, buf, 0, Math.min(bufSize, size - position), position);
        position += n;
        const chunk = carry + decoder.write(buf.subarray(0, n));
        carry = "";
        const parts = chunk.split("\n");
        carry = parts.pop() ?? "";
        for (const line of parts) {
          const entry = parseLogLine(line);
          if (!entry) continue;
          if (!matched) {
            if (entry.id === sinceId) {
              matched = true;
              sinceAt = entry.at;
            }
            continue;
          }
          after.push(entry);
          if (after.length >= limit) return { found: true, sinceAt, after };
        }
      }
      carry += decoder.end();
      if (carry.trim()) {
        const entry = parseLogLine(carry);
        if (entry) {
          if (!matched && entry.id === sinceId) {
            matched = true;
            sinceAt = entry.at;
          } else if (matched) {
            after.push(entry);
            if (after.length >= limit) return { found: true, sinceAt, after };
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  if (!matched) return { found: false };
  return { found: true, sinceAt, after: after.slice(0, limit) };
}

/** Read persisted JSONL (and legacy `.1` rotation), sorted oldest-first. */
function readAllLogEntries(logFile: string): QueryLogEntry[] {
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
    parsed.push(...parseLogText(text));
  }
  parsed.sort((a, b) => a.at - b.at);
  return parsed;
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

/** Trim on-disk JSONL to the newest `retention` entries (read on `/api/query-log`, not at process start). */
function compactLogFileIfNeeded(logFile: string, retention: number): void {
  const all = readAllLogEntries(logFile);
  if (all.length <= retention) return;
  writeLogAtomic(logFile, all.slice(-retention));
}

function truncateSql(sql: string, max = 2000): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function mergeEntries(a: QueryLogEntry[], b: QueryLogEntry[]): QueryLogEntry[] {
  const byId = new Map<string, QueryLogEntry>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.at - y.at);
}

export class QueryLog {
  /** Hot ring (persisted logs also append to JSONL). */
  private hot: QueryLogEntry[] = [];
  private metrics: QueryMetrics;
  /** Max hot entries when `logFile` is set; else max in-memory entries. */
  private readonly hotLimit: number;
  private readonly diskRetention: number;
  private readonly metricsFile?: string;
  private readonly logFile?: string;
  private listeners = new Set<(entry: QueryLogEntry) => void>();
  private pendingLogLines: string[] = [];
  private metricsDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private appendsSinceCompact = 0;
  private readonly compactEvery: number;

  constructor(opts: QueryLogOptions = {}) {
    if (opts.dataPath) {
      const requested = opts.memoryLimit ?? DEFAULT_HOT_BUFFER;
      this.hotLimit = Math.max(1, Math.min(requested, MAX_HOT_BUFFER));
      this.diskRetention = DEFAULT_DISK_RETENTION;
      this.compactEvery = Math.max(1, Math.ceil(this.diskRetention / 10));
      const dir = waveDir(opts.dataPath);
      mkdirSync(dir, { recursive: true });
      this.metricsFile = metricsPath(opts.dataPath);
      this.logFile = logPath(opts.dataPath);
      this.metrics = readMetrics(this.metricsFile);
    } else {
      const requested = opts.memoryLimit ?? DEFAULT_EPHEMERAL_MEMORY;
      this.hotLimit = Math.max(1, Math.min(requested, MAX_EPHEMERAL_MEMORY));
      this.diskRetention = DEFAULT_DISK_RETENTION;
      this.compactEvery = Math.max(1, Math.ceil(this.hotLimit / 10));
      this.metrics = { totalReads: 0, totalWrites: 0, totalOther: 0 };
    }
  }

  getMetrics(): QueryMetrics {
    return { ...this.metrics };
  }

  recent(limit = 100, sinceId?: string): QueryLogEntry[] {
    const cap = Math.max(1, Math.min(limit, this.logFile ? DEFAULT_DISK_RETENTION : this.hotLimit));

    if (!this.logFile) {
      if (sinceId) {
        const idx = this.hot.findIndex((e) => e.id === sinceId);
        if (idx >= 0) return this.hot.slice(idx + 1, idx + 1 + cap);
      }
      return this.hot.slice(-cap);
    }

    if (sinceId) {
      const hotIdx = this.hot.findIndex((e) => e.id === sinceId);
      if (hotIdx >= 0) return this.hot.slice(hotIdx + 1, hotIdx + 1 + cap);

      this.flush();
      const diskSince = readLogSince(this.logFile, sinceId, cap);
      if (diskSince.found) {
        const newerHot = this.hot.filter((e) => e.at > diskSince.sinceAt);
        return mergeEntries(diskSince.after, newerHot).slice(0, cap);
      }
    }

    const diskTail = existsSync(this.logFile) ? readLogTail(this.logFile, cap) : [];
    return mergeEntries(diskTail, this.hot).slice(-cap);
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

  private pushHot(entry: QueryLogEntry): void {
    this.hot.push(entry);
    if (this.hot.length > this.hotLimit) {
      this.hot.splice(0, this.hot.length - this.hotLimit);
    }
  }

  private maybeCompactDisk(): void {
    if (!this.logFile) return;
    this.appendsSinceCompact += 1;
    if (this.appendsSinceCompact < this.compactEvery) return;
    this.flush();
    try {
      compactLogFileIfNeeded(this.logFile, this.diskRetention);
    } catch {
      /* compaction must not break queries */
    } finally {
      this.appendsSinceCompact = 0;
    }
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

    this.pushHot(entry);

    if (this.metricsFile) this.metricsDirty = true;

    if (this.logFile) {
      try {
        this.pendingLogLines.push(`${JSON.stringify(entry)}\n`);
        if (this.pendingLogLines.length >= LOG_FLUSH_BATCH) {
          this.flush();
        } else {
          this.scheduleFlush();
        }
        this.maybeCompactDisk();
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
