import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QueryLog, classifySql } from "../src/queryLog.ts";

describe("classifySql", () => {
  test("read vs write keywords", () => {
    expect(classifySql("SELECT 1")).toBe("read");
    expect(classifySql("  WITH x AS (SELECT 1) SELECT * FROM x")).toBe("read");
    expect(classifySql("INSERT INTO t VALUES (1)")).toBe("write");
    expect(classifySql("UPDATE t SET n = 1")).toBe("write");
    expect(classifySql("DELETE FROM t")).toBe("write");
  });
});

describe("QueryLog", () => {
  test("persists metrics across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-qlog-"));
    try {
      const a = new QueryLog({ dataPath: dir });
      a.record({ sql: "SELECT 1", ok: true });
      a.record({ sql: "INSERT INTO t VALUES (1)", ok: true });
      expect(a.getMetrics()).toEqual({ totalReads: 1, totalWrites: 1, totalOther: 0 });

      const b = new QueryLog({ dataPath: dir });
      expect(b.getMetrics()).toEqual({ totalReads: 1, totalWrites: 1, totalOther: 0 });

      const raw = JSON.parse(readFileSync(join(dir, ".wave", "query-metrics.json"), "utf8"));
      expect(raw.totalReads).toBe(1);
      expect(raw.totalWrites).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
