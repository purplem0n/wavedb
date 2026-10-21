// Database / Transaction objects built on a pluggable Backend (native addon or HTTP).

import { ClosedError, ConflictError, WaveError, mapNativeError } from "./errors.ts";
import {
  Condition,
  Expression,
  and,
  count,
  decodeValue,
  encodeValue,
  inArray,
  type IR,
  type OrderSpec,
} from "./expr.ts";
import { diffSchema, type SchemaOp, type TableDefJson } from "./migrate.ts";
import { rebuildTable } from "./rebuild.ts";
import {
  DeleteBuilder,
  InsertBuilder,
  SelectBuilder,
  UpdateBuilder,
  whereFromObject,
  type ExecResult,
  type Executor,
  type FieldMap,
  type RawResult,
  type WhereInput,
} from "./query.ts";
import { loadNative, type NativeDb, type NativeTx } from "./native.ts";
import { tableAlias, tableMeta, type AnyTable, type InferSelect } from "./schema.ts";
import { SqlFragment, compileSql } from "./sql.ts";

export type SchemaMap = Record<string, AnyTable>;
export type Isolation = "snapshot" | "serializable";
export type Durability = "sync" | "async";

export interface CommitInfo {
  commitTs: number;
  keysWritten: number;
}

export interface DbStats {
  visibleTs: number;
  commits: number;
  conflicts: number;
  rollbacks: number;
  fsyncs: number;
  activeTxns: number;
  trackedWrites: number;
  diskBytes: number;
}

export interface TxBackend {
  exec: Executor;
  commit(): Promise<CommitInfo>;
  rollback(): Promise<void> | void;
}

export interface Backend {
  exec: Executor;
  begin(isolation: Isolation): Promise<TxBackend> | TxBackend;
  tables(): Promise<TableDefJson[]>;
  stats(): Promise<DbStats>;
  vacuum(): Promise<number>;
  compact(): Promise<void>;
  close(): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// native backend
// ---------------------------------------------------------------------------

class NativeExecutor implements Executor {
  constructor(private readonly target: Pick<NativeDb, "execute" | "executeSql">) {}
  async run(stmt: IR): Promise<RawResult> {
    try {
      return JSON.parse(await this.target.execute(JSON.stringify(stmt)));
    } catch (e) {
      throw mapNativeError(e);
    }
  }
  async runSql(sql: string, params: unknown[]): Promise<RawResult> {
    try {
      return JSON.parse(await this.target.executeSql(sql, JSON.stringify(params)));
    } catch (e) {
      throw mapNativeError(e);
    }
  }
}

export class NativeBackend implements Backend {
  readonly exec: Executor;
  constructor(readonly native: NativeDb) {
    this.exec = new NativeExecutor(native);
  }
  begin(isolation: Isolation): TxBackend {
    const tx: NativeTx = (() => {
      try {
        return this.native.begin(isolation);
      } catch (e) {
        throw mapNativeError(e);
      }
    })();
    return {
      exec: new NativeExecutor(tx),
      commit: async () => {
        try {
          return JSON.parse(await tx.commit());
        } catch (e) {
          throw mapNativeError(e);
        }
      },
      rollback: () => tx.rollback(),
    };
  }
  async tables(): Promise<TableDefJson[]> {
    try {
      return JSON.parse(this.native.tables());
    } catch (e) {
      throw mapNativeError(e);
    }
  }
  async stats(): Promise<DbStats> {
    try {
      return JSON.parse(this.native.stats());
    } catch (e) {
      throw mapNativeError(e);
    }
  }
  async vacuum(): Promise<number> {
    return Number(await this.native.vacuum());
  }
  async compact(): Promise<void> {
    await this.native.compact();
  }
  close(): void {
    this.native.close();
  }
}

// ---------------------------------------------------------------------------
// querier (shared by Database and Tx)
// ---------------------------------------------------------------------------

export type SqlResult<T = Record<string, any>> = T[] & {
  columns: string[];
  rowsAffected: number;
  lastInsertId: number | string | null;
};

function toSqlResult<T>(r: RawResult): SqlResult<T> {
  const rows = r.rows.map((row) => {
    const o: Record<string, unknown> = {};
    r.columns.forEach((c, i) => {
      o[c] = decodeValue(undefined, row[i]);
    });
    return o as T;
  }) as SqlResult<T>;
  rows.columns = r.columns;
  rows.rowsAffected = r.rowsAffected;
  rows.lastInsertId = (r.lastInsertId as number | string | null | undefined) ?? null;
  return rows;
}

export type OrderInput = OrderSpec | Expression<any>;

export interface RelationOptions {
  where?: Record<string, any> | Condition;
  orderBy?: any;
  /** per-parent limit for to-many relations */
  limit?: number;
  with?: Record<string, true | RelationOptions>;
}

export interface FindOptions<T extends AnyTable> {
  where?: WhereInput<T> | Condition;
  orderBy?: OrderInput | OrderInput[] | { [K in keyof InferSelect<T>]?: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /** Load related rows (matched through `.references()`), keyed by schema key. */
  with?: Record<string, true | RelationOptions>;
}

function isOrderSpec(o: unknown): o is OrderSpec {
  return typeof o === "object" && o !== null && "expr" in o && "desc" in o && (o as any).expr instanceof Expression;
}

function toOrderList(table: AnyTable, o: unknown): OrderInput[] {
  if (o === undefined || o === null) return [];
  if (Array.isArray(o)) return o.flatMap((x) => toOrderList(table, x));
  if (o instanceof Expression || isOrderSpec(o)) return [o as OrderInput];
  const m = tableMeta(table);
  const a = tableAlias(table);
  const out: OrderInput[] = [];
  for (const [k, dir] of Object.entries(o as Record<string, string>)) {
    const c = (table as any)[k];
    if (!c || !m.columns.some((x) => x.key === k)) throw new Error(`unknown column "${k}" in orderBy for "${a}"`);
    out.push({ expr: c, desc: String(dir).toLowerCase() === "desc" });
  }
  return out;
}

function toCondition(table: AnyTable, w: unknown): Condition | undefined {
  if (!w) return undefined;
  if (w instanceof Condition) return w;
  return whereFromObject(table, w as Record<string, any>);
}

export class TableQuery<T extends AnyTable> {
  constructor(
    private readonly q: Querier<any>,
    private readonly table: T,
  ) {}

