// Schema-as-code DSL: typed columns, tables, indexes.

import type { Expression, Increment } from "./expr.ts";
import { ColumnExpression } from "./expr.ts";

export type ColumnKind = "int" | "real" | "text" | "bool" | "blob" | "json" | "timestamp" | "uuid";

export type DefaultSpec =
  | { kind: "value"; v: unknown }
  | { kind: "now" }
  | { kind: "uuid7" }
  | { kind: "uuid4" };

export interface ColumnConfig {
  kind: ColumnKind;
  /** database column name (defaults to the object key) */
  name?: string;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  index: boolean;
  default?: DefaultSpec;
  references?: () => ColumnExpression<any, any>;
}

/**
 * A column definition. Generic parameters track the TypeScript value type,
 * whether the column is NOT NULL and whether it has a default (making it optional on insert).
 */
export class ColumnBuilder<T, NN extends boolean = false, HD extends boolean = false> {
  declare readonly _type: T;
  declare readonly _notNull: NN;
  declare readonly _hasDefault: HD;
  constructor(readonly config: ColumnConfig) {}

  private with<NN2 extends boolean, HD2 extends boolean>(patch: Partial<ColumnConfig>): ColumnBuilder<T, NN2, HD2> {
    return new ColumnBuilder<T, NN2, HD2>({ ...this.config, ...patch });
  }
  notNull(): ColumnBuilder<T, true, HD> {
    return this.with({ notNull: true });
  }
  primaryKey(): ColumnBuilder<T, true, HD> {
    return this.with({ primaryKey: true, notNull: true });
  }
  unique(): ColumnBuilder<T, NN, HD> {
    return this.with({ unique: true });
  }
  /** Create a secondary index on this column. */
  index(): ColumnBuilder<T, NN, HD> {
    return this.with({ index: true });
  }
  /** Constant default (applied when the column is omitted on insert). */
  default(value: T): ColumnBuilder<T, NN, true> {
    return this.with({ default: { kind: "value", v: value } });
  }
  /** Default to the current time (timestamp columns). */
  defaultNow(): ColumnBuilder<T, NN, true> {
    return this.with({ default: { kind: "now" } });
  }
  /** Default to a fresh time-ordered UUIDv7 (uuid / text columns). */
  defaultUuid(version: 4 | 7 = 7): ColumnBuilder<T, NN, true> {
    return this.with({ default: { kind: version === 7 ? "uuid7" : "uuid4" } });
  }
  /** Integer primary key allocated by the database (conflict-free). */
  autoIncrement(): ColumnBuilder<T, true, true> {
    return this.with({ autoIncrement: true, primaryKey: true, notNull: true });
  }
  references(target: () => ColumnExpression<any, any>): ColumnBuilder<T, NN, HD> {
    return this.with({ references: target });
  }
  /** Narrow the TypeScript type (useful for `json<T>()`-like columns). */
  $type<U>(): ColumnBuilder<U, NN, HD> {
    return this as unknown as ColumnBuilder<U, NN, HD>;
  }
}

const col = <T>(kind: ColumnKind, name?: string) =>
  new ColumnBuilder<T>({ kind, name, notNull: false, primaryKey: false, unique: false, autoIncrement: false, index: false });

export const int = (name?: string) => col<number>("int", name);
export const real = (name?: string) => col<number>("real", name);
export const text = (name?: string) => col<string>("text", name);
export const bool = (name?: string) => col<boolean>("bool", name);
export const blob = (name?: string) => col<Uint8Array>("blob", name);
export const timestamp = (name?: string) => col<Date>("timestamp", name);
export const uuid = (name?: string) => col<string>("uuid", name);
export const json = <T = unknown>(name?: string) => col<T>("json", name);

export type AnyColumnBuilder = ColumnBuilder<any, any, any>;
export type ColumnsDefinition = Record<string, AnyColumnBuilder>;

export const TABLE_META = Symbol.for("wavedb.table");

export interface IndexDefinition {
  name?: string;
  columns: string[]; // db column names
  unique: boolean;
}

export interface TableMeta {
  name: string;
  columns: { key: string; name: string; config: ColumnConfig }[];
  primaryKey: string[]; // db column names
  indexes: IndexDefinition[];
}

export type Table<N extends string, C extends ColumnsDefinition> = {
  readonly [K in keyof C]: ColumnExpression<
    C[K]["_type"],
    C[K]["_notNull"]
  >;
} & { readonly [TABLE_META]: TableMeta; readonly _name: N; readonly _columns: C };

export type AnyTable = { readonly [TABLE_META]: TableMeta };

export function tableHasAutoIncrement(t: AnyTable): boolean {
  return tableMeta(t).columns.some((c) => c.config.autoIncrement);
}

export function tableMeta(t: AnyTable): TableMeta {
  return t[TABLE_META];
}

type NullIf<T, NN> = NN extends true ? T : T | null;

type Flatten<T> = { [K in keyof T]: T[K] } & {};

export type InferSelect<T extends AnyTable> = T extends Table<any, infer C>
  ? Flatten<{ [K in keyof C]: NullIf<C[K]["_type"], C[K]["_notNull"]> }>
  : never;

