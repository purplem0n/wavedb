// Implementation of the `wave` commands. `run()` is pure enough to be unit-tested.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { serve, wave, type TableDefJson, type AnyTable, type Database, type SchemaMap, type WaveServer } from "@purplemon/wavedb";

export interface IO {
  out(s: string): void;
  err(s: string): void;
  /** stdin lines for the REPL (tests); default = process.stdin */
  input?: AsyncIterable<string>;
}

export type RunResult = { code: number } | { code: 0; running: WaveServer };

const HELP = `wave — WaveDB command line

Usage: wave <command> [path] [options]       (path defaults to ./data.wave)

  studio [path]       Open Wave Studio (web UI) on the database      --port 4400 --open --token T --host H
  dev [path]          Same as studio, plus applies --schema on start  --schema ./schema.ts
  serve [path]        Serve the database over HTTP for other processes --port 4401 --host 127.0.0.1 --token T
  sql [path] [SQL]    Run SQL (or start an interactive shell)          --json
  tables [path]       List tables, columns and indexes
  stats [path]        Engine statistics
  diff [path]         Show schema changes needed                       --schema ./schema.ts
  push [path]         Apply schema (additive; --force for destructive) --schema ./schema.ts
  export [path]       Dump database to JSON                            --out dump.json
  import [path]       Load a dump into the database                    --in dump.json
  vacuum [path]       Remove dead MVCC versions
  compact [path]      Force LSM compaction
  version

Options: --durability sync|async   --help
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOL_FLAGS = new Set(["open", "json", "force", "help", "no-open", "cors", "standby", "leader"]);

export function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) flags[name] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(name) || i + 1 >= rest.length || rest[i + 1]!.startsWith("--")) flags[name] = true;
      else flags[name] = rest[++i]!;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

export async function loadSchema(file: string): Promise<SchemaMap> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`schema file not found: ${file}`);
  const mod = await import(pathToFileURL(abs).href);
  const out: SchemaMap = {};
  const isTable = (v: unknown): v is AnyTable => typeof v === "object" && v !== null && Symbol.for("wavedb.table") in v;
  const visit = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) if (isTable(v)) out[k] = v;
  };
  if (mod.schema && typeof mod.schema === "object") visit(mod.schema);
  if (mod.default && typeof mod.default === "object") visit(mod.default);
  visit(mod);
  if (Object.keys(out).length === 0) throw new Error(`${file} does not export any wavedb tables (export const schema = { ... })`);
  return out;
}

function studioDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WAVE_STUDIO_DIR,
    join(here, "..", "studio"),
    join(here, "..", "..", "wave-studio", "dist"),
    join(here, "..", "..", "..", "wave-studio", "dist"),
  ].filter((p): p is string => !!p);
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

// ---- table formatting ------------------------------------------------------

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function formatTable(columns: string[], rows: unknown[][]): string {
  const cells = rows.map((r) => r.map(fmt));
  const widths = columns.map((c, i) => Math.min(60, Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length))));
  const cut = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
  const line = (r: string[]) => "| " + r.map((c, i) => cut(c, widths[i]!)).join(" | ") + " |";
  const sep = "+-" + widths.map((w) => "-".repeat(w)).join("-+-") + "-+";
  return [sep, line(columns), sep, ...cells.map(line), sep].join("\n");
}

async function printSql(db: Database<any>, text: string, io: IO, json: boolean) {
  const res = await db.exec.runSql(text, []);
  if (json) {
    io.out(JSON.stringify(res) + "\n");
    return;
  }
  if (res.columns.length) {
    io.out(formatTable(res.columns, res.rows) + `\n(${res.rows.length} row${res.rows.length === 1 ? "" : "s"})\n`);
  } else {
    io.out(`OK, ${res.rowsAffected} row${res.rowsAffected === 1 ? "" : "s"} affected\n`);
  }
}

export function describeTables(tables: TableDefJson[]): string {
  if (!tables.length) return "(no tables)\n";
  return (
    tables
      .map((t) => {
        const cols = t.columns
          .map((c) => `  ${c.name} ${c.type}${t.primaryKey.includes(c.name) ? " PRIMARY KEY" : c.nullable ? "" : " NOT NULL"}`)
          .join("\n");
        const idx = t.indexes.map((i) => `  ${i.unique ? "UNIQUE " : ""}INDEX ${i.name} (${i.columns.join(", ")})`).join("\n");
        return `TABLE ${t.name}\n${cols}${idx ? "\n" + idx : ""}`;
      })
      .join("\n\n") + "\n"
  );
}

// ---- export / import ---------------------------------------------------------

export interface Dump {
  format: "wavedb-dump";
  version: 1;
  tables: { def: TableDefJson; rows: unknown[][] }[];
}

async function exportDump(db: Database<any>): Promise<Dump> {
  const tables = await db.tables();
  const out: Dump["tables"] = [];
  await db.tx(async (tx) => {
    out.length = 0;
    for (const def of tables) {
      const cols = def.columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
      const r = await tx.exec.runSql(`SELECT ${cols} FROM "${def.name.replace(/"/g, '""')}"`, []);
      out.push({ def, rows: r.rows });
    }
  });
  return { format: "wavedb-dump", version: 1, tables: out };
}

