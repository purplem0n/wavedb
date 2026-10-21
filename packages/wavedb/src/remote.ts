// HTTP client: `connect("http://host:port")` returns a Database backed by a `wave serve` process.

import { Database, type Backend, type CommitInfo, type DbStats, type Isolation, type SchemaMap, type TxBackend } from "./db.ts";
import { WaveError, mapNativeError } from "./errors.ts";
import type { IR } from "./expr.ts";
import type { TableDefJson } from "./migrate.ts";
import type { Executor, RawResult } from "./query.ts";

export interface ConnectOptions<S extends SchemaMap> {
  schema?: S;
  token?: string;
  /** apply the schema on connect (default false for remote) */
  push?: boolean;
  fetch?: typeof fetch;
  /** Try URLs in order until one responds (failover). */
  urls?: string[];
}

class Http {
  constructor(
    readonly base: string,
    readonly token: string | undefined,
    readonly f: typeof fetch,
  ) {}
  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(this.base + path, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new WaveError(`cannot reach ${this.base}: ${(e as Error).message}`, "WAVE_NETWORK");
    }
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new WaveError(`bad response from server (${res.status})`, "WAVE_NETWORK");
    }
    if (!res.ok) {
      const e = data?.error;
      if (e?.code) throw mapNativeError(new Error(`${e.code}: ${e.message}`));
      throw new WaveError(e?.message ?? `HTTP ${res.status}`, "WAVE_NETWORK");
    }
    return data as T;
  }
}

class RemoteExecutor implements Executor {
  constructor(
    private readonly http: Http,
    private readonly tx?: string,
  ) {}
  run(stmt: IR): Promise<RawResult> {
    return this.http.call("POST", "/api/run", { stmt, tx: this.tx });
  }
  runSql(sql: string, params: unknown[]): Promise<RawResult> {
    return this.http.call("POST", "/api/run", { sql, params, tx: this.tx });
  }
}

class RemoteBackend implements Backend {
  readonly exec: Executor;
  constructor(private readonly http: Http) {
    this.exec = new RemoteExecutor(http);
  }
  async begin(isolation: Isolation): Promise<TxBackend> {
    const { id } = await this.http.call<{ id: string }>("POST", "/api/tx/begin", { isolation });
    const enc = encodeURIComponent(id);
    return {
      exec: new RemoteExecutor(this.http, id),
      commit: () => this.http.call<CommitInfo>("POST", `/api/tx/${enc}/commit`, {}),
      rollback: async () => {
        await this.http.call("POST", `/api/tx/${enc}/rollback`, {}).catch(() => {});
      },
    };
  }
  tables(): Promise<TableDefJson[]> {
    return this.http.call("GET", "/api/tables");
  }
  stats(): Promise<DbStats> {
    return this.http.call("GET", "/api/stats");
  }
  async vacuum(): Promise<number> {
    return (await this.http.call<{ removed: number }>("POST", "/api/vacuum", {})).removed;
  }
  async compact(): Promise<void> {
    await this.http.call("POST", "/api/compact", {});
  }
  close(): void {}
}

async function pickUrl(urls: string[], f: typeof fetch): Promise<string> {
  let last: Error | undefined;
  for (const u of urls) {
    const base = u.replace(/\/+$/, "");
    try {
      const res = await f(`${base}/api/health`);
      if (res.ok || res.status === 401) return base;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e as Error;
    }
  }
  throw new WaveError(`no reachable WaveDB server (${last?.message ?? "unknown"})`, "WAVE_NETWORK");
}

/** Connect to a WaveDB server started with `wave serve` / `serve(db)`. */
export async function connect<S extends SchemaMap = {}>(
  url: string,
  opts: ConnectOptions<S> = {},
): Promise<Database<S>> {
  const candidates = opts.urls?.length ? opts.urls : [url];
  const base = await pickUrl(candidates, opts.fetch ?? fetch);
  const http = new Http(base, opts.token, opts.fetch ?? fetch);
  const db = new Database<S>(new RemoteBackend(http), (opts.schema ?? {}) as S);
  await http.call("GET", "/api/ping");
  if (opts.push) await db.push();
  return db;
}