type RequiredKeys<C extends ColumnsDefinition> = {
  [K in keyof C]: C[K]["_notNull"] extends true ? (C[K]["_hasDefault"] extends true ? never : K) : never;
}[keyof C];
type OptionalKeys<C extends ColumnsDefinition> = Exclude<keyof C, RequiredKeys<C>>;

export type InferInsert<T extends AnyTable> = T extends Table<any, infer C>
  ? Flatten<{ [K in RequiredKeys<C>]: C[K]["_type"] } & { [K in OptionalKeys<C>]?: C[K]["_type"] | null }>
  : never;

export type InferUpdate<T extends AnyTable> = T extends Table<any, infer C>
  ? Flatten<{ [K in keyof C]?: C[K]["_type"] | (C[K]["_notNull"] extends true ? never : null) | Expression<any> | Increment }>
  : never;

export class IndexBuilder {
  constructor(
    private readonly _unique: boolean,
    private readonly _name?: string,
  ) {}
  on(...columns: ColumnExpression<any, any>[]): IndexDefinition {
    return { name: this._name, columns: columns.map((c) => c.name), unique: this._unique };
  }
}
export const index = (name?: string) => new IndexBuilder(false, name);
export const uniqueIndex = (name?: string) => new IndexBuilder(true, name);

export interface TableExtras {
  indexes?: IndexDefinition[];
  /** Composite primary key. */
  primaryKey?: ColumnExpression<any, any>[];
}

export function table<N extends string, C extends ColumnsDefinition>(
  name: N,
  columns: C,
  extras?: (t: { [K in keyof C]: ColumnExpression<C[K]["_type"], C[K]["_notNull"]> }) => TableExtras,
): Table<N, C> {
  const meta: TableMeta = { name, columns: [], primaryKey: [], indexes: [] };
  const out: Record<string | symbol, unknown> = {};
  for (const [key, b] of Object.entries(columns)) {
    const cfg = b.config;
    const dbName = cfg.name ?? key;
    meta.columns.push({ key, name: dbName, config: cfg });
    out[key] = new ColumnExpression(name, dbName, cfg.kind, cfg.notNull, key);
    if (cfg.primaryKey) meta.primaryKey.push(dbName);
  }
  const refs = out as { [K in keyof C]: ColumnExpression<C[K]["_type"], C[K]["_notNull"]> };
  for (const c of meta.columns) {
    if (c.config.index) meta.indexes.push({ columns: [c.name], unique: false });
  }
  if (extras) {
    const e = extras(refs);
    for (const i of e.indexes ?? []) meta.indexes.push(i);
    if (e.primaryKey?.length) meta.primaryKey = e.primaryKey.map((c) => c.name);
  }
  if (meta.primaryKey.length === 0) {
    throw new Error(`table "${name}" needs a primary key (use .primaryKey() / .autoIncrement() or { primaryKey: [...] })`);
  }
  out[TABLE_META] = meta;
  out._name = name;
  out._columns = columns;
  return out as unknown as Table<N, C>;
}

/** Re-bind a table under an alias (for self-joins). */
export function alias<T extends AnyTable, A extends string>(
  t: T,
  aliasName: A,
): T extends Table<any, infer C> ? Table<A, C> : never {
  const meta = tableMeta(t);
  const out: Record<string | symbol, unknown> = { ...(t as object) };
  for (const c of meta.columns) {
    out[c.key] = new ColumnExpression(aliasName, c.name, c.config.kind, c.config.notNull, c.key);
  }
  out[TABLE_META] = { ...meta, alias: aliasName } as TableMeta & { alias: string };
  out._name = aliasName;
  return out as any;
}

export function tableAlias(t: AnyTable): string {
  const m = tableMeta(t) as TableMeta & { alias?: string };
  return m.alias ?? m.name;
}

// ---------------------------------------------------------------------------
// statement specs
// ---------------------------------------------------------------------------

export interface ColumnSpecJson {
  name: string;
  type: ColumnKind;
  nullable: boolean;
  default?: DefaultSpec;
  unique: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  references?: { table: string; columns: string[] };
}

export function columnSpec(c: TableMeta["columns"][number], encode: (kind: ColumnKind, v: unknown) => unknown): ColumnSpecJson {
  const d = c.config.default;
  const ref = c.config.references?.();
  return {
    name: c.name,
    type: c.config.kind,
    nullable: !c.config.notNull,
    unique: c.config.unique,
    primaryKey: false, // composite-aware: PK is passed at table level
    autoIncrement: c.config.autoIncrement,
    ...(d ? { default: d.kind === "value" ? { kind: "value" as const, v: encode(c.config.kind, d.v) } : d } : {}),
    ...(ref ? { references: { table: ref.table, columns: [ref.name] } } : {}),
  };
}

export function createTableStatement(t: AnyTable, encode: (kind: ColumnKind, v: unknown) => unknown, ifNotExists = true) {
  const m = tableMeta(t);
  return {
    kind: "createTable",
    name: m.name,
    columns: m.columns.map((c) => columnSpec(c, encode)),
    primaryKey: m.primaryKey,
    indexes: m.indexes.map((i) => ({ name: i.name ?? defaultIndexName(m.name, i), columns: i.columns, unique: i.unique })),
    ifNotExists,
  };
}

export function defaultIndexName(table: string, i: IndexDefinition): string {
  return `${table}_${i.columns.join("_")}_${i.unique ? "key" : "idx"}`;
}