async function importDump(db: Database<any>, dump: Dump): Promise<number> {
  if (dump.format !== "wavedb-dump") throw new Error("not a wavedb dump");
  let n = 0;
  await db.tx(async (tx) => {
    n = 0;
    for (const { def, rows } of dump.tables) {
      const pk = def.primaryKey;
      await tx.exec.run({
        kind: "createTable",
        name: def.name,
        columns: def.columns.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          ...(c.default ? { default: c.default } : {}),
          unique: false,
          primaryKey: false,
          autoIncrement: def.autoIncrement && c.name === pk[0],
        })),
        primaryKey: pk,
        indexes: def.indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique })),
        ifNotExists: false,
      });
      for (let off = 0; off < rows.length; off += 500) {
        const chunk = rows.slice(off, off + 500);
        await tx.exec.run({
          kind: "insert",
          table: def.name,
          columns: def.columns.map((c) => c.name),
          rows: chunk.map((r) => r.map((v) => ({ t: "lit", v }))),
        });
        n += chunk.length;
      }
    }
  });
  return n;
}

// ---- commands ----------------------------------------------------------------

function openUrl(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore */
  }
}

function withDb(server: WaveServer, db: Database<any>): WaveServer {
  return {
    ...server,
    close: async () => {
      await server.close();
      await db.close();
    },
  };
}

