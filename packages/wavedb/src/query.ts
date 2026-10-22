// Typed query builders: select / insert / update / delete.

import {
  ColumnExpression,
  Expression,
  Increment,
  decodeValue,
  encodeValue,
  toIR,
  and,
  eq,
  gt,
  gte,
  lt,
  lte,
  ne,
  inArray,
  notInArray,
  like,
  ilike,
  isNull,
  isNotNull,
  or,
  type Condition,
  type IR,
  type OrderSpec,
} from "./expr.ts";
import {
  tableAlias,
  tableMeta,
  type AnyTable,
  type ColumnKind,
  type InferInsert,
  type InferSelect,
  type InferUpdate,
  type Table,
} from "./schema.ts";

export interface RawResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertId?: unknown;
  /** Engine execution time (ms), from the native layer. */
  durationMs?: number;
}

export interface Executor {
  run(stmt: IR): Promise<RawResult>;
  runSql(sql: string, params: unknown[]): Promise<RawResult>;
}

export interface ExecResult {
  rowsAffected: number;
  lastInsertId: number | string | null;
}

export type FieldMap = { [k: string]: Expression<any> | FieldMap };
export type InferFields<F> = {
  [K in keyof F]: F[K] extends Expression<infer T> ? T : F[K] extends FieldMap ? InferFields<F[K]> : never;
};
type NameOf<T> = T extends { _name: infer N extends string } ? N : string;

type OrderInput = OrderSpec | Expression<any>;
const toOrder = (o: OrderInput): IR => {
  if (o instanceof Expression) return { expr: o.toIR(), desc: false };
  return { expr: o.expr.toIR(), desc: o.desc };
};

// ---------------------------------------------------------------------------
// result shaping
// ---------------------------------------------------------------------------

interface Slot {
  path: string[];
  kind?: ColumnKind;
  group?: string;
}

function assemble(rows: unknown[][], slots: Slot[], nullableGroups: Set<string>): any[] {
  return rows.map((row) => {
    const obj: any = {};
    const groupHasValue = new Map<string, boolean>();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      const v = decodeValue(s.kind, row[i]);
      let cur = obj;
      for (let p = 0; p < s.path.length - 1; p++) {
        cur = cur[s.path[p]!] ??= {};
      }
      cur[s.path[s.path.length - 1]!] = v;
      if (s.group && nullableGroups.has(s.group)) {
        groupHasValue.set(s.group, (groupHasValue.get(s.group) ?? false) || v !== null);
      }
    }
    for (const g of nullableGroups) {
      if (groupHasValue.get(g) === false) obj[g] = null;
    }
    return obj;
  });
}

function fieldItems(fields: FieldMap, prefix: string[], items: IR[], slots: Slot[]) {
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Expression) {
      items.push({ t: "expr", expr: v.toIR(), alias: [...prefix, k].join(".") });
      slots.push({ path: [...prefix, k], kind: v instanceof ColumnExpression ? v.kind : undefined });
    } else {
      fieldItems(v, [...prefix, k], items, slots);
    }
  }
}

