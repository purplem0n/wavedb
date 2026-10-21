import { describe, expect, test } from "bun:test";
import { eq, int, table, text, wave } from "../src/index.ts";
import { openTmp } from "./helpers.ts";

describe("schema rebuild migrations", () => {
  test("enables autoIncrement on an existing table without rebuild", async () => {
    const v1 = table("items", { id: int().primaryKey(), name: text().notNull() });
    const { db: d1, dir } = await openTmp({ schema: { items: v1 } });
    await d1.insert(v1).values({ id: 10, name: "x" });
    await d1.close();

    const v2 = table("items", { id: int().autoIncrement(), name: text().notNull() });
    const d2 = await wave(`${dir}/data.wave`, { schema: { items: v2 }, push: false });
    const ops = await d2.diff();
    expect(ops.some((o) => o.op === "setAutoIncrement")).toBe(true);
    await d2.push();
    expect((await d2.tables()).find((t) => t.name === "items")!.autoIncrement).toBe(true);
    const r = await d2.insert(v2).values({ name: "y" });
    expect(r.lastInsertId).toBe(11);
    await d2.close();
  });

  test("column type change rebuilds table with allowDestructive", async () => {
    const v1 = table("items", { id: int().primaryKey(), v: int().notNull() });
    const { db: d1, dir } = await openTmp({ schema: { items: v1 } });
    await d1.insert(v1).values({ id: 1, v: 42 });
    await d1.close();

    const v2 = table("items", { id: int().primaryKey(), v: text().notNull() });
    const d2 = await wave(`${dir}/data.wave`, { schema: { items: v2 }, push: false });
    const ops = await d2.diff();
    expect(ops.some((o) => o.op === "rebuildTable")).toBe(true);
    await expect(d2.push()).rejects.toThrow(/allowDestructive/);
    await d2.push({ allowDestructive: true });
    expect(await d2.diff()).toEqual([]);
    expect((await d2.select().from(v2))[0]!.v).toBe("42");
    await d2.close();
  });

  test("primary key change rebuild preserves rows", async () => {
    const v1 = table("t", { id: int().primaryKey(), label: text().notNull() });
    const { db: d1, dir } = await openTmp({ schema: { t: v1 } });
    await d1.insert(v1).values([
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ]);
    await d1.close();

    const v2 = table("t", {
      id: int().notNull(),
      label: text().primaryKey(),
    });
    const d2 = await wave(`${dir}/data.wave`, { schema: { t: v2 }, push: false });
    await d2.push({ allowDestructive: true });
    const rows = await d2.select().from(v2).orderBy(v2.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label).sort()).toEqual(["a", "b"]);
    await d2.close();
  });
});