  private async run(opts: FindOptions<T> | RelationOptions): Promise<InferSelect<T>[]> {
    let sel: any = this.q.select().from(this.table);
    const cond = toCondition(this.table, opts.where);
    if (cond) sel = sel.where(cond);
    const order = toOrderList(this.table, opts.orderBy);
    if (order.length) sel = sel.orderBy(...order);
    const o = opts as FindOptions<T>;
    if (o.limit !== undefined) sel = sel.limit(o.limit);
    if (o.offset !== undefined) sel = sel.offset(o.offset);
    const rows: any[] = await sel;
    if (opts.with) await loadRelations(this.q, this.table, rows, opts.with);
    return rows;
  }

  findMany<O extends FindOptions<T>>(
    opts: O = {} as O,
  ): Promise<(InferSelect<T> & (O["with"] extends object ? { [K in keyof O["with"]]: any } : {}))[]> {
    return this.run(opts) as any;
  }

  async findFirst<O extends FindOptions<T>>(
    opts: O = {} as O,
  ): Promise<(InferSelect<T> & (O["with"] extends object ? { [K in keyof O["with"]]: any } : {})) | undefined> {
    return (await this.run({ ...opts, limit: 1 }))[0] as any;
  }

  async count(where?: WhereInput<T> | Condition): Promise<number> {
    const cond = toCondition(this.table, where);
    let sel: any = this.q.select({ n: count() }).from(this.table);
    if (cond) sel = sel.where(cond);
    const rows: { n: number }[] = await sel;
    return rows[0]?.n ?? 0;
  }
}

async function loadRelations(
  q: Querier<any>,
  parent: AnyTable,
  rows: any[],
  spec: Record<string, true | RelationOptions>,
): Promise<void> {
  const pm = tableMeta(parent);
  for (const [key, s] of Object.entries(spec)) {
    const rel = q.schema[key];
    if (!rel) throw new Error(`unknown relation "${key}": no table with that key in the schema`);
    const opts: RelationOptions = s === true ? {} : s;
    const rm = tableMeta(rel);
    const manyCol = rm.columns.find((c) => c.config.references?.().table === pm.name);
    const oneCol = pm.columns.find((c) => c.config.references?.().table === rm.name);
    const tq = new TableQuery(q, rel);
    if (manyCol) {
      const target = manyCol.config.references!();
      const ids = [...new Set(rows.map((r) => r[target.key]).filter((v) => v !== null && v !== undefined))];
      const groups = new Map<unknown, any[]>();
      if (ids.length) {
        const where = and(toCondition(rel, opts.where), inArray((rel as any)[manyCol.key], ids));
        const related = await (tq as any).run({ where, orderBy: opts.orderBy, with: opts.with });
        for (const r of related) {
          const k = keyOf(r[manyCol.key]);
          let g = groups.get(k);
          if (!g) groups.set(k, (g = []));
          g.push(r);
        }
      }
      for (const r of rows) {
        const g = groups.get(keyOf(r[target.key])) ?? [];
        r[key] = opts.limit !== undefined ? g.slice(0, opts.limit) : g;
      }
    } else if (oneCol) {
      const target = oneCol.config.references!();
      const ids = [...new Set(rows.map((r) => r[oneCol.key]).filter((v) => v !== null && v !== undefined))];
      const map = new Map<unknown, any>();
      if (ids.length) {
        const where = and(toCondition(rel, opts.where), inArray((rel as any)[target.key], ids));
        const related = await (tq as any).run({ where, with: opts.with });
        for (const r of related) map.set(keyOf(r[target.key]), r);
      }
      for (const r of rows) r[key] = map.get(keyOf(r[oneCol.key])) ?? null;
    } else {
      throw new Error(`no foreign key (.references()) links "${pm.name}" and "${rm.name}"`);
    }
  }
}

function keyOf(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

export type QueryApi<S extends SchemaMap> = { [K in keyof S]: TableQuery<S[K]> };

export abstract class Querier<S extends SchemaMap = SchemaMap> {
  abstract readonly exec: Executor;
  constructor(readonly schema: S) {}

  select(): SelectBuilder<undefined, {}, false>;
  select<F extends FieldMap>(fields: F): SelectBuilder<F, {}, false>;
  select(fields?: FieldMap): any {
    return new SelectBuilder(this.exec, fields);
  }
  insert<T extends AnyTable>(table: T): InsertBuilder<T> {
    return new InsertBuilder(this.exec, table);
  }
  update<T extends AnyTable>(table: T): UpdateBuilder<T> {
    return new UpdateBuilder(this.exec, table);
  }
  delete<T extends AnyTable>(table: T): DeleteBuilder<T> {
    return new DeleteBuilder(this.exec, table);
  }

  /** Relational reads: `db.query.users.findMany({ where: { age: { gt: 18 } }, with: { posts: true } })`. */
  get query(): QueryApi<S> {
    const out: Record<string, TableQuery<AnyTable>> = {};
    for (const [k, t] of Object.entries(this.schema)) out[k] = new TableQuery(this, t);
    return out as QueryApi<S>;
  }

  /** Tagged-template SQL (values are bound as parameters): `await db.sql\`select * from users where id = ${id}\``. */
  sql<T = Record<string, any>>(strings: TemplateStringsArray | SqlFragment, ...values: unknown[]): Promise<SqlResult<T>> {
    const frag = strings instanceof SqlFragment ? strings : new SqlFragment(strings, values);
    const { text, params } = compileSql(frag);
    return this.exec.runSql(text, params).then((r) => toSqlResult<T>(r));
  }

  /** Execute SQL text with positional (`$1`, `?`) parameters. */
  execute<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<SqlResult<T>> {
    return this.exec.runSql(text, params.map(encodeValue)).then((r) => toSqlResult<T>(r));
  }
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export class Tx<S extends SchemaMap = SchemaMap> extends Querier<S> {
  readonly exec: Executor;
  private done = false;
  constructor(
    private readonly handle: TxBackend,
    schema: S,
  ) {
    super(schema);
    const inner = handle.exec;
    const guard = () => {
      if (this.done) throw new ClosedError("transaction already finished");
    };
    this.exec = {
      run: (s) => (guard(), inner.run(s)),
      runSql: (s, p) => (guard(), inner.runSql(s, p)),
    };
  }
  get finished(): boolean {
    return this.done;
  }
  async commit(): Promise<CommitInfo> {
    if (this.done) throw new ClosedError("transaction already finished");
    this.done = true;
    return this.handle.commit();
  }
  async rollback(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.handle.rollback();
  }
  /** Nested `tx()` joins the enclosing transaction. */
  tx<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

export interface TxOptions {
  isolation?: Isolation;
  /** total attempts when the transaction conflicts (default 8) */
  retries?: number;
  /** base back-off in ms (default 2; first retry immediate, then jittered exponential, capped at 50ms) */
  backoffMs?: number;
}

export interface MigrationDef<S extends SchemaMap = SchemaMap> {
  id: string;
  up(tx: Tx<S>): Promise<void>;
}

export interface PushOptions {
  /** allow dropping columns / unique indexes / (with dropMissingTables) tables */
  allowDestructive?: boolean;
  dropMissingTables?: boolean;
}

export class Database<S extends SchemaMap = SchemaMap> extends Querier<S> {
  readonly exec: Executor;
  private closed = false;
  constructor(
    readonly backend: Backend,
    schema: S,
  ) {
    super(schema);
    this.exec = backend.exec;
  }

  /** Start a manual transaction (remember to commit or rollback). */
  async begin(opts: { isolation?: Isolation } = {}): Promise<Tx<S>> {
    this.assertOpen();
    return new Tx(await this.backend.begin(opts.isolation ?? "snapshot"), this.schema);
  }

  /**
   * Run `fn` in a transaction, committing on success and rolling back on throw.
   * Conflicts (another transaction committed a clashing write first) are retried automatically,
   * so `fn` must be safe to re-run.
   */
  async tx<T>(fn: (tx: Tx<S>) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    this.assertOpen();
    const attempts = Math.max(1, opts.retries ?? 8);
    const base = opts.backoffMs ?? 2;
    for (let attempt = 1; ; attempt++) {
      const tx = await this.begin({ isolation: opts.isolation });
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback().catch(() => {});
        if (e instanceof ConflictError && attempt < attempts) {
          // A conflict means someone else just committed, so an immediate retry usually succeeds.
          // After that: jittered, gently growing back-off (capped so a loser is not starved).
          if (attempt === 1) await new Promise((r) => setImmediate(r));
          else await new Promise((r) => setTimeout(r, Math.random() * Math.min(50, base * 2 ** (attempt - 2))));
          continue;
        }
        throw e;
      }
    }
  }

  // --- schema management --------------------------------------------------

  tables(): Promise<TableDefJson[]> {
    return this.backend.tables();
  }

  /** Pending changes needed to make the database match the schema. */
  async diff(opts: Pick<PushOptions, "dropMissingTables"> = {}): Promise<SchemaOp[]> {
    return diffSchema(Object.values(this.schema), await this.backend.tables(), opts);
  }

  /**
   * Apply schema changes (create tables, add columns, create indexes) atomically.
   * Destructive changes need `allowDestructive: true`.
   */
  async push(opts: PushOptions = {}): Promise<SchemaOp[]> {
    const ops = await this.diff(opts);
    const blocked = ops.filter((o) => !o.applicable);
    if (blocked.length) {
      throw new WaveError(`schema cannot be applied automatically:\n  ${blocked.map((o) => o.description).join("\n  ")}`, "WAVE_INVALID");
    }
    const destructive = ops.filter((o) => o.destructive);
    if (destructive.length && !opts.allowDestructive) {
      throw new WaveError(
        `schema push would lose data (pass { allowDestructive: true }):\n  ${destructive.map((o) => o.description).join("\n  ")}`,
        "WAVE_INVALID",
      );
    }
    if (ops.length) {
      await this.tx(async (tx) => {
        for (const op of ops) {
          if (op.op === "rebuildTable") {
            if (!op.rebuild) throw new WaveError("internal: rebuildTable missing payload", "WAVE_INVALID");
            await rebuildTable(tx.exec, op.rebuild.table, op.rebuild.existing);
          } else {
            await tx.exec.run(op.statement!);
          }
        }
      });
    }
    return ops;
  }

  /** Run ordered migrations exactly once each; returns the ids applied by this call. */
  async migrate(migrations: MigrationDef<S>[]): Promise<string[]> {
    await this.exec.run({
      kind: "createTable",
      name: "_wave_migrations",
      columns: [
        { name: "id", type: "text", nullable: false, unique: false, primaryKey: true, autoIncrement: false },
        { name: "applied_at", type: "timestamp", nullable: false, unique: false, primaryKey: false, autoIncrement: false, default: { kind: "now" } },
      ],
      primaryKey: ["id"],
      indexes: [],
      ifNotExists: true,
    });
    const applied: string[] = [];
    for (const m of migrations) {
      await this.tx(async (tx) => {
        const done = await tx.execute("SELECT id FROM _wave_migrations WHERE id = $1", [m.id]);
        if (done.length) return;
        await m.up(tx);
        await tx.execute("INSERT INTO _wave_migrations (id) VALUES ($1)", [m.id]);
        applied.push(m.id);
      });
    }
    return applied;
  }

  // --- operations -----------------------------------------------------------

  stats(): Promise<DbStats> {
    return this.backend.stats();
  }
  /** Remove MVCC versions no active snapshot can read. Returns how many were dropped. */
  vacuum(): Promise<number> {
    return this.backend.vacuum();
  }
  compact(): Promise<void> {
    return this.backend.compact();
  }

  /**
   * Re-run `query` whenever data changes (polls the commit clock). Returns an unsubscribe function.
   */
  watch<T>(query: () => PromiseLike<T>, onChange: (value: T) => void, opts: { intervalMs?: number } = {}): () => void {
    let stopped = false;
    let last = -1;
    const interval = opts.intervalMs ?? 100;
    const tick = async () => {
      if (stopped) return;
      try {
        const s = await this.stats();
        if (s.visibleTs !== last) {
          last = s.visibleTs;
          const v = await query();
          if (!stopped) onChange(v);
        }
      } catch {
        /* closed or transient; try again */
      }
      if (!stopped) timer = setTimeout(tick, interval);
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.backend.close();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private assertOpen() {
    if (this.closed) throw new ClosedError("database is closed");
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export interface OpenOptions<S extends SchemaMap> {
  schema?: S;
  /** `sync` (default): fsync before commit returns. `async`: faster, may lose the last few ms on power loss. */
  durability?: Durability;
  /** block cache size in MiB */
  cacheMb?: number;
  /** delete data on close (tests) */
  temporary?: boolean;
  /** apply the schema on open (create tables / add columns / indexes). Default: true when a schema is given. */
  push?: boolean | PushOptions;
}

/** Open (or create) a database directory, e.g. `wave("./data.wave", { schema })`. */
export async function wave<S extends SchemaMap = {}>(path = "./data.wave", opts: OpenOptions<S> = {}): Promise<Database<S>> {
  const native = loadNative();
  let handle: NativeDb;
  try {
    handle = native.NativeDb.open(
      path,
      JSON.stringify({ durability: opts.durability, cacheMb: opts.cacheMb, temporary: opts.temporary }),
    );
  } catch (e) {
    throw mapNativeError(e);
  }
  const db = new Database<S>(new NativeBackend(handle), (opts.schema ?? {}) as S);
  const doPush = opts.push ?? Object.keys(db.schema).length > 0;
  if (doPush) {
    try {
      await db.push(typeof doPush === "object" ? doPush : {});
    } catch (e) {
      await db.close();
      throw e;
    }
  }
  return db;
}

export type { ExecResult };
