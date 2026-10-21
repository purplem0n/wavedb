// Expression tree for the query builder. Compiles to the JSON IR understood by the Rust core.

import type { ColumnKind } from "./schema.ts";

export type IR = Record<string, unknown>;

export abstract class Expression<T = unknown> {
  declare readonly _t: T;
  abstract toIR(): IR;
}

export class ColumnExpression<T, NN extends boolean = false> extends Expression<NN extends true ? T : T | null> {
  declare readonly _nn: NN;
  constructor(
    readonly table: string,
    /** database column name */
    readonly name: string,
    readonly kind: ColumnKind,
    readonly notNull: boolean,
    /** JS object key */
    readonly key: string,
  ) {
    super();
  }
  toIR(): IR {
    return { t: "col", table: this.table, name: this.name };
  }
}

class RawIR<T> extends Expression<T> {
  constructor(private readonly ir: IR) {
    super();
  }
  toIR(): IR {
    return this.ir;
  }
}

export class Condition extends RawIR<boolean> {}

// ---------------------------------------------------------------------------
// value encoding
// ---------------------------------------------------------------------------

const JS_SAFE_INT_MAX = 9007199254740991n;
const JS_SAFE_INT_MIN = -9007199254740991n;

export function encodeValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "bigint") {
    if (v >= JS_SAFE_INT_MIN && v <= JS_SAFE_INT_MAX) return Number(v);
    return { $int: v.toString() };
  }
  if (v instanceof Uint8Array) return { $blob: Buffer.from(v).toString("base64") };
  return v;
}

export function decodeValue(kind: ColumnKind | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (kind === "timestamp" && typeof v === "number") return new Date(v);
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (kind !== "json" && typeof o.$blob === "string" && Object.keys(o).length === 1) {
      return new Uint8Array(Buffer.from(o.$blob, "base64"));
    }
    if (typeof o.$int === "string" && Object.keys(o).length === 1) {
      return BigInt(o.$int);
    }
  }
  if (kind === "int" && typeof v === "number" && Number.isInteger(v)) {
    if (v > Number.MAX_SAFE_INTEGER || v < Number.MIN_SAFE_INTEGER) return BigInt(String(v));
  }
  return v;
}

export type Operand<T = unknown> = T | Expression<T>;

export function toIR(x: unknown): IR {
  return x instanceof Expression ? x.toIR() : { t: "lit", v: encodeValue(x) };
}

// ---------------------------------------------------------------------------
// operators
// ---------------------------------------------------------------------------

const bin = (op: string, l: unknown, r: unknown) => new Condition({ t: "bin", op, l: toIR(l), r: toIR(r) });

type Cmp<T> = Expression<T> | Expression<T | null> | Expression<any>;

export const eq = <T>(l: Cmp<T>, r: Operand<T | null> | Expression<any>) => bin("=", l, r);
export const ne = <T>(l: Cmp<T>, r: Operand<T | null> | Expression<any>) => bin("!=", l, r);
export const gt = <T>(l: Cmp<T>, r: Operand<T> | Expression<any>) => bin(">", l, r);
export const gte = <T>(l: Cmp<T>, r: Operand<T> | Expression<any>) => bin(">=", l, r);
export const lt = <T>(l: Cmp<T>, r: Operand<T> | Expression<any>) => bin("<", l, r);
export const lte = <T>(l: Cmp<T>, r: Operand<T> | Expression<any>) => bin("<=", l, r);

export const like = (l: Expression<any>, pattern: string | Expression<string>) =>
  new Condition({ t: "like", e: l.toIR(), pattern: toIR(pattern), negated: false, ci: false });
export const ilike = (l: Expression<any>, pattern: string | Expression<string>) =>
  new Condition({ t: "like", e: l.toIR(), pattern: toIR(pattern), negated: false, ci: true });
export const notLike = (l: Expression<any>, pattern: string | Expression<string>) =>
  new Condition({ t: "like", e: l.toIR(), pattern: toIR(pattern), negated: true, ci: false });

export const between = <T>(l: Cmp<T>, lo: Operand<T>, hi: Operand<T>) =>
  new Condition({ t: "between", e: l.toIR(), lo: toIR(lo), hi: toIR(hi), negated: false });
export const notBetween = <T>(l: Cmp<T>, lo: Operand<T>, hi: Operand<T>) =>
  new Condition({ t: "between", e: l.toIR(), lo: toIR(lo), hi: toIR(hi), negated: true });

