import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWaveHandler } from "../src/server.ts";
import { QueryLog, classifySql, classifyStmt } from "../src/queryLog.ts";
import { wrapExecutorWithQueryLog } from "../src/queryLogWrap.ts";
import type { Executor } from "../src/query.ts";
import { openTmp } from "./helpers.ts";

describe("classifySql", () => {
  test("read vs write keywords", () => {
    expect(classifySql("SELECT 1")).toBe("read");
    expect(classifySql("  WITH x AS (SELECT 1) SELECT * FROM x")).toBe("read");
    expect(classifySql("INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifySql("UPDATE t SET n = 1")).toBe("write");
    expect(classifySql("DELETE FROM t")).toBe("write");
  });
});

describe("classifyStmt", () => {
  test("typed IR kinds", () => {
    expect(classifyStmt({ kind: "select" })).toBe("read");
    expect(classifyStmt({ kind: "insert" })).toBe("write");
    expect(classifyStmt({ kind: "update" })).toBe("write");
  });
});

describe("QueryLog", () => {
  test("persists log entries across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-qlog-"));
    try {
      const a = new QueryLog({ dataPath: dir });
      const id = a.record({ sql: "SELECT persist_me", ok: true }).id;
      expect(a.recent(5).some((e) => e.id === id)).toBe(true);
      a.flush();

      const b = new QueryLog({ dataPath: dir });
      expect(b.recent(5).some((e) => e.sql.includes("persist_me"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists metrics across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-qlog-"));
    try {
      const a = new QueryLog({ dataPath: dir });
      a.record({ sql: "SELECT 1", ok: true });
      a.record({ sql: "INSERT INTO t VALUES (1)", ok: true });
      expect(a.getMetrics()).toEqual({ totalReads: 1, totalWrites: 1, totalOther: 0 });
      a.flush();

      const b = new QueryLog({ dataPath: dir });
      expect(b.getMetrics()).toEqual({ totalReads: 1, totalWrites: 1, totalOther: 0 });

      const raw = JSON.parse(readFileSync(join(dir, ".wave", "query-metrics.json"), "utf8"));
      expect(raw.totalReads).toBe(1);
      expect(raw.totalWrites).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("in-process queries are logged once (HTTP /api/run does not duplicate)", async () => {
    const { db, dir } = await openTmp({});
    const handler = createWaveHandler(db, { dataPath: join(dir, "data.wave"), auth: false });
    const readsBefore = db.queryLog!.getMetrics().totalReads;

    await db.execute("SELECT 1 AS n");
    expect(db.queryLog!.getMetrics().totalReads).toBe(readsBefore + 1);

    const res = await handler.fetch(
      new Request("http://x/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 2 AS n" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(db.queryLog!.getMetrics().totalReads).toBe(readsBefore + 2);

    const recent = db.queryLog!.recent(10);
    expect(recent.filter((e) => e.sql.includes("SELECT 2")).length).toBe(1);
    await handler.close();
    await db.close();
  });

  test("typed IR run logs readable SQL", async () => {
    const log = new QueryLog();
    const inner: Executor = {
      async run() {
        return { columns: [], rows: [], rowsAffected: 0, durationMs: 0.5 };
      },
      async runSql() {
        return { columns: [], rows: [], rowsAffected: 0, durationMs: 0.5 };
      },
    };
    const exec = wrapExecutorWithQueryLog(inner, log);
    await exec.run({
      kind: "select",
      columns: [{ t: "star" }],
      from: { name: "products" },
      limit: 50,
      offset: 0,
    });
    const entry = log.recent(1)[0]!;
    expect(entry.sql).toBe('SELECT * FROM "products" LIMIT 50 OFFSET 0');
    expect(entry.sql).not.toContain('"kind"');
  });

  test("typed IR formatter failure still runs query and logs fallback", async () => {
    const log = new QueryLog();
    let ran = false;
    const inner: Executor = {
      async run() {
        ran = true;
        return { columns: [], rows: [], rowsAffected: 0, durationMs: 0.1 };
      },
      async runSql() {
        return { columns: [], rows: [], rowsAffected: 0, durationMs: 0.1 };
      },
    };
    const exec = wrapExecutorWithQueryLog(inner, log);
    await exec.run({
      kind: "insert",
      table: "products",
      columns: ["id"],
      rows: [[{ t: "lit", v: BigInt(1) }]],
    });
    expect(ran).toBe(true);
    expect(log.recent(1)[0]!.sql).toBe("/* unformattable statement */");
  });

  test("recent(since) returns earliest new entries in order", () => {
    const log = new QueryLog({ memoryLimit: 500 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(log.record({ sql: `SELECT ${i}`, ok: true }).id);
    }
    const batch = log.recent(2, ids[1]);
    expect(batch.map((e) => e.sql)).toEqual(["SELECT 2", "SELECT 3"]);
  });
});