export async function run(argv: string[], io: IO): Promise<RunResult> {
  const { cmd, positional, flags } = parseArgs(argv);
  if (cmd === "help" || flags.help) {
    io.out(HELP);
    return { code: 0 };
  }
  if (cmd === "version" || cmd === "--version") {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    io.out(`wave ${pkg.version}\n`);
    return { code: 0 };
  }
  const path = positional[0] && !(cmd === "sql" && positional.length === 1 && /\s/.test(positional[0]!)) ? positional[0]! : "./data.wave";
  const durability = flags.durability === "async" ? "async" : undefined;
  const schema = typeof flags.schema === "string" ? await loadSchema(flags.schema) : undefined;

  const open = (push: boolean) => wave(path, { schema, durability, push });

  switch (cmd) {
    case "studio":
    case "dev": {
      const db = await open(cmd === "dev" || !!schema);
      const dir = studioDir();
      if (!dir) {
        io.err("Wave Studio is not built. Run: bun run --filter wave-studio build\n");
      }
      const port = flags.port ? Number(flags.port) : 4400;
      const server = await serve(db, {
        port,
        host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
        token: typeof flags.token === "string" ? flags.token : undefined,
        staticDir: dir,
        cors: !!flags.cors,
      });
      io.out(`Wave Studio  ${server.url}${flags.token ? "  (token required)" : ""}\nDatabase     ${resolve(path)}\n`);
      if (flags.open) openUrl(server.url);
      return { code: 0, running: withDb(server, db) };
    }
    case "serve": {
      const db = await open(!!schema);
      const server = await serve(db, {
        port: flags.port ? Number(flags.port) : 4401,
        host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
        token: typeof flags.token === "string" ? flags.token : undefined,
        cors: !!flags.cors,
        dataPath: resolve(path),
        leader: !("leader" in flags) || flags.leader === true,
        standby: !!flags.standby,
      });
      io.out(`WaveDB serving ${resolve(path)} at ${server.url}\n`);
      return { code: 0, running: withDb(server, db) };
    }
    case "sql": {
      const db = await open(false);
      try {
        const text = positional.length > 1 ? positional.slice(1).join(" ") : /\s/.test(positional[0] ?? "") ? positional[0]! : undefined;
        if (text) {
          await printSql(db, text, io, !!flags.json);
          return { code: 0 };
        }
        // REPL
        const lines: AsyncIterable<string> = io.input ?? createInterface({ input: process.stdin, prompt: "wave> " });
        io.out(`WaveDB shell on ${resolve(path)} — end statements with ';', .help for commands\n`);
        let buf = "";
        for await (const raw of lines) {
          const line = raw.trim();
          if (!buf && line.startsWith(".")) {
            const [c, arg] = line.split(/\s+/);
            if (c === ".quit" || c === ".exit") break;
            else if (c === ".tables") io.out((await db.tables()).map((t) => t.name).join("\n") + "\n");
            else if (c === ".schema") io.out(describeTables((await db.tables()).filter((t) => !arg || t.name === arg)));
            else if (c === ".stats") io.out(JSON.stringify(await db.stats(), null, 2) + "\n");
            else io.out(".tables  .schema [table]  .stats  .quit\n");
            continue;
          }
          buf += (buf ? "\n" : "") + raw;
          if (buf.trimEnd().endsWith(";")) {
            const stmt = buf;
            buf = "";
            try {
              await printSql(db, stmt, io, !!flags.json);
            } catch (e) {
              io.err(`error: ${(e as Error).message}\n`);
            }
          }
        }
        return { code: 0 };
      } catch (e) {
        io.err(`error: ${(e as Error).message}\n`);
        return { code: 1 };
      } finally {
        await db.close();
      }
    }
    case "tables": {
      const db = await open(false);
      io.out(describeTables(await db.tables()));
      await db.close();
      return { code: 0 };
    }
    case "stats": {
      const db = await open(false);
      io.out(JSON.stringify(await db.stats(), null, 2) + "\n");
      await db.close();
      return { code: 0 };
    }
    case "diff":
    case "push": {
      if (!schema) {
        io.err(`wave ${cmd} needs --schema <file>\n`);
        return { code: 2 };
      }
      const db = await open(false);
      try {
        if (cmd === "diff") {
          const ops = await db.diff();
          io.out(ops.length ? ops.map((o) => `${o.applicable ? (o.destructive ? "!" : "+") : "x"} ${o.description}`).join("\n") + "\n" : "Schema is up to date.\n");
          return { code: ops.some((o) => !o.applicable) ? 1 : 0 };
        }
        const ops = await db.push({ allowDestructive: !!flags.force });
        io.out(ops.length ? `Applied ${ops.length} change(s):\n` + ops.map((o) => `  ${o.description}`).join("\n") + "\n" : "Schema is up to date.\n");
        return { code: 0 };
      } catch (e) {
        io.err(`error: ${(e as Error).message}\n`);
        return { code: 1 };
      } finally {
        await db.close();
      }
    }
    case "export": {
      const db = await open(false);
      const dump = await exportDump(db);
      await db.close();
      const text = JSON.stringify(dump);
      if (typeof flags.out === "string") {
        writeFileSync(flags.out, text);
        io.out(`Exported ${dump.tables.length} table(s), ${dump.tables.reduce((s, t) => s + t.rows.length, 0)} row(s) to ${flags.out}\n`);
      } else io.out(text + "\n");
      return { code: 0 };
    }
    case "import": {
      if (typeof flags.in !== "string") {
        io.err("wave import needs --in <dump.json>\n");
        return { code: 2 };
      }
      const db = await open(false);
      try {
        const n = await importDump(db, JSON.parse(readFileSync(flags.in, "utf8")));
        io.out(`Imported ${n} row(s)\n`);
        return { code: 0 };
      } catch (e) {
        io.err(`error: ${(e as Error).message}\n`);
        return { code: 1 };
      } finally {
        await db.close();
      }
    }
    case "vacuum":
    case "compact": {
      const db = await open(false);
      if (cmd === "vacuum") io.out(`Removed ${await db.vacuum()} dead version(s)\n`);
      else {
        await db.compact();
        io.out("Compaction complete\n");
      }
      await db.close();
      return { code: 0 };
    }
    default:
      io.err(`unknown command "${cmd}"\n\n${HELP}`);
      return { code: 2 };
  }
}
