// Tagged-template SQL: values are always bound as parameters, never concatenated.

import { encodeValue } from "./expr.ts";

const RAW = Symbol("wavedb.sql.raw");

export class SqlFragment {
  readonly [RAW] = true;
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

/** `sql\`select * from users where id = ${id}\`` */
export function sql(strings: TemplateStringsArray | readonly string[], ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

/** Insert trusted text verbatim (never pass user input). */
sql.raw = (text: string): SqlFragment => new SqlFragment([text], []);

/** Quote an identifier: `sql.identifier("users")`. */
sql.identifier = (name: string): SqlFragment => {
  if (name.includes("\0")) throw new Error("invalid identifier");
  return new SqlFragment([`"${name.replace(/"/g, '""')}"`], []);
};

/** Join fragments with a separator: `sql.join([a, b], sql.raw(", "))`. */
sql.join = (parts: readonly unknown[], separator: SqlFragment = sql.raw(", ")): SqlFragment => {
  const strings: string[] = [""];
  const values: unknown[] = [];
  parts.forEach((p, i) => {
    if (i > 0) {
      // splice separator
      const s = separator;
      strings[strings.length - 1] += s.strings[0]!;
      for (let k = 0; k < s.values.length; k++) {
        values.push(s.values[k]);
        strings.push(s.strings[k + 1]!);
      }
    }
    values.push(p);
    strings.push("");
  });
  return new SqlFragment(strings, values);
};

export interface CompiledSql {
  text: string;
  params: unknown[];
}

/** Flatten nested fragments into `$1, $2, ...` placeholders. */
export function compileSql(frag: SqlFragment): CompiledSql {
  const params: unknown[] = [];
  const walk = (f: SqlFragment): string => {
    let out = "";
    for (let i = 0; i < f.strings.length; i++) {
      out += f.strings[i];
      if (i < f.values.length) {
        const v = f.values[i];
        if (v instanceof SqlFragment) {
          out += walk(v);
        } else {
          params.push(encodeValue(v));
          out += `$${params.length}`;
        }
      }
    }
    return out;
  };
  return { text: walk(frag), params };
}
