import { afterAll, describe, expect, test } from "bun:test";
import { eq, int, table, text } from "../src/index.ts";
import { formatIrForLog } from "../src/irToSql.ts";
import { cleanup, openTmp } from "./helpers.ts";

afterAll(cleanup);

const users = table("users", {
  id: int().autoIncrement(),
  email: text().notNull(),
});

describe("formatIrForLog", () => {
  test("select with table alias, filter, limit", () => {
    const sql = formatIrForLog({
      kind: "select",
      columns: [
        { t: "expr", expr: { t: "col", table: "le", name: "mal_id" }, alias: "le.mal_id" },
        { t: "expr", expr: { t: "col", table: "le", name: "source" }, alias: "le.source" },
      ],
      from: { name: "latest_episodes", alias: "le" },
      where: {
        t: "bin",
        op: "=",
        l: { t: "col", table: "le", name: "source" },
        r: { t: "lit", v: "anilist" },
      },
      orderBy: [{ expr: { t: "col", table: "le", name: "updated_at" }, desc: true }],
      limit: 100,
    });
    expect(sql).toBe(
      'SELECT "le"."mal_id" AS "le.mal_id", "le"."source" AS "le.source" FROM "latest_episodes" AS "le" WHERE "le"."source" = \'anilist\' ORDER BY "le"."updated_at" DESC LIMIT 100',
    );
    expect(sql).not.toContain('"kind"');
  });

  test("nested arithmetic is parenthesized", () => {
    const sql = formatIrForLog({
      kind: "select",
      columns: [{ t: "star" }],
      from: { name: "t" },
      where: {
        t: "bin",
        op: "*",
        l: { t: "bin", op: "+", l: { t: "col", name: "a" }, r: { t: "lit", v: 1 } },
        r: { t: "lit", v: 2 },
      },
    });
    expect(sql).toContain("(\"a\" + 1) * 2");
  });

  test("case-insensitive like renders ILIKE", () => {
    const sql = formatIrForLog({
      kind: "select",
      columns: [{ t: "star" }],
      from: { name: "t" },
      where: { t: "like", e: { t: "col", name: "email" }, pattern: { t: "lit", v: "%x%" }, ci: true },
    });
    expect(sql).toContain("ILIKE");
    expect(sql).not.toContain("(ci)");
  });

  test("count star and pagination", () => {
    const sql = formatIrForLog({
      kind: "select",
      columns: [{ t: "expr", expr: { t: "func", name: "count", args: [], distinct: false, star: true }, alias: "n" }],
      from: { name: "anime_season" },
    });
    expect(sql).toContain('COUNT(*) AS "n"');
    expect(sql).toContain('FROM "anime_season"');
  });

  test("query builder statements match readable SQL", async () => {
    const { db } = await openTmp({ schema: { users } });
    const stmt = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "a@b.co"))
      .limit(50)
      .offset(0)
      .toStatement().stmt;
    const sql = formatIrForLog(stmt);
    expect(sql).toMatch(/SELECT .* FROM "users"/);
    expect(sql).toContain("WHERE");
    expect(sql).toContain("'a@b.co'");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain("OFFSET 0");
    await db.close();
  });
});
