import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, int, table, text, wave } from "@purplemon/wavedb";
import { formatTable, parseArgs, run } from "../src/cli.ts";
import { cleanup, tmpDir } from "../../wavedb/test/helpers.ts";

afterAll(cleanup);

function capture() {
  let out = "";
  let err = "";
  return {
    io: { out: (s: string) => void (out += s), err: (s: string) => void (err += s) },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function wv(args: string[], input?: string[]) {
  const c = capture();
  const io = { ...c.io, input: input ? (async function* () { yield* input; })() : undefined };
  const res = await run(args, io);
  return { res, out: c.out, err: c.err };
}

describe("wave cli", () => {
  test("parseArgs", () => {
    expect(parseArgs(["studio", "./db", "--port", "5000", "--open", "--token=x"])).toEqual({
      cmd: "studio",
      positional: ["./db"],
      flags: { port: "5000", open: true, token: "x" },
    });
  });

  test("formatTable", () => {
    const t = formatTable(["a", "b"], [[1, null], ["x", { k: 1 }]]);
    expect(t).toContain("| a ");
    expect(t).toContain("NULL");
    expect(t).toContain('{"k":1}');
  });

  test("sql / tables / stats / vacuum", async () => {
    const path = join(tmpDir(), "d.wave");
    let r = await wv(["sql", path, "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)"]);
    expect(r.res).toEqual({ code: 0 });
    r = await wv(["sql", path, "INSERT INTO t (name) VALUES ('a'), ('b')"]);
    expect(r.out).toContain("2 rows affected");
    r = await wv(["sql", path, "SELECT * FROM t ORDER BY id"]);
    expect(r.out).toContain("| id | name |");
    expect(r.out).toContain("(2 rows)");
    r = await wv(["sql", path, "SELECT count(*) AS n FROM t", "--json"]);
    expect(JSON.parse(r.out).rows).toEqual([[2]]);
    r = await wv(["tables", path]);
    expect(r.out).toContain("TABLE t");
    expect(r.out).toContain("id int PRIMARY KEY");
    r = await wv(["stats", path]);
    expect(JSON.parse(r.out).commits).toBeGreaterThanOrEqual(0);
    r = await wv(["vacuum", path]);
    expect(r.out).toMatch(/Removed \d+/);
  });

  test("sql REPL", async () => {
    const path = join(tmpDir(), "d.wave");
    const r = await wv(["sql", path], ["CREATE TABLE x (id INTEGER PRIMARY KEY, v TEXT);", "INSERT INTO x VALUES (1,", "'multi');", "SELECT * FROM x;", "SELECT * FROM nope;", ".tables", ".quit"]);
    expect(r.out).toContain("multi");
    expect(r.out).toContain("x\n");
    expect(r.err).toContain("error");
  });

  test("schema diff / push / export / import", async () => {
    const dir = tmpDir();
    const schemaFile = join(dir, "schema.ts");
    const wavedbEntry = join(import.meta.dir, "../../wavedb/src/index.ts");
    writeFileSync(
      schemaFile,
      `import { table, int, text } from ${JSON.stringify(wavedbEntry)};\nexport const users = table("users", { id: int().autoIncrement(), name: text().notNull().unique() });\nexport const notes = table("notes", { id: int().primaryKey(), body: text() });\n`,
    );
    const path = join(dir, "d.wave");
    let r = await wv(["diff", path, "--schema", schemaFile]);
    expect(r.out).toContain("create table users");
    expect(r.res.code).toBe(0);
    r = await wv(["push", path, "--schema", schemaFile]);
    expect(r.out).toContain("Applied 2 change(s)");
    r = await wv(["diff", path, "--schema", schemaFile]);
    expect(r.out).toContain("up to date");

    await wv(["sql", path, "INSERT INTO users (name) VALUES ('ann'), ('bob')"]);
    await wv(["sql", path, "INSERT INTO notes (id, body) VALUES (1, 'hi')"]);
    const dump = join(dir, "dump.json");
    r = await wv(["export", path, "--out", dump]);
    expect(r.out).toContain("2 table(s), 3 row(s)");
    expect(JSON.parse(readFileSync(dump, "utf8")).tables).toHaveLength(2);

    const path2 = join(dir, "restored.wave");
    r = await wv(["import", path2, "--in", dump]);
    expect(r.out).toContain("Imported 3 row(s)");
    const db = await wave(path2);
    expect((await db.sql`SELECT name FROM users ORDER BY id`).map((x) => x.name)).toEqual(["ann", "bob"]);
    // autoincrement continues after import
    const ins = await db.sql`INSERT INTO users (name) VALUES ('cy') RETURNING id`;
    expect(ins[0]!.id).toBe(3);
    expect((await db.sql`SELECT body FROM notes`)[0]!.body).toBe("hi");
    await db.close();
  });

  test("serve starts an HTTP server other processes can use", async () => {
    const path = join(tmpDir(), "s.wave");
    const r = await wv(["serve", path, "--port", "0", "--token", "cli-secret"]);
    expect("running" in r.res).toBe(true);
    if (!("running" in r.res)) return;
    const server = r.res.running;
    const t = table("t", { id: int().autoIncrement(), v: text() });
    const remote = await connect(server.url, { schema: { t }, push: true, token: "cli-secret" });
    await remote.insert(t).values({ v: "over-http" });
    expect((await remote.select().from(t))[0]!.v).toBe("over-http");
    await server.close();
  });

  test("studio serves static files + API from the same origin", async () => {
    const path = join(tmpDir(), "st.wave");
    const staticDir = join(tmpDir(), "studio");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<html>studio</html>");
    process.env.WAVE_STUDIO_DIR = staticDir;
    const r = await wv(["studio", path, "--port", "0", "--token", "cli-secret"]);
    delete process.env.WAVE_STUDIO_DIR;
    if (!("running" in r.res)) throw new Error("not running");
    const server = r.res.running;
    expect(await (await fetch(server.url + "/")).text()).toContain("studio");
    expect(await (await fetch(server.url + "/some/route")).text()).toContain("studio"); // SPA fallback
    expect((await fetch(server.url + "/missing.js")).status).toBe(404);
    expect(await (await fetch(server.url + "/..%2f..%2f..%2fetc/passwd")).text()).not.toContain("root:"); // no traversal
    const auth = { headers: { authorization: "Bearer cli-secret" } };
    expect(await (await fetch(server.url + "/api/tables", auth)).json()).toEqual([]);
    await server.close();
  });

  test("unknown command / missing args", async () => {
    expect((await wv(["bogus"])).res.code).toBe(2);
    expect((await wv(["push", join(tmpDir(), "x.wave")])).res.code).toBe(2);
    expect((await wv(["help"])).out).toContain("wave — WaveDB");
  });
});