export const inArray = <T>(l: Cmp<T>, list: readonly Operand<T>[]) =>
  list.length === 0
    ? new Condition({ t: "lit", v: false })
    : new Condition({ t: "in", e: l.toIR(), list: list.map(toIR), negated: false });
export const notInArray = <T>(l: Cmp<T>, list: readonly Operand<T>[]) =>
  list.length === 0
    ? new Condition({ t: "lit", v: true })
    : new Condition({ t: "in", e: l.toIR(), list: list.map(toIR), negated: true });

export const isNull = (e: Expression<any>) => new Condition({ t: "isNull", e: e.toIR(), negated: false });
export const isNotNull = (e: Expression<any>) => new Condition({ t: "isNull", e: e.toIR(), negated: true });

type MaybeCond = Condition | undefined | null | false;

export function and(...conds: MaybeCond[]): Condition | undefined {
  const cs = conds.filter((c): c is Condition => !!c);
  if (cs.length === 0) return undefined;
  return cs.reduce((a, b) => new Condition({ t: "bin", op: "and", l: a.toIR(), r: b.toIR() }));
}
export function or(...conds: MaybeCond[]): Condition | undefined {
  const cs = conds.filter((c): c is Condition => !!c);
  if (cs.length === 0) return undefined;
  return cs.reduce((a, b) => new Condition({ t: "bin", op: "or", l: a.toIR(), r: b.toIR() }));
}
export const not = (c: Condition) => new Condition({ t: "not", e: c.toIR() });

// ---------------------------------------------------------------------------
// functions & aggregates
// ---------------------------------------------------------------------------

export function fn<T = unknown>(name: string, ...args: unknown[]): Expression<T> {
  return new RawIR<T>({ t: "func", name, args: args.map(toIR), distinct: false, star: false });
}
export const count = (e?: Expression<any>): Expression<number> =>
  new RawIR<number>({ t: "func", name: "count", args: e ? [e.toIR()] : [], distinct: false, star: !e });
export const countDistinct = (e: Expression<any>): Expression<number> =>
  new RawIR<number>({ t: "func", name: "count", args: [e.toIR()], distinct: true, star: false });
export const sum = (e: Expression<any>): Expression<number | null> => fn("sum", e);
export const avg = (e: Expression<any>): Expression<number | null> => fn("avg", e);
export const min = <T>(e: Expression<T>): Expression<T | null> => fn("min", e);
export const max = <T>(e: Expression<T>): Expression<T | null> => fn("max", e);
export const lower = (e: Expression<any>): Expression<string> => fn("lower", e);
export const upper = (e: Expression<any>): Expression<string> => fn("upper", e);
export const length = (e: Expression<any>): Expression<number> => fn("length", e);
export const coalesce = <T>(...args: unknown[]): Expression<T> => fn("coalesce", ...args);
export const now = (): Expression<number> => fn("now");
/** Extract a value from a JSON column: `jsonGet(doc.meta, "a.b.0")`. */
export const jsonGet = (e: Expression<any>, path: string): Expression<unknown> => fn("json_extract", e, path);

/** Arithmetic helper: `add(col, 1)`. */
export const add = (l: unknown, r: unknown): Expression<number> => new RawIR<number>({ t: "bin", op: "+", l: toIR(l), r: toIR(r) });
export const sub = (l: unknown, r: unknown): Expression<number> => new RawIR<number>({ t: "bin", op: "-", l: toIR(l), r: toIR(r) });
export const mul = (l: unknown, r: unknown): Expression<number> => new RawIR<number>({ t: "bin", op: "*", l: toIR(l), r: toIR(r) });

/** Reference to the row proposed for insertion inside `onConflictDoUpdate({ set })`. */
export function excluded<T, NN extends boolean>(c: ColumnExpression<T, NN>): Expression<NN extends true ? T : T | null> {
  return new RawIR({ t: "col", table: "excluded", name: c.name });
}

/** `set({ views: inc(1) })` → `views = views + 1` (atomic within the statement). */
export class Increment {
  constructor(readonly by: number) {}
}
export const inc = (by = 1) => new Increment(by);
export const dec = (by = 1) => new Increment(-by);

export interface OrderSpec {
  expr: Expression<any>;
  desc: boolean;
}
export const asc = (expr: Expression<any>): OrderSpec => ({ expr, desc: false });
export const desc = (expr: Expression<any>): OrderSpec => ({ expr, desc: true });
