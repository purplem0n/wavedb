// Executor/backend wrappers — kept separate from queryLog.ts to avoid db ↔ queryLog cycles.

import { mapNativeError } from "./errors.ts";
import type { Backend, TxBackend } from "./db.ts";
import { formatIrForLog } from "./irToSql.ts";
import { QueryLog, classifyStmt } from "./queryLog.ts";
import type { Executor, RawResult } from "./query.ts";

function logSqlFromStmt(stmt: unknown): string {
  try {
    return formatIrForLog(stmt);
  } catch {
    return "/* unformattable statement */";
  }
}

function briefIrForLog(stmt: Record<string, unknown>): string {
  const kind = typeof stmt.kind === "string" ? stmt.kind.toLowerCase() : "stmt";
  if (kind === "select" || kind === "explain") {
    const from = stmt.from;
    const table =
      typeof from === "object" && from !== null && "name" in from && typeof (from as { name: unknown }).name === "string"
        ? (from as { name: string }).name
        : "?";
    return `${kind === "select" ? "SELECT" : "EXPLAIN"} … FROM ${table}`;
  }
  if (kind === "insert" || kind === "update" || kind === "delete") {
    const table = typeof stmt.table === "string" ? stmt.table : "?";
    return `${kind.toUpperCase()} ${table}`;
  }
  return kind.toUpperCase();
}

/** Wrap an executor so every `run` / `runSql` is recorded (in-process + HTTP share one log). */
export function wrapExecutorWithQueryLog(inner: Executor, queryLog: QueryLog): Executor {
  return {
    async run(stmt): Promise<RawResult> {
      const logSql = logSqlFromStmt(stmt);
      const logKind =
        typeof stmt === "object" && stmt !== null ? classifyStmt(stmt as Record<string, unknown>) : undefined;
      const hotSql =
        typeof stmt === "object" && stmt !== null ? briefIrForLog(stmt as Record<string, unknown>) : logSql;
      try {
        const r = await inner.run(stmt);
        queryLog.record({
          sql: logSql,
          hotSql,
          kind: logKind,
          durationMs: r.durationMs,
          rowsAffected: r.rowsAffected,
          ok: true,
        });
        return r;
      } catch (e) {
        const err = mapNativeError(e);
        queryLog.record({ sql: logSql, hotSql, kind: logKind, ok: false, error: err.message });
        throw e;
      }
    },
    async runSql(sql: string, params: unknown[]): Promise<RawResult> {
      try {
        const r = await inner.runSql(sql, params);
        queryLog.record({
          sql,
          durationMs: r.durationMs,
          rowsAffected: r.rowsAffected,
          ok: true,
        });
        return r;
      } catch (e) {
        const err = mapNativeError(e);
        queryLog.record({ sql, ok: false, error: err.message });
        throw e;
      }
    },
  };
}

function wrapTxBackendWithQueryLog(tx: TxBackend, queryLog: QueryLog): TxBackend {
  return {
    exec: wrapExecutorWithQueryLog(tx.exec, queryLog),
    commit: () => tx.commit(),
    rollback: () => tx.rollback(),
  };
}

/** Wrap a backend (including per-transaction executors). */
export function wrapBackendWithQueryLog(backend: Backend, queryLog: QueryLog): Backend {
  return {
    exec: wrapExecutorWithQueryLog(backend.exec, queryLog),
    begin: async (isolation) => {
      const tx = await backend.begin(isolation);
      return wrapTxBackendWithQueryLog(tx, queryLog);
    },
    tables: () => backend.tables(),
    stats: () => backend.stats(),
    vacuum: () => backend.vacuum(),
    compact: () => backend.compact(),
    close: () => backend.close(),
  };
}
