import { afterAll, describe, expect, test } from "bun:test";
import { ConflictError, ConstraintError, WaveError, connect, eq, int, serve, table, text } from "../src/index.ts";
import { cleanup, openTmp } from "./helpers.ts";

afterAll(cleanup);

const items = table("items", { id: int().autoIncrement(), name: text().notNull().unique(), qty: int().notNull().default(0) });
const schema = { items };

describe("remote (HTTP) mode", () => {
  test("typed queries, transactions and errors work over the wire", async () => {
    const { db } = await openTmp({ schema });
    const server = await serve(db);
    const remote = await connect(server.url, { schema });

    await remote.insert(items).values([{ name: "a" }, { name: "b", qty: 5 }]);
    expect((await remote.select().from(items).orderBy(items.id)).map((r) => r.name)).toEqual(["a", "b"]);
    // shared with local view
    expect(await db.query.items.count()).toBe(2);

    await expect(remote.insert(items).values({ name: "a" }).execute()).rejects.toBeInstanceOf(ConstraintError);

    await remote.tx(async (tx) => {
      await tx.update(items).set({ qty: 100 }).where(eq(items.name, "a"));
      // uncommitted change invisible to others
      expect((await db.query.items.findFirst({ where: { name: "a" } }))!.qty).toBe(0);
    });
    expect((await db.query.items.findFirst({ where: { name: "a" } }))!.qty).toBe(100);

    // conflict across local and remote
    const t1 = await remote.begin();
    const t2 = await db.begin();
    await t1.update(items).set({ qty: 1 }).where(eq(items.name, "b"));
    await t2.update(items).set({ qty: 2 }).where(eq(items.name, "b"));
    await t2.commit();
    await expect(t1.commit()).rejects.toBeInstanceOf(ConflictError);

    expect((await remote.stats()).commits).toBeGreaterThan(0);
    expect((await remote.tables()).map((t) => t.name)).toContain("items");
    await server.close();
    await db.close();
  });

  test("wide integers over HTTP", async () => {
    const wide = table("wide", { id: int().primaryKey(), n: int().notNull() });
    const wideSchema = { wide };
    const { db } = await openTmp({ schema: wideSchema });
    const server = await serve(db);
    const remote = await connect(server.url, { schema: wideSchema });
    const v = 9007199254740993n;
    await remote.insert(wide).values({ id: 1, n: v });
    expect((await remote.select().from(wide))[0]!.n).toBe(v);
    await server.close();
    await db.close();
  });

  test("token auth", async () => {
    const { db } = await openTmp({ schema });
    const server = await serve(db, { token: "s3cret" });
    const bad = await connect(server.url, { schema });
    await expect(bad.select().from(items).execute()).rejects.toBeInstanceOf(WaveError);
    const ok = await connect(server.url, { schema, token: "s3cret" });
    expect(await ok.select().from(items)).toEqual([]);
    await server.close();
    await db.close();
  });

  test("idle remote transactions are rolled back", async () => {
    const { db } = await openTmp({ schema });
    const server = await serve(db, { txIdleMs: 50 });
    const remote = await connect(server.url, { schema });
    const tx = await remote.begin();
    await tx.insert(items).values({ name: "ghost" });
    await new Promise((r) => setTimeout(r, 200));
    await expect(tx.commit()).rejects.toThrow(/expired|unknown/);
    expect(await db.query.items.count()).toBe(0);
    await server.close();
    await db.close();
  });

  test("concurrent remote clients retry conflicts", async () => {
    const { db } = await openTmp({ schema });
    await db.insert(items).values({ name: "ctr" });
    const server = await serve(db);
    const remote = await connect(server.url, { schema });
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let i = 0; i < 5; i++) {
          await remote.tx(
            async (tx) => {
              const r = (await tx.select().from(items).where(eq(items.name, "ctr")))[0]!;
              await tx.update(items).set({ qty: r.qty + 1 }).where(eq(items.name, "ctr"));
            },
            { retries: 100 },
          );
        }
      }),
    );
    expect((await db.query.items.findFirst({ where: { name: "ctr" } }))!.qty).toBe(40);
    await server.close();
    await db.close();
  });
});