function tableItems(t: AnyTable, nested: boolean, items: IR[], slots: Slot[]) {
  const m = tableMeta(t);
  const a = tableAlias(t);
  for (const c of m.columns) {
    items.push({ t: "expr", expr: { t: "col", table: a, name: c.name }, alias: `${a}.${c.key}` });
    slots.push({ path: nested ? [a, c.key] : [c.key], kind: c.config.kind, group: a });
  }
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

interface JoinState {
  kind: "inner" | "left";
  table: AnyTable;
  on: IR;
}

export class SelectBuilder<
  TFields extends FieldMap | undefined,
  TTables extends Record<string, unknown>,
  TJoined extends boolean,
> implements PromiseLike<
    (TFields extends FieldMap ? InferFields<TFields> : TJoined extends true ? TTables : TTables[keyof TTables])[]
  >
{
  declare readonly _row: TFields extends FieldMap
    ? InferFields<TFields>
    : TJoined extends true
      ? TTables
      : TTables[keyof TTables];

  private _from?: AnyTable;
  private _joins: JoinState[] = [];
  private _where?: Condition;
  private _group: IR[] = [];
  private _having?: Condition;
  private _order: IR[] = [];
  private _limit?: number;
  private _offset?: number;
  private _distinct = false;

  constructor(
    private readonly exec: Executor,
    private readonly fields?: FieldMap,
  ) {}

  from<T extends AnyTable>(t: T): SelectBuilder<TFields, { [K in NameOf<T>]: InferSelect<T> }, false> {
    this._from = t;
    return this as any;
  }
  innerJoin<T extends AnyTable>(t: T, on: Condition): SelectBuilder<TFields, TTables & { [K in NameOf<T>]: InferSelect<T> }, true> {
    this._joins.push({ kind: "inner", table: t, on: on.toIR() });
    return this as any;
  }
  leftJoin<T extends AnyTable>(t: T, on: Condition): SelectBuilder<TFields, TTables & { [K in NameOf<T>]: InferSelect<T> | null }, true> {
    this._joins.push({ kind: "left", table: t, on: on.toIR() });
    return this as any;
  }
  where(c: Condition | undefined): this {
    this._where = c;
    return this;
  }
  groupBy(...exprs: Expression<any>[]): this {
    this._group.push(...exprs.map((e) => e.toIR()));
    return this;
  }
  having(c: Condition | undefined): this {
    this._having = c;
    return this;
  }
  orderBy(...o: OrderInput[]): this {
    this._order.push(...o.map(toOrder));
    return this;
  }
  limit(n: number): this {
    this._limit = n;
    return this;
  }
  offset(n: number): this {
    this._offset = n;
    return this;
  }
  distinct(): this {
    this._distinct = true;
    return this;
  }

  toStatement(): { stmt: IR; slots: Slot[]; nullable: Set<string> } {
    const items: IR[] = [];
    const slots: Slot[] = [];
    const nullable = new Set<string>();
    const from = this._from;
    if (this.fields) {
      fieldItems(this.fields, [], items, slots);
    } else if (from) {
      const nested = this._joins.length > 0;
      tableItems(from, nested, items, slots);
      for (const j of this._joins) {
        tableItems(j.table, true, items, slots);
        if (j.kind === "left") nullable.add(tableAlias(j.table));
      }
    }
    const ref = (t: AnyTable): IR => {
      const m = tableMeta(t);
      const a = tableAlias(t);
      return a === m.name ? { name: m.name } : { name: m.name, alias: a };
    };
    const stmt: IR = {
      kind: "select",
      columns: items,
      ...(from ? { from: ref(from) } : {}),
      joins: this._joins.map((j) => ({ kind: j.kind, table: ref(j.table), on: j.on })),
      ...(this._where ? { where: this._where.toIR() } : {}),
      groupBy: this._group,
      ...(this._having ? { having: this._having.toIR() } : {}),
      orderBy: this._order,
      ...(this._limit !== undefined ? { limit: this._limit } : {}),
      ...(this._offset !== undefined ? { offset: this._offset } : {}),
      distinct: this._distinct,
    };
    return { stmt, slots, nullable };
  }

  async execute(): Promise<this["_row"][]> {
    const { stmt, slots, nullable } = this.toStatement();
    const res = await this.exec.run(stmt);
    return assemble(res.rows, slots, nullable);
  }

  /** First row or `undefined`. */
  async first(): Promise<this["_row"] | undefined> {
    this._limit = 1;
    return (await this.execute())[0];
  }

  /** Query plan (which index / scan each table uses). */
  async explain(): Promise<string[]> {
    const { stmt } = this.toStatement();
    const res = await this.exec.run({ kind: "explain", stmt });
    return res.rows.map((r) => String(r[0]));
  }

  then<R1 = this["_row"][], R2 = never>(
    onfulfilled?: ((value: this["_row"][]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

const DEFAULT_IR: IR = { t: "func", name: "default", args: [], distinct: false, star: false };

function returningItems(table: AnyTable, fields?: FieldMap): { items: IR[]; slots: Slot[] } {
  const items: IR[] = [];
  const slots: Slot[] = [];
  if (fields) {
    fieldItems(fields, [], items, slots);
  } else {
    const m = tableMeta(table);
    for (const c of m.columns) {
      items.push({ t: "expr", expr: { t: "col", table: m.name, name: c.name }, alias: c.key });
      slots.push({ path: [c.key], kind: c.config.kind });
    }
  }
  return { items, slots };
}

function execResult(r: RawResult): ExecResult {
  return { rowsAffected: r.rowsAffected, lastInsertId: (r.lastInsertId as number | string | null | undefined) ?? null };
}

export class InsertBuilder<T extends AnyTable, R = ExecResult> implements PromiseLike<R> {
  private _rows: Record<string, unknown>[] = [];
  private _conflict?: IR;
  private _returning?: { items: IR[]; slots: Slot[] };

  constructor(
    private readonly exec: Executor,
    private readonly table: T,
  ) {}

  values(v: InferInsert<T> | InferInsert<T>[]): this {
    this._rows.push(...(Array.isArray(v) ? v : [v]).map((r) => r as Record<string, unknown>));
    return this;
  }

  onConflictDoNothing(opts?: { target?: ColumnExpression<any, any> | ColumnExpression<any, any>[] }): this {
    const target = opts?.target ? [opts.target].flat().map((c) => c.name) : [];
    this._conflict = { target, kind: "doNothing" };
    return this;
  }

  onConflictDoUpdate(opts: {
    target?: ColumnExpression<any, any> | ColumnExpression<any, any>[];
    set: InferUpdate<T>;
  }): this {
    const target = opts.target ? [opts.target].flat().map((c) => c.name) : [];
    this._conflict = { target, kind: "doUpdate", set: assignments(this.table, opts.set as Record<string, unknown>) };
    return this;
  }

  returning(): InsertBuilder<T, InferSelect<T>[]>;
  returning<F extends FieldMap>(fields: F): InsertBuilder<T, InferFields<F>[]>;
  returning(fields?: FieldMap): any {
    this._returning = returningItems(this.table, fields);
    return this;
  }

  toStatement(): IR {
    const m = tableMeta(this.table);
    const byKey = new Map(m.columns.map((c) => [c.key, c]));
    const keys: string[] = [];
    for (const r of this._rows) {
      for (const [k, v] of Object.entries(r)) {
        if (v === undefined) continue;
        if (!byKey.has(k)) throw new Error(`unknown column "${k}" for table "${m.name}"`);
        if (!keys.includes(k)) keys.push(k);
      }
    }
    if (this._rows.length === 0) throw new Error("insert().values() requires at least one row");
    const rows = this._rows.map((r) =>
      keys.map((k) => (r[k] === undefined ? DEFAULT_IR : { t: "lit", v: encodeValue(r[k]) })),
    );
    const noKeys = keys.length === 0;
    return {
      kind: "insert",
      table: m.name,
      columns: noKeys ? [m.columns[0]!.name] : keys.map((k) => byKey.get(k)!.name),
      rows: noKeys ? this._rows.map(() => [DEFAULT_IR]) : rows,
      ...(this._conflict ? { onConflict: this._conflict } : {}),
      ...(this._returning ? { returning: this._returning.items } : {}),
    };
  }

  async execute(): Promise<R> {
    const res = await this.exec.run(this.toStatement());
    if (this._returning) return assemble(res.rows, this._returning.slots, new Set()) as R;
    return execResult(res) as R;
  }

  then<R1 = R, R2 = never>(
    onfulfilled?: ((value: R) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

function assignments(table: AnyTable, set: Record<string, unknown>): IR[] {
  const m = tableMeta(table);
  const byKey = new Map(m.columns.map((c) => [c.key, c]));
  const out: IR[] = [];
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    const c = byKey.get(k);
    if (!c) throw new Error(`unknown column "${k}" for table "${m.name}"`);
    let expr: IR;
    if (v instanceof Increment) {
      expr = {
        t: "bin",
        op: "+",
        l: { t: "col", table: m.name, name: c.name },
        r: { t: "lit", v: v.by },
      };
    } else {
      expr = toIR(v);
    }
    out.push({ column: c.name, expr });
  }
  return out;
}

// ---------------------------------------------------------------------------
// UPDATE / DELETE
// ---------------------------------------------------------------------------

export class UpdateBuilder<T extends AnyTable, R = ExecResult> implements PromiseLike<R> {
  private _set: IR[] = [];
  private _where?: Condition;
  private _returning?: { items: IR[]; slots: Slot[] };

  constructor(
    private readonly exec: Executor,
    private readonly table: T,
  ) {}

  set(values: InferUpdate<T>): this {
    this._set.push(...assignments(this.table, values as Record<string, unknown>));
    return this;
  }
  where(c: Condition | undefined): this {
    this._where = c;
    return this;
  }
  returning(): UpdateBuilder<T, InferSelect<T>[]>;
  returning<F extends FieldMap>(fields: F): UpdateBuilder<T, InferFields<F>[]>;
  returning(fields?: FieldMap): any {
    this._returning = returningItems(this.table, fields);
    return this;
  }
  toStatement(): IR {
    if (this._set.length === 0) throw new Error("update().set() requires at least one column");
    return {
      kind: "update",
      table: tableMeta(this.table).name,
      set: this._set,
      ...(this._where ? { where: this._where.toIR() } : {}),
      ...(this._returning ? { returning: this._returning.items } : {}),
    };
  }
  async execute(): Promise<R> {
    const res = await this.exec.run(this.toStatement());
    if (this._returning) return assemble(res.rows, this._returning.slots, new Set()) as R;
    return execResult(res) as R;
  }
  then<R1 = R, R2 = never>(
    onfulfilled?: ((value: R) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export class DeleteBuilder<T extends AnyTable, R = ExecResult> implements PromiseLike<R> {
  private _where?: Condition;
  private _returning?: { items: IR[]; slots: Slot[] };

  constructor(
    private readonly exec: Executor,
    private readonly table: T,
  ) {}

  where(c: Condition | undefined): this {
    this._where = c;
    return this;
  }
  returning(): DeleteBuilder<T, InferSelect<T>[]>;
  returning<F extends FieldMap>(fields: F): DeleteBuilder<T, InferFields<F>[]>;
  returning(fields?: FieldMap): any {
    this._returning = returningItems(this.table, fields);
    return this;
  }
  toStatement(): IR {
    return {
      kind: "delete",
      table: tableMeta(this.table).name,
      ...(this._where ? { where: this._where.toIR() } : {}),
      ...(this._returning ? { returning: this._returning.items } : {}),
    };
  }
  async execute(): Promise<R> {
    const res = await this.exec.run(this.toStatement());
    if (this._returning) return assemble(res.rows, this._returning.slots, new Set()) as R;
    return execResult(res) as R;
  }
  then<R1 = R, R2 = never>(
    onfulfilled?: ((value: R) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// object-style filters (used by db.query.<table>.findMany)
// ---------------------------------------------------------------------------

export type FilterOps<V> = {
  eq?: V | null;
  ne?: V | null;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  in?: V[];
  notIn?: V[];
  like?: string;
  ilike?: string;
  isNull?: boolean;
};

export type WhereInput<T extends AnyTable> = T extends Table<any, infer C>
  ? {
      [K in keyof C]?: C[K]["_type"] | null | FilterOps<C[K]["_type"]>;
    } & { OR?: WhereInput<T>[]; AND?: WhereInput<T>[] }
  : never;

const OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn", "like", "ilike", "isNull"]);

function isOpsObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v) || v instanceof Date || v instanceof Uint8Array) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => OPS.has(k));
}

export function whereFromObject(table: AnyTable, w: Record<string, any> | undefined): Condition | undefined {
  if (!w) return undefined;
  const m = tableMeta(table);
  const a = tableAlias(table);
  const conds: (Condition | undefined)[] = [];
  for (const [k, v] of Object.entries(w)) {
    if (v === undefined) continue;
    if (k === "OR") {
      conds.push(or(...(v as any[]).map((x) => whereFromObject(table, x))));
      continue;
    }
    if (k === "AND") {
      conds.push(and(...(v as any[]).map((x) => whereFromObject(table, x))));
      continue;
    }
    const c = m.columns.find((c) => c.key === k);
    if (!c) throw new Error(`unknown column "${k}" in where for table "${m.name}"`);
    const ce = new ColumnExpression<any, false>(a, c.name, c.config.kind, c.config.notNull, c.key);
    if (v === null) {
      conds.push(isNull(ce));
    } else if (isOpsObject(v)) {
      for (const [op, val] of Object.entries(v)) {
        if (val === undefined) continue;
        switch (op) {
          case "eq":
            conds.push(val === null ? isNull(ce) : eq(ce, val));
            break;
          case "ne":
            conds.push(val === null ? isNotNull(ce) : ne(ce, val));
            break;
          case "gt":
            conds.push(gt(ce, val));
            break;
          case "gte":
            conds.push(gte(ce, val));
            break;
          case "lt":
            conds.push(lt(ce, val));
            break;
          case "lte":
            conds.push(lte(ce, val));
            break;
          case "in":
            conds.push(inArray(ce, val as any[]));
            break;
          case "notIn":
            conds.push(notInArray(ce, val as any[]));
            break;
          case "like":
            conds.push(like(ce, val as string));
            break;
          case "ilike":
            conds.push(ilike(ce, val as string));
            break;
          case "isNull":
            conds.push(val ? isNull(ce) : isNotNull(ce));
            break;
        }
      }
    } else {
      conds.push(eq(ce, v));
    }
  }
  return and(...conds);
}
